const fs = require('fs');
const path = require('path');
const { getHistoricalRates } = require('dukascopy-node');
const { analyzeV8At } = require('../strategy_v8');
const { normalizeOrderFlow, alignToM5 } = require('../orderflow/schema');

async function loadPrice() {
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 86400000);
  const raw = await getHistoricalRates({ instrument: 'xauusd', dates: { from, to }, timeframe: 'm5', format: 'json' });
  const d = raw.map(x => ({ time: +x.timestamp, open: +x.open, high: +x.high, low: +x.low, close: +x.close }))
    .filter(x => Object.values(x).every(Number.isFinite)).sort((a, b) => a.time - b.time);
  if (d.length < 2500) throw new Error(`Insufficient XAUUSD M5 candles: ${d.length}; refusing to manufacture a result`);
  return d;
}

function loadFlow(file) {
  if (!file || !fs.existsSync(file)) return null;
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return normalizeOrderFlow(JSON.parse(line)); } catch { return null; }
  }).filter(Boolean).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return rows.length ? rows : null;
}

function flowByCandle(rows) {
  const m = new Map();
  for (const x of rows || []) {
    const t = Date.parse(x.timestamp);
    const bucket = alignToM5(t);
    const prev = m.get(bucket);
    if (!prev) {
      m.set(bucket, { candleTime: bucket, delta: x.delta, buyVolume: x.buyVolume, sellVolume: x.sellVolume,
        imbalance: x.imbalance, absorption: x.absorption, cvd: x.cvd, snapshots: 1,
        firstCvd: x.cvd, lastTimestamp: t, absorptionMode: x.absorptionMode });
    } else if (t >= prev.lastTimestamp) {
      prev.delta += x.delta;
      prev.buyVolume += x.buyVolume;
      prev.sellVolume += x.sellVolume;
      prev.imbalance = (prev.buyVolume + prev.sellVolume) > 0 ? (prev.buyVolume - prev.sellVolume) / (prev.buyVolume + prev.sellVolume) : 0;
      prev.absorption = Math.max(prev.absorption, x.absorption);
      prev.cvd = x.cvd;
      prev.snapshots++;
      prev.lastTimestamp = t;
    }
  }
  return m;
}

function makeCostConfig() {
  const n = name => Number(process.env[name] || '');
  const spread = n('XAU_SPREAD');
  const slippage = n('XAU_SLIPPAGE');
  const commission = n('XAU_COMMISSION');
  if (![spread, slippage, commission].every(Number.isFinite) || spread < 0 || slippage < 0 || commission < 0)
    return null;
  return { spread, slippage, commission, totalRoundTrip: 2 * (spread / 2 + slippage) + commission };
}

function executeTrade(d, i, sig, end, costs) {
  if (i + 1 >= end) return null;
  const entryBar = d[i + 1];
  const side = sig.direction === 'BUY' ? 1 : -1;
  const halfSpread = costs.spread / 2;
  const entry = entryBar.open + side * (halfSpread + costs.slippage);
  const sl = sig.sl;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0) || !Number.isFinite(entry)) return null;
  const tp1 = entry + side * risk, tp2 = entry + side * 2 * risk, tp3 = entry + side * 3 * risk;
  let exit = d[end - 1].close, exitIndex = end - 1, outcome = 'OPEN', ambiguous = false;
  let hit1 = false, hit2 = false, hit3 = false;
  for (let j = i + 1; j < end; j++) {
    const c = d[j];
    if (side === 1) {
      hit1 ||= c.high >= tp1; hit2 ||= c.high >= tp2; hit3 ||= c.high >= tp3;
      const slHit = c.low <= sl, tpHit = c.high >= tp3;
      if (slHit && tpHit) { ambiguous = true; outcome = 'SL'; exit = sl; exitIndex = j; break; }
      if (slHit) { outcome = 'SL'; exit = sl; exitIndex = j; break; }
      if (tpHit) { outcome = 'TP3'; exit = tp3; exitIndex = j; break; }
      if (c.high >= tp2) { outcome = 'TP2'; exit = tp2; exitIndex = j; break; }
      if (c.high >= tp1) { outcome = 'TP1'; exit = tp1; exitIndex = j; break; }
    } else {
      hit1 ||= c.low <= tp1; hit2 ||= c.low <= tp2; hit3 ||= c.low <= tp3;
      const slHit = c.high >= sl, tpHit = c.low <= tp3;
      if (slHit && tpHit) { ambiguous = true; outcome = 'SL'; exit = sl; exitIndex = j; break; }
      if (slHit) { outcome = 'SL'; exit = sl; exitIndex = j; break; }
      if (tpHit) { outcome = 'TP3'; exit = tp3; exitIndex = j; break; }
      if (c.low <= tp2) { outcome = 'TP2'; exit = tp2; exitIndex = j; break; }
      if (c.low <= tp1) { outcome = 'TP1'; exit = tp1; exitIndex = j; break; }
    }
  }
  if (outcome === 'OPEN') return null; // unresolved at split/data end is censored, never counted as a fake win/loss
  const grossR = side * (exit - entry) / risk;
  const costR = costs.totalRoundTrip / risk;
  const netR = grossR - costR;
  return { signalIndex: i, signalTime: sig.candleTime, entryIndex: i + 1, entryTime: entryBar.time,
    exitIndex, exitTime: d[exitIndex].time, direction: sig.direction, signalEntry: sig.entry,
    executedEntry: entry, sl, tp1, tp2, tp3, risk, outcome, grossR: +grossR.toFixed(6), costR: +costR.toFixed(6),
    R: +netR.toFixed(6), barsHeld: exitIndex - i, durationMinutes: (d[exitIndex].time - entryBar.time) / 60000,
    hitTP1: hit1, hitTP2: hit2, hitTP3: hit3, ambiguousSLFirst: ambiguous,
    causal: sig.diagnostic?.causal === true, m15ClosedOnly: sig.diagnostic?.m15ClosedOnly === true };
}

