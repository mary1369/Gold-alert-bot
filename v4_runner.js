const fs = require('fs');

// Single analysis entry point. The data feed is refreshed by the workflow;
// this runner only loads the local candles and starts the current signal engine.
const candlesFile = './xauusd_m5.json';

function localCandles() {
  try {
    const d = JSON.parse(fs.readFileSync(candlesFile, 'utf8'));
    return Array.isArray(d) ? d.filter(c => c && Number.isFinite(Number(c.time)) && Number.isFinite(Number(c.open)) && Number.isFinite(Number(c.high)) && Number.isFinite(Number(c.low)) && Number.isFinite(Number(c.close))) : [];
  } catch {
    return [];
  }
}

const d = localCandles();
if (d.length < 1200) throw new Error(`Need >=1200 M5 candles, got ${d.length}`);
console.log(`V5 DATA: ${d.length} local closed/available M5 candles`);

// The signal engine reads the same local data directly. No Yahoo, gold-api,
// Order Flow, or MT5 dependency is injected here.
require('./server_v5.js');
