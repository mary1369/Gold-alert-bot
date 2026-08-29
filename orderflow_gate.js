const fs = require('fs');
const { spawnSync } = require('child_process');
const FILE = './orderflow.json';
const MAX_AGE_MS = 90 * 1000;
function stop(reason){ console.log(`ORDERFLOW GATE: NO TRADE — ${reason}`); process.exit(0); }
if(!fs.existsSync(FILE)) stop('orderflow.json missing; waiting for real MT5 flow');
let x; try{x=JSON.parse(fs.readFileSync(FILE,'utf8'));}catch{stop('invalid orderflow.json');}
if(!x || typeof x!=='object') stop('invalid order-flow object');
if(String(x.source||'').toUpperCase()!=='MT5') stop('source is not MT5');
const t=Date.parse(x.time||'');
if(!Number.isFinite(t)) stop('missing/invalid timestamp');
if(Date.now()-t>MAX_AGE_MS) stop('order-flow data is stale');
if(!Number.isFinite(Number(x.delta))) stop('delta missing');
if(!Number.isFinite(Number(x.cvdSlope))) stop('cvdSlope missing');
const imbalance=String(x.imbalance||'').toUpperCase();
const allowed=new Set(['BUY','SELL','BULLISH','BEARISH','NEUTRAL','BUY_IMBALANCE','SELL_IMBALANCE']);
if(!allowed.has(imbalance)) stop('invalid imbalance');
console.log(`ORDERFLOW GATE: PASS — fresh MT5 flow (${Math.round((Date.now()-t)/1000)}s)`);
const r=spawnSync(process.execPath,['server_v3.js'],{stdio:'inherit',env:process.env});
process.exit(r.status==null?1:r.status);