function simulate(d, start, end, flowMap, useFlow, costs) {
  const trades = []; let i = start; let blockedByFlow = 0;
  while (i < end - 1) {
    const sig = analyzeV8At(d, i);
    if (!sig) { i++; continue; }
    if (useFlow) {
      const f = flowMap.get(d[i].time);
      const ok = f && f.snapshots > 0 && (sig.direction === 'BUY' ? f.delta > 0 && f.imbalance > 0 : f.delta < 0 && f.imbalance < 0);
      if (!ok) { blockedByFlow++; i++; continue; }
    }
    const t = executeTrade(d, i, sig, end, costs);
    if (!t) { i++; continue; }
    trades.push(t); i = t.exitIndex + 1;
  }
  return summarize(trades, blockedByFlow);
}

function summarize(trades, blockedByFlow = 0) {
  const wins = trades.filter(t => t.R > 0), losses = trades.filter(t => t.R < 0);
  const grossProfitR = wins.reduce((a,t) => a + t.R, 0), grossLossR = Math.abs(losses.reduce((a,t) => a + t.R, 0));
  const grossProfitBeforeCostR = trades.filter(t => t.grossR > 0).reduce((a,t) => a+t.grossR,0);
  const grossLossBeforeCostR = Math.abs(trades.filter(t => t.grossR < 0).reduce((a,t) => a+t.grossR,0));
  let eq=0, peak=0, dd=0, streak=0, maxStreak=0;
  for(const t of trades){eq+=t.R; peak=Math.max(peak,eq); dd=Math.max(dd,peak-eq); if(t.R<0){streak++;maxStreak=Math.max(maxStreak,streak)}else streak=0;}
  const avgDuration = trades.length ? trades.reduce((a,t)=>a+t.durationMinutes,0)/trades.length : 0;
  return { trades: trades.length, wins: wins.length, losses: losses.length, winRatePct: +(100*wins.length/(trades.length||1)).toFixed(2),
    averageR: +(trades.reduce((a,t)=>a+t.R,0)/(trades.length||1)).toFixed(6), expectancyR: +(trades.reduce((a,t)=>a+t.R,0)/(trades.length||1)).toFixed(6),
    profitFactor: +(grossProfitR/(grossLossR||1)).toFixed(6), grossProfitR:+grossProfitR.toFixed(6), grossLossR:+grossLossR.toFixed(6),
    grossProfitBeforeCostR:+grossProfitBeforeCostR.toFixed(6), grossLossBeforeCostR:+grossLossBeforeCostR.toFixed(6),
    maxDrawdownR:+dd.toFixed(6), maxConsecutiveLosses:maxStreak, averageTradeDurationMinutes:+avgDuration.toFixed(2),
    tp1Hits:trades.filter(t=>t.hitTP1).length, tp2Hits:trades.filter(t=>t.hitTP2).length, tp3Hits:trades.filter(t=>t.hitTP3).length,
    slFirstAmbiguousCandleCount:trades.filter(t=>t.ambiguousSLFirst).length, blockedByFlow, allSignalsCausal:trades.every(t=>t.causal&&t.m15ClosedOnly), details:trades };
}

