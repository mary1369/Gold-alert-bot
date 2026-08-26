const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SYMBOL = "XAUUSD";
const TIMEFRAME = "M5";
const POLL_MS = 30000;
const MAX_CANDLES = 500;

const STATE_FILE = "./state_v2.json";
const CANDLES_FILE = "./xauusd_m5.json";

const ATR_LEN = 14;
const SWING = 2;
const COOLDOWN_BARS = 6;

const PRICE_API = "https://api.gold-api.com/price/XAU";

let state = loadJson(STATE_FILE, {
  lastSignalKey: null,
  lastSignalCandle: null,
  lastDirection: null,
  lastAlertTime: 0,
  telegramTestSent: false
});

let candles = loadJson(CANDLES_FILE, []);
if (!Array.isArray(candles)) candles = [];

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("SAVE ERROR:", e.message);
  }
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function round(x) {
  return Number(x).toFixed(2);
}

function candleTime(ms) {
  return Math.floor(ms / 300000) * 300000;
}

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

  candles = normalizeCandles(candles).slice(-MAX_CANDLES);
  saveJson(CANDLES_FILE, candles);
}

function calculateATR(data, len = ATR_LEN) {
  if (data.length < len + 1) return null;

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

  return recent.reduce(
    (sum, value) => sum + value,
    0
  ) / recent.length;
}

function isSwingHigh(data, i) {
  if (i < SWING || i >= data.length - SWING) {
    return false;
  }

  for (
    let j = i - SWING;
    j <= i + SWING;
    j++
  ) {
    if (j !== i && data[j].high >= data[i].high) {
      return false;
    }
  }

  return true;
}

function isSwingLow(data, i) {
  if (i < SWING || i >= data.length - SWING) {
    return false;
  }

  for (
    let j = i - SWING;
    j <= i + SWING;
    j++
  ) {
    if (j !== i && data[j].low <= data[i].low) {
      return false;
    }
  }

  return true;
}

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

  if (highs.length < 2 || lows.length < 2) {
    return null;
  }

  const h1 = highs[highs.length - 2];
  const h2 = highs[highs.length - 1];

  const l1 = lows[lows.length - 2];
  const l2 = lows[lows.length - 1];

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
    lastHigh: h2,
    lastLow: l2
  };
}

function findOrderBlock(data, direction) {
  const start = Math.max(
    1,
    data.length - 30
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
        index: i
      };
    }

    if (
      direction === "SELL" &&
      c.close > c.open
    ) {
      return {
        low: c.low,
        high: c.high,
        index: i
      };
    }
  }

  return null;
}

function findFVG(data, direction) {
  const start = Math.max(
    2,
    data.length - 30
  );

  for (
    let i = data.length - 1;
    i >= start;
    i--
  ) {
    const a = data[i - 2];
    const c = data[i];

    if (
      direction === "BUY" &&
      c.low > a.high
    ) {
      return {
        low: a.high,
        high: c.low,
        index: i
      };
    }

    if (
      direction === "SELL" &&
      c.high < a.low
    ) {
      return {
        low: c.high,
        high: a.low,
        index: i
      };
    }
  }

  return null;
}

function bullishConfirmation(c, p) {
  const body = Math.abs(
    c.close - c.open
  );

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  const upperWick =
    c.high - Math.max(c.open, c.close);

  const range =
    c.high - c.low || 1;

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
  const body = Math.abs(
    c.close - c.open
  );

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  const upperWick =
    c.high - Math.max(c.open, c.close);

  const range =
    c.high - c.low || 1;

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

function inZone(c, zone) {
  if (!zone) return false;

  return (
    c.close >= zone.low &&
    c.close <= zone.high
  );
}

function detectLiquiditySweep(
  data,
  direction,
  structure
) {
  const c = data[data.length - 1];

  if (!structure) return false;

  if (direction === "BUY") {
    return (
      c.low < structure.lastLow.price &&
      c.close > structure.lastLow.price
    );
  }

  return (
    c.high > structure.lastHigh.price &&
    c.close < structure.lastHigh.price
  );
}

function displacement(c, direction, atr) {
  const range =
    c.high - c.low;

  if (!atr || range < atr * 0.8) {
    return false;
  }

  if (direction === "BUY") {
    return (
      c.close > c.open &&
      c.close - c.open >= range * 0.5
    );
  }

  return (
    c.close < c.open &&
    c.open - c.close >= range * 0.5
  );
}

function analyze(data) {
  if (data.length < 60) {
    return null;
  }

  const structure =
    getStructure(data);

  const atr =
    calculateATR(data);

  if (!structure || !atr) {
    return null;
  }

  const c =
    data[data.length - 1];

  const p =
    data[data.length - 2];

  let direction = null;

  if (
    structure.trend === "BULLISH"
  ) {
    direction = "BUY";
  }

  if (
    structure.trend === "BEARISH"
  ) {
    direction = "SELL";
  }

  if (!direction) {
    return null;
  }

  const bos =
    direction === "BUY"
      ? c.close > structure.lastHigh.price
      : c.close < structure.lastLow.price;

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

  const zone =
    ob || fvg;

  const retest =
    inZone(c, zone);

  const confirmation =
    direction === "BUY"
      ? bullishConfirmation(c, p)
      : bearishConfirmation(c, p);

  /*
    مهم:
    BOS لازم نیست حتماً روی همان کندل Retest باشد.
    اگر BOS قبلاً رخ داده باشد،
    Retest + Confirmation می‌تواند Entry بدهد.
  */

  let previousBreak = false;

  const lookback =
    data.slice(
      Math.max(0, data.length - 12),
      data.length - 1
    );

  if (direction === "BUY") {
    previousBreak =
      lookback.some(
        x =>
          x.close >
          structure.lastHigh.price
      );
  } else {
    previousBreak =
      lookback.some(
        x =>
          x.close <
          structure.lastLow.price
      );
  }

  const structureOK =
    bos ||
    previousBreak ||
    sweep;

  if (
    !structureOK ||
    !retest ||
    !confirmation ||
    !disp
  ) {
    return null;
  }

  let sl;

  if (direction === "BUY") {
    sl =
      Math.min(
        zone ? zone.low : c.low,
        structure.lastLow.price
      ) -
      atr * 0.15;
  } else {
    sl =
      Math.max(
        zone ? zone.high : c.high,
        structure.lastHigh.price
      ) +
      atr * 0.15;
  }

  const entry =
    c.close;

  const risk =
    Math.abs(entry - sl);

  if (
    risk < atr * 0.45 ||
    risk > atr * 2.5
  ) {
    return null;
  }

  const tp1 =
    direction === "BUY"
      ? entry +
