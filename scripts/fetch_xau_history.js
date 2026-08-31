const fs=require('fs');
const {getHistoricalRates}=require('dukascopy-node');
const DAY=86400000,M5=300000,NOW=Date.now(),MIN_M5=1200,MAX_AGE_MS=20*60000,MIN_TAIL=60;
function ts(v){const n=Number(v);return Number.isFinite(n)?(n<1e11?n*1000:n):NaN}
function norm(rows){return(rows||[]).map(r=>{const t=ts(r?.timestamp??r?.time??r?.[0]);const o=Number(r?.open??r?.[1]),h=Number(r?.high??r?.[2]),l=Number(r?.low??r?.[3]),c=Number(r?.close??r?.[4]),v=Number(r?.volume??r?.tickVolume??r?.[5]??0)||0;return Number.isFinite(t)&&[o,h,l,c].every(Number.isFinite)?{openTime:new Date(t).toISOString(),open:o,high:h,low:l,close:c,volume:v,isOpen:false}:null}).filter(Boolean)}
function unique(a){const m=new Map();for(const b of a||[])m.set(b.openTime,b);return[...m.values()].sort((x,y)=>Date.parse(x.openTime)-Date.parse(y.openTime))}
function load(){try{return fs.existsSync('xauusd_m5.json')?norm(JSON.parse(fs.readFileSync('xauusd_m5.json','utf8'))):[]}catch(e){console.log(`Cache unavailable: ${e.message}`);return[]}}
function latest(a){return a.length?Date.parse(a.at(-1).openTime):NaN}
function fresh(a){const age=NOW-latest(a);return a.length>=MIN_M5&&age>=0&&age<=MAX_AGE_MS}
function freshTail(a){const age=NOW-latest(a);return a.length>=MIN_TAIL&&age>=0&&age<=MAX_AGE_MS}
async function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
async function dukM5(days){const data=await getHistoricalRates({instrument:'xauusd',dates:{from:new Date(NOW-days*DAY),to:new Date(NOW-M5)},timeframe:'m5',priceType:'bid',format:'array',volumes:true,ignoreFlats:false,batchSize:1,pauseBetweenBatchesMs:7000,retryCount:2,pauseBetweenRetriesMs:10000,retryOnEmpty:true,failAfterRetryCount:2});return norm(Array.isArray(data)?data:data?.data)}
async function dukTicks(hours){const data=await getHistoricalRates({instrument:'xauusd',dates:{from:new Date(NOW-hours*3600000),to:new Date(NOW)},timeframe:'tick',priceType:'bid',format:'array',batchSize:1,pauseBetweenBatchesMs:7000,retryCount:2,pauseBetweenRetriesMs:10000,retryOnEmpty:true,failAfterRetryCount:2});return Array.isArray(data)?data:data?.data}
function ticksToM5(ticks){const m=new Map();for(const t of ticks||[]){const tms=ts(t?.timestamp??t?.time??t?.[0]),p=Number(t?.bidPrice??t?.bid??t?.[2]);if(!Number.isFinite(tms)||!Number.isFinite(p)||p<=0)continue;const k=Math.floor(tms/M5)*M5;let b=m.get(k);if(!b)b={openTime:new Date(k).toISOString(),open:p,high:p,low:p,close:p,volume:0,isOpen:false};b.high=Math.max(b.high,p);b.low=Math.min(b.low,p);b.close=p;b.volume++;m.set(k,b)}return[...m.values()].sort((a,b)=>Date.parse(a.openTime)-Date.parse(b.openTime))}
(async()=>{
 let cached=load(),bars=[];console.log(`Cached XAUUSD M5 bars: ${cached.length}`);if(cached.length)console.log(`Cached latest: ${new Date(latest(cached)).toISOString()} | age=${Math.round((NOW-latest(cached))/60000)}m`);
 // Bootstrap/refresh from the real historical M5 provider. Try smaller windows first to reduce rate-limit pressure.
 for(const days of [2,1,0.5,3,5]){if(fresh(bars))break;try{const got=unique(await dukM5(days));console.log(`Dukascopy M5 ${days}d: ${got.length}`);if(got.length)bars=unique([...bars,...got]);if(fresh(bars))break}catch(e){console.log(`Dukascopy M5 ${days}d failed: ${e.message}`);if(/429|rate.?limit/i.test(String(e)))await sleep(20000)}}
 // If historical M5 is unavailable but an adequate cache exists, refresh only the recent edge with ticks.
 if(!fresh(bars)&&cached.length>=MIN_M5){try{const tail=ticksToM5(await dukTicks(2));console.log(`Historical tick tail: ${tail.length} M5 buckets`);if(freshTail(tail))bars=unique([...cached,...tail])}catch(e){console.log(`Historical tick tail failed: ${e.message}`)}}
 bars=unique([...cached,...bars]);
 if(bars.length<MIN_M5)throw new Error(`Insufficient XAUUSD M5 history: ${bars.length}`);
 const lt=latest(bars),age=NOW-lt;console.log(`Final XAUUSD M5 candle UTC: ${new Date(lt).toISOString()} | age=${Math.round(age/60000)}m | bars=${bars.length}`);
 if(age<0||age>MAX_AGE_MS)throw new Error(`No fresh XAUUSD M5 feed: latest=${new Date(lt).toISOString()} age=${Math.round(age/60000)}m`);
 const out=bars.slice(-3000);fs.writeFileSync('/tmp/xau.json',JSON.stringify({symbol:'XAUUSD',interval:'5m',bars:out}));console.log(`Published ${out.length} unique fresh XAUUSD M5 bars`);
})().catch(e=>{console.error(e.message);process.exit(1)});
