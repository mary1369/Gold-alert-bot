const express = require('express');
const { analyzeAggressiveSMC } = require('./strategy_v71');

const app = express();
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HISTORY_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=5m&range=1d';

let lastProcessedCandle = null;
let lastSignalKey = null;
let lastError = null;

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeYahoo(result) {
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const candles = [];

  for (let i = 0; i < timestamps.length; i++) {
    const open = num(quote.open?.[i]);
    const high = num(quote.high?.[i]);
    const low = num(quote.low?.[i]);
    const close = num(quote.close?.[i]);

    if (open !== null && high !== null && low !== null && close !== null) {
      candles.push({
        time: timestamps[i] * 1000,
        open,
        high,
        low,
        close
      });
    }
  }

  return candles.sort((a, b) => a.time - b.time);
}

async function fetchCandles() {
  const response = await fetch(HISTORY_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  if (!response.ok) {
    throw new Error(`Yahoo HTTP ${response.status}`);
  }

  const json = await response.json();
  const result = json?.chart?.result?.[0];

  if (!result) {
    throw new Error('Yahoo returned no XAUUSD data');
  }

  const candles = normalizeYahoo(result);

  if (candles.length < 10) {
    throw new Error(`Not enough candles: ${candles.length}`);
  }

  return candles;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      })
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}: ${body}`);
  }

  const json = JSON.parse(body);
  if (!json.ok) {
    throw new Error(`Telegram API error: ${body}`);
  }
}

function formatSignal(signal) {
  const emoji = signal.type === 'BUY_LIMIT' ? '🟢' : '🔴';

  return `${emoji} NEW XAUUSD SIGNAL\n\n` +
    `Order: ${signal.type}\n` +
    `Entry: ${signal.entryPrice}\n` +
    `Stop Loss: ${signal.stopLoss}\n` +
    `Take Profit: ${signal.takeProfit}\n` +
    `Reason: ${signal.reason}`;
}

async function checkMarket() {
  try {
    const candles = await fetchCandles();

    // Yahoo's last 5m candle can still be forming. Analyze only closed candles.
    const closedCandles = candles.slice(0, -1);
    const latestClosed = closedCandles.at(-1);

    if (!latestClosed) return;

    if (latestClosed.time === lastProcessedCandle) return;
    lastProcessedCandle = latestClosed.time;

    const signal = analyzeAggressiveSMC(closedCandles);

    console.log(
      `XAUUSD ${new Date(latestClosed.time).toISOString()} close=${latestClosed.close} signal=${signal ? signal.type : 'NONE'}`
    );

    if (!signal) return;

    const key = [
      signal.type,
      latestClosed.time,
      signal.entryPrice,
      signal.stopLoss,
      signal.takeProfit
    ].join('|');

    if (key === lastSignalKey) {
      console.log('Duplicate signal blocked:', key);
      return;
    }

    await sendTelegram(formatSignal(signal));
    lastSignalKey = key;
    console.log('Telegram signal sent:', key);
  } catch (error) {
    lastError = error.message;
    console.error('BOT ERROR:', error.message);
  }
}

app.get('/status', (req, res) => {
  res.json({
    ok: !lastError,
    bot: 'Gold Alert Bot',
    lastProcessedCandle,
    lastSignalKey,
    lastError
  });
});

app.get('/', (req, res) => {
  res.send('Gold Alert Bot is running');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  checkMarket();
  setInterval(checkMarket, 60 * 1000);
});
