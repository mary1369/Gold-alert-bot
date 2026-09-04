const { normalizeOrderFlow } = require('./schema');

function validateOrderFlow(x, nowMs = Date.now()) {
  const n = normalizeOrderFlow(x);
  if (!n) return { valid: false, reason: 'schema' };
  const t = Date.parse(n.timestamp);
  if (Math.abs(nowMs - t) > 120000) return { valid: false, reason: 'stale' };
  return { valid: true, reason: 'ok', data: n };
}

module.exports = { validateOrderFlow };

if (require.main === module) {
  const sample = {
    timestamp: new Date().toISOString(), source: 'MT5:XAUUSD', symbol: 'XAUUSD', isReal: true,
    delta: 10, cvd: 100, buyVolume: 60, sellVolume: 50, imbalance: 0.0909,
    absorption: 0.0909, absorptionMode: 'tick_heuristic'
  };
  console.log(JSON.stringify(validateOrderFlow(sample)));
}
