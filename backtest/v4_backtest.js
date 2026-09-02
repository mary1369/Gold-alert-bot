const fs=require('fs');
const {getHistoricalRates}=require('dukascopy-node');
const {evaluate:v4Evaluate}=require('../engine/v4_victoria_hybrid');

async function load(){
  const to=new Date();
  const from=new Date(to.getTime()-7*24*60*60*1000);
  const raw=await getHistoricalRates({instrument:'xauusd',dates:{from,to},timeframe:'m5',format:'json'});
  const a=raw.map(x=>({time:+x.timestamp,open:+x.open,high:+x.high,low:+x.low,close:+x.close})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite)).sort((a,b)=>a.time-b.time);
  if(a.length<200)throw Error(`Insufficient XAUUSD M5 candles: ${a.length}`);
  return a;
}

function body(c){return Math.abs(c.close-c.open)}
function range(c){return Math.max(c.high-c.low,1e-9)}
function atr(d,len=14){if(d.length<len+1)return null;const tr=[];for(let i=1;i<d.length;i++)tr.push(Math.max(d[i].high-d[i].low,Math.abs(d[i].high-d[i-1].close),Math.abs(d[i].low-d[i-1].close)));return tr.slice(-len).reduce((a,b)=>a+b,0)/len}
function swingHigh(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].high>=d[i].high)return false;return true}
function swingLow(d,i,s=2){if(i<s||i>=d.length-s)return false;for(let j=i-s;j<=i+s;j++)if(j!==i&&d[j].low<=d[i].low)return false;return true}
function structure(d){const hs=[],ls=[];for(let i=2;i<d.length-2;i++){if(swingHigh(d,i))hs.push({i,p:d[i].high});if(swingLow(d,i))ls.push({i,p:d[i].low})}if(hs.length<2||ls.length<2)return null;const h1=hs.at(-2),h2=hs.at(-1),l1=ls.at(-2),l2=ls.at(-1);return{trend:h2.p>h1.p&&l2.p>l1.p?'BULLISH':h2.p<h1.p&&l2.p<l1.p?'BEARISH':'NEUTRAL',h1,h2,l1,l2}}
function ema(d,len){if(d.length<len)return null;const k=2/(len+1);let e=d[0].close;for(let i=1;i<d.length;i++)e+=(d[i].close-e)*k;return e}
function m15Trend(d){const m=[];for(const c of d){const t=Math.floor(c.time/900000)*900000;let x=m.at(-1);if(!x||x.time!==t)m.push({time:t,open:c.open,high:c.high,low:c.low,close:c.close});else{x.high=Math.max(x.high,c.high);x.low=Math.min(x.low,c.low);x.close=c.close}}if(m.length<50)return'UNKNOWN';const e20=ema(m,20),e50=ema(m,50),c=m.at(-1).close;return c>e20&&e20>e50?'BULLISH':c<e20&&e20<e50?'BEARISH':'NEUTRAL'}
function bos(d,s,dir){for(let i=Math.max(0,d.length-12);i<d.length;i++)if(dir==='BUY'?d[i].close>s.h2.p:d[i].close<s.l2.p)return true;return false}
function sweep(c,s,dir){return dir==='BUY'?c.low<s.l2.p&&c.close>s.l2.p:c.high>s.h2.p&&c.close<s.h2.p}
function ob(d,dir){for(let i=d.length-2;i>=Math.max(1,d.length-50);i--){const c=d[i];if(dir==='BUY'&&c.close<c.open)return{low:c.low,high:c.high,type:'ORDER BLOCK'};if(dir==='SELL'&&c.close>c.open)return{low:c.low,high:c.high,type:'ORDER BLOCK'}}return null}
function fvg(d,dir){for(let i=d.length-1;i>=Math.max(2,d.length-50);i--){const a=d[i-2],c=d[i];if(dir==='BUY'&&c.low>a.high)return{low:a.high,high:c.low,type:'BULLISH FVG'};if(dir==='SELL'&&c.high<a.low)return{low:c.high,high:a.low,type:'BEARISH FVG'}}return null}
function confirm(c,p,dir){const b=body(c),r=range(c),lw=Math.min(c.open,c.close)-c.low,uw=c.high-Math.max(c.open,c.close);if(dir==='BUY')return(c.close>c.open&&p.close<p.open&&c.close>=p.open&&c.open<=p.close)||(c.close>c.open&&lw>=b*1.2&&lw>uw&&b/r>=.2);return(c.close<c.open&&p.close>p.open&&c.open>=p.close&&c.close<=p.open)||(c.close<c.open&&uw>=b*1.2&&uw>lw&&b/r>=.2)}
function fibLevels(d,dir){const s=structure(d);if(!s)return null;const hi=s.h2.p,lo=s.l2.p,r=hi-lo;if(!(r>0))return null;const levels={};for(const x of [.236,.382,.5,.618,.705,.786])levels[x]=dir==='BUY'?hi-r*x:lo+r*x;levels[1.618]=dir==='BUY'?lo+r*1.618:hi-r*1.618;return{levels,range:r}}
function fibConfluence(d,dir){const f=fibLevels(d,dir);if(!f)return{ok:false};const c=d.at(-1),tol=f.range*.08;let best=Infinity,near=null;for(const x of [.236,.382,.5,.618,.705,.786]){const dist=Math.abs(c.close-f.levels[x]);if(dist<best){best=dist;near=x}}return{ok:best<=tol,near,levels:f.levels}}
function inZone(c,z){return z&&c.high>=z.low&&c.low<=z.high}

