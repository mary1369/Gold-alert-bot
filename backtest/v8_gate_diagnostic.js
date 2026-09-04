const fs = require('fs');
const { getHistoricalRates } = require('dukascopy-node');
const { analyzeV8At } = require('../strategy_v8');
(async()=>{try{
 const to=new Date(),from=new Date(to.getTime()-90*86400000);
 const raw=await getHistoricalRates({instrument:'xauusd',dates:{from,to},timeframe:'m5',format:'json'});
 const d=raw.map(x=>({time:+x.timestamp,open:+x.open,high:+x.high,low:+x.low,close:+x.close})).filter(x=>Object.values(x).every(Number.isFinite)).sort((a,b)=>a.time-b.time);
 const counts={}; const passes=[];
 for(let i=220;i<d.length;i++){const r=analyzeV8At(d,i);const key=r?'PASS':'BLOCKED';counts[key]=(counts[key]||0)+1;if(r&&passes.length<20)passes.push({index:i,time:d[i].time,direction:r.direction});}
 const checks=[];const step=Math.max(1,Math.floor((d.length-260)/30));
 for(let i=220;i<d.length-1;i+=step){const a=analyzeV8At(d,i),m=d.slice();for(let j=i+1;j<Math.min(d.length,i+8);j++)m[j]={...m[j],open:999999,high:999999,low:-999999,close:999999};const b=analyzeV8At(m,i);checks.push(JSON.stringify(a)===JSON.stringify(b));}
 const out={candles:d.length,evaluated:d.length-220,gateCounts:counts,firstPasses:passes,causalMutationTest:{passed:checks.length>0&&checks.every(Boolean),samples:checks.length}};
 fs.writeFileSync('backtest/v8_gate_diagnostic.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));if(!out.causalMutationTest.passed)process.exit(4);
}catch(e){console.error(e.stack||e);process.exit(1)}})();
