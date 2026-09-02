const fs = require('fs');
const vm = require('vm');
const { getHistoricalRates } = require('dukascopy-node');

async function load() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const raw = await getHistoricalRates({ instrument: 'xauusd', dates: { from, to }, timeframe: 'm5', format: 'json' });
  return raw.map(x => ({ time:+x.timestamp, open:+x.open, high:+x.high, low:+x.low, close:+x.close }))
    .filter(x => [x.time,x.open,x.high,x.low,x.close].every(Number.isFinite))
    .sort((a,b)=>a.time-b.time);
}

function loadProductionAnalyze() {
  const src = fs.readFileSync('server.js', 'utf8');
  const cut = src.indexOf('(async()=>{');
  if (cut < 0) throw new Error('Cannot locate production runner in server.js');
  const pure = src.slice(0, cut);
  const context = { require };
  vm.createContext(context);
  vm.runInContext(pure + '\nthis.__production = { normalize, analyze };', context, { filename:'server.js' });
  return context.__production.analyze;
}

function simulate(d, analyze, start=100) {
  const trades=[]; let i=start, signals=0;
  while(i<d.length-10){
    const closed=d.slice(0,i+1);
    const sig=analyze(closed);
    if(!sig){i++;continue}
    signals++;
    const entryBar=d[i+1];
    const entry=entryBar.open;
    const risk=Math.abs(entry-sig.sl);
    if(!(risk>0)){i++;continue}
    const tp2=sig.direction==='BUY'?entry+2*risk:entry-2*risk;
    let outcome='OPEN',exit=d.at(-1).close,bars=0;
    for(let j=i+1;j<d.length;j++){
      bars++; const c=d[j];
      if(sig.direction==='BUY'){
        if(c.low<=sig.sl){outcome='SL';exit=sig.sl;break;}
        if(c.high>=tp2){outcome='TP2';exit=tp2;break;}
      } else {
        if(c.high>=sig.sl){outcome='SL';exit=sig.sl;break;}
        if(c.low<=tp2){outcome='TP2';exit=tp2;break;}
      }
    }
    if(outcome==='OPEN') break;
    const R=sig.direction==='BUY'?(exit-entry)/risk:(entry-exit)/risk;
    trades.push({...sig,signalEntry:sig.entry,executedEntry:entry,outcome,R:+R.toFixed(3),bars});
    i += Math.max(1,bars);
  }
  const wins=trades.filter(x=>x.R>0), losses=trades.filter(x=>x.R<0);
  const netR=trades.reduce((a,x)=>a+x.R,0), grossWin=wins.reduce((a,x)=>a+x.R,0), grossLoss=Math.abs(losses.reduce((a,x)=>a+x.R,0));
  let eq=0,peak=0,maxDD=0; for(const t of trades){eq+=t.R;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq);}
  return {signals,trades:trades.length,wins:wins.length,losses:losses.length,winRate:trades.length?wins.length/trades.length:0,netR:+netR.toFixed(3),profitFactor:+(grossWin/(grossLoss||1)).toFixed(3),maxDrawdownR:+maxDD.toFixed(3),avgR:+(netR/(trades.length||1)).toFixed(3),details:trades};
}

(async()=>{
  try{
    const d=await load();
    if(d.length<1000) throw new Error(`Insufficient XAUUSD M5 candles: ${d.length}`);
    const analyze=loadProductionAnalyze();
    const result=simulate(d,analyze,100);
    const out={source:'Dukascopy XAUUSD spot M5',candles:d.length,periodStart:d[0].time,periodEnd:d.at(-1).time,logicSource:'server.js production analyze() loaded directly; no reconstructed strategy',execution:'signal generated from closed M5 candle; entry at next M5 open; SL unchanged; TP2=2R; one position at a time',result};
    fs.writeFileSync('backtest/exact_production_result.json',JSON.stringify(out,null,2));
    console.log(JSON.stringify({...out,result:{...result,details:undefined}},null,2));
  }catch(e){console.error(e);process.exit(1)}
})();
