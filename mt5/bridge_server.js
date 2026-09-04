const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.MT5_ORDERFLOW_KEY || '';
const FILE = process.env.ORDERFLOW_FILE || './orderflow.json';
const HISTORY_FILE = process.env.ORDERFLOW_HISTORY_FILE || path.join(path.dirname(FILE), 'orderflow_history.jsonl');

app.use(express.json({ limit: '32kb' }));

function authorized(req) {
  if (!API_KEY) return true;
  return req.get('X-API-Key') === API_KEY || req.get('X-OrderFlow-Key') === API_KEY;
}

function finiteFields(x) {
  return ['delta', 'cvd', 'buyVolume', 'sellVolume', 'imbalance', 'absorption']
    .every(k => Number.isFinite(Number(x[k])));
}

function valid(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.isReal !== true) return false;
  if (!String(x.source || '').toUpperCase().startsWith('MT5')) return false;
  if (!String(x.symbol || '').toUpperCase().includes('XAUUSD')) return false;
  if (!x.timestamp || !Number.isFinite(Date.parse(x.timestamp))) return false;
  if (!finiteFields(x)) return false;
  return true;
}

function appendHistory(payload) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(payload) + '\n', 'utf8');
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'XAUUSD MT5 Order Flow Bridge', history: HISTORY_FILE }));

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

app.get('/mt5/orderflow/history', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!fs.existsSync(HISTORY_FILE)) return res.json({ ok: true, count: 0, records: [] });
  const from = req.query.from ? Date.parse(String(req.query.from)) : -Infinity;
  const to = req.query.to ? Date.parse(String(req.query.to)) : Infinity;
  if (!Number.isFinite(from) && req.query.from) return res.status(400).json({ ok: false, error: 'bad_from' });
  if (!Number.isFinite(to) && req.query.to) return res.status(400).json({ ok: false, error: 'bad_to' });
  const records = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(x => x && valid(x)).filter(x => {
    const t = Date.parse(x.timestamp);
    return t >= from && t <= to;
  });
  res.json({ ok: true, count: records.length, records });
});

app.post('/mt5/orderflow', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!valid(req.body)) return res.status(422).json({ ok: false, error: 'invalid order-flow payload' });
  const payload = { ...req.body, receivedAt: new Date().toISOString(), historyVersion: 1 };
  fs.writeFileSync(FILE, JSON.stringify(payload, null, 2));
  appendHistory(payload);
  res.json({ ok: true, receivedAt: payload.receivedAt, persisted: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MT5 Order Flow Bridge listening on ${PORT}`);
});
