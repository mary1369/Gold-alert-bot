const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SYMBOL = 'XAUUSD';
const STATE_FILE = './state_v2.json';
const CANDLES_FILE = './xauusd_m5.json';
const ORDERFLOW_FILE = './orderflow.json';
const HISTORY_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=5m&range=5d';
const PRICE_API = 'https://api.gold-api.com/price/XAU';
const MIN_SCORE = 12;

function load(f, fallback) { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback; } catch { return fallback; } }
function save(f, x) { fs.writeFileSync(f, JSON.stringify(x, null, 2)); }
function num(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }
function fmt(ms) { return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC'); }
function r(x) { return num(x) == null ? '-' : Number(x).toFixed(2); }
function normalize(a) { return a.map(c => { const t = num(c.time ?? c.t); return { time: t * (t < 1e10 ? 1000 : 1), open: num(c.open ?? c.o), high: num(c.high ?? c.h), low: num(c.low ?? c.l), close: num(c.close ?? c.c), volume: num(c.volume ?? c.v) ?? 0 }; }).filter(c => c.time && c.open != null && c.high != null && c.low != null && c.close != null).sort((a,b) => a.time-b.time); }

async function fetchYahoo() {
  const res = await fetch(HISTORY_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw Error(`Yahoo HTTP ${res.status}`);
  const j = await res.json(), z = j?.chart?.result?.[0];
  if (!z?.timestamp?.length) throw Error('No XAUUSD historical candles');
  const q = z.indicators?.quote?.[0] || {}, a = [];
  for (let i=0; i<z.timestamp.length; i++) {
    const o=num(q.open?.[i]), h=num(q.high?.[i]), l=num(q.low?.[i]), c=num(q.close?.[i]), v=num(q.volume?.[i]) ?? 0;
    if (o!=null&&h!=null&&l!=null&&c!=null) a.push({time:z.timestamp[i]*1000,open:o,high:h,low:l,close:c,volume:v});
  }
  return normalize(a).slice(-1200);
}

async function fetchPrice() {
  const res = await fetch(PRICE_API, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw Error(`Price API HTTP ${res.status}`);
  const j = await res.json(), p=num(j.price ?? j?.data?.price ?? j?.result?.price);
  if (p==null) throw Error('No valid XAU price');
  return p;
}

function aggregate(d, minutes) {
  const step=minutes*60000, out=[];
  for (const c of d) {
    const t=Math.floor(c.time/step)*step; let x=out.at(-1);
    if (!x || x.time!==t) out.push({time:t,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume||0});
    else { x.high=Math.max(x.high,c.high); x.low=Math.min(x.low,c.low); x.close=c.close; x.volume+=(c.volume||0); }
  }
  return out;
}
function ema(d,len) { if(d.length<len)return null; const k=2/(len+1); let e=d[0].close; for(let i=1;i<d.length;i++)e+=(d[i].close-e)*k; return e; }
function atr(d,len=14) { if(d.length<len+1)return null; const t=[]; for(let i=1;i<d.length;i++)t.push(Math.max(d[i].high-d[i].low,Math.abs(d[i].high-d[i-1].close),Math.abs(d[i].low-d[i-1].close))); return t.slice(-len).reduce((a,b)=>a+b,0)/len; }
function swingHigh(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].high>=d[i].high)return false;return true;}
function swingLow(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].low<=d[i].low)return false;return true;}
function swings(d){const hs=[],ls=[];for(let i=2;i<d.length-2;i++){if(swingHigh(d,i))hs.push({i,p:d[i].high});if(swingLow(d,i))ls.push({i,p:d[i].low});}return{hs,ls};}
function structure(d){const {hs,ls}=swings(d);if(hs.length<3||ls.length<3)return null;const h1=hs.at(-2),h2=hs.at(-1),l1=ls.at(-2),l2=ls.at(-1);return{trend:h2.p>h1.p&&l2.p>l1.p?'BULLISH':h2.p<h1.p&&l2.p<l1.p?'BEARISH':'RANGE',h1,h2,l1,l2};}
function bias(d){const s=structure(d);if(!s)return'UNKNOWN';const e20=ema(d,20),e50=ema(d,50),c=d.at(-1).close;return s.trend==='BULLISH'&&c>e20&&e20>e50?'BULLISH':s.trend==='BEARISH'&&c<e20&&e20<e50?'BEARISH':s.trend;}
function bos(d,s,dir){const level=dir==='BUY'?s.h2.p:s.l2.p;return d.slice(-8).some(c=>dir==='BUY'?c.close>level:c.close<level);}
function sweep(c,s,dir){return dir==='BUY'?c.low<s.l2.p&&c.close>s.l2.p:c.high>s.h2.p&&c.close<s.h2.p;}
function mss(d,s,dir){const look=d.slice(-10);if(look.length<5)return false;const mid=look.slice(0,-2);const hi=Math.max(...mid.map(c=>c.high)),lo=Math.min(...mid.map(c=>c.low)),last=d.at(-1);return dir==='BUY'?last.close>hi:last.close<lo;}
function displacement(c,a,dir){const range=Math.max(c.high-c.low,1e-9),body=Math.abs(c.close-c.open);return range>=a*.8&&body/range>=.5&&(dir==='BUY'?c.close>c.open:c.close<c.open);}
function zone(d,dir){for(let i=d.length-2;i>=Math.max(1,d.length-80);i--){const c=d[i];if(dir==='BUY'&&c.close<c.open)return{low:c.low,high:c.high,type:'BULLISH OB'};if(dir==='SELL'&&c.close>c.open)return{low:c.low,high:c.high,type:'BEARISH OB'};}return null;}
function fvg(d,dir){for(let i=d.length-1;i>=Math.max(2,d.length-80);i--){const a=d[i-2],c=d[i];if(dir==='BUY'&&c.low>a.high)return{low:a.high,high:c.low,type:'BULLISH FVG'};if(dir==='SELL'&&c.high<a.low)return{low:c.high,high:a.low,type:'BEARISH FVG'};}return null;}

