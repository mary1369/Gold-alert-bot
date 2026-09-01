const fs = require('fs');

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const FILE = './xauusd_m5.json';
const STATE = './state_v2.json';
const DRY_RUN = process.env.SIGNAL_DRY_RUN === '1';

// V6: pure SMC/ICT. EMA and ATR are intentionally not used.
// A signal must be created on the latest closed M5 candle only.
// Reversal = liquidity sweep -> next-candle MSS -> displacement.
// Continuation = structure BOS + displacement + HTF alignment.
const MIN_SCORE = 7;
const SIGNAL_MAX_AGE = 15 * 60 * 1000;
const DATA_MAX_AGE = 20 * 60 * 1000;
const FIBS = [0.236, 0.382, 0.5, 0.618, 0.65, 0.705, 0.786, 0.886];

function load(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}

function save(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

function ts(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < 1e11 ? n * 1000 : n;
}

const candles = load(FILE, []).map(c => ({
  time: ts(c.time ?? c.openTime),
  open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
  volume: Number(c.volume) || 0, isOpen: c.isOpen === true,
})).filter(c => c.time && [c.open,c.high,c.low,c.close].every(Number.isFinite))
  .sort((a,b) => a.time-b.time);

const closed = candles.filter(c => !c.isOpen);
if (closed.length < 1200) throw Error(`Need >=1200 closed M5 candles, got ${closed.length}`);
const c = closed.at(-1);
const age = Date.now() - c.time;
if (age < 0 || age > DATA_MAX_AGE) throw Error(`Stale M5 data: ${Math.round(age/60000)}m`);

function aggregate(src, minutes) {
  const step = minutes * 60000, out = [];
  for (const x of src) {
    const t = Math.floor(x.time / step) * step;
    const last = out.at(-1);
    if (!last || last.time !== t) out.push({time:t,open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume});
    else { last.high=Math.max(last.high,x.high); last.low=Math.min(last.low,x.low); last.close=x.close; last.volume+=x.volume; }
  }
  return out;
}

function swingPoints(src, lookback=2) {
  const out=[];
  for(let i=lookback;i<src.length-lookback;i++) {
    const x=src[i];
    let hi=true, lo=true;
    for(let j=1;j<=lookback;j++){ if(x.high<=src[i-j].high || x.high<src[i+j].high) hi=false; if(x.low>=src[i-j].low || x.low>src[i+j].low) lo=false; }
    if(hi) out.push({type:'H',price:x.high,time:x.time,index:i});
    if(lo) out.push({type:'L',price:x.low,time:x.time,index:i});
  }
  return out;
}

function structure(src) {
  const s=swingPoints(src.slice(-160));
  const h=s.filter(x=>x.type==='H'), l=s.filter(x=>x.type==='L');
  if(h.length<2 || l.length<2) return 'UNKNOWN';
  const hh=h.at(-1).price>h.at(-2).price, hl=l.at(-1).price>l.at(-2).price;
  const lh=h.at(-1).price<h.at(-2).price, ll=l.at(-1).price<l.at(-2).price;
  if(hh&&hl) return 'BULLISH';
  if(lh&&ll) return 'BEARISH';
  return 'RANGE';
}

function fib(src) {
  const s=swingPoints(src.slice(-180));
  const h=s.filter(x=>x.type==='H').at(-1), l=s.filter(x=>x.type==='L').at(-1);
  if(!h||!l||h.price===l.price) return null;
  const d=Math.abs(h.price-l.price), up=h.time>l.time;
  const levels=Object.fromEntries(FIBS.map(r=>[r,up?l.price+d*r:h.price-d*r]));
  return {levels,range:d,direction:up?'UP':'DOWN'};
}

function fibNear(f, price) {
  if(!f) return null;
  const tol=Math.max(f.range*0.035,0.5);
  return FIBS.map(level=>({level,price:f.levels[level],dist:Math.abs(price-f.levels[level])}))
    .filter(x=>x.dist<=tol).sort((a,b)=>a.dist-b.dist)[0] || null;
}

function liquiditySweep(src, direction) {
  // Only the latest 6 candles are eligible. The swept level must pre-date the sweep.
  const start=Math.max(6,src.length-6);
  for(let i=src.length-1;i>=start;i--) {
    const prior=src.slice(i-6,i); if(prior.length<6) continue;
    const level=direction==='BUY'?Math.min(...prior.map(x=>x.low)):Math.max(...prior.map(x=>x.high));
    const x=src[i];
    const swept=direction==='BUY' ? x.low<level && x.close>level : x.high>level && x.close<level;
    if(!swept) continue;
    // MSS must occur after the sweep, never on the same candle.
    if(i!==src.length-2) continue;
    const confirm=src[i+1];
    const p3=src.slice(i-2,i+1);
    const p6=src.slice(Math.max(0,i-5),i+1);
    if(p3.length<3||p6.length<6) continue;
    const h3=Math.max(...p3.map(x=>x.high)), l3=Math.min(...p3.map(x=>x.low));
    const h6=Math.max(...p6.map(x=>x.high)), l6=Math.min(...p6.map(x=>x.low));
    const body=Math.abs(confirm.close-confirm.open), range=Math.max(confirm.high-confirm.low,1e-9);
    const displacement=body/range>=0.45;
    const mss=direction==='BUY'?confirm.close>h3:confirm.close<l3;
    const bos=direction==='BUY'?confirm.close>h6:confirm.close<l6;
    if(mss&&displacement) return {sweepIndex:i,confirmIndex:i+1,level,mss,bos,displacement};
  }
  return null;
}

function orderBlock(src,direction) {
  // Last opposite candle before the confirmed displacement.
  const end=src.length-2;
  for(let i=end;i>=Math.max(0,end-8);i--) {
    const x=src[i];
    if(direction==='BUY'&&x.close<x.open) return {time:x.time,high:x.high,low:x.low};
    if(direction==='SELL'&&x.close>x.open) return {time:x.time,high:x.high,low:x.low};
  }
  return null;
}

function fvg(src,direction) {
  for(let i=src.length-1;i>=Math.max(2,src.length-8);i--) {
    const a=src[i-2], x=src[i];
    if(direction==='BUY'&&x.low>a.high) return {time:x.time,low:a.high,high:x.low};
    if(direction==='SELL'&&x.high<a.low) return {time:x.time,low:x.high,high:a.low};
  }
  return null;
}

function analyze() {
  const m15=aggregate(closed,15), h1=aggregate(closed,60), h4=aggregate(closed,240);
  if(m15.length<20||h1.length<30||h4.length<12) return null;
  const st15=structure(m15), st1=structure(h1), st4=structure(h4);
  const prev6=closed.slice(-7,-1), prev3=closed.slice(-4,-1);
  const ph6=Math.max(...prev6.map(x=>x.high)), pl6=Math.min(...prev6.map(x=>x.low));
  const ph3=Math.max(...prev3.map(x=>x.high)), pl3=Math.min(...prev3.map(x=>x.low));
  const range=Math.max(c.high-c.low,1e-9), body=Math.abs(c.close-c.open);
  const displacement=body/range>=0.45;
  const bosBuy=c.close>ph6, bosSell=c.close<pl6;
  const mssBuy=c.close>ph3, mssSell=c.close<pl3;
  const buySweep=liquiditySweep(closed,'BUY'), sellSweep=liquiditySweep(closed,'SELL');
  const buyContext=st1==='BULLISH' && st15!=='BEARISH';
  const sellContext=st1==='BEARISH' && st15!=='BULLISH';
  const buyReversal=Boolean(buySweep);
  const sellReversal=Boolean(sellSweep);
  const buyContinuation=buyContext&&bosBuy&&displacement;
  const sellContinuation=sellContext&&bosSell&&displacement;

  const buyBase=buyReversal||buyContinuation;
  const sellBase=sellReversal||sellContinuation;
  if(!buyBase&&!sellBase) return null;
  if(buyBase&&sellBase) return null;

  const direction=buyBase?'BUY':'SELL';
  const sweep=direction==='BUY'?buySweep:sellSweep;
  const bos=direction==='BUY'?bosBuy:bosSell;
  const mss=direction==='BUY'?mssBuy:mssSell;
  const context=direction==='BUY'?buyContext:sellContext;
  const setup=sweep?'LIQUIDITY_SWEEP_MSS':'STRUCTURE_CONTINUATION';
  const ob=orderBlock(closed,direction), gap=fvg(closed,direction), f=fib(closed), fm=fibNear(f,c.close);

  // Independent score; OB/FVG are confirmations, never direction selectors.
  let score=0;
  if(sweep) score+=3;
  if(mss) score+=2;
  if(bos) score+=2;
  if(displacement) score+=1;
  if(context) score+=1;
  if(ob) score+=1;
  if(gap) score+=1;
  if(fm) score+=1;
  score=Math.min(10,score);
  if(score<MIN_SCORE) return null;

  const entry=c.close;
  const recent=closed.slice(-12);
  const low=Math.min(...recent.map(x=>x.low)), high=Math.max(...recent.map(x=>x.high));
  const structural=Math.max(high-low,0.5);
  const rawRisk=direction==='BUY'?entry-low:high-entry;
  const risk=Math.max(structural*0.25,Math.min(structural*1.25,rawRisk));
  if(!Number.isFinite(risk)||risk<=0) return null;

  return {direction,setup,score,entry,sl:direction==='BUY'?entry-risk:entry+risk,tp1:direction==='BUY'?entry+risk:entry-risk,tp2:direction==='BUY'?entry+2*risk:entry-2*risk,candleTime:c.time,h4:st4,h1:st1,m15:st15,bos,mss,sweep:Boolean(sweep),displacement,ob,fvg:gap,fib:fm};
}

const signal=analyze();
console.log(`ANALYSIS CANDLE: ${new Date(c.time).toISOString()} | age=${Math.round(age/60000)}m | closed=true`);

if(!signal || Date.now()-signal.candleTime>SIGNAL_MAX_AGE) {
  console.log('NO CURRENT QUALIFYING SIGNAL (V6 SMC validation)');
  process.exit(0);
}

const iran=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const signalTime=iran.format(new Date(signal.candleTime));
console.log(`QUALIFYING SIGNAL: ${signal.direction} ${signal.setup} score=${signal.score}/10 candle=${new Date(signal.candleTime).toISOString()} iran=${signalTime}`);

const state=load(STATE,{});
const key=`${signal.direction}|${signal.setup}|${signal.candleTime}|${signal.entry.toFixed(2)}`;
if(state.lastSignalKey===key) { console.log('DUPLICATE SIGNAL — not sent'); process.exit(0); }

async function send() {
  if(DRY_RUN) { console.log(`DRY RUN — Telegram not sent | key=${key}`); return; }
  if(!TOKEN||!CHAT) throw Error('Telegram secrets missing');
  const sent=new Date();
  const strength=signal.score>=9?'🟢 STRONG':'🟡 VALID';
  const setupName=signal.setup==='LIQUIDITY_SWEEP_MSS'?'Liquidity Sweep + MSS':'Structure Continuation';
  const fibLine=signal.fib?`Fib: ${signal.fib.level.toFixed(3)} @ ${signal.fib.price.toFixed(2)}`:'Fib: no nearby level';
  const text=[
    `${signal.direction==='BUY'?'🟢':'🔴'} XAUUSD ${signal.direction} V6`,
    '',`${strength} | Score ${signal.score}/10`,`📌 Setup: ${setupName}`,
    `🕐 Signal candle: ${signalTime} (Iran)`,
    `📨 Sent: ${iran.format(sent)} (Iran)`,'',
    `Entry: ${signal.entry.toFixed(2)}`,`SL: ${signal.sl.toFixed(2)}`,
    `TP1: ${signal.tp1.toFixed(2)}`,`TP2: ${signal.tp2.toFixed(2)} (Extended Target)`,'',
    `H4: ${signal.h4} | H1: ${signal.h1} | M15: ${signal.m15}`,
    `BOS: ${signal.bos?'YES':'NO'} | MSS: ${signal.mss?'YES':'NO'} | Sweep: ${signal.sweep?'YES':'NO'}`,
    `OB: ${signal.ob?'YES':'NO'} | FVG: ${signal.fvg?'YES':'NO'}`,
    fibLine,'EMA: OFF | ATR: OFF',
  ].join('\n');
  const url=`https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text})});
  const data=await res.json().catch(()=>null);
  if(!res.ok||!data?.ok) throw Error(`Telegram send failed: ${res.status} ${JSON.stringify(data)}`);
  save(STATE,{...state,lastSignalKey:key,lastSignalAt:sent.toISOString(),lastSignalCandle:signal.candleTime});
  console.log(`TELEGRAM SENT OK | signal=${signalTime} Iran | sent=${iran.format(sent)} Iran`);
}

send().catch(err=>{ console.error(err); process.exit(1); });
