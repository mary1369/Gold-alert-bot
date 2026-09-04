const FIELDS = ['delta', 'cvd', 'buyVolume', 'sellVolume', 'imbalance', 'absorption'];

function normalizeOrderFlow(x) {
  if (!x || typeof x !== 'object') return null;
  const timestamp = x.timestamp || x.time;
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
  if (x.isReal !== true) return null;
  if (!String(x.source || '').toUpperCase().startsWith('MT5')) return null;
  if (!String(x.symbol || '').toUpperCase().includes('XAUUSD')) return null;
  const out = { ...x, timestamp: new Date(timestamp).toISOString(), source: String(x.source), isReal: true };
  for (const k of FIELDS) {
    out[k] = Number(x[k]);
    if (!Number.isFinite(out[k])) return null;
  }
  if (out.imbalance < -1 || out.imbalance > 1) return null;
  out.absorptionMode = x.absorptionMode || 'unknown';
  out.dataClass = 'real_mt5_tick_feed';
  return out;
}

function alignToM5(timestampMs) {
  return Math.floor(timestampMs / 300000) * 300000;
}

module.exports = { FIELDS, normalizeOrderFlow, alignToM5 };
