const fs = require('fs');
const vm = require('vm');
const { getHistoricalRates } = require('dukascopy-node');

async function loadData(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const raw = await getHistoricalRates({ instrument: 'xauusd', dates: { from, to }, timeframe: 'm5', format: 'json' });
  return raw.map(x => ({ time:+x.timestamp, open:+x.open, high:+x.high, low:+x.low, close:+x.close, volume:+x.volume||0, isOpen:false }))
    .filter(x => [x.time,x.open,x.high,x.low,x.close].every(Number.isFinite))
    .sort((a,b)=>a.time-b.time);
}

function loadV6Analyze(initialData) {
  let src = fs.readFileSync('server_v6.js', 'utf8');
  const marker = 'const candles = load(FILE, []).map';
  const start = src.indexOf(marker);
  const agg = src.indexOf('function aggregate', start);
  const runner = src.indexOf('const signal=analyze();');
  if (start < 0 || agg < 0 || runner < 0) throw new Error('Cannot locate V6 data/runner boundaries');
  src = src.slice(0,start) + `let candles = __DATA;\nlet closed = candles;\nlet c = closed.at(-1);\nconst age = 0;\n` + src.slice(agg, runner);
  src += '\nthis.__v6 = { analyze, setData: (d)=>{ candles=d; closed=d; c=d.at(-1); } };';
  const context = { require, process:{env:{}}, __DATA:initialData };
  vm.createContext(context);
  vm.runInContext(src, context, {filename:'server_v6.js'});
  return { analyze: context.__v6.analyze, setData: context.__v6.setData };
}

function simulate(d, engine, start=300) {
  const trades=[]; let i=start, signals=0;
  while(i<d.length-20){
    engine.setData(d.slice(0,i+1));
    const sig=engine.analyze();
    if(!sig){i++;continue;}
    signals++;
    const entry=d[i+1]?.open, risk=Math.abs(entry-sig.sl);
    if(!(risk>0)){i++;continue;}
    const tp2=entry + (sig.direction==='BUY'?2*risk:-2*risk);
    let outcome='OPEN', exit=d.at(-1).close, bars=0;
    for(let j=i+1;j<d.length;j++){
      bars++; const x=d[j];
      if(sig.direction==='BUY') {
        if(x.low<=sig.sl){outcome='SL';exit=sig.sl;break;}
        if(x.high>=tp2){outcome='TP2';exit=tp2;break;}
      } else {
        if(x.high>=sig.sl){outcome='SL';exit=sig.sl;break;}
        if(x.low<=tp2){outcome='TP2';exit=tp2;break;}
      }
    }
    if(outcome==='OPEN') break;
    const R=sig.direction==='BUY'?(exit-entry)/risk:(entry-exit)/risk;
    trades.push({signalTime:new Date(sig.candleTime).toISOString(),direction:sig.direction,setup:sig.setup,score:sig.score,signalEntry:+sig.entry.toFixed(3),executedEntry:+entry.toFixed(3),sl:+sig.sl.toFixed(3),tp1:+sig.tp1.toFixed(3),tp2:+sig.tp2.toFixed(3),h4:sig.h4,h1:sig.h1,m15:sig.m15,bos:sig.bos,mss:sig.mss,sweep:sig.sweep,displacement:sig.displacement,ob:Boolean(sig.ob),fvg:Boolean(sig.fvg),fib:sig.fib?.level??null,outcome,R:+R.toFixed(3),bars});
    i += Math.max(1,bars);
  }
  const wins=trades.filter(x=>x.R>0), losses=trades.filter(x=>x.R<0);
  const netR=trades.reduce((a,x)=>a+x.R,0), grossWin=wins.reduce((a,x)=>a+x.R,0), grossLoss=Math.abs(losses.reduce((a,x)=>a+x.R,0));
  let eq=0,peak=0,maxDD=0; for(const t of trades){eq+=t.R;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq);}
  return {signals,trades:trades.length,wins:wins.length,losses:losses.length,winRate:+(trades.length?wins.length/trades.length:0).toFixed(4),netR:+netR.toFixed(3),profitFactor:+(grossWin/(grossLoss||1)).toFixed(3),maxDrawdownR:+maxDD.toFixed(3),avgR:+(netR/(trades.length||1)).toFixed(3),details:trades};
}

(async()=>{try{
  const days=180;
  const d=await loadData(days);
  if(d.length<1000) throw Error(`Insufficient XAUUSD M5 candles: ${d.length}`);
  const engine=loadV6Analyze(d.slice(0,1200));
  const result=simulate(d, engine, 300);
  const out={source:'Dukascopy XAUUSD spot M5',days,candles:d.length,periodStart:d[0].time,periodEnd:d.at(-1).time,logicSource:'server_v6.js production analyze() loaded directly; no reconstructed strategy',execution:'closed M5 signal; next M5 open entry; unchanged V6 SL; TP2=2R; one position at a time',result};
  fs.writeFileSync('backtest/exact_v6_result.json',JSON.stringify(out,null,2));
  console.log(JSON.stringify({...out,result:{...result,details:undefined}},null,2));
  console.log('\nTRADE_DETAILS');
  for(const t of result.details) console.log(JSON.stringify(t));
}catch(e){console.error(e.stack||e);process.exit(1)}})();