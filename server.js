const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SYMBOL = "XAUUSD";
const STATE_FILE = "./state_v2.json";
const CANDLES_FILE = "./xauusd_m5.json";
const HISTORY_URL = "https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=5m&range=1d";
const PRICE_API = "https://api.gold-api.com/price/XAU";

function load(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
}
function save(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function n(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }
function r(x) { return Number(x).toFixed(2); }
function fmt(ms) { return new Date(ms).toISOString().replace("T", " ").replace(".000Z", " UTC"); }

let state = load(STATE_FILE, {
  lastSignalKey: null,
  lastSignalCandle: null,
  lastDirection: null,
  lastAlertTime: 0,
  telegramTestSent: false
});

function normalize(arr) {
  return arr.map(c => ({
    time: n(c.time ?? c.t) * (n(c.time ?? c.t) < 10000000000 ? 1000 : 1),
    open: n(c.open ?? c.o), high: n(c.high ?? c.h),
    low: n(c.low ?? c.l), close: n(c.close ?? c.c)
  })).filter(c => c.time && c.open != null && c.high != null && c.low != null && c.close != null)
    .sort((a,b) => a.time-b.time);
}

async function fetchYahooCandles() {
  const res = await fetch(HISTORY_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error("No XAUUSD historical candles");
  const q = result.indicators?.quote?.[0];
  const out = [];
  for (let i=0;i<result.timestamp.length;i++) {
    const o=n(q.open?.[i]), h=n(q.high?.[i]), l=n(q.low?.[i]), c=n(q.close?.[i]);
    if (o!=null && h!=null && l!=null && c!=null) out.push({time:result.timestamp[i]*1000,open:o,high:h,low:l,close:c});
  }
  return normalize(out).slice(-300);
}

async function fetchPrice() {
  const res=await fetch(PRICE_API,{headers:{Accept:"application/json"}});
  if(!res.ok) throw new Error(`Price API HTTP ${res.status}`);
  const j=await res.json();
  const p=n(j.price ?? j?.data?.price ?? j?.result?.price);
  if(p==null) throw new Error("No valid XAU price");
  return p;
}

function ema(data,len){
  if(data.length<len) return null;
  const k=2/(len+1); let e=data[0].close;
  for(let i=1;i<data.length;i++) e=(data[i].close-e)*k+e;
  return e;
}
function atr(data,len=14){
  if(data.length<len+1)return null; const tr=[];
  for(let i=1;i<data.length;i++) tr.push(Math.max(data[i].high-data[i].low,Math.abs(data[i].high-data[i-1].close),Math.abs(data[i].low-data[i-1].close)));
  return tr.slice(-len).reduce((a,b)=>a+b,0)/len;
}
function rsi(data,len=14){
  if(data.length<len+1)return null; let gain=0,loss=0;
  for(let i=data.length-len;i<data.length;i++){const d=data[i].close-data[i-1].close;if(d>=0)gain+=d;else loss-=d;}
  if(loss===0)return 100; return 100-(100/(1+gain/loss));
}
function swingHigh(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].high>=d[i].high)return false;return true;}
function swingLow(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].low<=d[i].low)return false;return true;}
function structure(d){
  const hs=[],ls=[]; for(let i=2;i<d.length-2;i++){if(swingHigh(d,i))hs.push({i,p:d[i].high});if(swingLow(d,i))ls.push({i,p:d[i].low});}
  if(hs.length<2||ls.length<2)return null;
  const h1=hs.at(-2),h2=hs.at(-1),l1=ls.at(-2),l2=ls.at(-1);
  const trend=h2.p>h1.p&&l2.p>l1.p?"BULLISH":h2.p<h1.p&&l2.p<l1.p?"BEARISH":"NEUTRAL";
  return {trend,h1,h2,l1,l2};
}
function m15Trend(d){
  const m=[]; for(const c of d){const t=Math.floor(c.time/900000)*900000;let x=m.at(-1);if(!x||x.time!==t)m.push({time:t,open:c.open,high:c.high,low:c.low,close:c.close});else{x.high=Math.max(x.high,c.high);x.low=Math.min(x.low,c.low);x.close=c.close;}}
  if(m.length<50)return "UNKNOWN"; const e20=ema(m,20),e50=ema(m,50),c=m.at(-1).close;return c>e20&&e20>e50?"BULLISH":c<e20&&e20<e50?"BEARISH":"NEUTRAL";
}
function bos(d,s,dir){for(let i=Math.max(0,d.length-12);i<d.length;i++){if(dir==="BUY"&&d[i].close>s.h2.p)return true;if(dir==="SELL"&&d[i].close<s.l2.p)return true;}return false;}
function sweep(c,s,dir){return dir==="BUY"?c.low<s.l2.p&&c.close>s.l2.p:c.high>s.h2.p&&c.close<s.h2.p;}
function ob(d,dir){for(let i=d.length-2;i>=Math.max(1,d.length-50);i--){const c=d[i];if(dir==="BUY"&&c.close<c.open)return {low:c.low,high:c.high,type:"ORDER BLOCK"};if(dir==="SELL"&&c.close>c.open)return {low:c.low,high:c.high,type:"ORDER BLOCK"};}return null;}
function fvg(d,dir){for(let i=d.length-1;i>=Math.max(2,d.length-50);i--){const a=d[i-2],c=d[i];if(dir==="BUY"&&c.low>a.high)return {low:a.high,high:c.low,type:"BULLISH FVG"};if(dir==="SELL"&&c.high<a.low)return {low:c.high,high:a.low,type:"BEARISH FVG"};}return null;}
function confirm(c,p,dir){const body=Math.abs(c.close-c.open),range=Math.max(c.high-c.low,.00001),lw=Math.min(c.open,c.close)-c.low,uw=c.high-Math.max(c.open,c.close);if(dir==="BUY")return (c.close>c.open&&p.close<p.open&&c.close>=p.open&&c.open<=p.close)||(c.close>c.open&&lw>=body*1.2&&lw>uw&&body/range>=.2);return (c.close<c.open&&p.close>p.open&&c.open>=p.close&&c.close<=p.open)||(c.close<c.open&&uw>=body*1.2&&uw>lw&&body/range>=.2);}
function fibConfluence(d,dir){const s=structure(d);if(!s)return {ok:false,level:null};const hi=s.h2.p,lo=s.l2.p,range=hi-lo;const level=dir==="BUY"?hi-range*.786:lo+range*.786;const c=d.at(-1);return {ok:dir==="BUY"?Math.abs(c.close-level)<=range*.08:Math.abs(c.close-level)<=range*.08,level};}
function inZone(c,z){return z&&c.high>=z.low&&c.low<=z.high;}

