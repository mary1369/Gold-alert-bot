const fs=require('fs');
const {getHistoricalRates}=require('dukascopy-node');
const DAY=86400000,M5=300000,NOW=Date.now(),MIN_M5=1200,MAX_AGE_MS=20*60000;
function ts(v){const n=Number(v);return Number.isFinite(n)?(n<1e11?n*1000:n):NaN}
function norm(rows){return(rows||[]).map(r=>{const t=ts(r?.timestamp??r?.time??r?.[0]);const o=Number(r?.open??r?.[1]),h=Number(r?.high??r?.[2]),l=Number(r?.low??r?.[3]),c=Number(r?.close??r?.[4]),v=Number(r?.volume??r?.tickVolume??r?.[5]??0)||0;return Number.isFinite(t)&&[o,h,l,c].every(Number.isFinite)?{openTime:new Date(t).toISOString(),open:o,high:h,low:l,close:c,volume:v,isOpen:false}:null}).filter(Boolean)}
function unique(a){const m=new Map();for(const b of a||[])m.set(b.openTime,b);return[...m.values()].sort((x,y)=>Date.parse(x.openTime)-Date.parse(y.openTime))}
function latest(a){return a.length?Date.parse(a.at(-1).openTime):NaN}
function fresh(a){const age=NOW-latest(a);return a.length>=MIN_M5&&age>=0&&age<=MAX_AGE_MS}
async function dukM5(days){const data=await getHistoricalRates({instrument:'xauusd',dates:{from:new Date(NOW-days*DAY),to:new Date(NOW-M5)},timeframe:'m5',priceType:'bid',format:'array',volumes:true,ignoreFlats:false,batchSize:1,pauseBetweenBatchesMs:7000,retryCount:1,pauseBetweenRetriesMs:10000,retryOnEmpty:true,failAfterRetryCount:1});return norm(Array.isArray(data)?data:data?.data)}
async function biquoteM5(){
 const u='https://biquote.io/api/XAUUSD/ohlc?interval=5m&limit=1000';
 const r=await fetch(u,{headers:{'Accept':'application/json','User-Agent':'Gold-alert-bot/1.0'}});
 const text=await r.text();
 if(!r.ok)throw new Error(`BiQuote HTTP ${r.status}: ${text.slice(0,180)}`);
 let j;try{j=JSON.parse(text)}catch(e){throw new Error(`BiQuote invalid JSON: ${e.message}`)}
 const rows=Array.isArray(j)?j:(j?.data||j?.bars||j?.candles||j?.result||[]);
 if(!Array.isArray(rows)||!rows.length)throw new Error('BiQuote returned no M5 bars');
 return norm(rows.map(x=>({timestamp:x.timestamp??x.time??x.t??x.openTime,open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume??x.tickVolume})));
}
async function yahooM5(range='5d'){
 const u=`https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=5m&range=${range}&includePrePost=false&events=div%2Csplits`;
 const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}});
 const text=await r.text();
 if(!r.ok)throw new Error(`Yahoo HTTP ${r.status}: ${text.slice(0,180)}`);
 let j;try{j=JSON.parse(text)}catch(e){throw new Error(`Yahoo invalid JSON: ${e.message}`)}
 const q=j?.chart?.result?.[0];if(!q)throw new Error(`Yahoo returned no XAUUSD result: ${j?.chart?.error?.description||'unknown error'}`);
 const t=q.timestamp||[],c=q.indicators?.quote?.[0]||{};
 return norm(t.map((x,i)=>({timestamp:x,open:c.open?.[i],high:c.high?.[i],low:c.low?.[i],close:c.close?.[i],volume:c.volume?.[i]})));
}
(async()=>{
 let bars=[];
 for(const provider of [
   ['BiQuote M5',()=>biquoteM5()],
   ['Dukascopy M5 2d',()=>dukM5(2)],
   ['Dukascopy M5 1d',()=>dukM5(1)],
   ['Dukascopy M5 0.5d',()=>dukM5(0.5)],
   ['Yahoo XAUUSD M5 5d',()=>yahooM5('5d')],
   ['Yahoo XAUUSD M5 1d',()=>yahooM5('1d')]
 ]){
   try{const got=unique(await provider[1]());console.log(`${provider[0]}: ${got.length}`);bars=unique([...bars,...got]);if(fresh(bars))break}
   catch(e){console.log(`${provider[0]} failed: ${e?.stack||e?.message||String(e)}`)}
 }
 if(bars.length<MIN_M5)throw new Error(`Insufficient XAUUSD M5 history: ${bars.length}`);
 const lt=latest(bars),age=NOW-lt;console.log(`Final XAUUSD M5 candle UTC: ${new Date(lt).toISOString()} | age=${Math.round(age/60000)}m | bars=${bars.length}`);
 if(age<0||age>MAX_AGE_MS)throw new Error(`No fresh XAUUSD M5 feed: latest=${new Date(lt).toISOString()} age=${Math.round(age/60000)}m`);
 const out=bars.slice(-3000);fs.writeFileSync('/tmp/xau.json',JSON.stringify({symbol:'XAUUSD',interval:'5m',bars:out}));console.log(`Published ${out.length} unique fresh XAUUSD M5 bars`);
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
