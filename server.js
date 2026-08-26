const fs = require("fs");

// ======================================================
// XAUUSD SMC M5 TELEGRAM BOT - V2
// ======================================================

// =========================
// CONFIG
// =========================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// M5
const TIMEFRAME_SECONDS = 5 * 60;

// SMC
const SWING_LEN = 5;
const ATR_LEN = 14;

// Risk
const SL_ATR_MULT = 1.2;
const TP1_ATR_MULT = 1.0;
const TP2_ATR_MULT = 2.0;
const TP3_ATR_MULT = 3.0;

// Minimum distance between same-direction alerts
const COOLDOWN_BARS = 6;

// Data
const MAX_CANDLES = 500;

// IMPORTANT:
// New file so old tick-data from previous version
// does not contaminate the new M5 engine.
const CANDLES_FILE = "xauusd_m5.json";
const STATE_FILE = "state_v2.json";

// =========================
// JSON
// =========================

function loadJSON(path, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(path, "utf8")
    );
  } catch (e) {
    return fallback;
  }
}

function saveJSON(path, data) {
  fs.writeFileSync(
    path,
    JSON.stringify(data, null, 2)
  );
}

// =========================
// SLEEP
// =========================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================
// PRICE
// =========================

async function fetchPrice() {

  const attempts = 3;
  let lastErr;

  for (let i = 0; i < attempts; i++) {

    try {

      console.log(
        `Fetching XAU price... attempt ${i + 1}/${attempts}`
      );

      const res = await fetch(
        "https://api.gold-api.com/price/XAU"
      );

      const text = await res.text();

      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}: ${text}`
        );
      }

      const data = JSON.parse(text);

      if (
        typeof data.price !== "number" ||
        !Number.isFinite(data.price)
      ) {
        throw new Error(
          "Invalid price returned: " + text
        );
      }

      console.log(
        `XAUUSD price = ${data.price}`
      );

      return data.price;

    } catch (e) {

      lastErr = e;

      console.error(
        `Price attempt ${i + 1} failed:`,
        e.message
      );

      if (i < attempts - 1) {
        await sleep(3000);
      }
    }
  }

  throw lastErr;
}

// =========================
// TELEGRAM
// =========================

async function sendTelegram(text) {

  if (!TELEGRAM_TOKEN) {
    throw new Error(
      "TELEGRAM_TOKEN is missing"
    );
  }

  if (!CHAT_ID) {
    throw new Error(
      "TELEGRAM_CHAT_ID is missing"
    );
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  console.log(
    "Sending Telegram message..."
  );

  const res = await fetch(url, {

    method: "POST",

    headers: {
      "Content-Type": "application/json"
    },

    body: JSON.stringify({

      chat_id: CHAT_ID,

      text: text

    })

  });

  const responseText =
    await res.text();

  console.log(
    "Telegram HTTP status:",
    res.status
  );

  console.log(
    "Telegram response:",
    responseText
  );

  if (!res.ok) {

    throw new Error(
      `Telegram HTTP error ${res.status}: ${responseText}`
    );

  }

  let data;

  try {

    data =
      JSON.parse(responseText);

  } catch (e) {

    throw new Error(
      "Telegram returned invalid JSON"
    );

  }

  if (!data.ok) {

    throw new Error(
      `Telegram API rejected message: ${responseText}`
    );

  }

  console.log(
    "✅ TELEGRAM MESSAGE SENT"
  );

  return true;
}

// =========================
// TEST MESSAGE
// =========================

function testMessage(price) {

  return (
    `🟢 XAUUSD SMC BOT ONLINE\n\n` +

    `Symbol: XAUUSD\n` +
    `Price: ${Number(price).toFixed(2)}\n` +

    `Timeframe: M5\n\n` +

    `Price API: ✅ OK\n` +
    `Telegram: ✅ OK\n` +
    `M5 Engine: ✅ ACTIVE\n` +
    `SMC Engine: ✅ ACTIVE\n\n` +

    `Waiting for high-quality setup...`
  );
}

// =========================
// M5 CANDLE BUILDER
// =========================

function updateM5Candle(candles, price, timestamp) {

  const bucket =
    Math.floor(
      timestamp / TIMEFRAME_SECONDS
    ) * TIMEFRAME_SECONDS;

  let current =
    candles[candles.length - 1];

  // No candle yet
  if (!current) {

    current = {

      t: bucket,

      o: price,
      h: price,
      l: price,
      c: price

    };

    candles.push(current);

    return {
      newCandle: false,
      closedCandle: null
    };
  }

  // Same M5 candle
  if (current.t === bucket) {

    current.h =
      Math.max(current.h, price);

    current.l =
      Math.min(current.l, price);

    current.c = price;

    return {
      newCandle: false,
      closedCandle: null
    };
  }

  // New M5 candle started
  const closedCandle = {
    ...current
  };

  current = {

    t: bucket,

    o: price,
    h: price,
    l: price,
    c: price

  };

  candles.push(current);

  while (
    candles.length >
    MAX_CANDLES
  ) {

    candles.shift();

  }

  return {
    newCandle: true,
    closedCandle
  };
}

// =========================
// ATR
// =========================

function computeATRSeries(cs, len) {

  const atr =
    new Array(cs.length)
      .fill(null);

  const trs = [];

  let sum = 0;

  for (
    let i = 0;
    i < cs.length;
    i++
  ) {

    const prevClose =
      i > 0
        ? cs[i - 1].c
        : cs[i].c;

    const tr =
      Math.max(

        cs[i].h - cs[i].l,

        Math.abs(
          cs[i].h - prevClose
        ),

        Math.abs(
          cs[i].l - prevClose
        )

      );

    trs.push(tr);

    sum += tr;

    if (i >= len) {

      sum -=
        trs[i - len];

    }

    if (i >= len - 1) {

      atr[i] =
        sum / len;

    }
  }

  return atr;
}

// =========================
// PIVOT HIGH
// =========================

function isPivotHigh(cs, i, len) {

  if (
    i - len < 0 ||
    i + len >= cs.length
  ) {

    return false;

  }

  const h =
    cs[i].h;

  for (
    let k = i - len;
    k <= i + len;
    k++
  ) {

    if (
      k !== i &&
      cs[k].h >= h
    ) {

      return false;

    }
  }

  return true;
}

// =========================
// PIVOT LOW
// =========================

function isPivotLow(cs, i, len) {

  if (
    i - len < 0 ||
    i + len >= cs.length
  ) {

    return false;

  }

  const l =
    cs[i].l;

  for (
    let k = i - len;
    k <= i + len;
    k++
  ) {

    if (
      k !== i &&
      cs[k].l <= l
    ) {

      return false;

    }
  }

  return true;
}

// =========================
// ORDER BLOCK
// =========================

function findLastOppositeBar(
  cs,
  i,
  wantBull
) {

  for (
    let k = i - 1;
    k >= Math.max(0, i - 20);
    k--
  ) {

    const bar =
      cs[k];

    // Bullish OB
    // Last bearish candle before bullish displacement

    if (
      wantBull &&
      bar.c < bar.o
    ) {

      return {

        top:
          Math.max(
            bar.o,
            bar.c
          ),

        bot:
          Math.min(
            bar.o,
            bar.l
          ),

        index: k

      };
    }

    // Bearish OB
    // Last bullish candle before bearish displacement

    if (
      !wantBull &&
      bar.c > bar.o
    ) {

      return {

        top:
          Math.max(
            bar.o,
            bar.h
          ),

        bot:
          Math.min(
            bar.o,
            bar.c
          ),

        index: k

      };
    }
  }

  return null;
}

// =========================
// CANDLE CONFIRMATION
// =========================

function bullishConfirmation(
  cs,
  i
) {

  if (i < 1) {
    return false;
  }

  const c =
    cs[i];

  const p =
    cs[i - 1];

  const body =
    Math.abs(
      c.c - c.o
    );

  if (body <= 0) {
    return false;
  }

  const bullish =
    c.c > c.o;

  const previousBearish =
    p.c < p.o;

  const bullEngulf =
    bullish &&
    previousBearish &&
    c.c > p.o &&
    c.o <= p.c;

  const lowerWick =
    Math.min(c.o, c.c) -
    c.l;

  const upperWick =
    c.h -
    Math.max(c.o, c.c);

  const bullPin =
    bullish &&
    lowerWick >= body * 1.5 &&
    upperWick <= body;

  return (
    bullEngulf ||
    bullPin
  );
}

// =========================
// BEARISH CONFIRMATION
// =========================

function bearishConfirmation(
  cs,
  i
) {

  if (i < 1) {
    return false;
  }

  const c =
    cs[i];

  const p =
    cs[i - 1];

  const body =
    Math.abs(
      c.c - c.o
    );

  if (body <= 0) {
    return false;
  }

  const bearish =
    c.c < c.o;

  const previousBullish =
    p.c > p.o;

  const bearEngulf =
    bearish &&
    previousBullish &&
    c.c < p.o &&
    c.o >= p.c;

  const upperWick =
    c.h -
    Math.max(c.o, c.c);

  const lowerWick =
    Math.min(c.o, c.c) -
    c.l;

  const bearPin =
    bearish &&
    upperWick >= body * 1.5 &&
    lowerWick <= body;

  return (
    bearEngulf ||
    bearPin
  );
}

// =========================
// SMC ANALYSIS
// =========================

function analyze(cs) {

  const atr =
    computeATRSeries(
      cs,
      ATR_LEN
    );

  let lastSwingHigh = null;
  let lastSwingLow = null;

  let trend = 0;

  let lastEvent = "";

  let ob = null;

  let fvg = null;

  const signals = [];

  // ==============================================
  // IMPORTANT:
  // We analyze CLOSED candles only.
  // Last candle is the currently forming M5.
  // ==============================================

  const lastClosedIndex =
    cs.length - 2;

  if (
    lastClosedIndex < 10
  ) {

    return {

      signals,
      trend,
      lastEvent,
      ob,
      fvg,

      atr:
        atr[lastClosedIndex] || null

    };
  }

  for (
    let i = 0;
    i <= lastClosedIndex;
    i++
  ) {

    // =====================
    // SWINGS
    // =====================

    if (
      isPivotHigh(
        cs,
        i,
        SWING_LEN
      )
    ) {

      lastSwingHigh =
        cs[i].h;

    }

    if (
      isPivotLow(
        cs,
        i,
        SWING_LEN
      )
    ) {

      lastSwingLow =
        cs[i].l;

    }

    const c =
      cs[i].c;

    const prevC =
      i > 0
        ? cs[i - 1].c
        : c;

    // =====================
    // BOS / CHOCH
    // =====================

    const bullBreak =
      lastSwingHigh !== null &&
      prevC <= lastSwingHigh &&
      c > lastSwingHigh;

    const bearBreak =
      lastSwingLow !== null &&
      prevC >= lastSwingLow &&
      c < lastSwingLow;

    // =====================
    // BULLISH BREAK
    // =====================

    if (bullBreak) {

      lastEvent =
        trend === -1
          ? "CHOCH_UP"
          : "BOS_UP";

      trend = 1;

      const found =
        findLastOppositeBar(
          cs,
          i,
          true
        );

      if (found) {

        ob = {

          top: found.top,

          bot: found.bot,

          dir: 1,

          index:
            found.index

        };

      }
    }

    // =====================
    // BEARISH BREAK
    // =====================

    if (bearBreak) {

      lastEvent =
        trend === 1
          ? "CHOCH_DOWN"
          : "BOS_DOWN";

      trend = -1;

      const found =
        findLastOppositeBar(
          cs,
          i,
          false
        );

      if (found) {

        ob = {

          top: found.top,

          bot: found.bot,

          dir: -1,

          index:
            found.index

        };

      }
    }

    // =====================
    // FVG
    // =====================

    if (i >= 2) {

      const bullFVG =
        cs[i].l >
        cs[i - 2].h;

      const bearFVG =
        cs[i].h <
        cs[i - 2].l;

      if (bullFVG) {

        fvg = {

          top:
            cs[i].l,

          bot:
            cs[i - 2].h,

          dir: 1,

          index: i

        };
      }

      if (bearFVG) {

        fvg = {

          top:
            cs[i - 2].l,

          bot:
            cs[i].h,

          dir: -1,

          index: i

        };
      }
    }

    // =====================
    // ZONES
    // =====================

    const inBullOB =
      ob &&
      ob.dir === 1 &&
      c <= ob.top &&
      c >= ob.bot;

    const inBearOB =
      ob &&
      ob.dir === -1 &&
      c <= ob.top &&
      c >= ob.bot;

    const inBullFVG =
      fvg &&
      fvg.dir === 1 &&
      c <= fvg.top &&
      c >= fvg.bot;

    const inBearFVG =
      fvg &&
      fvg.dir === -1 &&
      c <= fvg.top &&
      c >= fvg.bot;

    const inBullZone =
      inBullOB ||
      inBullFVG;

    const inBearZone =
      inBearOB ||
      inBearFVG;

    // =====================
    // CONFIRMATION
    // =====================

    const bullConfirm =
      bullishConfirmation(
        cs,
        i
      );

    const bearConfirm =
      bearishConfirmation(
        cs,
        i
      );

    const a =
      atr[i] || 0;

    // =====================
    // BUY SIGNAL
    // =====================

    if (

      trend === 1 &&

      inBullZone &&

      bullConfirm &&

      (
        lastEvent === "BOS_UP" ||
        lastEvent === "CHOCH_UP"
      ) &&

      a > 0

    ) {

      signals.push({

        index: i,

        direction: "BUY",

        entry: c,

        sl:
          c -
          a * SL_ATR_MULT,

        tp1:
          c +
          a * TP1_ATR_MULT,

        tp2:
          c +
          a * TP2_ATR_MULT,

        tp3:
          c +
          a * TP3_ATR_MULT,

        event:
          lastEvent,

        atr: a,

        ob: ob,

        fvg: fvg

      });
    }

    // =====================
    // SELL SIGNAL
    // =====================

    if (

      trend === -1 &&

      inBearZone &&

      bearConfirm &&

      (
        lastEvent === "BOS_DOWN" ||
        lastEvent === "CHOCH_DOWN"
      ) &&

      a > 0

    ) {

      signals.push({

        index: i,

        direction: "SELL",

        entry: c,

        sl:
          c +
          a * SL_ATR_MULT,

        tp1:
          c -
          a * TP1_ATR_MULT,

        tp2:
          c -
          a * TP2_ATR_MULT,

        tp3:
          c -
          a * TP3_ATR_MULT,

        event:
          lastEvent,

        atr: a,

        ob: ob,

        fvg: fvg

      });
    }
  }

  return {

    signals,

    trend,

    lastEvent,

    ob,

    fvg,

    atr:
      atr[lastClosedIndex] || null

  };
}

// =========================
// FORMAT
// =========================

function fmt(n) {

  if (
    n === null ||
    n === undefined ||
    !Number.isFinite(Number(n))
  ) {

    return "N/A";

  }

  return Number(n)
    .toFixed(2);
}

// =========================
// SIGNAL MESSAGE
// =========================

function formatSignal(
  sig
) {

  const emoji =
    sig.direction === "BUY"
      ? "🟢"
      : "🔴";

  const risk =
    Math.abs(
      sig.entry -
      sig.sl
    );

  const reward1 =
    Math.abs(
      sig.tp1 -
      sig.entry
    );

  const rr1 =
    risk > 0
      ? reward1 / risk
      : 0;

  const reward2 =
    Math.abs(
      sig.tp2 -
      sig.entry
    );

  const rr2 =
    risk > 0
      ? reward2 / risk
      : 0;

  const reward3 =
    Math.abs(
      sig.tp3 -
      sig.entry
    );

  const rr3 =
    risk > 0
      ? reward3 / risk
      : 0;

  const zone =
    sig.ob
      ? "ORDER BLOCK"
      : sig.fvg
      ? "FVG"
      : "ZONE";

  return (

    `${emoji} XAUUSD M5 SMC ALERT ${emoji}\n\n` +

    `Direction: ${sig.direction}\n` +

    `Structure: ${sig.event}\n` +

    `Zone: ${zone}\n\n` +

    `Entry: ${fmt(sig.entry)}\n` +

    `SL: ${fmt(sig.sl)}\n\n` +

    `TP1: ${fmt(sig.tp1)}  | RR 1:${rr1.toFixed(1)}\n` +

    `TP2: ${fmt(sig.tp2)}  | RR 1:${rr2.toFixed(1)}\n` +

    `TP3: ${fmt(sig.tp3)}  | RR 1:${rr3.toFixed(1)}\n\n` +

    `ATR: ${fmt(sig.atr)}\n\n` +

    `⚠️ CONFIRMED ON CLOSED M5 CANDLE\n` +

    `Confirm price on your FX24 chart before entry.`

  );
}

// =========================
// MAIN
// =========================

async function main() {

  console.log(
    "===================================="
  );

  console.log(
    "XAUUSD SMC M5 BOT V2 START"
  );

  console.log(
    "===================================="
  );

  // =========================
  // ENV CHECK
  // =========================

  console.log(
    "Telegram token:",
    TELEGRAM_TOKEN
      ? "✅ FOUND"
      : "❌ MISSING"
  );

  console.log(
    "Telegram chat ID:",
    CHAT_ID
      ? "✅ FOUND"
      : "❌ MISSING"
  );

  // =========================
  // PRICE
  // =========================

  const price =
    await fetchPrice();

  console.log(
    `Current XAUUSD: ${fmt(price)}`
  );

  // =========================
  // LOAD
  // =========================

  const candles =
    loadJSON(
      CANDLES_FILE,
      []
    );

  const state =
    loadJSON(

      STATE_FILE,

      {

        lastAlertCandle: {

          BUY: null,

          SELL: null

        },

        telegramTestSent: false

      }

    );

  // =========================
  // UPDATE M5
  // =========================

  const now =
    Math.floor(
      Date.now() / 1000
    );

  const candleResult =
    updateM5Candle(
      candles,
      price,
      now
    );

  console.log(
    `M5 candles: ${candles.length}/${MAX_CANDLES}`
  );

  console.log(
    `New M5 candle: ${
      candleResult.newCandle
        ? "YES"
        : "NO"
    }`
  );

  if (
    candles.length > 0
  ) {

    const current =
      candles[
        candles.length - 1
      ];

    console.log(
      `Current M5 O:${fmt(current.o)} H:${fmt(current.h)} L:${fmt(current.l)} C:${fmt(current.c)}`
    );

  }

  // =========================
  // TELEGRAM TEST
  // =========================

  if (
    !state.telegramTestSent
  ) {

    console.log(
      "Running Telegram test..."
    );

    await sendTelegram(
      testMessage(price)
    );

    state.telegramTestSent =
      true;

    saveJSON(
      STATE_FILE,
      state
    );

    console.log(
      "Telegram test completed."
    );
  }

  // =========================
  // NEED ENOUGH M5 DATA
  // =========================

  const minimumCandles =
    Math.max(
      ATR_LEN + 5,
      SWING_LEN * 2 + 10
    );

  if (
    candles.length <
    minimumCandles
  ) {

    console.log(
      `⏳ Warming up M5 engine: ${candles.length}/${minimumCandles}`
    );

  } else {

    // =================================================
    // IMPORTANT:
    // Analyze only when a new M5 candle has closed.
    // =================================================

    if (
      candleResult.newCandle
    ) {

      console.log(
        "===================================="
      );

      console.log(
        "🔔 NEW M5 CANDLE CLOSED"
      );

      console.log(
        "Running SMC analysis..."
      );

      console.log(
        "===================================="
      );

      const result =
        analyze(candles);

      console.log(
        "Trend:",
        result.trend === 1
          ? "🟢 BULLISH"
          : result.trend === -1
          ? "🔴 BEARISH"
          : "⚪ NEUTRAL"
      );

      console.log(
        "Last event:",
        result.lastEvent || "NONE"
      );

      console.log(
        "ATR:",
        fmt(result.atr)
      );

      if (result.ob) {

        console.log(
          `OB: ${fmt(result.ob.bot)} - ${fmt(result.ob.top)}`
        );

      } else {

        console.log(
          "OB: NONE"
        );

      }

      if (result.fvg) {

        console.log(
          `FVG: ${fmt(result.fvg.bot)} - ${fmt(result.fvg.top)}`
        );

      } else {

        console.log(
          "FVG: NONE"
        );

      }

      // =========================
      // CLOSED CANDLE INDEX
      // =========================

      const closedIndex =
        candles.length - 2;

      const newest =
        result.signals.filter(
          s =>
            s.index === closedIndex
        );

      if (
        newest.length === 0
      ) {

        console.log(
          "ℹ️ NO HIGH-QUALITY SMC SIGNAL"
        );

      } else {

        for (
          const sig of newest
        ) {

          console.log(
            `🔥 SIGNAL: ${sig.direction}`
          );

          const lastAlert =
            state.lastAlertCandle[
              sig.direction
            ];

          const gap =
            lastAlert === null
              ? 999999
              : closedIndex -
                lastAlert;

          console.log(
            `Cooldown gap: ${gap} bars`
          );

          // =========================
          // DUPLICATE PROTECTION
          // =========================

          if (
            lastAlert === closedIndex
          ) {

            console.log(
              "⛔ Duplicate signal blocked."
            );

            continue;

          }

          // =========================
          // COOLDOWN
          // =========================

          if (
            gap <
            COOLDOWN_BARS
          ) {

            console.log(
              "⏳ Signal blocked by cooldown."
            );

            continue;

          }

          // =========================
          // SEND
          // =========================

          await sendTelegram(
            formatSignal(sig)
          );

          state.lastAlertCandle[
            sig.direction
          ] = closedIndex;

          console.log(
            "✅ SMC signal sent to Telegram."
          );
        }
      }

    } else {

      console.log(
        "⏸ No M5 candle closed yet."
      );

      console.log(
        "Waiting for next M5 close..."
      );

    }
  }

  // =========================
  // SAVE
  // =========================

  saveJSON(
    CANDLES_FILE,
    candles
  );

  saveJSON(
    STATE_FILE,
    state
  );

  console.log(
    "State saved."
  );

  console.log(
    "===================================="
  );

  console.log(
    "XAUUSD SMC M5 BOT V2 FINISHED"
  );

  console.log(
    "===================================="
  );
}

// =========================
// ERROR HANDLER
// =========================

main().catch((e) => {

  console.error(
    "❌ BOT FAILED:"
  );

  console.error(
    e
  );

  process.exit(1);

});
