const fs = require('fs');
const { getHistoricalRates } = require('dukascopy-node');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const MIN_M5 = 1200;

function normalizeRows(rows) {
  return (rows || []).map((r) => {
    const ts = Number(r?.timestamp ?? r?.time ?? r?.[0]);
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
  // 14 calendar days gives a large safety buffer for weekends/data gaps.
  // dukascopy-node officially supports XAUUSD and M5 historical OHLC data.
  const from = new Date(NOW - 14 * DAY);
  const to = new Date(NOW);
  const data = await getHistoricalRates({
    instrument: 'xauusd',
    dates: { from, to },
    timeframe: 'm5',
    priceType: 'bid',
    format: 'array',
    volumes: true,
    ignoreFlats: true,
    batchSize: 10,
    pauseBetweenBatchesMs: 500
  });
  const rows = Array.isArray(data) ? data : data?.data;
  const bars = normalizeRows(rows);
  if (bars.length < MIN_M5) throw new Error(`Dukascopy returned only ${bars.length} usable M5 bars`);
  return bars;
}

(async () => {
  let bars;
  try {
    bars = await fetchDukascopy();
    console.log(`Fetched ${bars.length} XAUUSD M5 bars from Dukascopy`);
  } catch (err) {
    // Do NOT silently fall back to the known-limited 289-bar Biquote feed.
    // A short history must never reach V4 and create false 'no setup' results.
    throw new Error(`XAUUSD history fetch failed: ${err.message}`);
  }

  const unique = new Map();
  for (const b of bars) unique.set(b.openTime, b);
  const merged = [...unique.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));

  if (merged.length < MIN_M5) {
    throw new Error(`Insufficient closed XAUUSD M5 history: ${merged.length} bars; need at least ${MIN_M5}`);
  }

  fs.writeFileSync('/tmp/xau.json', JSON.stringify({ symbol: 'XAUUSD', interval: '5m', bars: merged }));
  console.log(`Merged ${merged.length} unique closed XAUUSD M5 bars`);
})();
