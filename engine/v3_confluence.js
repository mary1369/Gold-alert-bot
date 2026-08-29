// V3 research engine: multi-timeframe structure + MSS + Fibonacci confluence.
// Safe-by-default: returns NO_TRADE unless H4/H1/M15/M5 align and MSS is confirmed.
// Order Flow is intentionally NOT synthesized here.

function finite(x){return Number.isFinite(Number(x));}
function body(c){return Math.abs(c.close-c.open);}
function range(c){return Math.max(c.high-c.low,1e-9);}
function swingHigh(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].high>=d[i].high)return false;return true;}
function swingLow(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].low<=d[i].low)return false;return true;}
function structure(d,s=2){const highs=[],lows=[];for(let i=s;i<d.length-s;i++){if(swingHigh(d,i,s))highs.push({i,p:d[i].high});if(swingLow(d,i,s))lows.push({i,p:d[i].low});}if(highs.length<3||lows.length<3)return null;const h1=highs.at(-2),h2=highs.at(-1),l1=lows.at(-2),l2=lows.at(-1);const trend=h2.p>h1.p&&l2.p>l1.p?'BULLISH':h2.p<h1.p&&l2.p<l1.p?'BEARISH':'NEUTRAL';return{trend,h1,h2,l1,l2};}
function mss(d,dir,s=2){const st=structure(d,s);if(!st)return{ok:false,reason:'NO_STRUCTURE'};const c=d.at(-1);const priorHigh=st.h2.p,priorLow=st.l2.p;const displacement=body(c)/range(c)>=0.5;const closeBreak=dir==='BUY'?c.close>priorHigh:c.close<priorLow;return{ok:closeBreak&&displacement,closeBreak,displacement,broken:dir==='BUY'?priorHigh:priorLow};}
function fib(d,dir){const st=structure(d);if(!st)return null;const hi=st.h2.p,lo=st.l2.p,r=hi-lo;if(!(r>0))return null;const levels={};for(const x of [.236,.382,.5,.618,.705,.786])levels[x]=dir==='BUY'?hi-r*x:lo+r*x;levels[1]=dir==='BUY'?lo:hi;levels[1.272]=dir==='BUY'?lo+r*1.272:hi-r*1.272;levels[1.618]=dir==='BUY'?lo+r*1.618:hi-r*1.618;return{levels,range:r};}
function bias(tf){if(!tf)return'UNKNOWN';return structure(tf)?.trend||'UNKNOWN';}
function evaluate({h4,h1,m15,m5}){if(![h4,h1,m15,m5].every(x=>Array.isArray(x)&&x.length>=30))return{decision:'NO_TRADE',reason:'INSUFFICIENT_DATA'};const b=[bias(h4),bias(h1),bias(m15)];let dir=null;if(b.every(x=>x==='BULLISH'))dir='BUY';else if(b.every(x=>x==='BEARISH'))dir='SELL';else return{decision:'NO_TRADE',reason:'HTF_MISALIGNMENT',biases:b};const ms=mss(m5,dir);if(!ms.ok)return{decision:'NO_TRADE',reason:'M5_MSS_NOT_CONFIRMED',biases:b,mss:ms};const f=fib(m5,dir);return{decision:'READY_FOR_ENTRY_FILTERS',direction:dir,biases:b,mss:ms,fib:f,requirements:['LIQUIDITY_SWEEP','OB_OR_FVG','RISK_FILTER','VALID_LIVE_ORDER_FLOW_OR_EXPLICITLY_UNAVAILABLE']};}
module.exports={structure,mss,fib,evaluate};
