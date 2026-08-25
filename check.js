const fs = require("fs");

// =========================
// CONFIG
// =========================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SWING_LEN = 5;
const ATR_LEN = 14;

const SL_ATR_MULT = 1.2;
const TP1_ATR_MULT = 1.0;
const TP2_ATR_MULT = 2.0;
const TP3_ATR_MULT = 3.0;

const COOLDOWN_BARS = 6;
const MAX_CANDLES = 500;

const CANDLES_FILE = "candles.json";
const STATE_FILE = "state.json";

// =========================
// JSON
// =========================
function loadJSON(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function saveJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
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
      console.log(`Fetching XAU price... attempt ${i + 1}/${attempts}`);

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

      console.log(`XAUUSD price = ${data.price}`);

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

  console.log("Sending Telegram message...");
  console.log("CHAT_ID:", CHAT_ID);
  console.log("Message:");
  console.log(text);

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

  const responseText = await res.text();

  console.log(
    "Telegram HTTP status:",
    res.status
  );

  console.log(
    "Telegram raw response:",
    responseText
  );

  if (!res.ok) {
    throw new Error(
      `Telegram HTTP error ${res.status}: ${responseText}`
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
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
    "✅ TELEGRAM MESSAGE SENT SUCCESSFULLY"
  );

  return true;
}

// =========================
// TEST MESSAGE
// =========================
function testMessage(price) {

  return (
    `🟢 XAUUSD BOT ONLINE\n\n` +

    `Symbol: XAUUSD\n` +
    `Price: ${Number(price).toFixed(2)}\n\n` +

    `Price API: ✅ OK\n` +
    `Telegram: 🔄 TESTING\n\n` +

    `SMC Engine: ACTIVE`
  );
}

// =========================
// ATR
// =========================
function computeATRSeries(cs, len) {

  const atr =
    new Array(cs.length).fill(null);

  const trs = [];

  let sum = 0;

  for (let i = 0; i < cs.length; i++) {

    const prevClose =
      i > 0 ? cs[i - 1].c : cs[i].c;

    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - prevClose),
      Math.abs(cs[i].l - prevClose)
    );

    trs.push(tr);

    sum += tr;

    if (i >= len) {
      sum -= trs[i - len];
    }

    if (i >= len - 1) {
      atr[i] = sum / len;
    }
  }

  return atr;
}

// =========================
// PIVOTS
// =========================
function isPivotHigh(cs, i, len) {

  if (
    i - len < 0 ||
    i + len >= cs.length
  ) {
    return false;
  }

  const h = cs[i].h;

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

function isPivotLow(cs, i, len) {

  if (
    i - len < 0 ||
    i + len >= cs.length
  ) {
    return false;
  }

  const l = cs[i].l;

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

    const bar = cs[k];

    // Bullish OB = last bearish candle
    if (
      wantBull &&
      bar.c < bar.o
    ) {

      return {
        top: Math.max(
          bar.o,
          bar.c
        ),

        bot: Math.min(
          bar.o,
          bar.l
        )
      };
    }

    // Bearish OB = last bullish candle
    if (
      !wantBull &&
      bar.c > bar.o
    ) {

      return {
        top: Math.max(
          bar.o,
          bar.h
        ),

        bot: Math.min(
          bar.o,
          bar.c
        )
      };
    }
  }

  return null;
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

  for (
    let i = 0;
    i < cs.length;
    i++
  ) {

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

    const c = cs[i].c;

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
          dir: 1
        };
      }
    }

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
          dir: -1
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
          top: cs[i].l,
          bot: cs[i - 2].h,
          dir: 1
        };
      }

      if (bearFVG) {

        fvg = {
          top: cs[i - 2].l,
          bot: cs[i].h,
          dir: -1
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
    // CANDLE CONFIRMATION
    // =====================

    if (i > 0) {

      const o = cs[i].o;
      const h = cs[i].h;
      const l = cs[i].l;

      const po = cs[i - 1].o;
      const pc = cs[i - 1].c;

      const bullEngulf =
        c > o &&
        pc < po &&
        c > po &&
        o < pc;

      const bearEngulf =
        c < o &&
        pc > po &&
        c < po &&
        o > pc;

      const body =
        Math.abs(c - o);

      const bullPin =
        c > o &&
        body > 0 &&
        (o - l) >
          body * 1.5 &&
        (h - c) <
          body;

      const bearPin =
        c < o &&
        body > 0 &&
        (h - o) >
          body * 1.5 &&
        (c - l) <
          body;

      const bullConfirm =
        bullEngulf ||
        bullPin;

      const bearConfirm =
        bearEngulf ||
        bearPin;

      const a =
        atr[i] || 0;

      // =====================
      // BUY
      // =====================

      if (
        trend === 1 &&
        inBullZone &&
        bullConfirm &&
        (
          lastEvent === "CHOCH_UP" ||
          lastEvent === "BOS_UP"
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
          event: lastEvent
        });
      }

      // =====================
      // SELL
      // =====================

      if (
        trend === -1 &&
        inBearZone &&
        bearConfirm &&
        (
          lastEvent === "CHOCH_DOWN" ||
          lastEvent === "BOS_DOWN"
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
          event: lastEvent
        });
      }
    }
  }

  return {
    signals,
    trend,
    lastEvent,
    ob,
    fvg,
    atr: atr[atr.length - 1]
  };
}

