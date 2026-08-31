const fs = require('fs');
const { getHistoricalRates } = require('dukascopy-node');

const DAY = 24 * 60 * 60 * 1000;
const M5 = 5 * 60 * 1000;
const NOW = Date.now();
const MIN_M5 = 1200;
const MAX_AGE_MS = 20 * 60 * 1000;
const CACHE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

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

function loadCachedBars() {
  try {
    if (!fs.existsSync('xauusd_m5.json')) return [];
    const raw = JSON.parse(fs.readFileSync('xauusd_m5.json', 'utf8'));
    return normalizeRows(raw);
  } catch (e) {
    console.log(`Cached XAUUSD history unavailable: ${e.message}`);
    return [];
  }
}

function uniqueSorted(bars) {
  const map = new Map();
  for (const b of bars || []) map.set(b.openTime, b);
  return [...map.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
}

function latestTime(bars) {
  return bars.length ? Date.parse(bars.at(-1).openTime) : NaN;
}

function isFresh(bars) {
  const latest = latestTime(bars);
  const age = NOW - latest;
  return bars.length >= MIN_M5 && age >= 0 && age <= MAX_AGE_MS;
}

async function fetchHistoricalM5(days, batchSize) {
  const from = new Date(NOW - days * DAY);
  const to = new Date(NOW - 5 * 60 * 1000);
  const data = await getHistoricalRates({
    instrument: 'xauusd', dates: { from, to }, timeframe: 'm5', priceType: 'bid',
    format: 'array', volumes: true, ignoreFlats: false, batchSize,
    pauseBetweenBatchesMs: 1500, retryCount: 2, pauseBetweenRetriesMs: 1500,
    retryOnEmpty: true
  });
  return normalizeRows(Array.isArray(data) ? data : data?.data);
}

async function fetchRecentHistoricalTicks(hours = 6) {
  const from = new Date(NOW - hours * 60 * 60 * 1000);
  const to = new Date(NOW);
  const data = await getHistoricalRates({
    instrument: 'xauusd', dates: { from, to }, timeframe: 'tick', priceType: 'bid',
    format: 'array', batchSize: 1, pauseBetweenBatchesMs: 2000,
    retryCount: 3, pauseBetweenRetriesMs: 2000, retryOnEmpty: true
  });
  return Array.isArray(data) ? data : data?.data;
}

function ticksToM5(ticks) {
  const map = new Map();
  for (const t of ticks || []) {
    const ts = normalizeTimestamp(t?.timestamp ?? t?.time ?? t?.[0]);
    const bid = Number(t?.bidPrice ?? t?.bid ?? t?.[2]);
    if (!Number.isFinite(ts) || !Number.isFinite(bid) || bid <= 0) continue;
    const bucket = Math.floor(ts / M5) * M5;
    let c = map.get(bucket);
    if (!c) c = { openTime: new Date(bucket).toISOString(), open: bid, high: bid, low: bid, close: bid, volume: 0, isOpen: false };
    c.high = Math.max(c.high, bid);
    c.low = Math.min(c.low, bid);
    c.close = bid;
    c.volume += 1;
    map.set(bucket, c);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
}

(async () => {
  let cached = loadCachedBars();
  let bars = [];
  console.log(`Cached XAUUSD M5 bars: ${cached.length}`);
  if (cached.length) {
    const age = Math.round((NOW - latestTime(cached)) / 60000);
    console.log(`Cached latest candle: ${new Date(latestTime(cached)).toISOString()} | age=${age}m`);
  }

  // Primary source: fresh Dukascopy historical M5.
  for (const [days, batch] of [[2, 1], [1, 1], [0.5, 1]]) {
    try {
      const fresh = uniqueSorted(await fetchHistoricalM5(days, batch));
      console.log(`Dukascopy historical ${days}d returned ${fresh.length} M5 bars`);
      if (fresh.length >= MIN_M5 && isFresh(fresh)) {
        bars = fresh;
        break;
      }
      if (fresh.length) bars = uniqueSorted([...bars, ...fresh]);
    } catch (e) {
      console.log(`Dukascopy historical ${days}d failed: ${e.message}`);
    }
  }

  // If the historical M5 endpoint is temporarily empty, keep cached history and
  // refresh only the recent edge from historical tick data. This avoids relying
  // on a desktop/MT5 Order Flow server and avoids inventing a candle from one quote.
  if (!isFresh(bars)) {
    console.log('Historical M5 is not fresh; refreshing recent edge from Dukascopy historical ticks...');
    try {
      const ticks = await fetchRecentHistoricalTicks(6);
      const recent = ticksToM5(ticks);
      console.log(`Historical tick refresh produced ${recent.length} M5 buckets`);
      if (recent.length) bars = uniqueSorted([...cached, ...bars, ...recent]);
    } catch (e) {
      console.log(`Historical tick refresh failed: ${e.message}`);
      bars = uniqueSorted([...cached, ...bars]);
    }
  }

  bars = uniqueSorted(bars);
  if (bars.length < MIN_M5) throw new Error(`Insufficient XAUUSD M5 history: ${bars.length}`);

  const latest = latestTime(bars);
  const age = NOW - latest;
  console.log(`Final XAUUSD M5 candle UTC: ${new Date(latest).toISOString()} | age=${Math.round(age / 60000)}m`);
  if (age < 0 || age > MAX_AGE_MS) {
    throw new Error(`No fresh XAUUSD M5 feed: latest=${new Date(latest).toISOString()} age=${Math.round(age / 60000)}m`);
  }

  fs.writeFileSync('/tmp/xau.json', JSON.stringify({ symbol: 'XAUUSD', interval: '5m', bars }));
  console.log(`Published ${bars.length} unique fresh XAUUSD M5 bars`);
})();