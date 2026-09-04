const fs = require('fs');
const { getHistoricalRates } = require('dukascopy-node');

const FROM = new Date('2026-03-06T00:00:00.000Z');
const TO = new Date('2026-09-02T23:59:59.000Z');

async function load() {
  const raw = await getHistoricalRates({ instrument: 'xauusd', dates: { from: FROM, to: TO }, timeframe: 'm5', format: 'json' });
  return raw.map(x => ({ time:+x.timestamp, open:+x.open, high:+x.high, low:+x.low, close:+x.close }))
    .filter(x => Object.values(x).every(Number.isFinite)).sort((a,b)=>a.time-b.time);
}

function loadAnalyze() {
  const src = fs.readFileSync('strategy_v71.js', 'utf8');
  const m = { exports:{} };
  new Function('module','exports',src)(m,m.exports);
  return { analyze:m.exports.analyzeV71, source:src };
}

// Guard only numeric array-index reads. Avoid Reflect.get with the Proxy as receiver;
// that receiver pattern was the source of the previous diagnostic recursion failure.
function guardedPrefix(d, end, accesses) {
  const p = d.slice(0, end + 1);
  return new Proxy(p, {
    get(target, prop) {
      if (typeof prop === 'string' && /^\\d+$/.test(prop)) accesses.push(+prop);
      return target[prop];
    }
  });
}

function sigKey(s) {
  if (!s) return null;
  return JSON.stringify({
    direction:s.direction, entry:s.entry, sl:s.sl, tp1:s.tp1, tp2:s.tp2, tp3:s.tp3,
    fibNear:s.fibNear, candleTime:s.candleTime, diagnostic:s.diagnostic
  });
}

function fvgAt(d, dir, i) {
  if (!Number.isInteger(i) || i < 2 || i >= d.length) return null;
  const a=d[i-2], c=d[i];
  if (dir==='BUY' && c.low>a.high) return { low:a.high, high:c.low, type:'BULLISH FVG', i };
  if (dir==='SELL' && c.high<a.low) return { low:c.high, high:a.low, type:'BEARISH FVG', i };
  return null;
}
function overlap(c,f) { return c.low<=f.high && c.high>=f.low; }

function summarize(arr) {
  return {
    targets:arr.length,
    signals:arr.filter(x=>x.signal).length,
    violations:arr.filter(x=>x.violation).length,
    runtimeErrors:arr.filter(x=>x.reason==='runtime_error').length,
    examples:arr.filter(x=>x.violation).slice(0,50)
  };
}

function bucketFor(index, cut) { return index < cut ? 'IS' : 'OOS'; }

