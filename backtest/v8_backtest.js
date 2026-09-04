const fs = require('fs');
const { getHistoricalRates } = require('dukascopy-node');
const { analyzeV8 } = require('../strategy_v8');

async function load() {
  const to = new Date();
  const from = new Date(to.getTime() - 45 * 86400000);
  const raw = await getHistoricalRates({ instrument: 'xauusd', dates: { from, to }, timeframe: 'm5', format: 'json' });
  return raw.map(x => ({ time: +x.timestamp, open: +x.open, high: +x.high, low: +x.low, close: +x.close }))
    .filter(x => Object.values(x).every(Number.isFinite)).sort((a, b) => a.time - b.time);
}

function simulate(d, start, end) {
  const trades = [];
  let i = start;
  while (i < end - 1) {
    // Exact live decision point: only candles through i are visible.
    const sig = analyzeV8(d.slice(0, i + 1));
    if (!sig) { i++; continue; }
    // Signal is known at close i; execution is the next candle open.
    const entryBar = d[i + 1], entry = entryBar.open, risk = Math.abs(entry - sig.sl);
    if (!(risk > 0) || !Number.isFinite(entry)) { i++; continue; }
    const tp1 = sig.direction === 'BUY' ? entry + risk : entry - risk;
    const tp2 = sig.direction === 'BUY' ? entry + 2 * risk : entry - 2 * risk;
    const tp3 = sig.direction === 'BUY' ? entry + 3 * risk : entry - 3 * risk;
    let outcome = 'OPEN', exit = d[end - 1].close, exitIndex = end - 1;
    for (let j = i + 1; j < end; j++) {
      const c = d[j];
      if (sig.direction === 'BUY') {
        // Conservative ambiguity rule: if SL and TP are both touched, SL wins.
        if (c.low <= sig.sl) { outcome = 'SL'; exit = sig.sl; exitIndex = j; break; }
        if (c.high >= tp3) { outcome = 'TP3'; exit = tp3; exitIndex = j; break; }
        if (c.high >= tp2) { outcome = 'TP2'; exit = tp2; exitIndex = j; break; }
        if (c.high >= tp1) { outcome = 'TP1'; exit = tp1; exitIndex = j; break; }
      } else {
        if (c.high >= sig.sl) { outcome = 'SL'; exit = sig.sl; exitIndex = j; break; }
        if (c.low <= tp3) { outcome = 'TP3'; exit = tp3; exitIndex = j; break; }
        if (c.low <= tp2) { outcome = 'TP2'; exit = tp2; exitIndex = j; break; }
        if (c.low <= tp1) { outcome = 'TP1'; exit = tp1; exitIndex = j; break; }
      }
    }
    if (outcome === 'OPEN') break;
    const R = sig.direction === 'BUY' ? (exit - entry) / risk : (entry - exit) / risk;
    trades.push({ signalIndex: i, signalTime: sig.candleTime, entryIndex: i + 1, entryTime: entryBar.time,
      exitIndex, exitTime: d[exitIndex].time, direction: sig.direction, signalEntry: sig.entry,
      executedEntry: entry, sl: sig.sl, tp1, tp2, tp3, outcome, R: +R.toFixed(4), barsHeld: exitIndex - i,
      causal: sig.diagnostic?.causal === true, m15ClosedOnly: sig.diagnostic?.m15ClosedOnly === true });
    // One position at a time; no overlapping trades.
    i = exitIndex + 1;
  }
  const wins = trades.filter(t => t.R > 0), losses = trades.filter(t => t.R < 0);
  const netR = trades.reduce((a, t) => a + t.R, 0), grossWinR = wins.reduce((a, t) => a + t.R, 0);
  const grossLossR = Math.abs(losses.reduce((a, t) => a + t.R, 0));
  let equity = 0, peak = 0, maxDD = 0, losingStreak = 0, maxLosingStreak = 0;
  for (const t of trades) {
    equity += t.R; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity);
    if (t.R < 0) { losingStreak++; maxLosingStreak = Math.max(maxLosingStreak, losingStreak); } else losingStreak = 0;
  }
  return { trades: trades.length, wins: wins.length, losses: losses.length,
    winRatePct: +(100 * wins.length / (trades.length || 1)).toFixed(2), netR: +netR.toFixed(4),
    profitFactor: +(grossWinR / (grossLossR || 1)).toFixed(4), expectancyR: +(netR / (trades.length || 1)).toFixed(4),
    maxDrawdownR: +maxDD.toFixed(4), maxLosingStreak, allSignalsCausal: trades.every(t => t.causal && t.m15ClosedOnly), details: trades };
}

(async () => {
  try {
    const d = await load();
    if (d.length < 2500) throw new Error(`Insufficient candles: ${d.length}`);
    const cut = Math.floor(d.length * 2 / 3);
    const IS = simulate(d, 220, cut - 1), OOS = simulate(d, cut, d.length), ALL = simulate(d, 220, d.length);
    const out = { strategy: 'ICT-V8', execution: 'signal at close i; entry at open i+1',
      sameCandleRule: 'SL-first if SL and TP are both touched in the same candle',
      positionRule: 'one position at a time; next signal only after exit', source: 'Dukascopy XAUUSD M5',
      candles: d.length, periodStart: d[0].time, periodEnd: d.at(-1).time,
      split: 'first 2/3 IS; final 1/3 OOS; OOS untouched by rules', IS, OOS, ALL };
    fs.writeFileSync('backtest/v8_result.json', JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ ...out, IS: { ...IS, details: undefined }, OOS: { ...OOS, details: undefined }, ALL: { ...ALL, details: undefined } }, null, 2));
  } catch (e) { console.error(e.stack || e); process.exit(1); }
})();