function antiLookahead(d) {
  const checks=[]; const step=Math.max(1,Math.floor((d.length-260)/25));
  for(let i=220;i<d.length-1;i+=step){
    const a=analyzeV8At(d,i); const mutated=d.slice();
    for(let j=i+1;j<Math.min(d.length,i+6);j++) mutated[j]={...mutated[j],open:1e9,high:1e9,low:-1e9,close:1e9};
    const b=analyzeV8At(mutated,i);
    checks.push(JSON.stringify(a)===JSON.stringify(b));
  }
  if(!checks.length || !checks.every(Boolean)) throw new Error('ANTI-LOOKAHEAD FAILURE: future-candle mutation changed an as-of-i result');
  return { passed:true, samples:checks.length, rule:'analysis at i is computed from candles[0..i] only; future candles were mutated and did not change the result' };
}

(async()=>{
  try{
    const d=await loadPrice();
    const anti=antiLookahead(d);
    const cut=Math.floor(d.length*2/3);
    const flowFile=process.env.ORDERFLOW_HISTORY_FILE || path.resolve('orderflow_history.jsonl');
    const flowRows=loadFlow(flowFile); const flowMap=flowByCandle(flowRows);
    const zeroCosts={spread:0,slippage:0,commission:0,totalRoundTrip:0};
    const costCfg=makeCostConfig();
    const A_IS=simulate(d,220,cut,flowMap,false,zeroCosts), A_OOS=simulate(d,cut,d.length,flowMap,false,zeroCosts);
    const A_IS_COST=costCfg?simulate(d,220,cut,flowMap,false,costCfg):null, A_OOS_COST=costCfg?simulate(d,cut,d.length,flowMap,false,costCfg):null;
    const B_C=flowRows?{available:true,records:flowRows.length,candles:flowMap.size}: {available:false,reason:`Missing real MT5 historical flow at ${flowFile}`};
    const B_IS=B_C.available?simulate(d,220,cut,flowMap,true,zeroCosts):null, B_OOS=B_C.available?simulate(d,cut,d.length,flowMap,true,zeroCosts):null;
    const C_IS=B_C.available&&costCfg?simulate(d,220,cut,flowMap,true,costCfg):null, C_OOS=B_C.available&&costCfg?simulate(d,cut,d.length,flowMap,true,costCfg):null;
    const out={strategy:'ICT-V8',execution:'decision at close i; entry at open i+1; SL/TP fixed from signal SL and executed entry risk',sameCandleRule:'SL-first',overlap:'none',source:'Dukascopy XAUUSD M5 for price; MT5 tick feed required for B/C',candles:d.length,periodStart:d[0].time,periodEnd:d.at(-1).time,split:{method:'chronological 2/3 IS, final 1/3 OOS',cutIndex:cut},antiLookahead:anti,transactionCostConfig:costCfg||{status:'BLOCKED',reason:'Set XAU_SPREAD, XAU_SLIPPAGE, XAU_COMMISSION; no costs are guessed'},A:{IS:A_IS,OOS:A_OOS,withCosts:{IS:A_IS_COST,OOS:A_OOS_COST}},B:{flow:B_C,IS:B_IS,OOS:B_OOS},C:{flow:B_C,costsConfigured:!!costCfg,IS:C_IS,OOS:C_OOS}};
    fs.writeFileSync('backtest/v8_result.json',JSON.stringify(out,null,2));
    fs.writeFileSync('backtest/v8_trades.csv',csv(out));
    console.log(JSON.stringify({...out,A:{IS:{...A_IS,details:undefined},OOS:{...A_OOS,details:undefined},withCosts:{IS:A_IS_COST?{...A_IS_COST,details:undefined}:null,OOS:A_OOS_COST?{...A_OOS_COST,details:undefined}:null}},B:{flow:B_C,IS:B_IS?{...B_IS,details:undefined}:null,OOS:B_OOS?{...B_OOS,details:undefined}:null},C:{flow:B_C,costsConfigured:!!costCfg,IS:C_IS?{...C_IS,details:undefined}:null,OOS:C_OOS?{...C_OOS,details:undefined}:null}},null,2));
    if(!B_C.available) process.exitCode=2;
    if(B_C.available&&!costCfg) process.exitCode=3;
  }catch(e){console.error(e.stack||e);process.exitCode=1;}
})();

function csv(out){const all=[...(out.A.IS.details||[]),...(out.A.OOS.details||[]),...(out.B.IS?.details||[]),...(out.B.OOS?.details||[]),...(out.C.IS?.details||[]),...(out.C.OOS?.details||[])];if(!all.length)return 'no_trades\n';const keys=Object.keys(all[0]);return keys.join(',')+'\n'+all.map(x=>keys.map(k=>JSON.stringify(x[k]??'')).join(',')).join('\n')+'\n';}
