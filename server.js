const fs = require("fs");
const http = require("http");

// ============================================================
// CONFIG
// ============================================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PORT = Number(process.env.PORT || 10000);

const SYMBOL = "XAUUSD";
const TIMEFRAME = "M5";

const POLL_MS = 30000;
const MAX_CANDLES = 500;

const ATR_LEN = 14;
const SWING = 2;
const COOLDOWN_BARS = 6;

const PRICE_API = "https://api.gold-api.com/price/XAU";

const STATE_FILE = "./state_v2.json";
const CANDLES_FILE = "./xauusd_m5.json";

// ============================================================
// STATE
// ============================================================

let state = loadJson(STATE_FILE, {
  lastSignalKey: null,
  lastSignalCandle: null,
  lastDirection: null,
  lastAlertTime: 0,
  telegramTestSent: false
});

let candles = loadJson(CANDLES_FILE, []);

if (!Array.isArray(candles)) {
  candles = [];
}

// ============================================================
// FILE FUNCTIONS
// ============================================================

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (e) {
    console.error("LOAD ERROR:", file, e.message);
    return fallback;
  }
}

function saveJson(file, value) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(value, null, 2)
    );
  } catch (e) {
    console.error("SAVE ERROR:", file, e.message);
  }
}

// ============================================================
// HELPERS
// ============================================================

function num(x) {
  const n = Number(x);

  return Number.isFinite(n)
    ? n
    : null;
}

function round(x) {
  return Number(x).toFixed(2);
}

function candleTime(ms) {
  return Math.floor(ms / 300000) * 300000;
}

function formatTime(ms) {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", " UTC");
}

// ============================================================
// CANDLES
// ============================================================

