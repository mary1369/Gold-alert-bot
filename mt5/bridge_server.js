const express = require('express');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.MT5_ORDERFLOW_KEY || '';
const FILE = process.env.ORDERFLOW_FILE || './orderflow.json';

app.use(express.json({ limit: '32kb' }));

function authorized(req) {
  if (!API_KEY) return true;
  return req.get('X-API-Key') === API_KEY;
}

function valid(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.isReal !== true) return false;
  if (!String(x.source || '').toUpperCase().startsWith('MT5')) return false;
  if (!Number.isFinite(Number(x.delta))) return false;
  if (!x.time && !x.timestamp) return false;
  return true;
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'XAUUSD MT5 Order Flow Bridge' }));

app.get('/mt5/orderflow', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!fs.existsSync(FILE)) return res.status(404).json({ ok: false, error: 'no order-flow data' });
  try {
    const x = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!valid(x)) return res.status(422).json({ ok: false, error: 'invalid order-flow data' });
    res.json(x);
  } catch {
    res.status(500).json({ ok: false, error: 'invalid stored JSON' });
  }
});

app.post('/mt5/orderflow', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!valid(req.body)) return res.status(422).json({ ok: false, error: 'invalid order-flow payload' });
  const payload = { ...req.body, receivedAt: new Date().toISOString() };
  fs.writeFileSync(FILE, JSON.stringify(payload, null, 2));
  res.json({ ok: true, receivedAt: payload.receivedAt });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MT5 Order Flow Bridge listening on ${PORT}`);
});
