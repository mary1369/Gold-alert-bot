const fs = require('fs');
const { spawnSync } = require('child_process');
const FILE = './orderflow.json';
const MAX_AGE_MS = 90 * 1000;

function stop(reason) {
  console.log(`ORDERFLOW GATE: NO TRADE — ${reason}`);
  process.exit(0);
}

if (!fs.existsSync(FILE)) stop('orderflow.json missing; waiting for real MT5 flow');

let x;
try { x = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch { stop('invalid orderflow.json'); }
if (!x || typeof x !== 'object') stop('invalid order-flow object');
if (x.isReal !== true) stop('order-flow is not marked real');
if (!String(x.source || '').toUpperCase().startsWith('MT5')) stop('source is not MT5');

const rawTime = x.time || x.timestamp;
const t = Date.parse(rawTime || '');
if (!Number.isFinite(t)) stop('missing/invalid timestamp');
if (Date.now() - t > MAX_AGE_MS) stop('order-flow data is stale');
if (!Number.isFinite(Number(x.delta))) stop('delta missing');

// MT5 bridge publishes numeric imbalance and cumulative CVD.
// Convert the numeric imbalance to a direction and use the current delta
// as the short-interval CVD slope proxy; never fabricate a trade side.
const delta = Number(x.delta);
const numericImbalance = Number(x.imbalance);
let imbalance = String(x.imbalance || '').toUpperCase();
if (Number.isFinite(numericImbalance)) {
  imbalance = numericImbalance > 1 ? 'BUY' : numericImbalance < -1 ? 'SELL' : 'NEUTRAL';
}
const allowed = new Set(['BUY','SELL','BULLISH','BEARISH','NEUTRAL','BUY_IMBALANCE','SELL_IMBALANCE']);
if (!allowed.has(imbalance)) stop('invalid imbalance');

const normalized = {
  ...x,
  time: new Date(t).toISOString(),
  delta,
  cvdSlope: Number.isFinite(Number(x.cvdSlope)) ? Number(x.cvdSlope) : delta,
  imbalance,
  source: String(x.source || 'MT5'),
  isReal: true
};
fs.writeFileSync(FILE, JSON.stringify(normalized, null, 2));

console.log(`ORDERFLOW GATE: PASS — fresh real MT5 flow (${Math.round((Date.now() - t) / 1000)}s)`);
const r = spawnSync(process.execPath, ['server_v4.js'], { stdio: 'inherit', env: process.env });
process.exit(r.status == null ? 1 : r.status);
