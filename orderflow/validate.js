function validateOrderFlow(x, nowMs = Date.now()) {
  if (!x || x.isReal !== true) return { valid: false, reason: 'not_real' };
  if (!x.source || typeof x.source !== 'string') return { valid: false, reason: 'missing_source' };
  const t = Date.parse(x.timestamp);
  if (!Number.isFinite(t)) return { valid: false, reason: 'bad_timestamp' };
  if (Math.abs(nowMs - t) > 120000) return { valid: false, reason: 'stale' };
  for (const k of ['delta','cvd','buyVolume','sellVolume','imbalance','absorption']) {
    if (!Number.isFinite(Number(x[k]))) return { valid: false, reason: `bad_${k}` };
  }
  return { valid: true, reason: 'ok' };
}

module.exports = { validateOrderFlow };

if (require.main === module) {
  const sample = { timestamp: new Date().toISOString(), source: 'TEST', isReal: true, delta: 10, cvd: 100, buyVolume: 60, sellVolume: 50, imbalance: 1.2, absorption: 0.3 };
  console.log(JSON.stringify(validateOrderFlow(sample)));
}
