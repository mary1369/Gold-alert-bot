// server_v6.js - Fast Dispatcher
const express = require('express');
const fetch = require('node-fetch');
const { analyzeAggressiveSMC } = require('./strategy_v71');

const app = express();
const PORT = process.env.PORT || 3000;

// اطلاعات ربات تلگرام خود را جایگزین کنید
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID';

let lastSignalTime = 0;

function sendTelegramSignal(signal) {
  const now = Date.now();
  if (now - lastSignalTime < 60000) return; // جلوگیری از سیگنال تکراری
  lastSignalTime = now;

  const emoji = signal.type === 'BUY_LIMIT' ? '🟢' : '🔴';
  const text = `${emoji} *NEW SMC AGGRESSIVE SIGNAL*\n` +
               `-----------------------------------\n` +
               `📌 *Order:* \`${signal.type}\`\n` +
               `🎯 *Entry:* \`$${signal.entryPrice}\`\n` +
               `🛑 *Stop Loss:* \`$${signal.stopLoss}\`\n` +
               `🏆 *Take Profit:* \`$${signal.takeProfit}\`\n` +
               `💡 *Reason:* ${signal.reason}\n` +
               `-----------------------------------`;

  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' })
  }).catch(err => console.error('Telegram Error:', err));
}

app.get('/status', (req, res) => res.send('Bot is running...'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
