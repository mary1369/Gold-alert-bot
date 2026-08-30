const fs = require('fs');
const { spawnSync } = require('child_process');
const FILE = './orderflow.json';
const MAX_AGE_MS = 90 * 1000;

function runAnalysis(reason) {
  if (reason) console.log(`ORDERFLOW: OPTIONAL — ${reason}; running price/SMC analysis without flow confirmation.`);
  const r = spawnSync(process.execPath, ['server_v4.js'], { stdio: 'inherit', env: process.env });
  process.exit(r.status == null ? 1 : r.status);
}

function disableStaleFile() {
  if (!fs.existsSync(FILE)) return;
  try { fs.renameSync(FILE, `${FILE}.stale`); }
  catch { try { fs.unlinkSync(FILE); } catch {} }
}

if (!fs.existsSync(FILE)) runAnalysis('no real MT5 order-flow file is available');

let x;
try { x = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch { disableStaleFile(); runAnalysis('invalid orderflow.json'); }

if (!x || typeof x !== 'object') { disableStaleFile(); runAnalysis('invalid order-flow object'); }
if (x.isReal !== true) { disableStaleFile(); runAnalysis('order-flow is not marked real'); }
if (!String(x.source || '').toUpperCase().startsWith('MT5')) { disableStaleFile(); runAnalysis('order-flow source is not MT5'); }

const rawTime = x.time || x.timestamp;
const t = Date.parse(rawTime || '');
if (!Number.isFinite(t)) { disableStaleFile(); runAnalysis('missing/invalid order-flow timestamp'); }
if (Date.now() - t > MAX_AGE_MS || t > Date.now() + 30000) { disableStaleFile(); runAnalysis('order-flow data is stale or from the future'); }
if (!Number.isFinite(Number(x.delta))) { disableStaleFile(); runAnalysis('order-flow delta is missing'); }

const delta = Number(x.delta);
const numericImbalance = Number(x.imbalance);
let imbalance = String(x.imbalance || '').toUpperCase();
if (Number.isFinite(numericImbalance)) imbalance = numericImbalance > 1 ? 'BUY' : numericImbalance < -1 ? 'SELL' : 'NEUTRAL';
const allowed = new Set(['BUY','SELL','BULLISH','BEARISH','NEUTRAL','BUY_IMBALANCE','SELL_IMBALANCE']);
if (!allowed.has(imbalance)) { disableStaleFile(); runAnalysis('invalid order-flow imbalance'); }

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
console.log(`ORDERFLOW: CONNECTED — fresh real MT5 flow (${Math.round((Date.now() - t) / 1000)}s)`);

const r = spawnSync(process.execPath, ['server_v4.js'], { stdio: 'inherit', env: process.env });
process.exit(r.status == null ? 1 : r.status);
