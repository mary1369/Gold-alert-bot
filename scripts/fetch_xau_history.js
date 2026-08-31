const fs = require('fs');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const windows = [
  [now - 3 * DAY, now],
  [now - 6 * DAY, now - 3 * DAY]
];

async function fetchWindow(from, to) {
  const url = new URL('https://biquote.io/api/XAUUSD/ohlc');
  url.searchParams.set('interval', '5m');
  url.searchParams.set('limit', '1000');
  url.searchParams.set('from', new Date(from).toISOString());
  url.searchParams.set('to', new Date(to).toISOString());

  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Gold-alert-bot/1.0' } });
  if (!res.ok) throw new Error(`biquote history HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j?.bars)) throw new Error('biquote history: missing bars array');
  return j.bars;
}

(async () => {
  const all = [];
  for (const [from, to] of windows) {
    const bars = await fetchWindow(from, to);
    console.log(`Fetched ${bars.length} bars: ${new Date(from).toISOString()} -> ${new Date(to).toISOString()}`);
    all.push(...bars);
  }

  const unique = new Map();
  for (const b of all) {
    if (!b?.openTime) continue;
    unique.set(b.openTime, b);
  }

  const merged = [...unique.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
  fs.writeFileSync('/tmp/xau.json', JSON.stringify({ symbol: 'XAUUSD', interval: '5m', bars: merged }));
  console.log(`Merged ${merged.length} raw XAUUSD M5 bars`);
})();
