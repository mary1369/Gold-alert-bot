const fs = require('fs');
const https = require('https');
const { getHistoricalRates } = require('dukascopy-node');

const DAY=24*60*60*1000,M5=5*60*1000,NOW=Date.now(),MIN_M5=1200,MAX_AGE_MS=20*60*1000,MIN_TAIL=60;
function normalizeTimestamp(v){const n=Number(v);if(!Number.isFinite(n))return NaN;return n<1e11?n*1000:n}
function normalizeRows(rows){return(rows||[]).map(r=>{const ts=normalizeTimestamp(r?.timestamp??r?.time??r?.[0]);const open=Number(r?.open??r?.[1]),high=Number(r?.high??r?.[2]),low=Number(r?.low??r?.[3]),close=Number(r?.close??r?.[4]);const volume=Number(r?.volume??r?.tickVolume??r?.[5]??0)||0;if(!Number.isFinite(ts)||![open,high,low,close].every(Number.isFinite))return null;return{openTime:new Date(ts).toISOString(),open,high,low,close,volume,isOpen:false}}).filter(Boolean)}
function loadCachedBars(){try{return fs.existsSync('xauusd_m5.json')?normalizeRows(JSON.parse(fs.readFileSync('xauusd_m5.json','utf8'))):[]}catch(e){console.log(`Cached history unavailable: ${e.message}`);return[]}}
function uniqueSorted(bars){const m=new Map();for(const b of bars||[])m.set(b.openTime,b);return[...m.values()].sort((a,b)=>Date.parse(a.openTime)-Date.parse(b.openTime))}
function latestTime(bars){return bars.length?Date.parse(bars.at(-1).openTime):NaN}
function ageMs(bars){const t=latestTime(bars);return Number.isFinite(t)?NOW-t:Infinity}
function isFresh(bars){return bars.length>=MIN_M5&&ageMs(bars)>=0&&ageMs(bars)<=MAX_AGE_MS}
function hasFreshTail(bars){return bars.length>=MIN_TAIL&&ageMs(bars)>=0&&ageMs(bars)<=MAX_AGE_MS}
async function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function httpGetJson(url,timeoutMs=12000){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Gold-alert-bot/5.0','Accept':'application/json'}},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>{if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){return httpGetJson(new URL(res.headers.location,url).toString(),timeoutMs).then(resolve,reject)}if(res.statusCode!==200)return reject(new Error(`HTTP ${res.statusCode}`));try{resolve(JSON.parse(body))}catch(e){reject(e)}})});req.setTimeout(timeoutMs,()=>req.destroy(new Error('request timeout')));req.on('error',reject)})}
async function fetchBiquoteM5(){
  const now=new Date(NOW), olderTo=new Date(NOW-1000*M5), olderFrom=new Date(NOW-2000*M5);
  const urls=[`https://biquote.io/api/XAUUSD/ohlc?interval=5m&limit=1000`,
    `https://biquote.io/api/XAUUSD/ohlc?interval=5m&limit=1000&from=${encodeURIComponent(olderFrom.toISOString())}&to=${encodeURIComponent(olderTo.toISOString())}`];
  const sets=[];
  for(const url of urls){const j=await httpGetJson(url);const rows=Array.isArray(j?.bars)?j.bars:[];sets.push(rows.map(b=>({openTime:b.openTime,open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),volume:Number(b.volume??b.tickVolume??0)||0,isOpen:b.isOpen===true})).filter(b=>b.openTime&&[b.open,b.high,b.low,b.close].every(Number.isFinite)&&!b.isOpen))}
  return uniqueSorted(sets.flat());
}
async function fetchM5(days){const{getHistoricalRates}=require('dukascopy-node');const data=await getHistoricalRates({instrument:'xauusd',dates:{from:new Date(NOW-days*DAY),to:new Date(NOW-5*60*1000)},timeframe:'m5',priceType:'bid',format:'array',volumes:true,ignoreFlats:false,batchSize:1,pauseBetweenBatchesMs:5000,retryCount:1,pauseBetweenRetriesMs:5000,retryOnEmpty:true,failAfterRetryCount:1});return normalizeRows(Array.isArray(data)?data:data?.data)}
async function fetchTicks(hours){const{getHistoricalRates}=require('dukascopy-node');const data=await getHistoricalRates({instrument:'xauusd',dates:{from:new Date(NOW-hours*60*60*1000),to:new Date(NOW)},timeframe:'tick',priceType:'bid',format:'array',batchSize:1,pauseBetweenBatchesMs:5000,retryCount:1,pauseBetweenRetriesMs:5000,retryOnEmpty:true,failAfterRetryCount:1});return Array.isArray(data)?data:data?.data}
function ticksToM5(ticks){const m=new Map();for(const t of ticks||[]){const ts=normalizeTimestamp(t?.timestamp??t?.time??t?.[0]),bid=Number(t?.bidPrice??t?.bid??t?.[2]);if(!Number.isFinite(ts)||!Number.isFinite(bid)||bid<=0)continue;const b=Math.floor(ts/M5)*M5;let c=m.get(b);if(!c)c={openTime:new Date(b).toISOString(),open:bid,high:bid,low:bid,close:bid,volume:0,isOpen:false};c.high=Math.max(c.high,bid);c.low=Math.min(c.low,bid);c.close=bid;c.volume++;m.set(b,c)}return[...m.values()].sort((a,b)=>Date.parse(a.openTime)-Date.parse(b.openTime))}
(async()=>{
 let cached=loadCachedBars();console.log(`Cached XAUUSD M5 bars: ${cached.length}`);if(cached.length)console.log(`Cached latest: ${new Date(latestTime(cached)).toISOString()} | age=${Math.round(ageMs(cached)/60000)}m`);
 let bars=[];
 // Provider 1: Biquote free XAUUSD OHLC. Two paged calls give up to ~2000 closed M5 bars.
 try{const b=await fetchBiquoteM5();console.log(`Biquote XAUUSD M5: ${b.length}`);if(b.length)bars=b}catch(e){console.log(`Biquote M5 failed: ${e.message}`)}
 // Provider 2: Dukascopy historical M5 when available.
 if(!isFresh(bars)){for(const days of [2,1,0.5]){try{const fresh=uniqueSorted(await fetchM5(days));console.log(`Dukascopy M5 ${days}d: ${fresh.length}`);if(fresh.length>=MIN_M5&&isFresh(fresh)){bars=fresh;break}if(fresh.length)bars=uniqueSorted([...bars,...fresh])}catch(e){console.log(`Dukascopy M5 ${days}d failed: ${e.message}`);if(/429|rate.?limit/i.test(String(e)))await sleep(12000)}}}
 // Provider 3: Dukascopy tick edge if cached history is structurally adequate.
 if(!isFresh(bars)&&cached.length>=MIN_M5){try{const tail=ticksToM5(await fetchTicks(2));console.log(`Historical tick tail: ${tail.length} M5 buckets`);if(hasFreshTail(tail))bars=uniqueSorted([...cached,...tail])}catch(e){console.log(`Historical tick tail failed: ${e.message}`)}}
 bars=uniqueSorted([...cached,...bars]);
 if(bars.length<MIN_M5)throw new Error(`Insufficient XAUUSD M5 history: ${bars.length}`);
 const latest=latestTime(bars),age=NOW-latest;console.log(`Final XAUUSD M5 candle UTC: ${new Date(latest).toISOString()} | age=${Math.round(age/60000)}m | bars=${bars.length}`);
 if(age<0||age>MAX_AGE_MS)throw new Error(`No fresh XAUUSD M5 feed: latest=${new Date(latest).toISOString()} age=${Math.round(age/60000)}m`);
 fs.writeFileSync('/tmp/xau.json',JSON.stringify({symbol:'XAUUSD',interval:'5m',bars:bars.slice(-3000)}));console.log(`Published ${Math.min(bars.length,3000)} unique fresh XAUUSD M5 bars`);
})();