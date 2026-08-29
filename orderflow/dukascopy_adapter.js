// Free historical Order Flow adapter for XAUUSD research.
// Downloads Dukascopy tick data and derives a proxy Delta/CVD from tick direction.
// IMPORTANT: this is broker/exchange-feed-independent historical research data, NOT global spot XAUUSD order flow.
// No secrets are required. Live signal activation must remain disabled until feed validation.

const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Gold-alert-bot-research/1.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(Buffer.concat(chunks));
      });
    }).on('error', reject);
  });
}

// Intentionally exposes only research primitives. A caller must label output as proxy.
async function downloadTickArchive(url) {
  const data = await get(url);
  return data;
}

function classifyTick(previous, current) {
  if (!previous || !current) return 0;
  if (current > previous) return 1;
  if (current < previous) return -1;
  return 0;
}

function buildProxyFlow(ticks) {
  let delta = 0;
  const out = [];
  let previous = null;
  for (const tick of ticks) {
    const direction = classifyTick(previous, tick.price);
    const volume = Number.isFinite(tick.volume) ? tick.volume : 1;
    const signed = direction * volume;
    delta += signed;
    out.push({ timestamp: tick.timestamp, delta: signed, cvd: delta });
    previous = tick.price;
  }
  return { source: 'Dukascopy historical tick proxy', isReal: false, out };
}

module.exports = { downloadTickArchive, buildProxyFlow, classifyTick };
