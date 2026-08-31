const fs = require('fs');

const j = JSON.parse(fs.readFileSync('/tmp/xau.json', 'utf8'));
const raw = Array.isArray(j?.bars) ? j.bars : [];
const bars = raw.filter(b => !b?.isOpen).map(b => ({
  time: Date.parse(b.openTime),
  open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
  volume: Number(b.volume ?? b.tickVolume ?? 0) || 0
})).filter(b => Number.isFinite(b.time) && [b.open,b.high,b.low,b.close].every(Number.isFinite)).sort((a,b)=>a.time-b.time);
const out=[];
for(const b of bars){ if(!out.length || b.time>out.at(-1).time) out.push(b); }
const MIN_M5=1200;
if(out.length<MIN_M5) throw new Error(`Insufficient closed XAUUSD M5 history: ${out.length} bars (minimum ${MIN_M5})`);
const latest=out.at(-1).time;
const age=Date.now()-latest;
const latestMinute=new Date(latest).getUTCMinutes();
const utcHour=new Date().getUTCHours();
const rolloverGap = latestMinute >= 58 && age >= 0 && age <= 90*60*1000;
const marketBreak=utcHour===21;
const maxAge=(marketBreak || rolloverGap) ? 90*60*1000 : 20*60*1000;
if(age<0 || age>maxAge) throw new Error(`Stale XAUUSD M5 data after parse: latest=${new Date(latest).toISOString()} age=${Math.round(age/60000)}m max=${Math.round(maxAge/60000)}m`);
const trimmed=out.slice(-3000);
fs.writeFileSync('xauusd_m5.json',JSON.stringify(trimmed,null,2));
console.log(`Loaded ${trimmed.length} unique closed XAUUSD M5 bars; latest=${new Date(latest).toISOString()}; marketBreak=${marketBreak}; rolloverGap=${rolloverGap}`);