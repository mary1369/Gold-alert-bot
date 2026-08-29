const fs = require('fs');

function fail(message) {
  console.error(`SAFETY GATE FAIL: ${message}`);
  process.exit(1);
}
function load(path) {
  if (!fs.existsSync(path)) fail(`missing ${path}`);
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { fail(`invalid JSON in ${path}`); }
}
function aggregate(d, minutes) {
  const step = minutes * 60000;
  const out = [];
  for (const c of d) {
    if (![c.time,c.open,c.high,c.low,c.close].every(Number.isFinite)) continue;
    const t = Math.floor(c.time / step) * step;
    let x = out.at(-1);
    if (!x || x.time !== t) out.push({time:t,open:c.open,high:c.high,low:c.low,close:c.close});
    else { x.high=Math.max(x.high,c.high); x.low=Math.min(x.low,c.low); x.close=c.close; }
  }
  return out;
}

const candles = load('xauusd_m5.json');
if (!Array.isArray(candles) || candles.length < 300) fail('insufficient closed M5 history');
for (const c of candles) {
  if (!Number.isFinite(c.time) || !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)) fail('invalid candle detected');
}
const m5 = candles.slice().sort((a,b)=>a.time-b.time);
for (let i=1;i<m5.length;i++) if (m5[i].time <= m5[i-1].time) fail('duplicate/non-monotonic candle timestamps');
const h1 = aggregate(m5,60), h4 = aggregate(m5,240);
if (h1.length < 50) fail(`only ${h1.length} H1 bars`);
if (h4.length < 20) fail(`only ${h4.length} H4 bars`);

const of = load('orderflow.json');
if (!of || typeof of !== 'object') fail('Order Flow object missing');
if (String(of.source || '').toLowerCase() !== 'mt5') fail('Order Flow source is not MT5; synthetic/non-MT5 flow is blocked');
if (!Number.isFinite(Number(of.delta))) fail('real MT5 delta is missing');
if (!Number.isFinite(Number(of.cvdSlope))) fail('real MT5 CVD slope is missing');
if (!of.time) fail('Order Flow timestamp missing');
const ofTime = Date.parse(of.time);
if (!Number.isFinite(ofTime)) fail('invalid Order Flow timestamp');
if (Math.abs(Date.now() - ofTime) > 10 * 60 * 1000) fail('Order Flow data is stale (>10 minutes)');

console.log(`SAFETY GATE PASS | M5=${m5.length} H1=${h1.length} H4=${h4.length} | MT5 Order Flow fresh`);
