const fs = require('fs');

const j = JSON.parse(fs.readFileSync('/tmp/xau.json', 'utf8'));
const z = j?.chart?.result?.[0];
const q = z?.indicators?.quote?.[0];
if (!z?.timestamp?.length || !q) throw new Error('Yahoo: missing XAUUSD 5m data');

const bars = [];
for (let i = 0; i < z.timestamp.length; i++) {
  const o = Number(q.open?.[i]);
  const h = Number(q.high?.[i]);
  const l = Number(q.low?.[i]);
  const c = Number(q.close?.[i]);
  const v = Number(q.volume?.[i]) || 0;
  if ([o, h, l, c].every(Number.isFinite)) {
    bars.push({ time: z.timestamp[i] * 1000, open: o, high: h, low: l, close: c, volume: v });
  }
}

const out = bars.filter((b, i) => i === 0 || b.time > bars[i - 1].time).slice(-1200);
if (out.length < 300) throw new Error(`Yahoo: only ${out.length} valid M5 bars`);
fs.writeFileSync('xauusd_m5.json', JSON.stringify(out, null, 2));
console.log(`Loaded ${out.length} valid XAUUSD M5 bars from Yahoo`);
