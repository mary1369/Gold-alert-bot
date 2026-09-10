// strategy_v71.js - Aggressive SMC Engine
function analyzeAggressiveSMC(candles) {
  if (!candles || candles.length < 4) return null;

  const c1 = candles[candles.length - 2];
  const c2 = candles[candles.length - 3];
  const c3 = candles[candles.length - 4];

  const minBuffer = 0.40; // فیلتر اسپرد طلا ($0.40)

  // 1. Bullish FVG + Sweep
  const isBullishFVG = c1.low > c3.high;
  const sweptSellSide = c2.low < c3.low || c1.low < c2.low;

  if (isBullishFVG && sweptSellSide) {
    const entry = c3.high;
    const sl = Math.min(c1.low, c2.low, c3.low) - minBuffer;
    const risk = entry - sl;

    if (risk > 0 && risk <= 4.0) {
      return {
        type: 'BUY_LIMIT',
        entryPrice: Number(entry.toFixed(2)),
        stopLoss: Number(sl.toFixed(2)),
        takeProfit: Number((entry + risk * 3).toFixed(2)),
        reason: 'Aggressive Bullish FVG + Sweep'
      };
    }
  }

  // 2. Bearish FVG + Sweep
  const isBearishFVG = c1.high < c3.low;
  const sweptBuySide = c2.high > c3.high || c1.high > c2.high;

  if (isBearishFVG && sweptBuySide) {
    const entry = c3.low;
    const sl = Math.max(c1.high, c2.high, c3.high) + minBuffer;
    const risk = sl - entry;

    if (risk > 0 && risk <= 4.0) {
      return {
        type: 'SELL_LIMIT',
        entryPrice: Number(entry.toFixed(2)),
        stopLoss: Number(sl.toFixed(2)),
        takeProfit: Number((entry - risk * 3).toFixed(2)),
        reason: 'Aggressive Bearish FVG + Sweep'
      };
    }
  }

  return null;
}

module.exports = { analyzeAggressiveSMC };
