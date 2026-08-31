const fs = require('fs');
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

async function fetchDukascopy() {
  const from = new Date(NOW - 14 * DAY);
  const to = new Date(NOW);
  const data = await getHistoricalRates({
    instrument: 'xauusd', dates: { from, to }, timeframe: 'm5', priceType: 'bid',
    format: 'array', volumes: true, ignoreFlats: true, batchSize: 10, pauseBetweenBatchesMs: 500
  });
  const rows = Array.isArray(data) ? data : data?.data;
  const bars = normalizeRows(rows);
  if (bars.length < MIN_M5) throw new Error(`Dukascopy returned only ${bars.length} usable M5 bars`);
  return bars;
}

(async () => {
  const bars = await fetchDukascopy();
  const unique = new Map();
  for (const b of bars) unique.set(b.openTime, b);
  const merged = [...unique.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
  if (merged.length < MIN_M5) throw new Error(`Insufficient closed XAUUSD M5 history: ${merged.length}`);

  const latest = Date.parse(merged.at(-1).openTime);
  const age = NOW - latest;
  console.log(`Fetched ${merged.length} XAUUSD M5 bars from Dukascopy`);
  console.log(`Latest M5 candle UTC: ${new Date(latest).toISOString()} | age=${Math.round(age / 60000)}m`);
  if (age < 0 || age > MAX_AGE_MS) {
    throw new Error(`STALE XAUUSD M5 DATA: latest=${new Date(latest).toISOString()} age=${Math.round(age / 60000)}m; refusing to publish stale data`);
  }

  fs.writeFileSync('/tmp/xau.json', JSON.stringify({ symbol: 'XAUUSD', interval: '5m', bars: merged }));
  console.log(`Merged ${merged.length} unique fresh XAUUSD M5 bars`);
})();