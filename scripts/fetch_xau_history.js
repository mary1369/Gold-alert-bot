const fs = require('fs');
const { getHistoricalRates, getRealTimeRates } = require('dukascopy-node');

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
    format: 'array', volumes: true, ignoreFlats: true, batchSize: 10,
    pauseBetweenBatchesMs: 500, retryCount: 2, pauseBetweenRetriesMs: 500,
    retryOnEmpty: true
  });
  return normalizeRows(Array.isArray(data) ? data : data?.data);
}

function ticksToM5(ticks) {
  const map = new Map();
  for (const t of ticks || []) {
    const ts = normalizeTimestamp(t?.timestamp ?? t?.time ?? t?.[0]);
    const price = Number(t?.bidPrice ?? t?.bid ?? t?.price ?? t?.[2]);
    if (!Number.isFinite(ts) || !Number.isFinite(price)) continue;
    const bucket = Math.floor(ts / 300000) * 300000;
    let c = map.get(bucket);
    if (!c) c = { openTime: new Date(bucket).toISOString(), open: price, high: price, low: price, close: price, volume: 0, isOpen: false };
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volume += 1;
    map.set(bucket, c);
  }
  return [...map.values()].sort((a,b) => Date.parse(a.openTime) - Date.parse(b.openTime));
}

async function fetchRealtimeTicks() {
  const data = await getRealTimeRates({ instrument: 'xauusd', timeframe: 'tick', format: 'json' });
  const ticks = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(ticks) || !ticks.length) throw new Error('Dukascopy real-time returned no ticks');
  return ticksToM5(ticks);
}

(async () => {
  let bars = [];
  try {
    bars = await fetchDukascopy();
    console.log(`Dukascopy returned ${bars.length} usable M5 bars`);
    if (!usableFresh(bars)) {
      const latest = bars.length ? Date.parse(bars.at(-1).openTime) : NaN;
      console.log(`Dukascopy historical stale: latest=${Number.isFinite(latest) ? new Date(latest).toISOString() : 'none'}`);
    }
  } catch (e) {
    console.log(`Dukascopy historical fetch failed: ${e.message}`);
  }

  if (!usableFresh(bars)) {
    console.log('Trying Dukascopy real-time tick fallback...');
    try {
      const realtime = await fetchRealtimeTicks();
      console.log(`Dukascopy real-time produced ${realtime.length} current M5 buckets`);
      if (realtime.length) {
        const firstRealtime = Date.parse(realtime[0].openTime);
        bars = [...bars.filter(b => Date.parse(b.openTime) < firstRealtime), ...realtime];
      }
    } catch (e) {
      console.log(`Dukascopy real-time fallback failed: ${e.message}`);
    }
  }

  const unique = new Map();
  for (const b of bars) unique.set(b.openTime, b);
  const merged = [...unique.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
  if (merged.length < MIN_M5) throw new Error(`Insufficient XAUUSD M5 history: ${merged.length}`);

  const latest = Date.parse(merged.at(-1).openTime);
  const age = NOW - latest;
  console.log(`Final XAUUSD M5 candle UTC: ${new Date(latest).toISOString()} | age=${Math.round(age / 60000)}m`);
  if (age < 0 || age > MAX_AGE_MS) throw new Error(`No fresh XAUUSD M5 feed: latest=${new Date(latest).toISOString()} age=${Math.round(age / 60000)}m`);

  fs.writeFileSync('/tmp/xau.json', JSON.stringify({ symbol: 'XAUUSD', interval: '5m', bars: merged }));
  console.log(`Published ${merged.length} unique fresh XAUUSD M5 bars`);
})();