const fs = require('fs');
const { spawnSync } = require('child_process');
const { validateOrderFlow } = require('./orderflow/validate');
const FILE = './orderflow.json';
const MAX_AGE_MS = 120 * 1000;

function runAnalysis(reason) {
  if (reason) console.log(`ORDERFLOW: OPTIONAL — ${reason}; running price/SMC analysis without flow confirmation.`);
  const r = spawnSync(process.execPath, ['v4_runner.js'], { stdio: 'inherit', env: process.env });
  process.exit(r.status == null ? 1 : r.status);
}
function disableStaleFile() {
  if (!fs.existsSync(FILE)) return;
  try { fs.renameSync(FILE, `${FILE}.stale`); } catch { try { fs.unlinkSync(FILE); } catch {} }
}
if (!fs.existsSync(FILE)) runAnalysis('no real MT5 order-flow file is available');
let x;
try { x = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { disableStaleFile(); runAnalysis('invalid orderflow.json'); }
const check = validateOrderFlow(x);
if (!check.valid) { disableStaleFile(); runAnalysis(`order-flow validation failed: ${check.reason}`); }

const t = Date.parse(x.timestamp);
if (Date.now() - t > MAX_AGE_MS || t > Date.now() + 30000) { disableStaleFile(); runAnalysis('order-flow data is stale or from the future'); }

const ratio = Number(x.imbalance);
let imbalance = 'NEUTRAL';
if (Number.isFinite(ratio)) {
  if (ratio >= 0.20) imbalance = 'BUY';
  else if (ratio <= -0.20) imbalance = 'SELL';
}
const normalized = {
  ...x,
  time: new Date(t).toISOString(),
  timestamp: new Date(t).toISOString(),
  delta: Number(x.delta),
  cvd: Number(x.cvd),
  cvdSlope: Number(x.delta),
  imbalanceRatio: ratio,
  imbalance,
  buyVolume: Number(x.buyVolume),
  sellVolume: Number(x.sellVolume),
  absorption: Number(x.absorption),
  source: String(x.source),
  isReal: true
};
fs.writeFileSync(FILE, JSON.stringify(normalized, null, 2));
console.log(`ORDERFLOW: CONNECTED — fresh real MT5 flow (${Math.round((Date.now() - t) / 1000)}s) imbalance=${imbalance} ratio=${ratio.toFixed(3)} delta=${normalized.delta.toFixed(4)}`);

const r = spawnSync(process.execPath, ['v4_runner.js'], { stdio: 'inherit', env: process.env });
process.exit(r.status == null ? 1 : r.status);
