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

const out = bars.filter((b, i) => i === 0 || b.time > bars[i - 1].time);

// V4 needs enough M5 history to build its higher timeframes reliably.
// 50 H1 candles require about 600 M5 bars; 20 H4 candles require about 960.
// Keep a wider buffer so gaps/weekends do not silently starve the engine.
const MIN_M5 = 1200;
if (out.length < MIN_M5) {
  throw new Error(`Insufficient closed XAUUSD M5 history: ${out.length} bars (minimum ${MIN_M5})`);
}

// Keep the newest history while retaining enough bars for H1/H4 structure.
const trimmed = out.slice(-3000);
fs.writeFileSync('xauusd_m5.json', JSON.stringify(trimmed, null, 2));
console.log(`Loaded ${trimmed.length} unique closed XAUUSD M5 bars`);
