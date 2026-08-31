const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function normalizeRows(rows) {
  const out = [];
  for (const r of rows || []) {
    const ts = Number(r?.timestamp ?? r?.time ?? r?.[0]);
    const open = Number(r?.open ?? r?.[1]);
    const high = Number(r?.high ?? r?.[2]);
    const low = Number(r?.low ?? r?.[3]);
    const close = Number(r?.close ?? r?.[4]);
    const volume = Number(r?.volume ?? r?.tickVolume ?? r?.[5] ?? 0) || 0;
    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) continue;
    out.push({
      openTime: new Date(ts).toISOString(),
      open, high, low, close, volume,
      isOpen: false
    });
  }
  return out;
}

function fetchDukascopy() {
  // Use a real historical XAUUSD feed instead of Yahoo's futures proxy.
  // Seven calendar days normally provide ~2,000 M5 bars, comfortably above
  // the V4 requirement for H1/H4 construction.
  const from = new Date(NOW - 7 * DAY).toISOString().slice(0, 10);
  const dir = '/tmp/dukascopy-xau';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  execFileSync('npx', [
    '--yes', 'dukascopy-node@1.50.0',
    '-i', 'xauusd',
    '-from', from,
    '-to', 'now',
    '-t', 'm5',
    '-f', 'json',
    '-dir', dir,
    '-fl'
  ], { stdio: 'inherit', timeout: 180000 });

  const files = fs.readdirSync(dir)
    .filter(f => /xauusd-.*-m5\.json$/i.test(f))
    .map(f => path.join(dir, f));
  if (!files.length) throw new Error('Dukascopy produced no XAUUSD M5 JSON file');

  // The downloader can create more than one artifact; merge all of them.
  const all = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    all.push(...normalizeRows(Array.isArray(parsed) ? parsed : parsed?.data));
  }
  return all;
}

async function fetchBiquote() {
  const url = new URL('https://biquote.io/api/XAUUSD/ohlc');
  url.searchParams.set('interval', '5m');
  url.searchParams.set('limit', '1000');
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Gold-alert-bot/4.0' } });
  if (!res.ok) throw new Error(`biquote history HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j?.bars)) throw new Error('biquote history: missing bars array');
  return j.bars.filter(b => !b?.isOpen).map(b => ({
    openTime: b.openTime,
    open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
    volume: Number(b.volume ?? b.tickVolume ?? 0) || 0,
    isOpen: false
  }));
}

(async () => {
  let bars;
  try {
    bars = fetchDukascopy();
    console.log(`Fetched ${bars.length} XAUUSD M5 bars from Dukascopy historical feed`);
  } catch (err) {
    console.warn(`Dukascopy history unavailable: ${err.message}`);
    bars = await fetchBiquote();
    console.log(`Fetched ${bars.length} XAUUSD M5 bars from biquote fallback`);
  }

  const unique = new Map();
  for (const b of bars) {
    if (!b?.openTime) continue;
    unique.set(b.openTime, b);
  }
  const merged = [...unique.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));

  if (merged.length < 1200) {
    throw new Error(`Insufficient XAUUSD M5 history: ${merged.length} bars; need at least 1200`);
  }

  fs.writeFileSync('/tmp/xau.json', JSON.stringify({ symbol: 'XAUUSD', interval: '5m', bars: merged }));
  console.log(`Merged ${merged.length} unique closed XAUUSD M5 bars`);
})();
