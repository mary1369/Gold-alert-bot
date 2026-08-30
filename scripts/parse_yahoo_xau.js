const fs = require('fs');

const j = JSON.parse(fs.readFileSync('/tmp/xau.json', 'utf8'));
const raw = Array.isArray(j?.bars) ? j.bars : [];

const bars = raw
  .filter(b => !b?.isOpen)
  .map(b => ({
    time: Date.parse(b.openTime),
    open: Number(b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close),
    volume: Number(b.volume ?? b.tickVolume ?? 0) || 0
  }))
  .filter(b => Number.isFinite(b.time) && [b.open, b.high, b.low, b.close].every(Number.isFinite))
  .sort((a, b) => a.time - b.time);

const out = bars.filter((b, i) => i === 0 || b.time > bars[i - 1].time).slice(-1200);
if (out.length < 300) throw new Error(`biquote: only ${out.length} valid closed M5 bars`);

fs.writeFileSync('xauusd_m5.json', JSON.stringify(out, null, 2));
console.log(`Loaded ${out.length} valid closed XAUUSD M5 bars from biquote`);