function analyze(d){
  if(d.length<80)return null; const c=d.at(-1),p=d.at(-2),s=structure(d),a=atr(d),rsiV=rsi(d); if(!s||!a)return null;
  const m15=m15Trend(d); let dir=null;
  if(s.trend==="BULLISH"&&m15!=="BEARISH")dir="BUY";
  if(s.trend==="BEARISH"&&m15!=="BULLISH")dir="SELL"; if(!dir)return null;
  const b=bos(d,s,dir),sw=sweep(c,s,dir),o=ob(d,dir),f=fvg(d,dir),z=f||o;
  const ret=inZone(c,z), conf=confirm(c,p,dir), disp=(c.high-c.low)>=a*.8&&Math.abs(c.close-c.open)/(c.high-c.low||1)>=.5&&(dir==="BUY"?c.close>c.open:c.close<c.open);
  const fib=fibConfluence(d,dir);
  let score=0;if(b)score+=2;if(sw)score+=2;if(f)score+=2;if(o)score++;if(ret)score+=2;if(conf)score++;if(disp)score++;if((dir==="BUY"&&m15==="BULLISH")||(dir==="SELL"&&m15==="BEARISH"))score+=2;if(fib.ok)score++;
  if(score<8||(!b&&!sw)||!z||!ret||!conf||!disp)return null;
  const sl=dir==="BUY"?Math.min(z.low,s.l2.p)-a*.15:Math.max(z.high,s.h2.p)+a*.15,entry=c.close,risk=Math.abs(entry-sl);if(risk<a*.45||risk>a*2.5)return null;
  return {direction:dir,entry,sl,tp1:dir==="BUY"?entry+risk:entry-risk,tp2:dir==="BUY"?entry+risk*2:entry-risk*2,tp3:dir==="BUY"?entry+risk*3:entry-risk*3,score,atr:a,rsi:rsiV,m15,structure:s.trend,bos:b,sweep:sw,ob:Boolean(o),fvg:Boolean(f),zone:z.type,confirmation:conf,displacement:disp,fib705:fib.ok,candleTime:c.time};
}

