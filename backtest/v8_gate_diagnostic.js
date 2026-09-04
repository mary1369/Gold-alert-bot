const fs = require('fs');
const { getHistoricalRates } = require('dukascopy-node');

function atr(d,n=14){if(d.length<n+1)return null;const tr=[];for(let i=1;i<d.length;i++)tr.push(Math.max(d[i].high-d[i].low,Math.abs(d[i].high-d[i-1].close),Math.abs(d[i].low-d[i-1].close)));return tr.slice(-n).reduce((a,b)=>a+b,0)/n}
function ema(d,n){if(d.length<n)return null;let k=2/(n+1),e=d[0].close;for(let i=1;i<d.length;i++)e+=(d[i].close-e)*k;return e}
function swingHigh(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].high>=d[i].high)return false;return true}
function swingLow(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].low<=d[i].low)return false;return true}
function swings(d){const h=[],l=[];for(let i=2;i<d.length-2;i++){if(swingHigh(d,i))h.push({i,p:d[i].high});if(swingLow(d,i))l.push({i,p:d[i].low})}return{h,l}}
function aggregate(d,min){const step=min*60000,o=[];for(const c of d){const t=Math.floor(c.time/step)*step,x=o.at(-1);if(!x||x.time!==t)o.push({time:t,open:c.open,high:c.high,low:c.low,close:c.close});else{x.high=Math.max(x.high,c.high);x.low=Math.min(x.low,c.low);x.close=c.close}}return o}
function bias15(d){let x=aggregate(d,15);if(x.length<50)return'UNKNOWN';x=x.slice(0,-1);if(x.length<50)return'UNKNOWN';const e20=ema(x,20),e50=ema(x,50),c=x.at(-1).close;return c>e20&&e20>e50?'BULLISH':c<e20&&e20<e50?'BEARISH':'NEUTRAL'}
function fvgAt(d,i,dir){if(i<2)return null;const a=d[i-2],c=d[i];if(dir==='BUY'&&c.low>a.high)return{low:a.high,high:c.low,i};if(dir==='SELL'&&c.high<a.low)return{low:c.high,high:a.low,i};return null}
function freshFvg(d,dir,ms){for(let i=ms+1;i<=Math.min(ms+3,d.length-1);i++){const f=fvgAt(d,i,dir);if(!f)continue;let touched=false;for(let j=f.i+1;j<d.length-1;j++)if(d[j].low<=f.high&&d[j].high>=f.low){touched=true;break}if(!touched)return f}return null}
function overlap(c,z){return c&&z&&c.high>=z.low&&c.low<=z.high}
function rsi(d,n=14){if(d.length<n+1)return null;let g=0,l=0;for(let i=d.length-n;i<d.length;i++){const x=d[i].close-d[i-1].close;if(x>=0)g+=x;else l-=x}return l===0?100:100-100/(1+g/l)}
function gate(d){
  if(d.length<220)return 'history<220'; const a=atr(d); if(!a)return'atr'; const b=bias15(d); if(b==='UNKNOWN')return'm15_unknown'; if(b==='NEUTRAL')return'm15_neutral';
  const s=swings(d); if(s.h.length<3)return'not_enough_swing_highs'; if(s.l.length<3)return'not_enough_swing_lows';
  const dir=b==='BULLISH'?'BUY':'SELL',ph=s.h.at(-2),pl=s.l.at(-2),ch=s.h.at(-1),cl=s.l.at(-1);
  if(dir==='BUY'?(ch.p<=ph.p||cl.p<=pl.p):(ch.p>=ph.p||cl.p>=pl.p))return'structure_not_directional';
  let sweep=null; for(let i=Math.max(4,d.length-7);i<d.length;i++){if(dir==='BUY'&&d[i].low<cl.p&&d[i].close>cl.p)sweep={i,level:cl.p};if(dir==='SELL'&&d[i].high>ch.p&&d[i].close<ch.p)sweep={i,level:ch.p}}
  if(!sweep)return'no_liquidity_sweep';
  let ms=null; for(let i=sweep.i+1;i<=Math.min(d.length-1,sweep.i+4);i++){const x=d[i],body=Math.abs(x.close-x.open),rng=Math.max(x.high-x.low,1e-9),disp=body/rng>=.55&&rng>=a*.8;if(dir==='BUY'&&x.close>ph.p&&x.close>x.open&&disp){ms={i,level:ph.p};break}if(dir==='SELL'&&x.close<pl.p&&x.close<x.open&&disp){ms={i,level:pl.p};break}}
  if(!ms)return'no_mss_displacement'; const f=freshFvg(d,dir,ms.i); if(!f)return'no_fresh_fvg'; if(!overlap(d.at(-1),f))return'fvg_not_retraced_at_close';
  const legLow=dir==='BUY'?sweep.level:ms.level,legHigh=dir==='BUY'?ms.level:sweep.level,rng=Math.abs(legHigh-legLow);if(rng<=0)return'zero_ote_range';
  const ote705=dir==='BUY'?legHigh-rng*.705:legLow+rng*.705,ote786=dir==='BUY'?legHigh-rng*.786:legLow+rng*.786,tol=Math.max(rng*.10,a*.35);if(Math.min(Math.abs(d.at(-1).close-ote705),Math.abs(d.at(-1).close-ote786))>tol)return'ote_miss';
  const rv=rsi(d);if(rv==null)return'rsi_missing';if(dir==='BUY'?(rv<48||rv>72):(rv<28||rv>52))return'rsi_filter';
  const sl=dir==='BUY'?Math.min(sweep.level,f.low)-a*.2:Math.max(sweep.level,f.high)+a*.2,risk=Math.abs(d.at(-1).close-sl);if(risk<a*.45)return'risk_too_small';if(risk>a*2.2)return'risk_too_large';return'PASS';
}

(async()=>{try{const to=new Date(),from=new Date(to.getTime()-90*86400000);const raw=await getHistoricalRates({instrument:'xauusd',dates:{from,to},timeframe:'m5',format:'json'});const d=raw.map(x=>({time:+x.timestamp,open:+x.open,high:+x.high,low:+x.low,close:+x.close})).filter(x=>Object.values(x).every(Number.isFinite)).sort((a,b)=>a.time-b.time);const counts={};for(let i=220;i<d.length;i++){const r=gate(d.slice(0,i+1));counts[r]=(counts[r]||0)+1}const out={candles:d.length,evaluated:d.length-220,gateCounts:counts};fs.writeFileSync('backtest/v8_gate_diagnostic.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));}catch(e){console.error(e.stack||e);process.exit(1)}})();