// Complete Fibonacci framework used by the signal engine.
// Retracement: 0, 0.236, 0.382, 0.500, 0.618, 0.650, 0.705, 0.786, 0.886, 1.000
// Extensions: 1.272, 1.414, 1.618, 2.000, 2.618, 3.618, 4.236
const FIB_RETRACEMENTS = [0, .236, .382, .5, .618, .65, .705, .786, .886, 1];
const FIB_EXTENSIONS = [1.272, 1.414, 1.618, 2, 2.618, 3.618, 4.236];
const FIB_ENTRY_LEVELS = [.618, .65, .705, .786, .886];

function fib(d,dir){
  const s=structure(d); if(!s)return null;
  const hi=s.h2.p, lo=s.l2.p, range=hi-lo; if(range<=0)return null;
  const levels={};
  for(const x of FIB_RETRACEMENTS) levels[x]=dir==='BUY'?hi-range*x:lo+range*x;
  for(const x of FIB_EXTENSIONS) levels[x]=dir==='BUY'?lo+range*x:hi-range*x;
  return {levels,range,high:hi,low:lo,direction:dir};
}

function fibNear(d,dir,a=null){
  const f=fib(d,dir); if(!f)return{ok:false};
  const p=d.at(-1).close;
  const tolerance=Math.max(f.range*0.012, (a||0)*0.35, 0.30);
  let near=null,best=Infinity;
  for(const x of FIB_ENTRY_LEVELS){
    const dist=Math.abs(p-f.levels[x]);
    if(dist<best){best=dist;near=x;}
  }
  return {ok:best<=tolerance,near,levels:f.levels,range:f.range,distance:best,tolerance};
}