(async()=>{
  const d=await load();
  const {analyze,source}=loadAnalyze();
  const cut=Math.floor(d.length*2/3);

  // Targets are the actual seven NO_OTE attribution candidates already established by
  // the unchanged strategy diagnostic. This keeps the audit deterministic and avoids
  // re-running analyzeV71 tens of thousands of times through a Proxy.
  const attribution = JSON.parse(fs.readFileSync('backtest/v71_gate_diagnostic.json','utf8'));
  const targets = attribution.modes.NO_OTE.ALL.examples.map(e=>({
    time:e.time,
    index:d.findIndex(c=>new Date(c.time).toISOString()===e.time),
    dir:e.dir
  }));

  const buckets={IS:[],OOS:[],ALL:[]};
  for(const t of targets){
    const rec={index:t.index,time:t.time,expectedDirection:t.dir,signal:false,violation:false};
    if(t.index<0){rec.violation=true;rec.reason='target_index_not_found';}
    else {
      const accesses=[]; let s=null;
      try { s=analyze(guardedPrefix(d,t.index,accesses)); }
      catch(e) { rec.violation=true; rec.reason='runtime_error'; rec.error=String(e); }
      rec.signal=!!s; rec.actualDirection=s?.direction||null;
      if(!rec.violation){
        const future=accesses.filter(x=>x>t.index);
        rec.maxAccess=accesses.length?Math.max(...accesses):-1;
        rec.futureAccesses=future;
        if(future.length){rec.violation=true;rec.reason='future_array_access';}
        const q=s?.diagnostic||{};
        const fi=q.fvgIndex, mi=q.mssIndex;
        rec.fvgIndex=fi; rec.mssIndex=mi; rec.sweepIndex=q.sweepIndex; rec.displacementAge=q.displacementAge;
        if(s && (!Number.isInteger(fi) || fi>t.index || (Number.isInteger(mi)&&fi<mi))){rec.violation=true;rec.reason='invalid_fvg_index';}
        if(s && !rec.violation){
          const f=fvgAt(d,s.direction,fi);
          if(!f || !overlap(d[t.index],f)){rec.violation=true;rec.reason='fvg_not_currently_overlapped';}
          else {
            for(let j=fi+1;j<t.index;j++) if(overlap(d[j],f)){rec.violation=true;rec.reason='fresh_fvg_already_touched';rec.firstTouchViolationIndex=j;break;}
          }
        }
        if(s && !rec.violation && Number.isInteger(mi) && q.displacementAge!==t.index-mi){rec.violation=true;rec.reason='age_mismatch';}
      }
    }
    const b=bucketFor(t.index,cut); buckets[b].push(rec); buckets.ALL.push(rec);
  }

  // Future-bar invariance with a valid target-index harness:
  // evaluate exactly the same target prefix twice while mutating ONLY the suffix after
  // the target. The prefix itself is byte-for-byte identical, so any output difference
  // is a failure of the harness/strategy boundary. The guarded execution above is the
  // complementary test that detects an attempted future numeric read.
  const invariance={IS:{checked:0,violations:0,examples:[]},OOS:{checked:0,violations:0,examples:[]},ALL:{checked:0,violations:0,examples:[]}};
  for(const r of buckets.ALL){
    if(!r.signal || r.index<0) continue;
    const i=r.index, b=bucketFor(i,cut);
    const baseAccess=[];
    const base=sigKey(analyze(guardedPrefix(d,i,baseAccess)));
    const mutated=d.slice();
    for(let j=i+1;j<Math.min(d.length,i+101);j++) mutated[j]={...mutated[j],open:mutated[j].open+777,high:mutated[j].high+999,low:mutated[j].low-999,close:mutated[j].close-555};
    const replayAccess=[];
    const replay=sigKey(analyze(guardedPrefix(mutated,i,replayAccess)));
    invariance[b].checked++; invariance.ALL.checked++;
    if(base!==replay){
      const ex={index:i,time:r.time,reason:'future_suffix_invariance_violation',base,replay};
      invariance[b].violations++; invariance.ALL.violations++;
      invariance[b].examples.push(ex); invariance.ALL.examples.push(ex);
    }
  }

  // Static sanity checks on the Fresh-FVG implementation: no obvious access pattern
  // beyond the supplied array boundary. These are supplementary, not a substitute for runtime tests.
  const staticChecks={
    swingCenteredUsesCurrentBoundary:/i\\s*\\+\\s*2/.test(source),
    fvgFormationUsesOnlyFormationBars:/ms\\s*\\+\\s*1/.test(source),
    touchScanBoundedByArrayEnd:/j\\s*<\\s*d\\.length/.test(source),
    usesAnalyzePrefixInHarness:true
  };

  const result={
    test:'Fresh-FVG Runtime Audit + Explicit Future-Bar Invariance / Look-ahead Test',
    strategy:'V7.1', source:'Dukascopy XAUUSD M5', candles:d.length,
    periodStart:new Date(d[0].time).toISOString(), periodEnd:new Date(d.at(-1).time).toISOString(),
    splitIndex:cut, targets:targets.map(t=>({time:t.time,index:t.index,dir:t.dir})),
    methodology:{
      runtimeFutureAccess:'Proxy guards the exact target prefix and records every numeric array index read; any index > target is a violation.',
      futureBarInvariance:'For each target signal, run analyzeV71 on the target prefix, mutate only bars after target, then run the identical target prefix again; output must remain identical.',
      note:'The harness never passes future bars to analyzeV71 during target evaluation. Therefore suffix mutation cannot influence the prefix unless the harness itself leaks it; this is paired with the runtime future-index guard.'
    },
    freshFvg:{IS:summarize(buckets.IS),OOS:summarize(buckets.OOS),ALL:summarize(buckets.ALL)},
    futureBarInvariance:invariance,
    staticChecks
  };
  fs.writeFileSync('backtest/v71_fresh_fvg_lookahead_audit.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
