const fs = require('fs');
const https = require('https');
const { getHistoricalRates } = require('dukascopy-node');

const DAY = 24 * 60 * 60 * 1000;
const M5 = 5 * 60 * 1000;
const NOW = Date.now();
const MIN_M5 = 1200;
const MAX_AGE_MS = 20 * 60 * 1000;
const MIN_TAIL = 60;

function normalizeTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n < 1e11 ? n * 1000 : n;
}
function normalizeRows(rows) {
  return (rows || []).map(r => {
    const ts=normalizeTimestamp(r?.timestamp ?? r?.time ?? r?.[0]);
    const open=Number(r?.open ?? r?.[1]), high=Number(r?.high ?? r?.[2]), low=Number(r?.low ?? r?.[3]), close=Number(r?.close ?? r?.[4]);
    const volume=Number(r?.volume ?? r?.tickVolume ?? r?.[5] ?? 0)||0;
    if(!Number.isFinite(ts)||![open,high,low,close].every(Number.isFinite)) return null;
    return {openTime:new Date(ts).toISOString(),open,high,low,close,volume,isOpen:false};
  }).filter(Boolean);
}
function loadCachedBars(){try{if(!fs.existsSync('xauusd_m5.json'))return[];return normalizeRows(JSON.parse(fs.readFileSync('xauusd_m5.json','utf8')))}catch(e){console.log(`Cached history unavailable: ${e.message}`);return[]}}
function uniqueSorted(bars){const m=new Map();for(const b of bars||[])m.set(b.openTime,b);return [...m.values()].sort((a,b)=>Date.parse(a.openTime)-Date.parse(b.openTime))}
function latestTime(bars){return bars.length?Date.parse(bars.at(-1).openTime):NaN}
function ageMs(bars){const t=latestTime(bars);return Number.isFinite(t)?NOW-t:Infinity}
function isFresh(bars){return bars.length>=MIN_M5&&ageMs(bars)>=0&&ageMs(bars)<=MAX_AGE_MS}
function hasFreshTail(bars){return bars.length>=MIN_TAIL&&ageMs(bars)>=0&&ageMs(bars)<=MAX_AGE_MS}
async function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function httpGetJson(url, timeoutMs=12000){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Gold-alert-bot/5.0'}},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>{if(res.statusCode!==200)return reject(new Error(`HTTP ${res.statusCode}`));try{resolve(JSON.parse(body))}catch(e){reject(e)}})});req.setTimeout(timeoutMs,()=>req.destroy(new Error('request timeout')));req.on('error',reject)})}
async function fetchM5(days){const data=await getHistoricalRates({instrument:'xauusd',dates:{from:new Date(NOW-days*DAY),to:new Date(NOW-5*60*1000)},timeframe:'m5',priceType:'bid',format:'array',volumes:true,ignoreFlats:false,batchSize:1,pauseBetweenBatchesMs:5000,retryCount:1,pauseBetweenRetriesMs:5000,retryOnEmpty:true,failAfterRetryCount:1});return normalizeRows(Array.isArray(data)?data:data?.data)}
async function fetchTicks(hours){const data=await getHistoricalRates({instrument:'xauusd',dates:{from:new Date(NOW-hours*60*60*1000),to:new Date(NOW)},timeframe:'tick',priceType:'bid',format:'array',batchSize:1,pauseBetweenBatchesMs:5000,retryCount:1,pauseBetweenRetriesMs:5000,retryOnEmpty:true,failAfterRetryCount:1});return Array.isArray(data)?data:data?.data}
function ticksToM5(ticks){const m=new Map();for(const t of ticks||[]){const ts=normalizeTimestamp(t?.timestamp??t?.time??t?.[0]);const bid=Number(t?.bidPrice??t?.bid??t?.[2]);if(!Number.isFinite(ts)||!Number.isFinite(bid)||bid<=0)continue;const b=Math.floor(ts/M5)*M5;let c=m.get(b);if(!c)c={openTime:new Date(b).toISOString(),open:bid,high:bid,low:bid,close:bid,volume:0,isOpen:false};c.high=Math.max(c.high,bid);c.low=Math.min(c.low,bid);c.close=bid;c.volume++;m.set(b,c)}return [...m.values()].sort((a,b)=>Date.parse(a.openTime)-Date.parse(b.openTime))}
async function fetchYahooM5(){
  const period2=Math.floor((NOW-5*60*1000)/1000), period1=period2-60*24*60*60;
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?period1=${period1}&period2=${period2}&interval=5m&events=history&includeAdjustedClose=true`;
  const j=await httpGetJson(url); const r=j?.chart?.result?.[0]; if(!r?.timestamp?.length) throw new Error('Yahoo chart returned no XAUUSD=X bars');
  const q=r.indicators?.quote?.[0]||{}; const out=[];
  for(let i=0;i<r.timestamp.length;i++){const o=Number(q.open?.[i]),h=Number(q.high?.[i]),l=Number(q.low?.[i]),c=Number(q.close?.[i]); if([o,h,l,c].every(Number.isFinite)) out.push({openTime:new Date(r.timestamp[i]*1000).toISOString(),open:o,high:h,low:l,close:c,volume:Number(q.volume?.[i]||0),isOpen:false})}
  return uniqueSorted(out);
}
async function fetchGoldPriceFresh(){
  const j=await httpGetJson('https://www.goldprice.dev/v1/prices?symbol=XAU-USD-SPOT');
  const ts=Date.parse(j?.computed_at||''); const price=Number(j?.price); if(!Number.isFinite(ts)||!Number.isFinite(price)) throw new Error('GoldPrice.dev invalid response');
  if(Date.now()-ts>10*60*1000 || j?.is_stale===true) throw new Error('GoldPrice.dev price is stale');
  console.log(`GoldPrice.dev fresh spot validation: ${price} | age=${Math.round((Date.now()-ts)/60000)}m`);
  return true;
}
(async()=>{
 let cached=loadCachedBars();console.log(`Cached XAUUSD M5 bars: ${cached.length}`);if(cached.length)console.log(`Cached latest: ${new Date(latestTime(cached)).toISOString()} | age=${Math.round(ageMs(cached)/60000)}m`);
 let bars=[];
 for(const days of [2,1,0.5]){try{const fresh=uniqueSorted(await fetchM5(days));console.log(`Dukascopy M5 ${days}d: ${fresh.length}`);if(fresh.length>=MIN_M5&&isFresh(fresh)){bars=fresh;break}if(fresh.length)bars=uniqueSorted([...bars,...fresh]);}catch(e){console.log(`Dukascopy M5 ${days}d failed: ${e.message}`);if(/429|rate.?limit/i.test(String(e))){await sleep(12000)}}}
 if(!isFresh(bars)&&cached.length>=MIN_M5){try{const ticks=await fetchTicks(2);const tail=ticksToM5(ticks);console.log(`Historical tick tail: ${tail.length} M5 buckets`);if(hasFreshTail(tail))bars=uniqueSorted([...cached,...tail]);}catch(e){console.log(`Historical tick tail failed: ${e.message}`)}}
 if(!isFresh(bars)){
   try { const yahoo=await fetchYahooM5(); console.log(`Yahoo XAUUSD=X M5: ${yahoo.length}`); if(isFresh(yahoo)) bars=yahoo; else console.log(`Yahoo M5 is not fresh: age=${Math.round(ageMs(yahoo)/60000)}m`); }
   catch(e){ console.log(`Yahoo XAUUSD=X fallback failed: ${e.message}`); }
 }
 if(!isFresh(bars)){
   try { await fetchGoldPriceFresh(); } catch(e) { console.log(`GoldPrice.dev validation failed: ${e.message}`); }
 }
 bars=uniqueSorted([...cached,...bars]);
 if(bars.length<MIN_M5)throw new Error(`Insufficient XAUUSD M5 history: ${bars.length}`);
 const latest=latestTime(bars),age=NOW-latest;console.log(`Final XAUUSD M5 candle UTC: ${new Date(latest).toISOString()} | age=${Math.round(age/60000)}m | bars=${bars.length}`);
 if(age<0||age>MAX_AGE_MS)throw new Error(`No fresh XAUUSD M5 feed: latest=${new Date(latest).toISOString()} age=${Math.round(age/60000)}m`);
 fs.writeFileSync('/tmp/xau.json',JSON.stringify({symbol:'XAUUSD',interval:'5m',bars}));
 console.log(`Published ${bars.length} unique fresh XAUUSD M5 bars`);
})();