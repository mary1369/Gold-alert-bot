// V4 Victoria + SMC Hybrid Engine
// Victoria-derived core: 3-touch trendline -> break -> safety line.
// SMC remains confirmation: liquidity sweep, MSS/BOS, OB/FVG, Fib and ATR risk.
// Numeric thresholds below are engineering choices for XAUUSD M5, not claims about Victoria Duke's proprietary rules.

function finite(x){return Number.isFinite(Number(x));}
function body(c){return Math.abs(c.close-c.open);}
function range(c){return Math.max(c.high-c.low,1e-9);}
function atr(d,len=14){if(d.length<len+1)return null;const tr=[];for(let i=1;i<d.length;i++)tr.push(Math.max(d[i].high-d[i].low,Math.abs(d[i].high-d[i-1].close),Math.abs(d[i].low-d[i-1].close)));return tr.slice(-len).reduce((a,b)=>a+b,0)/len;}
function swingHigh(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].high>=d[i].high)return false;return true;}
function swingLow(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].low<=d[i].low)return false;return true;}
function pivots(d,s=2){const hs=[],ls=[];for(let i=s;i<d.length-s;i++){if(swingHigh(d,i,s))hs.push({i,p:d[i].high});if(swingLow(d,i,s))ls.push({i,p:d[i].low});}return{hs,ls};}
function lineThrough(a,b,x){if(!a||!b||b.i===a.i)return null;return a.p+(b.p-a.p)*(x-a.i)/(b.i-a.i);}
function trendline3(d,dir,s=2){const {hs,ls}=pivots(d,s);const pts=dir==='BUY'?hs:ls;if(pts.length<3)return null;const p0=pts.at(-3),p1=pts.at(-2),p2=pts.at(-1);const slope=(p2.p-p0.p)/(p2.i-p0.i);if(dir==='BUY' && slope>=0)return null;if(dir==='SELL' && slope<=0)return null;let touches=0;const tol=Math.max((atr(d)||0)*0.18,0.15);for(const p of pts.slice(-8)){const v=lineThrough(p0,p2,p.i);if(v!=null&&Math.abs(p.p-v)<=tol)touches++;}if(touches<3)return null;return{p0,p1,p2,slope,touches,tol,at:i=>lineThrough(p0,p2,i)};}
function breakSignal(d,line,dir){if(!line||d.length<2)return false;const c=d.at(-1),p=d.at(-2),lv=line.at(d.length-1),pl=line.at(d.length-2);if(dir==='BUY')return p.close<=pl&&c.close>lv&&body(c)/range(c)>=0.45;return p.close>=pl&&c.close<lv&&body(c)/range(c)>=0.45;}
function structure(d,s=2){const {hs,ls}=pivots(d,s);if(hs.length<3||ls.length<3)return null;const h1=hs.at(-2),h2=hs.at(-1),l1=ls.at(-2),l2=ls.at(-1);return{trend:h2.p>h1.p&&l2.p>l1.p?'BULLISH':h2.p<h1.p&&l2.p<l1.p?'BEARISH':'NEUTRAL',h1,h2,l1,l2};}
function mss(d,dir,s=2){const st=structure(d,s);if(!st)return false;const c=d.at(-1);const displacement=body(c)/range(c)>=0.5;return displacement&&(dir==='BUY'?c.close>st.h2.p:c.close<st.l2.p);}
function sweep(d,dir){const st=structure(d);if(!st)return false;const c=d.at(-1);return dir==='BUY'?c.low<st.l2.p&&c.close>st.l2.p:c.high>st.h2.p&&c.close<st.h2.p;}
function fib(d,dir){const st=structure(d);if(!st)return null;const hi=st.h2.p,lo=st.l2.p,r=hi-lo;if(!(r>0))return null;const levels={};for(const x of [.618,.705,.786,.886])levels[x]=dir==='BUY'?hi-r*x:lo+r*x;levels[1.618]=dir==='BUY'?lo+r*1.618:hi-r*1.618;return{levels,range:r};}
function nearFib(d,dir){const f=fib(d,dir);if(!f)return false;const c=d.at(-1),tol=f.range*.08;return [.618,.705,.786,.886].some(x=>Math.abs(c.close-f.levels[x])<=tol);}
function zone(d,dir){for(let i=d.length-2;i>=Math.max(1,d.length-50);i--){const c=d[i];if(dir==='BUY'&&c.close<c.open)return{low:c.low,high:c.high,type:'OB'};if(dir==='SELL'&&c.close>c.open)return{low:c.low,high:c.high,type:'OB'};}return null;}
function inZone(c,z){return !!z&&c.high>=z.low&&c.low<=z.high;}
function rangeFilter(d){const st=structure(d);if(!st)return true;const a=atr(d);if(!a)return true;const span=Math.max(...d.slice(-20).map(x=>x.high))-Math.min(...d.slice(-20).map(x=>x.low));return span<a*2.2;}
function evaluate(d){if(!Array.isArray(d)||d.length<100)return{decision:'NO_TRADE',reason:'INSUFFICIENT_DATA'};const a=atr(d),c=d.at(-1),st=structure(d);if(!a||!st)return{decision:'NO_TRADE',reason:'NO_STRUCTURE'};const candidates=['BUY','SELL'];for(const dir of candidates){const tl=trendline3(d,dir);if(!tl||!breakSignal(d,tl,dir))continue;if(rangeFilter(d))return{decision:'NO_TRADE',reason:'RANGE'};const ms=mss(d,dir),sw=sweep(d,dir),z=zone(d,dir),ret=inZone(c,z),fibOk=nearFib(d,dir);let score=2+2+1; // 3-touch + break + non-range
if(ms)score+=2;if(sw)score+=2;if(z)score+=1;if(ret)score+=1;if(fibOk)score+=1;if(body(c)/range(c)>=0.5)score+=1;
if(score<8||!ms||!z||!ret)return{decision:'NO_TRADE',reason:'CONFIRMATION_MISSING',score,direction:dir};
const safety=tl.at(d.length-1);const sl=dir==='BUY'?Math.min(z.low,safety)-a*.15:Math.max(z.high,safety)+a*.15;const risk=Math.abs(c.close-sl);if(risk<a*.45||risk>a*2.5)return{decision:'NO_TRADE',reason:'RISK_FILTER',score,direction:dir};const f=fib(d,dir);return{decision:'SIGNAL',direction:dir,entry:c.close,sl,risk,tp1:dir==='BUY'?c.close+risk:c.close-risk,tp2:dir==='BUY'?c.close+2*risk:c.close-2*risk,tp3:f?.levels?.[1.618],score,trendlineTouches:tl.touches,break:true,mss:ms,sweep:sw,zone:z.type,fibOk,safetyLine:safety,candleTime:c.time};}
return{decision:'NO_TRADE',reason:'NO_TRENDLINE_BREAK'};}
module.exports={evaluate,trendline3,rangeFilter};
