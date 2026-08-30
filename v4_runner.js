const fs = require('fs');

// V4 runner: keep the analysis engine independent from unreliable external
// Yahoo/spot-price fallbacks. The workflow already refreshes xauusd_m5.json
// from biquote, so server_v4 receives a local, fresh candle source.
const candlesFile = './xauusd_m5.json';

function localCandles() {
  try {
    const d = JSON.parse(fs.readFileSync(candlesFile, 'utf8'));
    return Array.isArray(d) ? d.filter(c => c && Number.isFinite(Number(c.time)) && Number.isFinite(Number(c.open)) && Number.isFinite(Number(c.high)) && Number.isFinite(Number(c.low)) && Number.isFinite(Number(c.close))) : [];
  } catch {
    return [];
  }
}

const originalFetch = global.fetch;

global.fetch = async function(url, options) {
  const u = String(url);
  const d = localCandles();
  const latest = d.at(-1);

  // Replace the obsolete Yahoo candle fallback with the already refreshed
  // local biquote candles, in Yahoo's expected response shape.
  if (u.includes('query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X')) {
    const timestamps = d.map(c => Math.floor(Number(c.time) / 1000));
    const quote = {
      open: d.map(c => Number(c.open)),
      high: d.map(c => Number(c.high)),
      low: d.map(c => Number(c.low)),
      close: d.map(c => Number(c.close)),
      volume: d.map(c => Number(c.volume || 0))
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({ chart: { result: [{ timestamp: timestamps, indicators: { quote: [quote] } }] } })
    };
  }

  // Avoid an unnecessary second external price dependency. Use the latest
  // closed local XAUUSD candle as the current analysis price.
  if (u.includes('api.gold-api.com/price/XAU')) {
    if (!latest) return { ok: false, status: 503, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ price: Number(latest.close) })
    };
  }

  return originalFetch(url, options);
};

require('./server_v4.js');
