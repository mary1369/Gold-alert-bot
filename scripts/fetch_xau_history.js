const fs = require('fs');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const SYMBOL = 'XAUUSD=X';

function toBarsFromYahoo(j) {
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (!Number.isFinite(ts[i])) continue;
    const open = Number(q.open?.[i]);
    const high = Number(q.high?.[i]);
    const low = Number(q.low?.[i]);
    const close = Number(q.close?.[i]);
    const volume = Number(q.volume?.[i] ?? 0) || 0;
    if (![open, high, low, close].every(Number.isFinite)) continue;
    out.push({ openTime: new Date(ts[i] * 1000).toISOString(), open, high, low, close, volume });
  }
  return out;
}

async function fetchYahoo() {
  // Yahoo supports intraday 5m history for recent periods. Ten days gives
  // substantially more M5 history than V4 needs for H1/H4 construction.
  const period1 = Math.floor((NOW - 10 * DAY) / 1000);
  const period2 = Math.floor(NOW / 1000);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}`);
  url.searchParams.set('period1', String(period1));
  url.searchParams.set('period2', String(period2));
  url.searchParams.set('interval', '5m');
  url.searchParams.set('events', 'history');
  url.searchParams.set('includePrePost', 'true');

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 Gold-alert-bot/4.0'
    }
  });
  if (!res.ok) throw new Error(`Yahoo history HTTP ${res.status}`);
  const j = await res.json();
  const bars = toBarsFromYahoo(j);
  if (bars.length < 500) throw new Error(`Yahoo history returned only ${bars.length} usable M5 bars`);
  return bars;
}

async function fetchBiquote() {
  // Fallback only. Some spot-data endpoints cap a single request, so use
  // multiple windows and merge them rather than assuming one call is enough.
  const windows = [
    [NOW - 3 * DAY, NOW],
    [NOW - 6 * DAY, NOW - 3 * DAY],
    [NOW - 9 * DAY, NOW - 6 * DAY]
  ];
  const all = [];
  for (const [from, to] of windows) {
    const url = new URL('https://biquote.io/api/XAUUSD/ohlc');
    url.searchParams.set('interval', '5m');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('from', new Date(from).toISOString());
    url.searchParams.set('to', new Date(to).toISOString());
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Gold-alert-bot/4.0' } });
    if (!res.ok) throw new Error(`biquote history HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j?.bars)) throw new Error('biquote history: missing bars array');
    all.push(...j.bars);
  }
  return all;
}

(async () => {
  let bars;
  try {
    bars = await fetchYahoo();
    console.log(`Fetched ${bars.length} XAUUSD M5 bars from Yahoo history`);
  } catch (err) {
    console.warn(`Yahoo history unavailable: ${err.message}`);
    bars = await fetchBiquote();
    console.log(`Fetched ${bars.length} raw XAUUSD M5 bars from biquote fallback`);
  }

  const unique = new Map();
  for (const b of bars) {
    const key = b?.openTime;
    if (!key) continue;
    unique.set(key, b);
  }
  const merged = [...unique.values()]
    .sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));

  if (merged.length < 500) {
    throw new Error(`Insufficient XAUUSD M5 history: ${merged.length} bars; need at least 500`);
  }

  fs.writeFileSync('/tmp/xau.json', JSON.stringify({ symbol: 'XAUUSD', interval: '5m', bars: merged }));
  console.log(`Merged ${merged.length} unique raw XAUUSD M5 bars`);
})();
