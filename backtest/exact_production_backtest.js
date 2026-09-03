const fs = require('fs');
const vm = require('vm');
const { getHistoricalRates } = require('dukascopy-node');

const FROM = new Date('2026-03-06T00:00:00.000Z');
const TO = new Date('2026-09-02T23:59:59.000Z');
const SPLIT = new Date('2026-07-06T14:05:00.000Z');

async function load() {
  const raw = await getHistoricalRates({ instrument: 'xauusd', dates: { from: FROM, to: TO }, timeframe: 'm5', format: 'json' });
  return raw.map(x => ({ time:+x.timestamp, open:+x.open, high:+x.high, low:+x.low, close:+x.close }))
    .filter(x => [x.time,x.open,x.high,x.low,x.close].every(Number.isFinite))
    .sort((a,b)=>a.time-b.time);
}

function loadProductionAnalyze() {
  const src = fs.readFileSync('server.js', 'utf8');
  const cut = src.indexOf('(async()=>{');
  if (cut < 0) throw new Error('Cannot locate production runner in server.js');
  const pure = src.slice(0, cut);
  const context = { require, process: { env: {} } };
  vm.createContext(context);
  vm.runInContext(pure + '\nthis.__production = { normalize, analyze };', context, { filename:'server.js' });
  return context.__production.analyze;
}

function entryReason(s) {
  const parts = [];
  if (s.bos) parts.push('BOS');
  if (s.sweep) parts.push('Liquidity Sweep');
  if (s.fvg) parts.push('FVG');
  if (s.ob) parts.push('Order Block');
  if (s.confirmation) parts.push('Candle Confirmation');
  if (s.displacement) parts.push('Displacement');
  if ((s.direction==='BUY'&&s.m15==='BULLISH')||(s.direction==='SELL'&&s.m15==='BEARISH')) parts.push('M15 Alignment');
  if (s.fibNear != null) parts.push(`Fib ${s.fibNear}`);
  return parts.join(' + ');
}

function outcomeReason(t) {
  if (t.outcome === 'TP2') return `TP2 reached before SL (${t.R}R)`;
  if (t.outcome === 'SL') return `SL reached before TP2 (-1R); entry setup factors: ${t.entryReason}`;
  return 'No exit before data end';
}

function simulate(d, analyze) {
  const trades = [];
  let i = 100;
  while (i < d.length - 10) {
    const sig = analyze(d.slice(0, i + 1));
    if (!sig) { i++; continue; }

    const entry = d[i + 1].open;
    const risk = Math.abs(entry - sig.sl);
    if (!(risk > 0)) { i++; continue; }

    const tp2 = sig.direction === 'BUY' ? entry + 2*risk : entry - 2*risk;
    let outcome='OPEN', exit=d.at(-1).close, bars=0, exitTime=d.at(-1).time;
    for (let j=i+1; j<d.length; j++) {
      bars++;
      const c=d[j];
      if (sig.direction==='BUY') {
        if (c.low<=sig.sl) { outcome='SL'; exit=sig.sl; exitTime=c.time; break; }
        if (c.high>=tp2) { outcome='TP2'; exit=tp2; exitTime=c.time; break; }
      } else {
        if (c.high>=sig.sl) { outcome='SL'; exit=sig.sl; exitTime=c.time; break; }
        if (c.low<=tp2) { outcome='TP2'; exit=tp2; exitTime=c.time; break; }
      }
    }
    if (outcome==='OPEN') break;

    const R = sig.direction==='BUY' ? (exit-entry)/risk : (entry-exit)/risk;
    const t = {
      time:sig.candleTime,
      signalTime:sig.candleTime,
      direction:sig.direction,
      entry,
      signalEntry:sig.entry,
      sl:sig.sl,
      tp1:entry + (sig.direction==='BUY'?risk:-risk),
      tp2,
      tp3:sig.tp3,
      score:sig.score,
      atr:sig.atr,
      rsi:sig.rsi,
      m15:sig.m15,
      structure:sig.structure,
      bos:sig.bos,
      sweep:sig.sweep,
      ob:sig.ob,
      fvg:sig.fvg,
      zone:sig.zone,
      retest:true,
      confirmation:sig.confirmation,
      displacement:sig.displacement,
      fibNear:sig.fibNear,
      entryReason:entryReason(sig),
      outcome,
      exit,
      exitTime,
      R:+R.toFixed(3),
      bars,
    };
    t.outcomeReason=outcomeReason(t);
    t.path = new Date(t.time) < SPLIT ? 'IS' : 'OOS';
    trades.push(t);
    i += Math.max(1,bars);
  }
  return trades;
}

function stats(trades) {
  const wins=trades.filter(x=>x.R>0), losses=trades.filter(x=>x.R<0);
  const netR=trades.reduce((a,x)=>a+x.R,0);
  const grossWin=wins.reduce((a,x)=>a+x.R,0);
  const grossLoss=Math.abs(losses.reduce((a,x)=>a+x.R,0));
  let eq=0,peak=0,maxDD=0,losing=0,maxLosing=0;
  for(const t of trades){
    eq+=t.R; peak=Math.max(peak,eq); maxDD=Math.max(maxDD,peak-eq);
    if(t.R<0){losing++;maxLosing=Math.max(maxLosing,losing)}else losing=0;
  }
  const buy=trades.filter(x=>x.direction==='BUY').length;
  const sell=trades.filter(x=>x.direction==='SELL').length;
  const reasons={};
  for(const t of trades) reasons[t.entryReason]=(reasons[t.entryReason]||0)+1;
  return {
    trades:trades.length,wins:wins.length,losses:losses.length,
    winRate:+(trades.length?wins.length/trades.length*100:0).toFixed(2),
    netR:+netR.toFixed(3),
    profitFactor:+(grossWin/(grossLoss||1)).toFixed(3),
    avgR:+(netR/(trades.length||1)).toFixed(3),
    maxDrawdownR:+maxDD.toFixed(3),
    maxLosingStreak:maxLosing,
    buy,sell,
    entryReasonCounts:reasons,
  };
}

(async()=>{
  try {
    const d=await load();
    if(d.length<1000) throw Error(`Insufficient XAUUSD M5 candles: ${d.length}`);
    const analyze=loadProductionAnalyze();
    const trades=simulate(d,analyze);
    const IS=trades.filter(t=>t.path==='IS');
    const OOS=trades.filter(t=>t.path==='OOS');
    const out={
      version:'EXACT-TELEGRAM-SERVERJS-IS-OOS-2026-09-03',
      source:'Dukascopy XAUUSD spot M5',
      candles:d.length,
      periodStart:new Date(d[0].time).toISOString(),
      periodEnd:new Date(d.at(-1).time).toISOString(),
      splitTime:SPLIT.toISOString(),
      serverSha:'afe78978c9234d26ff32aed91c68e792c0b320c9',
      logicSource:'server.js production analyze() loaded directly with vm; no reconstructed strategy',
      execution:'closed M5 signal; next M5 open entry; server.js SL unchanged; TP2=2R from executed entry; one position at a time; SL-first on same bar',
      IS:{...stats(IS),details:IS},
      OOS:{...stats(OOS),details:OOS},
      combined:{...stats(trades)},
    };
    fs.writeFileSync('backtest/exact_production_result.json',JSON.stringify(out,null,2));
    console.log(JSON.stringify({...out,IS:{...out.IS,details:undefined},OOS:{...out.OOS,details:undefined}},null,2));
  } catch(e) { console.error(e); process.exit(1); }
})();