function normalizeCandles(arr) {
  return arr
    .map(c => ({
      time: Number(c.time),
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      c.open !== null &&
      c.high !== null &&
      c.low !== null &&
      c.close !== null
    )
    .sort((a, b) => a.time - b.time);
}

function updateCandle(price) {
  const t = candleTime(Date.now());

  let c = candles[candles.length - 1];

  if (!c || c.time !== t) {
    c = {
      time: t,
      open: price,
      high: price,
      low: price,
      close: price
    };

    candles.push(c);
  } else {
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
  }

  candles = normalizeCandles(candles)
    .slice(-MAX_CANDLES);

  saveJson(CANDLES_FILE, candles);
}

// ============================================================
// ATR
// ============================================================

function calculateATR(data, len = ATR_LEN) {
  if (data.length < len + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < data.length; i++) {
    const h = data[i].high;
    const l = data[i].low;
    const pc = data[i - 1].close;

    trs.push(
      Math.max(
        h - l,
        Math.abs(h - pc),
        Math.abs(l - pc)
      )
    );
  }

  const recent = trs.slice(-len);

  if (!recent.length) {
    return null;
  }

  return (
    recent.reduce(
      (sum, value) => sum + value,
      0
    ) / recent.length
  );
}

// ============================================================
// EMA
// ============================================================

function calculateEMA(data, len) {
  if (data.length < len) {
    return null;
  }

  const multiplier = 2 / (len + 1);

  let ema = data[0].close;

  for (let i = 1; i < data.length; i++) {
    ema =
      (data[i].close - ema) *
      multiplier +
      ema;
  }

  return ema;
}

// ============================================================
// SWINGS
// ============================================================

function isSwingHigh(data, i) {
  if (
    i < SWING ||
    i >= data.length - SWING
  ) {
    return false;
  }

  for (
    let j = i - SWING;
    j <= i + SWING;
    j++
  ) {
    if (
      j !== i &&
      data[j].high >= data[i].high
    ) {
      return false;
    }
  }

  return true;
}

function isSwingLow(data, i) {
  if (
    i < SWING ||
    i >= data.length - SWING
  ) {
    return false;
  }

  for (
    let j = i - SWING;
    j <= i + SWING;
    j++
  ) {
    if (
      j !== i &&
      data[j].low <= data[i].low
    ) {
      return false;
    }
  }

  return true;
}

// ============================================================
// STRUCTURE
// ============================================================

function getStructure(data) {
  const highs = [];
  const lows = [];

  for (
    let i = SWING;
    i < data.length - SWING;
    i++
  ) {
    if (isSwingHigh(data, i)) {
      highs.push({
        index: i,
        price: data[i].high
      });
    }

    if (isSwingLow(data, i)) {
      lows.push({
        index: i,
        price: data[i].low
      });
    }
  }

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {
    return null;
  }

  const h1 =
    highs[highs.length - 2];

  const h2 =
    highs[highs.length - 1];

  const l1 =
    lows[lows.length - 2];

  const l2 =
    lows[lows.length - 1];

  let trend = "NEUTRAL";

  if (
    h2.price > h1.price &&
    l2.price > l1.price
  ) {
    trend = "BULLISH";
  }

  if (
    h2.price < h1.price &&
    l2.price < l1.price
  ) {
    trend = "BEARISH";
  }

  return {
    trend,
    highs,
    lows,
    previousHigh: h1,
    lastHigh: h2,
    previousLow: l1,
    lastLow: l2
  };
}

// ============================================================
// M15
// ============================================================

function buildM15(data) {
  const result = [];

  for (const c of data) {
    const bucket =
      Math.floor(c.time / 900000) *
      900000;

    let m =
      result[result.length - 1];

    if (!m || m.time !== bucket) {
      m = {
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      };

      result.push(m);
    } else {
      m.high =
        Math.max(m.high, c.high);

      m.low =
        Math.min(m.low, c.low);

      m.close = c.close;
    }
  }

  return result;
}

function getM15Trend(data) {
  const m15 = buildM15(data);

  if (m15.length < 50) {
    return {
      trend: "UNKNOWN",
      ema20: null,
      ema50: null
    };
  }

  const ema20 =
    calculateEMA(m15, 20);

  const ema50 =
    calculateEMA(m15, 50);

  const last =
    m15[m15.length - 1];

  let trend = "NEUTRAL";

  if (
    ema20 &&
    ema50 &&
    last.close > ema20 &&
    ema20 > ema50
  ) {
    trend = "BULLISH";
  }

  if (
    ema20 &&
    ema50 &&
    last.close < ema20 &&
    ema20 < ema50
  ) {
    trend = "BEARISH";
  }

  return {
    trend,
    ema20,
    ema50
  };
}

// ============================================================
// ORDER BLOCK
// ============================================================

function findOrderBlock(data, direction) {
  const start =
    Math.max(
      1,
      data.length - 40
    );

  for (
    let i = data.length - 2;
    i >= start;
    i--
  ) {
    const c = data[i];

    if (
      direction === "BUY" &&
      c.close < c.open
    ) {
      return {
        low: c.low,
        high: c.high,
        index: i,
        type: "ORDER BLOCK"
      };
    }

    if (
      direction === "SELL" &&
      c.close > c.open
    ) {
      return {
        low: c.low,
        high: c.high,
        index: i,
        type: "ORDER BLOCK"
      };
    }
  }

  return null;
}

// ============================================================
// FVG
// ============================================================

function findFVG(data, direction) {
  const start =
    Math.max(
      2,
      data.length - 40
    );

  for (
    let i = data.length - 1;
    i >= start;
    i--
  ) {
    const a = data[i - 2];
    const c = data[i];

    if (!a || !c) {
      continue;
    }

    if (
      direction === "BUY" &&
      c.low > a.high
    ) {
      return {
        low: a.high,
        high: c.low,
        index: i,
        type: "BULLISH FVG"
      };
    }

    if (
      direction === "SELL" &&
      c.high < a.low
    ) {
      return {
        low: c.high,
        high: a.low,
        index: i,
        type: "BEARISH FVG"
      };
    }
  }

  return null;
}

// ============================================================
// CONFIRMATION
// ============================================================

function bullishConfirmation(c, p) {
  if (!c || !p) {
    return false;
  }

  const body =
    Math.abs(c.close - c.open);

  const lowerWick =
    Math.min(c.open, c.close) -
    c.low;

  const upperWick =
    c.high -
    Math.max(c.open, c.close);

  const range =
    Math.max(
      c.high - c.low,
      0.00001
    );

  const engulf =
    c.close > c.open &&
    p.close < p.open &&
    c.close >= p.open &&
    c.open <= p.close;

  const pin =
    c.close > c.open &&
    lowerWick >= body * 1.2 &&
    lowerWick > upperWick &&
    body / range >= 0.2;

  return engulf || pin;
}

function bearishConfirmation(c, p) {
  if (!c || !p) {
    return false;
  }

  const body =
    Math.abs(c.close - c.open);

  const lowerWick =
    Math.min(c.open, c.close) -
    c.low;

  const upperWick =
    c.high -
    Math.max(c.open, c.close);

  const range =
    Math.max(
      c.high - c.low,
      0.00001
    );

  const engulf =
    c.close < c.open &&
    p.close > p.open &&
    c.open >= p.close &&
    c.close <= p.open;

  const pin =
    c.close < c.open &&
    upperWick >= body * 1.2 &&
    upperWick > lowerWick &&
    body / range >= 0.2;

  return engulf || pin;
}

// ============================================================
// DISPLACEMENT
// ============================================================

function displacement(
  c,
  direction,
  atr
) {
  if (!c || !atr) {
    return false;
  }

  const range =
    c.high - c.low;

  const body =
    Math.abs(
      c.close - c.open
    );

  if (
    range < atr * 0.8
  ) {
    return false;
  }

  if (
    body / range < 0.5
  ) {
    return false;
  }

  if (direction === "BUY") {
    return c.close > c.open;
  }

  return c.close < c.open;
}

// ============================================================
// LIQUIDITY SWEEP
// ============================================================

function detectLiquiditySweep(
  data,
  direction,
  structure
) {
  if (!structure) {
    return false;
  }

  const c =
    data[data.length - 1];

  if (!c) {
    return false;
  }

  if (direction === "BUY") {
    return (
      c.low <
      structure.lastLow.price &&
      c.close >
      structure.lastLow.price
    );
  }

  return (
    c.high >
    structure.lastHigh.price &&
    c.close <
    structure.lastHigh.price
  );
}

// ============================================================
// ZONE
// ============================================================

function inZone(c, zone) {
  if (!c || !zone) {
    return false;
  }

  return (
    c.high >= zone.low &&
    c.low <= zone.high
  );
}

// ============================================================
// BOS
// ============================================================

function detectRecentBOS(
  data,
  direction,
  structure
) {
  if (!structure) {
    return false;
  }

  const start =
    Math.max(
      0,
      data.length - 12
    );

  for (
    let i = start;
    i < data.length;
    i++
  ) {
    const c = data[i];

    if (
      direction === "BUY" &&
      c.close >
      structure.lastHigh.price
    ) {
      return true;
    }

    if (
      direction === "SELL" &&
      c.close <
      structure.lastLow.price
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// ANALYSIS
// ============================================================

function analyze(data) {
  /*
    Last candle = CLOSED candle.
    The current live candle is NOT used here.
  */

  if (data.length < 60) {
    return null;
  }

  const structure =
    getStructure(data);

  const atr =
    calculateATR(data);

  if (
    !structure ||
    !atr
  ) {
    return null;
  }

  const c =
    data[data.length - 1];

  const p =
    data[data.length - 2];

  const m15 =
    getM15Trend(data);

  let direction = null;

  if (
    structure.trend === "BULLISH" &&
    m15.trend !== "BEARISH"
  ) {
    direction = "BUY";
  }

  if (
    structure.trend === "BEARISH" &&
    m15.trend !== "BULLISH"
  ) {
    direction = "SELL";
  }

  if (!direction) {
    return null;
  }

  const bos =
    detectRecentBOS(
      data,
      direction,
      structure
    );

  const sweep =
    detectLiquiditySweep(
      data,
      direction,
      structure
    );

  const disp =
    displacement(
      c,
      direction,
      atr
    );

  const confirmation =
    direction === "BUY"
      ? bullishConfirmation(c, p)
      : bearishConfirmation(c, p);

  const ob =
    findOrderBlock(
      data,
      direction
    );

  const fvg =
    findFVG(
      data,
      direction
    );

  /*
    Prefer FVG.
    If no FVG exists, use OB.
  */

  const zone =
    fvg || ob;

  const retest =
    inZone(c, zone);

  /*
    High-quality setup:
    BOS or liquidity sweep
    + zone retest
    + confirmation
    + displacement
  */

  if (
    (!bos && !sweep) ||
    !zone ||
    !retest ||
    !confirmation ||
    !disp
  ) {
    return null;
  }

  // ==========================================================
  // SL
  // ==========================================================

  let sl;

  if (direction === "BUY") {
    sl =
      Math.min(
        zone.low,
        structure.lastLow.price
      ) -
      atr * 0.15;
  } else {
    sl =
      Math.max(
        zone.high,
        structure.lastHigh.price
      ) +
      atr * 0.15;
  }

  const entry =
    c.close;

  const risk =
    Math.abs(
      entry - sl
    );

  /*
    Reject abnormal SL.
  */

  if (
    risk < atr * 0.45 ||
    risk > atr * 2.5
  ) {
    return null;
  }

  // ==========================================================
  // TP
  // ==========================================================

  let tp1;
  let tp2;
  let tp3;

  if (direction === "BUY") {
    tp1 =
      entry + risk * 1.0;

    tp2 =
      entry + risk * 2.0;

    tp3 =
      entry + risk * 3.0;
  } else {
    tp1 =
      entry - risk * 1.0;

    tp2 =
      entry - risk * 2.0;

    tp3 =
      entry - risk * 3.0;
  }

  // ==========================================================
  // SCORE
  // ==========================================================

  let score = 0;

  if (bos) {
    score += 2;
  }

  if (sweep) {
    score += 2;
  }

  if (fvg) {
    score += 2;
  }

  if (ob) {
    score += 1;
  }

  if (retest) {
    score += 2;
  }

  if (confirmation) {
    score += 1;
  }

  if (disp) {
    score += 1;
  }

  if (
    direction === "BUY" &&
    m15.trend === "BULLISH"
  ) {
    score += 2;
  }

  if (
    direction === "SELL" &&
    m15.trend === "BEARISH"
  ) {
    score += 2;
  }

  /*
    Minimum score.
  */

  if (score < 7) {
    return null;
  }

  return {
    direction,
    entry,
    sl,
    tp1,
    tp2,
    tp3,
    atr,
    score,
    structure: structure.trend,
    m15Trend: m15.trend,
    bos,
    sweep,
    orderBlock: Boolean(ob),
    fvg: Boolean(fvg),
    zoneType: zone.type,
    confirmation,
    displacement: disp,
    candleTime: c.time
  };
}

// ============================================================
// DUPLICATE PROTECTION
// ============================================================

function makeSignalKey(signal) {
  return [
    signal.direction,
    signal.candleTime,
    round(signal.entry),
    round(signal.sl)
  ].join("_");
}

function isCooldown(signal) {
  if (
    !state.lastSignalCandle
  ) {
    return false;
  }

  const bars =
    Math.abs(
      signal.candleTime -
      state.lastSignalCandle
    ) / 300000;

  return bars < COOLDOWN_BARS;
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(text) {
  if (
    !TELEGRAM_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    throw new Error(
      "TELEGRAM_TOKEN or TELEGRAM_CHAT_ID missing"
    );
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          chat_id:
            TELEGRAM_CHAT_ID,

          text,

          disable_web_page_preview:
            true
        })
      }
    );

  const body =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status}: ${body}`
    );
  }

  let result;

  try {
    result =
      JSON.parse(body);
  } catch {
    throw new Error(
      "Invalid Telegram response"
    );
  }

  if (!result.ok) {
    throw new Error(
      `Telegram API error: ${body}`
    );
  }

  return result;
}

// ============================================================
// ONLINE
// ============================================================

async function sendOnline() {
  if (
    state.telegramTestSent
  ) {
    return;
  }

  const message =
`🟢 XAUUSD SMC BOT ONLINE

Symbol: XAUUSD
Timeframe: M5

Strategy:
SMC
BOS
Liquidity Sweep
Order Block
FVG
Displacement
ATR

Status:
Monitoring for high-quality setups.

Price API:
Gold-API`;

  try {
    await sendTelegram(message);

    state.telegramTestSent =
      true;

    saveJson(
      STATE_FILE,
      state
    );

    console.log(
      "ONLINE MESSAGE SENT"
    );
  } catch (e) {
    console.error(
      "ONLINE TELEGRAM ERROR:",
      e.message
    );
  }
}

// ============================================================
// SIGNAL MESSAGE
// ============================================================

function buildSignalMessage(signal) {
  const emoji =
    signal.direction === "BUY"
      ? "🟢"
      : "🔴";

  return (
`${emoji} XAUUSD ${signal.direction} SIGNAL

━━━━━━━━━━━━━━━━━━

📌 Symbol: XAUUSD
⏱ Timeframe: M5

💰 Entry: ${round(signal.entry)}

🛑 SL: ${round(signal.sl)}

🎯 TP1: ${round(signal.tp1)}
🎯 TP2: ${round(signal.tp2)}
🎯 TP3: ${round(signal.tp3)}

━━━━━━━━━━━━━━━━━━

📊 M15 Trend:
${signal.m15Trend}

📈 M5 Structure:
${signal.structure}

🧠 SMC CONFIRMATION

BOS:
${signal.bos ? "✅" : "❌"}

Liquidity Sweep:
${signal.sweep ? "✅" : "❌"}

Order Block:
${signal.orderBlock ? "✅" : "❌"}

FVG:
${signal.fvg ? "✅" : "❌"}

Retest:
${signal.zoneType}

Confirmation Candle:
${signal.confirmation ? "✅" : "❌"}

Displacement:
${signal.displacement ? "✅" : "❌"}

⭐ Setup Score:
${signal.score}

ATR:
${round(signal.atr)}

🕒 Closed Candle:
${formatTime(signal.candleTime)}

⚠️ Risk management is mandatory.`
  );
}

// ============================================================
// PRICE API
// ============================================================

async function fetchGoldPrice() {
  const response =
    await fetch(
      PRICE_API,
      {
        method: "GET",
        headers: {
          Accept:
            "application/json"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `Price API HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  let price =
    num(json.price);

  if (
    price === null &&
    json.data
  ) {
    price =
      num(json.data.price);
  }

  if (
    price === null &&
    json.result
  ) {
    price =
      num(json.result.price);
  }

  if (price === null) {
    throw new Error(
      "No valid XAU price returned"
    );
  }

  return price;
}

// ============================================================
// POLLING
// ============================================================

let lastPrice = null;
let lastError = null;
let lastCandleTime = null;
let polling = false;

async function poll() {
  if (polling) {
    return;
  }

  polling = true;

  try {
    const price =
      await fetchGoldPrice();

    lastPrice = price;
    lastError = null;

    const previous =
      candles[candles.length - 1];

    updateCandle(price);

    const current =
      candles[candles.length - 1];

    /*
      Detect new M5 candle.
      The previous candle is now CLOSED.
    */

    const newCandle =
      !previous ||
      !current ||
      previous.time !== current.time;

    if (
      newCandle &&
      previous &&
      candles.length >= 60
    ) {
      /*
        Analyze candles WITHOUT
        the newly opened live candle.
      */

      const closedData =
        candles.slice(
          0,
          candles.length - 1
        );

      const signal =
        analyze(closedData);

      if (signal) {
        const key =
          makeSignalKey(signal);

        const duplicate =
          key === state.lastSignalKey;

        const cooldown =
          isCooldown(signal);

        if (
          !duplicate &&
          !cooldown
        ) {
          const message =
            buildSignalMessage(
              signal
            );

          try {
            await sendTelegram(
              message
            );

            state.lastSignalKey =
              key;

            state.lastSignalCandle =
              signal.candleTime;

            state.lastDirection =
              signal.direction;

            state.lastAlertTime =
              Date.now();

            saveJson(
              STATE_FILE,
              state
            );

            console.log(
              "SIGNAL SENT:",
              signal.direction,
              round(signal.entry)
            );
          } catch (e) {
            console.error(
              "SIGNAL TELEGRAM ERROR:",
              e.message
            );
          }
        } else {
          console.log(
            "SIGNAL BLOCKED:",
            duplicate
              ? "DUPLICATE"
              : "COOLDOWN"
          );
        }
      }
    }

    lastCandleTime =
      current
        ? current.time
        : null;

    console.log(
      `[${new Date().toISOString()}] XAUUSD=${round(price)} candles=${candles.length}`
    );

  } catch (e) {
    lastError =
      e.message;

    console.error(
      "POLL ERROR:",
      e.message
    );
  } finally {
    polling = false;
  }
}

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    (req, res) => {
      res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      if (
        req.url === "/" ||
        req.url === "/health"
      ) {
        res.writeHead(200);

        res.end(
          JSON.stringify({
            status: "ok",
            bot: "XAUUSD SMC BOT",
            symbol: SYMBOL,
            timeframe: TIMEFRAME,
            price: lastPrice,
            candles: candles.length,
            lastCandleTime,
            lastError,
            uptime:
              Math.floor(
                process.uptime()
              )
          })
        );

        return;
      }

      if (
        req.url === "/status"
      ) {
        res.writeHead(200);

        res.end(
          JSON.stringify({
            status: "running",
            symbol: SYMBOL,
            timeframe: TIMEFRAME,
            price: lastPrice,
            candles: candles.length,
            lastCandleTime,
            lastSignalCandle:
              state.lastSignalCandle,
            lastDirection:
              state.lastDirection,
            lastAlertTime:
              state.lastAlertTime,
            lastError,
            uptime:
              Math.floor(
                process.uptime()
              )
          })
        );

        return;
      }

      res.writeHead(404);

      res.end(
        JSON.stringify({
          error: "Not found"
        })
      );
    }
  );

// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "===================================="
    );

    console.log(
      "XAUUSD SMC BOT STARTED"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `TIMEFRAME: ${TIMEFRAME}`
    );

    console.log(
      `CANDLES: ${candles.length}`
    );

    console.log(
      "===================================="
    );

    sendOnline();

    poll();

    setInterval(
      poll,
      POLL_MS
    );
  }
);

// ============================================================
// ERROR SAFETY
// ============================================================

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "SIGTERM",
  () => {
    saveJson(
      STATE_FILE,
      state
    );

    saveJson(
      CANDLES_FILE,
      candles
    );

    server.close(
      () => process.exit(0)
    );
  }
);

process.on(
  "SIGINT",
  () => {
    saveJson(
      STATE_FILE,
      state
    );

    saveJson(
      CANDLES_FILE,
      candles
    );

    process.exit(0);
  }
);
