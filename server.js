const express = require("express");
const app = express();
app.use(express.json());

// ============ CONFIG ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_SECONDS = 30;          // how often we fetch the price (API allows this, no key needed)
const CANDLE_MINUTES = 5;         // build our own M5 candles from polled ticks
const SWING_LEN = 5;              // bars each side to confirm a swing high/low
const ATR_LEN = 14;
const SL_ATR_MULT = 1.2;
const TP1_ATR_MULT = 1.0;
const TP2_ATR_MULT = 2.0;
const TP3_ATR_MULT = 3.0;
const COOLDOWN_BARS = 6;          // min candles between two alerts of the same direction

// ============ STATE ============
let candles = [];              // {t, o, h, l, c}  t = bucket start (unix seconds)
let currentBucket = null;      // {t, o, h, l, c}
let lastAlertBar = { BUY: -999, SELL: -999 };

async function fetchPrice() {
  const res = await fetch("https://api.gold-api.com/price/XAU");
  if (!res.ok) throw new Error("price fetch failed: " + res.status);
  const data = await res.json();
  return data.price;
}

function bucketStart(nowSec) {
  const size = CANDLE_MINUTES * 60;
  return Math.floor(nowSec / size) * size;
}

async function pollTick() {
  try {
    const price = await fetchPrice();
    const nowSec = Math.floor(Date.now() / 1000);
    const b = bucketStart(nowSec);

    if (!currentBucket || currentBucket.t !== b) {
      if (currentBucket) {
        candles.push(currentBucket);
        if (candles.length > 500) candles.shift();
        onCandleClose();
      }
      currentBucket = { t: b, o: price, h: price, l: price, c: price };
    } else {
      currentBucket.h = Math.max(currentBucket.h, price);
      currentBucket.l = Math.min(currentBucket.l, price);
      currentBucket.c = price;
    }
  } catch (e) {
    console.error("poll error:", e.message);
  }
}

// ============ SMC ENGINE (ported from the XAU-SMC Pine indicator) ============
function computeATRSeries(cs, len) {
  const atr = new Array(cs.length).fill(null);
  let sum = 0;
  const trs = [];
  for (let i = 0; i < cs.length; i++) {
    const prevClose = i > 0 ? cs[i - 1].c : cs[i].c;
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - prevClose),
      Math.abs(cs[i].l - prevClose)
    );
    trs.push(tr);
    if (i >= len) sum += tr - trs[i - len];
    else sum += tr;
    if (i >= len - 1) atr[i] = sum / len;
  }
  return atr;
}

function isPivotHigh(cs, i, len) {
  if (i - len < 0 || i + len >= cs.length) return false;
  const h = cs[i].h;
  for (let k = i - len; k <= i + len; k++) if (k !== i && cs[k].h >= h) return false;
  return true;
}
function isPivotLow(cs, i, len) {
  if (i - len < 0 || i + len >= cs.length) return false;
  const l = cs[i].l;
  for (let k = i - len; k <= i + len; k++) if (k !== i && cs[k].l <= l) return false;
  return true;
}

function findLastOppositeBar(cs, i, wantBull) {
  for (let k = i - 1; k >= Math.max(0, i - 20); k--) {
    const bar = cs[k];
    if (wantBull && bar.c < bar.o) return { top: Math.max(bar.o, bar.c), bot: Math.min(bar.o, bar.l) };
    if (!wantBull && bar.c > bar.o) return { top: Math.max(bar.o, bar.h), bot: Math.min(bar.o, bar.c) };
  }
  return null;
}