// Baseline mirrors the active server.js signal rules without Telegram/network side effects.
function baseline(d){
  if(d.length<80)return null;const c=d.at(-1),p=d.at(-2),s=structure(d),a=atr(d);if(!s||!a)return null;
  const m15=m15Trend(d);let dir=null;if(s.trend==='BULLISH'&&m15!=='BEARISH')dir='BUY';if(s.trend==='BEARISH'&&m15!=='BULLISH')dir='SELL';if(!dir)return null;
  const b=bos(d,s,dir),sw=sweep(c,s,dir),o=ob(d,dir),f=fvg(d,dir),z=f||o,ret=inZone(c,z),conf=confirm(c,p,dir),disp=(c.high-c.low)>=a*.8&&body(c)/(c.high-c.low||1)>=.5,fib=fibConfluence(d,dir);
  let score=0;if(b)score+=2;if(sw)score+=2;if(f)score+=2;if(o)score++;if(ret)score+=2;if(conf)score++;if(disp)score++;if((dir==='BUY'&&m15==='BULLISH')||(dir==='SELL'&&m15==='BEARISH'))score+=2;if(fib.ok)score++;
  if(score<8||(!b&&!sw)||!z||!ret||!conf||!disp)return null;
  const sl=dir==='BUY'?Math.min(z.low,s.l2.p)-a*.15:Math.max(z.high,s.h2.p)+a*.15,entry:c.close,risk=Math.abs(entry-sl);if(risk<a*.45||risk>a*2.5)return null;
  return{direction:dir,entry,sl,risk,tp2:dir==='BUY'?entry+2*risk:entry-2*risk,score,candleTime:c.time};
}

function simulate(d,evaluator,start=100){
  const trades=[];let i=start;let signals=0;
  while(i<d.length-10){
    const sig=evaluator(d.slice(0,i+1));
    if(!sig){i++;continue} signals++;
    let outcome='OPEN',exit=d.at(-1).close,bars=0;
    for(let j=i+1;j<d.length;j++){bars++;const c=d[j];if(sig.direction==='BUY'){if(c.low<=sig.sl){outcome='SL';exit=sig.sl;break}if(c.high>=sig.tp2){outcome='TP2';exit=sig.tp2;break}}else{if(c.high>=sig.sl){outcome='SL';exit=sig.sl;break}if(c.low<=sig.tp2){outcome='TP2';exit=sig.tp2;break}}}
    if(outcome!=='OPEN'){const R=sig.direction==='BUY'?(exit-sig.entry)/sig.risk:(sig.entry-exit)/sig.risk;trades.push({...sig,outcome,R:+R.toFixed(3),bars});i+=Math.max(1,bars);}
    else break;
  }
  let eq=0,peak=0,maxDD=0;for(const t of trades){eq+=t.R;peak=Math.max(peak,eq);maxDD=Math.max(maxDD,peak-eq)}
  const wins=trades.filter(x=>x.R>0),losses=trades.filter(x=>x.R<0),grossWin=wins.reduce((a,x)=>a+x.R,0),grossLoss=Math.abs(losses.reduce((a,x)=>a+x.R,0));
  return{signals,trades:trades.length,wins:wins.length,losses:losses.length,winRate:+(trades.length?wins.length/trades.length:0).toFixed(4),netR:+eq.toFixed(3),profitFactor:+(grossWin/(grossLoss||1)).toFixed(3),maxDrawdownR:+maxDD.toFixed(3),avgR:+(trades.length?eq/trades.length:0).toFixed(3),details:trades};
}

(async()=>{try{
  const d=await load();
  const baselineResult=simulate(d,baseline,100);
  const v4Result=simulate(d,v4Evaluate,100);
  const result={source:'Dukascopy XAUUSD spot M5',periodStart:d[0].time,periodEnd:d.at(-1).time,candles:d.length,exitModel:'one position at a time; SL vs TP2, identical for both engines',baseline:baselineResult,v4:v4Result,comparison:{winRateDelta:+(v4Result.winRate-baselineResult.winRate).toFixed(4),netRDelta:+(v4Result.netR-baselineResult.netR).toFixed(3),profitFactorDelta:+(v4Result.profitFactor-baselineResult.profitFactor).toFixed(3),drawdownDelta:+(v4Result.maxDrawdownR-baselineResult.maxDrawdownR).toFixed(3),tradeCountDelta:v4Result.trades-baselineResult.trades}};
  fs.mkdirSync('backtest',{recursive:true});fs.writeFileSync('backtest/v4_result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,baseline:{...baselineResult,details:undefined},v4:{...v4Result,details:undefined}},null,2));
}catch(e){console.error(e);process.exit(1)}})();