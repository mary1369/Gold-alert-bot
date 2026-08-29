const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({limit:'32kb'}));

const PORT = Number(process.env.PORT || 3000);
const BRIDGE_SECRET = process.env.ORDERFLOW_BRIDGE_SECRET || '';
const MAX_AGE_MS = 15000;
let latest = null;

function timingSafeEqual(a,b){
  const aa=Buffer.from(String(a)); const bb=Buffer.from(String(b));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}

app.get('/health',(_req,res)=>res.json({ok:true,service:'mt5-orderflow-bridge'}));
app.get('/orderflow',(_req,res)=>{
  if(!latest) return res.status(404).json({ok:false,error:'no_orderflow'});
  if(Date.now()-latest.receivedAt>MAX_AGE_MS) return res.status(410).json({ok:false,error:'stale_orderflow'});
  return res.json(latest.data);
});

app.post('/mt5/orderflow',(req,res)=>{
  if(!BRIDGE_SECRET) return res.status(503).json({ok:false,error:'bridge_secret_not_configured'});
  const auth=String(req.get('authorization')||'');
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  if(!timingSafeEqual(token,BRIDGE_SECRET)) return res.status(401).json({ok:false,error:'unauthorized'});
  const b=req.body||{};
  const required=['source','symbol','time','delta','cvdSlope','tickCount'];
  if(required.some(k=>b[k]===undefined||b[k]===null)) return res.status(400).json({ok:false,error:'missing_fields'});
  if(String(b.source)!=='MT5') return res.status(400).json({ok:false,error:'source_must_be_MT5'});
  if(String(b.symbol).toUpperCase()!=='XAUUSD') return res.status(400).json({ok:false,error:'symbol_must_be_XAUUSD'});
  const t=Date.parse(b.time);
  if(!Number.isFinite(t)||Math.abs(Date.now()-t)>MAX_AGE_MS) return res.status(400).json({ok:false,error:'stale_or_invalid_timestamp'});
  if(!Number.isFinite(Number(b.delta))||!Number.isFinite(Number(b.cvdSlope))||!Number.isFinite(Number(b.tickCount))||Number(b.tickCount)<5) return res.status(400).json({ok:false,error:'invalid_flow_values'});
  latest={data:{source:'MT5',symbol:'XAUUSD',time:new Date(t).toISOString(),delta:Number(b.delta),cvdSlope:Number(b.cvdSlope),imbalance:String(b.imbalance||'NEUTRAL'),absorption:String(b.absorption||'NONE'),tickCount:Number(b.tickCount)},receivedAt:Date.now()};
  return res.status(200).json({ok:true});
});

app.listen(PORT,()=>console.log(`MT5 Order Flow bridge listening on ${PORT}`));
