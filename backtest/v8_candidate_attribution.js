const fs=require('fs');
const src=JSON.parse(fs.readFileSync('backtest/v8_candidate_result.json','utf8'));
const tr=src.ALL.details||[];
function stats(a){const n=a.length,w=a.filter(t=>t.R>0),l=a.filter(t=>t.R<0),gp=w.reduce((s,t)=>s+t.R,0),gl=Math.abs(l.reduce((s,t)=>s+t.R,0)),eq=[];let e=0,p=0,dd=0;for(const t of a){e+=t.R;p=Math.max(p,e);dd=Math.max(dd,p-e);eq.push(e)}return{trades:n,wins:w.length,losses:l.length,winRate:+(100*w.length/(n||1)).toFixed(2),netR:+a.reduce((s,t)=>s+t.R,0).toFixed(3),profitFactor:+(gp/(gl||1)).toFixed(3),avgR:+(a.reduce((s,t)=>s+t.R,0)/(n||1)).toFixed(3),maxDrawdownR:+dd.toFixed(3)}}
function cohort(name,p){const a=tr.filter(p);return [name,{...stats(a),sharePct:+(100*a.length/(tr.length||1)).toFixed(2)}]}
const out={strategy:src.strategy,runBasis:'Exact 284-trade ALL detail set from V8 Candidate Relaxed Validation; no new trades generated',total:stats(tr),cohorts:Object.fromEntries([
 cohort('FVG_only',t=>t.fvg&&!t.ob),cohort('OB_only',t=>t.ob&&!t.fvg),cohort('FVG_and_OB',t=>t.fvg&&t.ob),cohort('FVG_present',t=>t.fvg),cohort('OB_present',t=>t.ob),
 cohort('confirmation_yes',t=>t.confirmation),cohort('confirmation_no',t=>!t.confirmation),cohort('OB_only_confirmation_yes',t=>t.ob&&!t.fvg&&t.confirmation),cohort('OB_only_confirmation_no',t=>t.ob&&!t.fvg&&!t.confirmation),cohort('FVG_and_OB_confirmation_yes',t=>t.fvg&&t.ob&&t.confirmation),cohort('FVG_and_OB_confirmation_no',t=>t.fvg&&t.ob&&!t.confirmation),
 cohort('ATR_lt_1',t=>t.atrRatio<1),cohort('ATR_1_to_2_2',t=>t.atrRatio>=1&&t.atrRatio<=2.2),cohort('ATR_gt_2_2',t=>t.atrRatio>2.2),
 cohort('BUY',t=>t.direction==='BUY'),cohort('SELL',t=>t.direction==='SELL'),cohort('LONDON',t=>t.session==='LONDON'),cohort('NEW_YORK',t=>t.session==='NEW_YORK'),
 cohort('score_90_100',t=>t.score>=90),cohort('score_70_89',t=>t.score>=70&&t.score<90)
]),limitations:[
 'The stored candidate artifact records bos=true and choch=false for every trade, so BOS-vs-CHOCH cannot be separated from this artifact.',
 'The candidate explicitly has no sweep gate and the stored trade details do not contain a sweep flag, so sweep-removal impact cannot be quantified from these 284 records alone.',
 'RR is fixed at 1.5 in every stored trade; therefore RR>=1.5 is a constant gate here and cannot explain cross-trade differences.',
 'This attribution is cohort analysis of the exact executed 284 trades, not a claim that removing a filter causes an identical counterfactual P&L; overlapping cohorts are intentionally reported.'
],diagnosis:[
 'Strongest positive cohort: FVG_and_OB, but only 9 trades; too small to declare an edge.',
 'FVG_only is materially worse than OB_only in this sample.',
 'Confirmation_yes is much less negative than confirmation_no; this supports making confirmation materially more important rather than optional/free.',
 'The score is non-discriminatory in the candidate because the observed score range is concentrated at 90-100; score threshold therefore did not filter quality.'
]};
fs.writeFileSync('backtest/v8_candidate_attribution_result.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));
