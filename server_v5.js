const fs = require('fs');

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const FILE = './xauusd_m5.json';
const STATE = './state_v2.json';

// V5 signal engine: pure market structure + SMC triggers + Fibonacci.
// EMA and ATR are intentionally NOT used as signal gates or risk calculations.
const MIN_SCORE = 7;
const MAX_SCORE = 10;
const FIBS = [0.236, 0.382, 0.5, 0.618, 0.65, 0.705, 0.786, 0.886];

const load = (file, fallback) => {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
};

const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

const normalizeTs = (ts) => {
  let x = Number(ts);
  if (!Number.isFinite(x)) return null;
  if (x < 1e11) x *= 1000;
  return x;
};

const candles = load(FILE, [])
  .map((c) => ({
    time: normalizeTs(c.time ?? c.openTime),
    open: +c.open,
    high: +c.high,
    low: +c.low,
    close: +c.close,
    volume: +c.volume || 0,
    isOpen: c.isOpen === true,
  }))
  .filter((c) => c.time && [c.open, c.high, c.low, c.close].every(Number.isFinite))
  .sort((a, b) => a.time - b.time);

if (candles.length < 1200) {
  throw Error(`Need >=1200 M5 candles, got ${candles.length}`);
}

const closed = candles.filter((c) => !c.isOpen);
const latest = closed.at(-1);
const NOW = Date.now();
const MAX_AGE = 20 * 60 * 1000;

if (!latest) process.exit(0);

if (NOW - latest.time < 0 || NOW - latest.time > MAX_AGE) {
  console.log(
    `STALE DATA: latest closed candle ${new Date(latest.time).toISOString()}, age ${Math.round(
      (NOW - latest.time) / 60000,
    )}m`,
  );
  process.exit(0);
}

console.log(
  `ANALYSIS LATEST: ${new Date(latest.time).toISOString()} | age=${Math.round(
    (NOW - latest.time) / 60000,
  )}m | closed=true`,
);