function analyze(cs) {
  const atr = computeATRSeries(cs, ATR_LEN);
  let lastSwingHigh = null, lastSwingLow = null, trend = 0, lastEvent = "";
  let ob = null; // {top, bot, dir}
  let fvg = null; // {top, bot, dir}
  const signals = []; // {index, direction, entry, sl, tp1, tp2, tp3, event}

  for (let i = 0; i < cs.length; i++) {
    if (isPivotHigh(cs, i, SWING_LEN)) lastSwingHigh = cs[i].h;
    if (isPivotLow(cs, i, SWING_LEN)) lastSwingLow = cs[i].l;

    const c = cs[i].c;
    const prevC = i > 0 ? cs[i - 1].c : c;

    const bullBreak = lastSwingHigh != null && prevC <= lastSwingHigh && c > lastSwingHigh;
    const bearBreak = lastSwingLow != null && prevC >= lastSwingLow && c < lastSwingLow;

    if (bullBreak) {
      lastEvent = trend === -1 ? "CHOCH_UP" : "BOS_UP";
      trend = 1;
      const found = findLastOppositeBar(cs, i, true);
      if (found) ob = { top: found.top, bot: found.bot, dir: 1 };
    }
    if (bearBreak) {
      lastEvent = trend === 1 ? "CHOCH_DOWN" : "BOS_DOWN";
      trend = -1;
      const found = findLastOppositeBar(cs, i, false);
      if (found) ob = { top: found.top, bot: found.bot, dir: -1 };
    }

    if (i >= 2) {
      const bullFVG = cs[i].l > cs[i - 2].h;
      const bearFVG = cs[i].h < cs[i - 2].l;
      if (bullFVG) fvg = { top: cs[i].l, bot: cs[i - 2].h, dir: 1 };
      if (bearFVG) fvg = { top: cs[i - 2].l, bot: cs[i].h, dir: -1 };
    }

    const inBullZone = (ob && ob.dir === 1 && c <= ob.top && c >= ob.bot) || (fvg && fvg.dir === 1 && c <= fvg.top && c >= fvg.bot);
    const inBearZone = (ob && ob.dir === -1 && c <= ob.top && c >= ob.bot) || (fvg && fvg.dir === -1 && c <= fvg.top && c >= fvg.bot);

    if (i > 0) {
      const o = cs[i].o, h = cs[i].h, l = cs[i].l;
      const po = cs[i - 1].o, pc = cs[i - 1].c;
      const bullEngulf = c > o && pc < po && c > po && o < pc;
      const bearEngulf = c < o && pc > po && c < po && o > pc;
      const body = Math.abs(c - o);
      const bullPin = c > o && (o - l) > body * 1.5 && (h - c) < body;
      const bearPin = c < o && (h - o) > body * 1.5 && (c - l) < body;
      const bullConfirm = bullEngulf || bullPin;
      const bearConfirm = bearEngulf || bearPin;

      const a = atr[i] || 0;
      if (trend === 1 && inBullZone && bullConfirm && (lastEvent === "CHOCH_UP" || lastEvent === "BOS_UP") && a > 0) {
        signals.push({ index: i, direction: "BUY", entry: c, sl: c - a * SL_ATR_MULT, tp1: c + a * TP1_ATR_MULT, tp2: c + a * TP2_ATR_MULT, tp3: c + a * TP3_ATR_MULT, event: lastEvent });
      }
      if (trend === -1 && inBearZone && bearConfirm && (lastEvent === "CHOCH_DOWN" || lastEvent === "BOS_DOWN") && a > 0) {
        signals.push({ index: i, direction: "SELL", entry: c, sl: c + a * SL_ATR_MULT, tp1: c - a * TP1_ATR_MULT, tp2: c - a * TP2_ATR_MULT, tp3: c - a * TP3_ATR_MULT, event: lastEvent });
      }
    }
  }

  return signals;
}

function fmt(n) {
  return Number(n).toFixed(2);
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID env vars");
    return false;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) console.error("Telegram send failed:", await res.text());
  return res.ok;
}

function formatMessage(sig) {
  const emoji = sig.direction === "BUY" ? "🟢" : "🔴";
  return (
    `${emoji} *XAU-SMC ALERT (${CANDLE_MINUTES}m)* ${emoji}\n\n` +
    `*Symbol:* XAUUSD\n` +
    `*Direction:* ${sig.direction}\n` +
    `*Structure Event:* ${sig.event}\n\n` +
    `*Entry:* ${fmt(sig.entry)}\n` +
    `*SL:* ${fmt(sig.sl)}\n` +
    `*TP1:* ${fmt(sig.tp1)}\n` +
    `*TP2:* ${fmt(sig.tp2)}\n` +
    `*TP3:* ${fmt(sig.tp3)}\n\n` +
    `⚠️ سیگنال خودکار بر اساس ساختار قیمت است. قبل از ورود واقعی چارت را خودت هم چک کن و اخبار مهم را در نظر بگیر.`
  );
}

async function onCandleClose() {
  if (candles.length < SWING_LEN * 2 + 3) return; // not enough data yet
  const signals = analyze(candles);
  const lastIndex = candles.length - 1;
  const newest = signals.filter((s) => s.index === lastIndex);

  for (const sig of newest) {
    const gap = lastIndex - lastAlertBar[sig.direction];
    if (gap >= COOLDOWN_BARS) {
      lastAlertBar[sig.direction] = lastIndex;
      const msg = formatMessage(sig);
      console.log("Signal:", sig);
      await sendTelegram(msg);
    }
  }
}

setInterval(pollTick, POLL_SECONDS * 1000);
pollTick();

// ============ ROUTES ============
app.get("/", (req, res) => {
  res.send("XAU-SMC self-hosted bot is running. Candles collected: " + candles.length);
});

app.get("/status", (req, res) => {
  res.json({
    candlesCollected: candles.length,
    lastCandle: candles[candles.length - 1] || null,
    currentBucket,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
