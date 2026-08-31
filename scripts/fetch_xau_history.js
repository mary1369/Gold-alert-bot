const fs = require('fs');
const { getHistoricalRates } = require('dukascopy-node');

const DAY = 24 * 60 * 60 * 1000;
const M5 = 5 * 60 * 1000;
const NOW = Date.now();
const MIN_M5 = 1200;
const MAX_AGE_MS = 20 * 60 * 1000;

function ts(v) {
  if (typeof v === 'string') {
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return n < 1e11 ? n * 1000 : n;
}

function normalizeRows(rows) {
  return (rows || []).map((r) => {
    const t = ts(r?.timestamp ?? r?.time ?? r?.openTime ?? r?.[0]);
    const open = Number(r?.open ?? r?.[1]);
    const high = Number(r?.high ?? r?.[2]);
    const low = Number(r?.low ?? r?.[3]);
    const close = Number(r?.close ?? r?.[4]);
    const volume = Number(r?.volume ?? r?.tickVolume ?? r?.[5] ?? 0) || 0;
    const isOpen = r?.isOpen === true || r?.isOpen === 1 || r?.isOpen === 'true';
    if (!Number.isFinite(t) || ![open, high, low, close].every(Number.isFinite)) return null;
    return { openTime: new Date(t).toISOString(), open, high, low, close, volume, isOpen };
  }).filter(Boolean);
}

function unique(rows) {
  const m = new Map();
  for (const b of rows || []) m.set(b.openTime, b);
  return [...m.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
}

function closed(rows) {
  const cutoff = Math.floor(NOW / M5) * M5 - M5;
  return unique(rows).filter((b) => Date.parse(b.openTime) <= cutoff && !b.isOpen);
}

function fresh(rows) {
  const x = closed(rows);
  if (x.length < MIN_M5) return false;
  const age = NOW - Date.parse(x.at(-1).openTime);
  return age >= 0 && age <= MAX_AGE_MS;
}

function loadCache() {
  try {
    const j = JSON.parse(fs.readFileSync('xauusd_m5.json', 'utf8'));
    const rows = Array.isArray(j) ? j : (j?.bars || []);
    const normalized = normalizeRows(rows);
    console.log(`Cached XAUUSD M5: ${normalized.length} rows`);
    return normalized;
  } catch (_) {
    console.log('No usable XAUUSD M5 cache found.');
    return [];
  }
}

async function biquoteLatest() {
  const url = 'https://biquote.io/api/XAUUSD/ohlc?interval=5m&limit=1000';
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Gold-alert-bot/1.0' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`BiQuote latest HTTP ${r.status}: ${text.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`BiQuote latest invalid JSON: ${e.message}`); }
  const rows = Array.isArray(j) ? j : (j?.bars || j?.data || j?.candles || j?.result || []);
  const bars = normalizeRows(rows);
  console.log(`BiQuote latest: raw=${rows.length || 0} parsed=${bars.length} closed=${closed(bars).length} latest=${bars.length ? bars.at(-1).openTime : 'none'}`);
  if (!bars.length) throw new Error('BiQuote returned no XAUUSD M5 bars');
  return bars;
}

async function dukascopyM5(days) {
  const data = await getHistoricalRates({
    instrument: 'xauusd',
    dates: { from: new Date(NOW - days * DAY), to: new Date(NOW - M5) },
    timeframe: 'm5',
    priceType: 'bid',
    format: 'array',
    volumes: true,
    ignoreFlats: false,
    batchSize: 1,
    pauseBetweenBatchesMs: 7000,
    retryCount: 1,
    pauseBetweenRetriesMs: 10000,
    retryOnEmpty: true,
    failAfterRetryCount: 1
  });
  return normalizeRows(Array.isArray(data) ? data : data?.data);
}

(async () => {
  let bars = loadCache();

  // The repository cache is intentionally part of the feed pipeline.  BiQuote
  // reliably provides the current M5 window, while the cache preserves older
  // closed bars between scheduled GitHub Actions runs.  This avoids depending
  // on an unstable third-party historical endpoint for every 5-minute run.
  try {
    const live = await biquoteLatest();
    bars = unique([...bars, ...live]);
    console.log(`Merged live BiQuote data with cache: ${closed(bars).length} closed bars`);
  } catch (e) {
    console.log(`BiQuote latest failed: ${e?.stack || e?.message || String(e)}`);
  }

  // Only use Dukascopy when the persisted cache + live refresh cannot satisfy
  // the minimum history.  It is never required for the normal path.
  if (!fresh(bars)) {
    for (const days of [2, 5, 10]) {
      try {
        const got = closed(await dukascopyM5(days));
        console.log(`Dukascopy M5 ${days}d: ${got.length}`);
        bars = unique([...bars, ...got]);
        if (fresh(bars)) break;
      } catch (e) {
        console.log(`Dukascopy M5 ${days}d failed: ${e?.stack || e?.message || String(e)}`);
      }
    }
  }

  bars = closed(bars);
  if (!fresh(bars)) {
    const latest = bars.length ? new Date(Date.parse(bars.at(-1).openTime)).toISOString() : 'none';
    throw new Error(`No fresh XAUUSD M5 feed: bars=${bars.length}, latest=${latest}`);
  }

  const out = bars.slice(-3000);
  fs.writeFileSync('/tmp/xau.json', JSON.stringify({ symbol: 'XAUUSD', interval: '5m', bars: out }));
  console.log(`Published ${out.length} unique fresh closed XAUUSD M5 bars; latest=${out.at(-1).openTime}`);
})().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