function agg(source, minutes) {
  const step = minutes * 60000;
  const result = [];
  for (const c of source) {
    const time = Math.floor(c.time / step) * step;
    const last = result.at(-1);
    if (!last || last.time !== time) {
      result.push({
        time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return result;
}

function swings(source) {
  const result = [];
  for (let i = 2; i < source.length - 2; i++) {
    if (source[i].high > source[i - 1].high && source[i].high >= source[i + 1].high) {
      result.push({ type: 'H', price: source[i].high, time: source[i].time });
    }
    if (source[i].low < source[i - 1].low && source[i].low <= source[i + 1].low) {
      result.push({ type: 'L', price: source[i].low, time: source[i].time });
    }
  }
  return result;
}

function structureTrend(source) {
  const s = swings(source.slice(-120));
  const highs = s.filter((x) => x.type === 'H');
  const lows = s.filter((x) => x.type === 'L');
  if (highs.length < 2 || lows.length < 2) return 'UNKNOWN';

  const h1 = highs.at(-2);
  const h2 = highs.at(-1);
  const l1 = lows.at(-2);
  const l2 = lows.at(-1);

  if (h2.price > h1.price && l2.price > l1.price) return 'BULLISH';
  if (h2.price < h1.price && l2.price < l1.price) return 'BEARISH';
  return 'RANGE';
}

function fib(source) {
  const s = swings(source.slice(-160));
  const highs = s.filter((x) => x.type === 'H');
  const lows = s.filter((x) => x.type === 'L');
  if (!highs.length || !lows.length) return null;

  const hi = highs.at(-1);
  const lo = lows.at(-1);
  const up = hi.time > lo.time;
  const distance = Math.abs(hi.price - lo.price);
  if (!Number.isFinite(distance) || distance <= 0) return null;

  const levels = Object.fromEntries(
    FIBS.map((level) => [level, up ? lo.price + distance * level : hi.price - distance * level]),
  );

  return {
    levels,
    anchorHigh: hi.price,
    anchorLow: lo.price,
    direction: up ? 'UP' : 'DOWN',
    range: distance,
  };
}

function bestFib(f, price, direction) {
  if (!f || !Number.isFinite(f.range) || f.range <= 0) return null;

  // Price can be reasonably close to a Fib level without ATR being involved.
  const tolerance = Math.max(f.range * 0.08, 0.5);
  const candidates = FIBS
    .map((level) => ({ level, price: f.levels[level], dist: Math.abs(price - f.levels[level]) }))
    .filter((x) => x.dist <= tolerance);

  if (!candidates.length) return null;

  const directional = candidates.filter((x) => (direction === 'BUY' ? x.price <= price : x.price >= price));
  return (directional.length ? directional : candidates).sort((a, b) => a.dist - b.dist)[0];
}

function recentRange(source, count = 12) {
  const part = source.slice(-count);
  if (!part.length) return 0;
  return Math.max(...part.map((x) => x.high)) - Math.min(...part.map((x) => x.low));
}

function signalAt(index) {
  const a = closed.slice(0, index + 1);
  if (a.length < 120) return null;

  const m15 = agg(a, 15);
  const h1 = agg(a, 60);
  const h4 = agg(a, 240);
  const c = a.at(-1);

  if (h1.length < 50 || h4.length < 20) return null;

  const st4 = structureTrend(h4);
  const st1 = structureTrend(h1);
  const st15 = structureTrend(m15);

  // Structure is the primary directional filter. No EMA confirmation is used.
  const bullStructure = st4 === 'BULLISH' && st1 !== 'BEARISH' && st15 !== 'BEARISH';
  const bearStructure = st4 === 'BEARISH' && st1 !== 'BULLISH' && st15 !== 'BULLISH';

  // M5 SMC trigger area.
  const previous = a.slice(-7, -1);
  const previousHigh = Math.max(...previous.map((x) => x.high));
  const previousLow = Math.min(...previous.map((x) => x.low));

  const candleRange = Math.max(c.high - c.low, 1e-9);
  const body = Math.abs(c.close - c.open);
  const displacement = body / candleRange >= 0.5;

  const breakoutBuy = c.close > previousHigh;
  const breakoutSell = c.close < previousLow;

  const sweepBuy = a.slice(-5).some((x) => x.low < previousLow && x.close > previousLow);
  const sweepSell = a.slice(-5).some((x) => x.high > previousHigh && x.close < previousHigh);

  const zone = a.slice(-40, -1);
  const support = Math.min(...zone.map((x) => x.low));
  const resistance = Math.max(...zone.map((x) => x.high));
  const zoneRange = Math.max(recentRange(a, 40), candleRange, 1e-9);
  const zoneTolerance = Math.max(zoneRange * 0.08, 0.5);

  const nearSupport =
    Math.abs(c.low - support) <= zoneTolerance || (c.low <= support + zoneTolerance * 0.5 && c.close > support);
  const nearResistance =
    Math.abs(c.high - resistance) <= zoneTolerance ||
    (c.high >= resistance - zoneTolerance * 0.5 && c.close < resistance);

  const supportRejection = nearSupport && c.close > c.open && c.close > support;
  const resistanceRejection = nearResistance && c.close < c.open && c.close < resistance;

  const q = a.slice(-4, -1);
  const mssBuy = c.close > Math.max(...q.map((x) => x.high));
  const mssSell = c.close < Math.min(...q.map((x) => x.low));

  let direction = null;
  let score = 0;
  let setup = '';

  if (bullStructure && (breakoutBuy || sweepBuy || mssBuy)) {
    direction = 'BUY';
    setup = 'TREND';
    score = 5 + (breakoutBuy ? 2 : 0) + (sweepBuy ? 1 : 0) + (mssBuy ? 1 : 0) + (displacement ? 1 : 0);
  } else if (bearStructure && (breakoutSell || sweepSell || mssSell)) {
    direction = 'SELL';
    setup = 'TREND';
    score = 5 + (breakoutSell ? 2 : 0) + (sweepSell ? 1 : 0) + (mssSell ? 1 : 0) + (displacement ? 1 : 0);
  } else if (supportRejection && (mssBuy || displacement)) {
    direction = 'BUY';
    setup = 'SUPPORT_REJECTION';
    score = 5 + (mssBuy ? 2 : 0) + (displacement ? 1 : 0) + (bullStructure ? 1 : 0);
  } else if (resistanceRejection && (mssSell || displacement)) {
    direction = 'SELL';
    setup = 'RESISTANCE_REJECTION';
    score = 5 + (mssSell ? 2 : 0) + (displacement ? 1 : 0) + (bearStructure ? 1 : 0);
  } else {
    return null;
  }

  const fibData = fib(a);
  const fibMatch = fibData ? bestFib(fibData, c.close, direction) : null;

  if (fibMatch) {
    const fibScore = fibMatch.dist <= Math.max(fibData.range * 0.03, 0.25) ? 2 : 1;
    const premiumFib = [0.618, 0.65, 0.705, 0.786, 0.886].includes(fibMatch.level);
    score += fibScore + (premiumFib ? 1 : 0);
  }

  // Avoid the old ATR-dependent rejection penalty. Fib remains confirmation, not a hard gate.
  score = Math.min(MAX_SCORE, score);
  if (score < MIN_SCORE) return null;

  const entry = c.close;
  const swingLow = Math.min(...a.slice(-12).map((x) => x.low));
  const swingHigh = Math.max(...a.slice(-12).map((x) => x.high));

  // Structure-based risk only. No ATR is used.
  let risk = direction === 'BUY' ? entry - swingLow : swingHigh - entry;
  const structuralRange = Math.max(recentRange(a, 12), candleRange, 1e-9);
  const minimumRisk = Math.max(structuralRange * 0.25, 0.5);
  const maximumRisk = Math.max(structuralRange * 1.5, minimumRisk);
  risk = Math.max(minimumRisk, Math.min(maximumRisk, risk));

  const sl = direction === 'BUY' ? entry - risk : entry + risk;

  return {
    direction,
    setup,
    entry,
    sl,
    tp1: direction === 'BUY' ? entry + risk : entry - risk,
    tp2: direction === 'BUY' ? entry + 2 * risk : entry - 2 * risk,
    score,
    candleTime: c.time,
    h4: st4,
    h1: st1,
    m15: st15,
    breakout: direction === 'BUY' ? breakoutBuy : breakoutSell,
    sweep: direction === 'BUY' ? sweepBuy : sweepSell,
    displacement,
    mss: direction === 'BUY' ? mssBuy : mssSell,
    fib: fibMatch,
    fibLevel: fibMatch?.level ?? null,
  };
}

let signal = null;
for (let i = closed.length - 1; i >= Math.max(0, closed.length - 3); i--) {
  const candidate = signalAt(i);
  if (candidate && NOW - candidate.candleTime <= 15 * 60 * 1000) {
    signal = candidate;
    break;
  }
}

if (!signal) {
  console.log('NO CURRENT QUALIFYING SIGNAL (latest 3 closed M5; EMA/ATR removed)');
  process.exit(0);
}

console.log(
  `QUALIFYING SIGNAL: ${signal.direction} ${signal.setup} score=${signal.score}/10 candle=${new Date(
    signal.candleTime,
  ).toISOString()}`,
);

const state = load(STATE, {});
const key = `${signal.direction}|${signal.setup}|${signal.candleTime}|${signal.entry.toFixed(2)}`;

if (state.lastSignalKey === key) {
  console.log('DUPLICATE SIGNAL — not sent');
  process.exit(0);
}

function iranTime(ts) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(normalizeTs(ts)));
}

async function send(s) {
  if (!TOKEN || !CHAT) throw Error('Telegram secrets missing');

  const strength = s.score >= 9 ? '🟢 STRONG' : '🟡 VALID';
  const setupName =
    s.setup === 'SUPPORT_REJECTION'
      ? 'Support + Fib Rejection'
      : s.setup === 'RESISTANCE_REJECTION'
        ? 'Resistance + Fib Rejection'
        : 'Structure Continuation + Fib';
  const fibLine = s.fib
    ? `Fib: ${s.fibLevel.toFixed(3)} @ ${s.fib.price.toFixed(2)}`
    : 'Fib: no nearby level (not required)';

  const text = `${s.direction === 'BUY' ? '🟢' : '🔴'} XAUUSD ${s.direction} V5\n\n${strength} | Score ${s.score}/10\n📌 Setup: ${setupName}\n🕐 Signal: ${iranTime(s.candleTime)} (Iran)\n\nEntry: ${s.entry.toFixed(2)}\nSL: ${s.sl.toFixed(2)}\nTP1: ${s.tp1.toFixed(2)}\nTP2: ${s.tp2.toFixed(2)} (Extended Target)\n\nStructure H4 ${s.h4} | H1 ${s.h1} | M15 ${s.m15}\nBreakout ${s.breakout ? '✅' : '❌'} | Sweep ${s.sweep ? '✅' : '❌'} | Displacement ${s.displacement ? '✅' : '❌'} | MSS ${s.mss ? '✅' : '❌'}\n${fibLine}\n\n⚠️ TP2 is a target, not a guarantee. Risk management mandatory.`;

  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text }),
  });

  if (!response.ok) {
    throw Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
  }
}

(async () => {
  await send(signal);
  state.lastSignalKey = key;
  state.lastSignalTime = new Date().toISOString();
  save(STATE, state);
  console.log('TELEGRAM: SIGNAL SENT');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
