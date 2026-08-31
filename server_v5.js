const fs = require('fs');
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const FILE = './xauusd_m5.json';
const STATE = './state_v2.json';
const MIN_SCORE = 7;
const n = x => Number.isFinite(Number(x)) ? Number(x) : null;
const load = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d; } catch { return d; } };
const save = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 2));

const candles = load(FILE, []).map(c => ({time:n(c.time),open:n(c.open),high:n(c.high),low:n(c.low),close:n(c.close),volume:n(c.volume)||0}))
  .filter(c => c.time && [c.open,c.high,c.low,c.close].every(v => v != null)).sort((a,b)=>a.time-b.time);
if (candles.length < 1200) throw Error(`Need >=1200 M5 candles, got ${candles.length}`);
const closed = candles.slice(0, -1);

function agg(a, minutes) {
  const step = minutes * 60000, out = [];
  for (const c of a) {
    const t = Math.floor(c.time / step) * step, x = out.at(-1);
    if (!x || x.time !== t) out.push({time:t,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume});
    else { x.high=Math.max(x.high,c.high); x.low=Math.min(x.low,c.low); x.close=c.close; x.volume+=c.volume; }
  }
  return out;
}
function ema(a, len) { if (a.length < len) return null; let e=a[0].close,k=2/(len+1); for(let i=1;i<a.length;i++) e+=(a[i].close-e)*k; return e; }
function atr(a, len=14) { if(a.length<len+1)return null; const tr=[]; for(let i=1;i<a.length;i++) tr.push(Math.max(a[i].high-a[i].low,Math.abs(a[i].high-a[i-1].close),Math.abs(a[i].low-a[i-1].close))); return tr.slice(-len).reduce((s,x)=>s+x,0)/len; }
function trend(a) { const e20=ema(a,20),e50=ema(a,50),c=a.at(-1)?.close; if(!e20||!e50||c==null)return'UNKNOWN'; if(c>e20&&e20>e50)return'BULLISH'; if(c<e20&&e20<e50)return'BEARISH'; return 'RANGE'; }
function signalAt(idx) {
  const a=closed.slice(0,idx+1); if(a.length<100)return null;
  const m15=agg(a,15),h1=agg(a,60),h4=agg(a,240); if(h1.length<50||h4.length<20)return null;
  const t4=trend(h4),t1=trend(h1),t15=trend(m15), c=a.at(-1), prev=a.slice(-7,-1), atrv=atr(a); if(!atrv)return null;
  const priorHi=Math.max(...prev.map(x=>x.high)), priorLo=Math.min(...prev.map(x=>x.low));
  const bullishBreak=c.close>priorHi, bearishBreak=c.close<priorLo;
  const body=Math.abs(c.close-c.open), range=Math.max(c.high-c.low,1e-9), displacement=body/range>=0.5 && range>=atrv*0.65;
  const sweepBuy=a.slice(-5).some(x=>x.low<priorLo&&x.close>priorLo), sweepSell=a.slice(-5).some(x=>x.high>priorHi&&x.close<priorHi);
  let dir=null, score=0;
  if(t4==='BULLISH'&&t1==='BULLISH'&&t15!=='BEARISH'&&(bullishBreak||sweepBuy)) {dir='BUY';score=4+(bullishBreak?2:0)+(sweepBuy?1:0)+(displacement?1:0);}
  if(t4==='BEARISH'&&t1==='BEARISH'&&t15!=='BULLISH'&&(bearishBreak||sweepSell)) {dir='SELL';score=4+(bearishBreak?2:0)+(sweepSell?1:0)+(displacement?1:0);}
  if(!dir||score<MIN_SCORE)return null;
  const entry=c.close;
  const swingLow=Math.min(...a.slice(-12).map(x=>x.low)), swingHigh=Math.max(...a.slice(-12).map(x=>x.high));
  let sl = dir==='BUY' ? Math.min(swingLow, entry-atrv*0.9) : Math.max(swingHigh, entry+atrv*0.9);
  let risk=Math.abs(entry-sl); if(risk<atrv*0.5)risk=atrv*0.5; if(risk>atrv*2.5)risk=atrv*2.5;
  sl=dir==='BUY'?entry-risk:entry+risk;
  return {direction:dir,entry,sl,tp1:dir==='BUY'?entry+risk:entry-risk,tp2:dir==='BUY'?entry+risk*2:entry-risk*2,score,candleTime:c.time,h4:t4,h1:t1,m15:t15,m5:bullishBreak?'BULLISH':bearishBreak?'BEARISH':'RANGE',breakout:dir==='BUY'?bullishBreak:bearishBreak,sweep:dir==='BUY'?sweepBuy:sweepSell,displacement,atr:atrv};
}

let found=null;
for(let i=Math.max(100,closed.length-36);i<closed.length;i++){const s=signalAt(i);if(s)found=s;}
console.log(`V5 SCAN: ${Math.min(36,closed.length-100)} recent closed M5 candles`);
if(!found){console.log('NO SIGNAL: no confirmed trend-break/sweep setup in recent closed candles.');process.exit(0);}
console.log('SIGNAL CANDIDATE',JSON.stringify(found));
const state=load(STATE,{}), key=`${found.direction}|${found.candleTime}|${found.entry.toFixed(2)}|${found.sl.toFixed(2)}`;
if(state.lastSignalKey===key){console.log('DUPLICATE SIGNAL — not sent');process.exit(0);}
function iranTime(ts){return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ts*1000));}
async function send(s){
  if(!TOKEN||!CHAT)throw Error('Telegram secrets missing');
  const strength=s.score>=9?'🟢 STRONG':'🟡 VALID';
  const text=`${s.direction==='BUY'?'🟢':'🔴'} XAUUSD ${s.direction} V5\n\n${strength} | Score ${s.score}/10\n🕐 Signal: ${iranTime(s.candleTime)} (Iran)\n\nEntry: ${s.entry.toFixed(2)}\nSL: ${s.sl.toFixed(2)}\nTP1: ${s.tp1.toFixed(2)}\nTP2: ${s.tp2.toFixed(2)} (Extended Target)\n\nH4 ${s.h4} | H1 ${s.h1} | M15 ${s.m15}\nBreakout ${s.breakout?'✅':'❌'} | Sweep ${s.sweep?'✅':'❌'} | Displacement ${s.displacement?'✅':'❌'}\nATR ${s.atr.toFixed(2)}\n\n⚠️ TP2 is a target, not a guarantee. Risk management mandatory.`;
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text})});
  if(!r.ok)throw Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
}
(async()=>{await send(found);state.lastSignalKey=key;state.lastSignalTime=new Date().toISOString();save(STATE,state);console.log('TELEGRAM: SIGNAL SENT');})().catch(e=>{console.error(e);process.exit(1);});