function key(s){return `${s.direction}|${s.candleTime}|${r(s.entry)}|${r(s.sl)}`;}
function msg(s){return `${s.direction==="BUY"?"🟢":"🔴"} XAUUSD ${s.direction} SIGNAL\n\n⏱ M5 | Closed candle: ${fmt(s.candleTime)}\n💰 Entry: ${r(s.entry)}\n🛑 SL: ${r(s.sl)}\n🎯 TP1: ${r(s.tp1)}\n🎯 TP2: ${r(s.tp2)}\n🎯 TP3: ${r(s.tp3)}\n\n📊 M15: ${s.m15}\n📈 M5: ${s.structure}\n\n🧠 MSS/BOS: ${s.bos?"✅":"❌"}\n💧 Liquidity Sweep: ${s.sweep?"✅":"❌"}\n📦 Order Block: ${s.ob?"✅":"❌"}\n🟦 FVG: ${s.fvg?"✅":"❌"}\n🎯 Fib 0.705/0.786: ${s.fib705?"✅":"❌"}\n🕯 Confirmation: ${s.confirmation?"✅":"❌"}\n⚡ Displacement: ${s.displacement?"✅":"❌"}\n⭐ Score: ${s.score}/15\n📏 ATR: ${r(s.atr)}\n📉 RSI: ${s.rsi==null?"-":r(s.rsi)}\n\n⚠️ Risk management mandatory.`;}

async function telegram(text){
  if(!TELEGRAM_TOKEN||!TELEGRAM_CHAT_ID)throw new Error("Telegram secrets missing");
  const res=await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:true})});
  const body=await res.text(); if(!res.ok)throw new Error(`Telegram HTTP ${res.status}: ${body}`); const j=JSON.parse(body);if(!j.ok)throw new Error(`Telegram API: ${body}`);return j;
}

(async()=>{
  try {
    let candles;
    try { candles=await fetchYahooCandles(); } catch(e) {
      console.log("Historical feed unavailable:",e.message);
      const p=await fetchPrice(); const old=normalize(load(CANDLES_FILE,[])); const t=Math.floor(Date.now()/300000)*300000; const last=old.at(-1); if(last&&last.time===t){last.high=Math.max(last.high,p);last.low=Math.min(last.low,p);last.close=p;} else old.push({time:t,open:p,high:p,low:p,close:p}); candles=old.slice(-300);
    }
    if(candles.length<80)throw new Error(`Not enough M5 candles: ${candles.length}`);
    candles=normalize(candles); save(CANDLES_FILE,candles);
    const latest=candles.at(-1), closed=candles.slice(0,-1), signal=analyze(closed);
    console.log(`XAUUSD=${r(latest.close)} candles=${candles.length} latest=${fmt(latest.time)}`);
    if(signal){const k=key(signal);if(k!==state.lastSignalKey&&signal.candleTime!==state.lastSignalCandle){await telegram(msg(signal));state.lastSignalKey=k;state.lastSignalCandle=signal.candleTime;state.lastDirection=signal.direction;state.lastAlertTime=Date.now();save(STATE_FILE,state);console.log("SIGNAL SENT",k);}else console.log("DUPLICATE BLOCKED",k);} else console.log("NO HIGH QUALITY SETUP");
    if(!state.telegramTestSent){await telegram("🟢 XAUUSD SMC BOT ONLINE\n\nM5 SMC engine active.\nAlerts are sent only for confirmed, unique setups.\nDuplicate alerts are blocked.");state.telegramTestSent=true;save(STATE_FILE,state);}
  } catch(e) { console.error("BOT ERROR:",e.message); process.exitCode=1; }
})();
