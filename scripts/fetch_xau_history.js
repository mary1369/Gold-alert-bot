const fs = require('fs');
const https = require('https');
const { getHistoricalRates } = require('dukascopy-node');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const MIN_M5 = 1200;
const MAX_AGE_MS = 20 * 60 * 1000;

function normalizeTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n < 1e11 ? n * 1000 : n;
}

function normalizeRows(rows) {
  return (rows || []).map((r) => {
    const ts = normalizeTimestamp(r?.timestamp ?? r?.time ?? r?.[0]);
    const open = Number(r?.open ?? r?.[1]);
    const high = Number(r?.high ?? r?.[2]);
    const low = Number(r?.low ?? r?.[3]);
    const close = Number(r?.close ?? r?.[4]);
    const volume = Number(r?.volume ?? r?.tickVolume ?? r?.[5] ?? 0) || 0;
    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
    return { openTime: new Date(ts).toISOString(), open, high, low, close, volume, isOpen: false };
  }).filter(Boolean);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

function usableFresh(bars) {
  if (bars.length < MIN_M5) return false;
  const latest = Date.parse(bars.at(-1).openTime);
  const age = NOW - latest;
  return age >= 0 && age <= MAX_AGE_MS;
}

async function fetchDukascopy() {
  const from = new Date(NOW - 14 * DAY);
  const to = new Date(NOW);
  const data = await getHistoricalRates({
    instrument: 'xauusd', dates: { from, to }, timeframe: 'm5', priceType: 'bid',
    format: 'array', volumes: true, ignoreFlats: true, batchSize: 10, pauseBetweenBatchesMs: 500
  });
  return normalizeRows(Array.isArray(data) ? data : data?.data);
}

async function fetchYahoo() {
  const period1 = Math.floor((NOW - 7 * DAY) / 1000);
  const period2 = Math.floor(NOW / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?period1=${period1}&period2=${period2}&interval=5m&includePrePost=true&events=history`;
  const j = await fetchJson(url);
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp?.length) throw new Error('Yahoo returned no XAUUSD M5 timestamps');
  const q = r.indicators?.quote?.[0] || {};
  const bars = r.timestamp.map((ts, i) => ({
    openTime: new Date(Number(ts) * 1000).toISOString(),
    open: Number(q.open?.[i]), high: Number(q.high?.[i]), low: Number(q.low?.[i]), close: Number(q.close?.[i]), volume: Number(q.volume?.[i] ?? 0) || 0, isOpen: false
  })).filter(b => [b.open,b.high,b.low,b.close].every(Number.isFinite));
  return bars;
}

(async () => {
  let bars = [];
  try {
    bars = await fetchDukascopy();
    console.log(`Dukascopy returned ${bars.length} usable M5 bars`);
    if (!usableFresh(bars)) {
      const latest = bars.length ? Date.parse(bars.at(-1).openTime) : NaN;
      console.log(`Dukascopy stale/unusable: latest=${Number.isFinite(latest) ? new Date(latest).toISOString() : 'none'}`);
      bars = [];
    }
  } catch (e) {
    console.log(`Dukascopy fetch failed: ${e.message}`);
  }

  if (!bars.length) {
    console.log('Trying Yahoo Finance XAUUSD=X 5m fallback...');
    bars = await fetchYahoo();
    if (!usableFresh(bars)) {
      const latest = bars.length ? Date.parse(bars.at(-1).openTime) : NaN;
      throw new Error(`No fresh XAUUSD M5 feed. Yahoo latest=${Number.isFinite(latest) ? new Date(latest).toISOString() : 'none'}`);
    }
    console.log(`Yahoo fallback returned ${bars.length} fresh XAUUSD M5 bars`);
  }

  const unique = new Map();
  for (const b of bars) unique.set(b.openTime, b);
  const merged = [...unique.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
  if (merged.length < MIN_M5) throw new Error(`Insufficient XAUUSD M5 history: ${merged.length}`);

  const latest = Date.parse(merged.at(-1).openTime);
  const age = NOW - latest;
  console.log(`Final XAUUSD M5 candle UTC: ${new Date(latest).toISOString()} | age=${Math.round(age / 60000)}m`);
  if (age < 0 || age > MAX_AGE_MS) throw new Error(`STALE XAUUSD M5 DATA: latest=${new Date(latest).toISOString()} age=${Math.round(age / 60000)}m`);

  fs.writeFileSync('/tmp/xau.json', JSON.stringify({ symbol: 'XAUUSD', interval: '5m', bars: merged }));
  console.log(`Published ${merged.length} unique fresh XAUUSD M5 bars`);
})();