// =========================
// FORMAT
// =========================
function fmt(n) {
  return Number(n).toFixed(2);
}

function formatSignal(sig) {

  const emoji =
    sig.direction === "BUY"
      ? "🟢"
      : "🔴";

  return (
    `${emoji} XAUUSD SMC ALERT ${emoji}\n\n` +

    `Direction: ${sig.direction}\n` +
    `Structure: ${sig.event}\n\n` +

    `Entry: ${fmt(sig.entry)}\n` +
    `SL: ${fmt(sig.sl)}\n` +
    `TP1: ${fmt(sig.tp1)}\n` +
    `TP2: ${fmt(sig.tp2)}\n` +
    `TP3: ${fmt(sig.tp3)}\n\n` +

    `⚠️ Automated SMC signal.\n` +
    `Confirm on your broker chart before entering.`
  );
}

// =========================
// MAIN
// =========================
async function main() {

  console.log("==============================");
  console.log("XAUUSD SMC BOT START");
  console.log("==============================");

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
  // LOAD STATE
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
        lastAlertBar: {
          BUY: -999,
          SELL: -999
        },
        telegramTestSent: false
      }
    );

  // =========================
  // ADD PRICE
  // =========================

  const now =
    Math.floor(
      Date.now() / 1000
    );

  candles.push({
    t: now,
    o: price,
    h: price,
    l: price,
    c: price
  });

  while (
    candles.length >
    MAX_CANDLES
  ) {

    candles.shift();
  }

  console.log(
    `Data points: ${candles.length}/${MAX_CANDLES}`
  );

  // =========================
  // TELEGRAM TEST
  // =========================

  if (!state.telegramTestSent) {

    console.log(
      "Running Telegram test..."
    );

    await sendTelegram(
      testMessage(price)
    );

    state.telegramTestSent =
      true;

    console.log(
      "Telegram test completed."
    );
  }

  // =========================
  // SMC
  // =========================

  if (
    candles.length >=
    SWING_LEN * 2 + 3
  ) {

    const result =
      analyze(candles);

    console.log(
      "Trend:",
      result.trend === 1
        ? "BULLISH"
        : result.trend === -1
        ? "BEARISH"
        : "NEUTRAL"
    );

    console.log(
      "Last event:",
      result.lastEvent || "NONE"
    );

    console.log(
      "ATR:",
      result.atr
        ? fmt(result.atr)
        : "N/A"
    );

    const lastIndex =
      candles.length - 1;

    const newest =
      result.signals.filter(
        s =>
          s.index === lastIndex
      );

    if (newest.length === 0) {

      console.log(
        "ℹ️ No new signal."
      );

    } else {

      for (
        const sig of newest
      ) {

        const gap =
          lastIndex -
          (
            state.lastAlertBar[
              sig.direction
            ] ?? -999
          );

        console.log(
          `Signal found: ${sig.direction}`
        );

        console.log(
          `Cooldown gap: ${gap}`
        );

        if (
          gap >=
          COOLDOWN_BARS
        ) {

          await sendTelegram(
            formatSignal(sig)
          );

          state.lastAlertBar[
            sig.direction
          ] = lastIndex;

          console.log(
            "✅ Signal sent to Telegram."
          );

        } else {

          console.log(
            "⏳ Signal blocked by cooldown."
          );
        }
      }
    }

  } else {

    console.log(
      `⏳ Warming up: ${candles.length}/${SWING_LEN * 2 + 3}`
    );
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
    "=============================="
  );

  console.log(
    "XAUUSD SMC BOT FINISHED"
  );

  console.log(
    "=============================="
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

  // IMPORTANT:
  // Exit 1 so GitHub Actions
  // correctly shows FAILURE.

  process.exit(1);
});