function inZone(c,z){return z&&c.high>=z.low&&c.low<=z.high;}
function loadOF(){const x=load(ORDERFLOW_FILE,null);if(!x||typeof x!=='object')return{available:false};return{available:true,delta:num(x.delta),cvdSlope:num(x.cvdSlope),imbalance:x.imbalance||'NEUTRAL',absorption:x.absorption||'NONE',source:x.source||'unknown',time:x.time||null};}
function ofConfirm(of,dir){if(!of.available)return false;const positive=dir==='BUY';const deltaOk=of.delta==null?true:(positive?of.delta>0:of.delta<0);const cvdOk=of.cvdSlope==null?true:(positive?of.cvdSlope>0:of.cvdSlope<0);const imb=String(of.imbalance).toUpperCase();const imbOk=imb==='NEUTRAL'||(positive?imb.includes('BUY')||imb.includes('BULL'):imb.includes('SELL')||imb.includes('BEAR'));return deltaOk&&cvdOk&&imbOk;}

function analyze(d){
  if(d.length<200)return null;
  const m5=d.slice(0,-1),m15=aggregate(m5,15),h1=aggregate(m5,60),h4=aggregate(m5,240);
  if(h4.length<20||h1.length<50||m15.length<50)return null;
  const h4b=bias(h4),h1b=bias(h1),m15b=bias(m15),s=structure(m5),a=atr(m5); if(!s||!a)return null;
  let dir=null;
  if(h4b==='BULLISH'&&h1b==='BULLISH'&&m15b!=='BEARISH'&&s.trend==='BULLISH')dir='BUY';
  if(h4b==='BEARISH'&&h1b==='BEARISH'&&m15b!=='BULLISH'&&s.trend==='BEARISH')dir='SELL';
  if(!dir)return null;
  const c=m5.at(-1),b=bos(m5,s,dir),sw=sweep(c,s,dir),ms=mss(m5,s,dir),ob=zone(m5,dir),fv=fvg(m5,dir),z=fv||ob,ret=inZone(c,z),disp=displacement(c,a,dir),fibc=fibNear(m5,dir,a),of=loadOF();
  let score=0;
  if(h4b===dirToBias(dir))score+=2;if(h1b===dirToBias(dir))score+=2;if(m15b===dirToBias(dir))score+=1;if(sw)score+=2;if(ms)score+=2;if(b)score+=1;if(ob)score+=1;if(fv)score+=1;if(ret)score+=1;if(disp)score+=2;if(fibc.ok)score+=1;if(of.available&&ofConfirm(of,dir))score+=2;
  if(score<MIN_SCORE||!sw||!ms||!disp||!z||!ret)return null;
  const sl=dir==='BUY'?Math.min(z.low,s.l2.p)-a*.15:Math.max(z.high,s.h2.p)+a*.15,entry=c.close,risk=Math.abs(entry-sl);
  if(risk<a*.45||risk>a*2.2)return null;
  const fl=fibc.levels||{};
  return{direction:dir,entry,sl,tp1:entry+(dir==='BUY'?risk:-risk),tp2:entry+(dir==='BUY'?risk*2:-risk*2),tp3:fl[1.618]??entry+(dir==='BUY'?risk*3:-risk*3),score,h4:h4b,h1:h1b,m15:m15b,m5:s.trend,atr:a,sweep:sw,mss:ms,bos:b,ob:Boolean(ob),fvg:Boolean(fv),fibNear:fibc.near,fibDistance:fibc.distance,fibTolerance:fibc.tolerance,fibLevels:fl,orderflow:of,displacement:disp,candleTime:c.time};
}
function dirToBias(d){return d==='BUY'?'BULLISH':'BEARISH';}
function key(s){return`${s.direction}|${s.candleTime}|${s.entry.toFixed(2)}|${s.sl.toFixed(2)}`;}
function msg(s){const f=s.fibLevels||{},o=s.orderflow;return`${s.direction==='BUY'?'🟢':'🔴'} XAUUSD ${s.direction} V4\n\n⏱ M5 closed: ${fmt(s.candleTime)}\n💰 Entry: ${r(s.entry)}\n🛑 SL: ${r(s.sl)}\n🎯 TP1: ${r(s.tp1)}\n🎯 TP2: ${r(s.tp2)}\n🎯 TP3 / Fib 1.618: ${r(s.tp3)}\n\n🏛 H4: ${s.h4}\n📊 H1: ${s.h1}\n📈 M15: ${s.m15}\n🧭 M5: ${s.m5}\n\n💧 Sweep: ${s.sweep?'✅':'❌'}\n🧠 MSS: ${s.mss?'✅':'❌'} | BOS: ${s.bos?'✅':'❌'}\n📦 OB: ${s.ob?'✅':'❌'} | FVG: ${s.fvg?'✅':'❌'}\n🎯 Fib near: ${s.fibNear??'-'} | distance ${r(s.fibDistance)}\nFib 0 ${r(f[0])} | 0.236 ${r(f[.236])} | 0.382 ${r(f[.382])}\nFib 0.500 ${r(f[.5])} | 0.618 ${r(f[.618])} | 0.650 ${r(f[.65])}\nFib 0.705 ${r(f[.705])} | 0.786 ${r(f[.786])} | 0.886 ${r(f[.886])} | 1.000 ${r(f[1])}\nExt 1.272 ${r(f[1.272])} | 1.414 ${r(f[1.414])} | 1.618 ${r(f[1.618])}\nExt 2.000 ${r(f[2])} | 2.618 ${r(f[2.618])} | 3.618 ${r(f[3.618])} | 4.236 ${r(f[4.236])}\n\n🧬 Order Flow: ${o.available?'CONNECTED':'WAITING'}\nΔ ${r(o.delta)} | CVD slope ${r(o.cvdSlope)}\nImbalance: ${o.imbalance||'-'} | Absorption: ${o.absorption||'-'}\n⚡ Displacement: ${s.displacement?'✅':'❌'}\n⭐ Score: ${s.score}\n📏 ATR: ${r(s.atr)}\n\n⚠️ Risk management mandatory.`;}
async function telegram(text){if(!TELEGRAM_TOKEN||!TELEGRAM_CHAT_ID)throw Error('Telegram secrets missing');const res=await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:true})});const body=await res.text();if(!res.ok)throw Error(`Telegram HTTP ${res.status}: ${body}`);const j=JSON.parse(body);if(!j.ok)throw Error(`Telegram API: ${body}`);}
(async()=>{try{let candles;try{candles=await fetchYahoo();}catch(e){console.log('Yahoo unavailable:',e.message);const p=await fetchPrice(),old=normalize(load(CANDLES_FILE,[])),t=Math.floor(Date.now()/300000)*300000,last=old.at(-1);if(last&&last.time===t){last.high=Math.max(last.high,p);last.low=Math.min(last.low,p);last.close=p;}else old.push({time:t,open:p,high:p,low:p,close:p,volume:0});candles=old.slice(-1200);}candles=normalize(candles);save(CANDLES_FILE,candles);const signal=analyze(candles),state=load(STATE_FILE,{lastSignalKey:null,lastSignalCandle:null,lastDirection:null,lastAlertTime:0});console.log(`${SYMBOL} candles=${candles.length} H4=${aggregate(candles,240).length} H1=${aggregate(candles,60).length} OF=${loadOF().available?'YES':'NO'}`);if(signal){const k=key(signal);if(k!==state.lastSignalKey&&signal.candleTime!==state.lastSignalCandle){await telegram(msg(signal));state.lastSignalKey=k;state.lastSignalCandle=signal.candleTime;state.lastDirection=signal.direction;state.lastAlertTime=Date.now();save(STATE_FILE,state);console.log('SIGNAL SENT',k);}else console.log('DUPLICATE BLOCKED',k);}else console.log('NO HIGH QUALITY SETUP');}catch(e){console.error('XAU-SMC V4 ERROR:',e?.stack||e);process.exit(1);}})();
