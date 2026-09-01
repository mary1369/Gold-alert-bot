const fs = require('fs');

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const FILE = './xauusd_m5.json';
const STATE = './state_v2.json';

// V5: SMC + market structure + Fibonacci only.
// EMA and ATR are deliberately absent from signal gates, scoring, SL and TP.
const MIN_SCORE = 6;
const MAX_SCORE = 10;
const FIBS = [0.236, 0.382, 0.5, 0.618, 0.65, 0.705, 0.786, 0.886];
const SIGNAL_MAX_AGE = 15 * 60 * 1000;
const DATA_MAX_AGE = 20 * 60 * 1000;

function load(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function save(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function normalizeTs(ts) {
  let x = Number(ts);
  if (!Number.isFinite(x)) return null;
  if (x < 1e11) x *= 1000;
  return x;
}

const candles = load(FILE, [])
  .map((c) => ({
    time: normalizeTs(c.time ?? c.openTime),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume) || 0,
    isOpen: c.isOpen === true,
  }))
  .filter((c) => c.time && [c.open, c.high, c.low, c.close].every(Number.isFinite))
  .sort((a, b) => a.time - b.time);

if (candles.length < 1200) throw Error(`Need >=1200 M5 candles, got ${candles.length}`);

const closed = candles.filter((c) => !c.isOpen);
const latest = closed.at(-1);
const NOW = Date.now();
if (!latest) process.exit(0);

const dataAge = NOW - latest.time;
if (dataAge < 0 || dataAge > DATA_MAX_AGE) {
  console.log(`STALE DATA: latest closed candle ${new Date(latest.time).toISOString()}, age ${Math.round(dataAge / 60000)}m`);
  process.exit(0);
}

console.log(`ANALYSIS LATEST: ${new Date(latest.time).toISOString()} | age=${Math.round(dataAge / 60000)}m | closed=true`);

function aggregate(source, minutes) {
  const step = minutes * 60000;
  const out = [];
  for (const c of source) {
    const t = Math.floor(c.time / step) * step;
    const last = out.at(-1);
    if (!last || last.time !== t) {
      out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return out;
}

function swings(source) {
  const out = [];
  for (let i = 2; i < source.length - 2; i += 1) {
    const c = source[i];
    if (c.high > source[i - 1].high && c.high >= source[i + 1].high) out.push({ type: 'H', price: c.high, time: c.time, index: i });
    if (c.low < source[i - 1].low && c.low <= source[i + 1].low) out.push({ type: 'L', price: c.low, time: c.time, index: i });
  }
  return out;
}

function structure(source) {
  const s = swings(source.slice(-160));
  const highs = s.filter((x) => x.type === 'H');
  const lows = s.filter((x) => x.type === 'L');
  if (highs.length < 2 || lows.length < 2) return 'UNKNOWN';
  const h1 = highs.at(-2), h2 = highs.at(-1), l1 = lows.at(-2), l2 = lows.at(-1);
  if (h2.price > h1.price && l2.price > l1.price) return 'BULLISH';
  if (h2.price < h1.price && l2.price < l1.price) return 'BEARISH';
  return 'RANGE';
}

function fib(source) {
  const s = swings(source.slice(-180));
  const highs = s.filter((x) => x.type === 'H');
  const lows = s.filter((x) => x.type === 'L');
  if (!highs.length || !lows.length) return null;
  const hi = highs.at(-1), lo = lows.at(-1);
  const distance = Math.abs(hi.price - lo.price);
  if (!Number.isFinite(distance) || distance <= 0) return null;
  const up = hi.time > lo.time;
  const levels = Object.fromEntries(FIBS.map((level) => [level, up ? lo.price + distance * level : hi.price - distance * level]));
  return { levels, anchorHigh: hi.price, anchorLow: lo.price, direction: up ? 'UP' : 'DOWN', range: distance };
}

function nearestFib(f, price) {
  if (!f || !f.range) return null;
  const tolerance = Math.max(f.range * 0.07, 0.5);
  return FIBS
    .map((level) => ({ level, price: f.levels[level], dist: Math.abs(price - f.levels[level]) }))
    .filter((x) => x.dist <= tolerance)
    .sort((a, b) => a.dist - b.dist)[0] || null;
}

function recentRange(source, count) {
  const p = source.slice(-count);
  if (!p.length) return 0;
  return Math.max(...p.map((x) => x.high)) - Math.min(...p.map((x) => x.low));
}

function detectOrderBlock(source, direction) {
  const start = Math.max(0, source.length - 12);
  for (let i = source.length - 2; i >= start; i -= 1) {
    const c = source[i];
    if (direction === 'BUY' && c.close < c.open) return { time: c.time, high: c.high, low: c.low };
    if (direction === 'SELL' && c.close > c.open) return { time: c.time, high: c.high, low: c.low };
  }
  return null;
}

function detectFvg(source, direction) {
  for (let i = source.length - 1; i >= Math.max(2, source.length - 10); i -= 1) {
    const a = source[i - 2], c = source[i];
    if (direction === 'BUY' && c.low > a.high) return { time: c.time, low: a.high, high: c.low };
    if (direction === 'SELL' && c.high < a.low) return { time: c.time, low: c.high, high: a.low };
  }
  return null;
}

// A sweep is valid only when its liquidity level is defined BEFORE the sweep candle.
// Confirmation must happen AFTER the sweep. This prevents a stale sweep from being
// combined with an unrelated later MSS/BOS and creating a false direction.
function recentSweep(source, direction) {
  const first = Math.max(6, source.length - 8);
  for (let i = source.length - 1; i >= first; i -= 1) {
    const prior = source.slice(i - 6, i);
    if (prior.length < 6) continue;
    const level = direction === 'BUY'
      ? Math.min(...prior.map((x) => x.low))
      : Math.max(...prior.map((x) => x.high));
    const c = source[i];
    const swept = direction === 'BUY'
      ? c.low < level && c.close > level
      : c.high > level && c.close < level;
    if (!swept) continue;

    for (let j = i + 1; j <= Math.min(source.length - 1, i + 3); j += 1) {
      const confirm = source[j];
      const p3 = source.slice(Math.max(0, j - 3), j);
      const p6 = source.slice(Math.max(0, j - 6), j);
      if (p3.length < 3 || p6.length < 6) continue;
      const high3 = Math.max(...p3.map((x) => x.high));
      const low3 = Math.min(...p3.map((x) => x.low));
      const high6 = Math.max(...p6.map((x) => x.high));
      const low6 = Math.min(...p6.map((x) => x.low));
      const body = Math.abs(confirm.close - confirm.open);
      const candleRange = Math.max(confirm.high - confirm.low, 1e-9);
      const displacement = body / candleRange >= 0.35;
      const mss = direction === 'BUY' ? confirm.close > high3 : confirm.close < low3;
      const bos = direction === 'BUY' ? confirm.close > high6 : confirm.close < low6;
      if ((mss || bos) && displacement) {
        return { sweepIndex: i, confirmIndex: j, level, mss, bos, displacement, time: c.time };
      }
    }
  }
  return null;
}

function signalAt(index) {
  const a = closed.slice(0, index + 1);
  if (a.length < 160) return null;

  const m15 = aggregate(a, 15);
  const h1 = aggregate(a, 60);
  const h4 = aggregate(a, 240);
  if (m15.length < 20 || h1.length < 50 || h4.length < 20) return null;

  const st4 = structure(h4);
  const st1 = structure(h1);
  const st15 = structure(m15);
  const c = a.at(-1);
  const prev6 = a.slice(-7, -1);
  const prev3 = a.slice(-4, -1);
  const prevHigh6 = Math.max(...prev6.map((x) => x.high));
  const prevLow6 = Math.min(...prev6.map((x) => x.low));
  const prevHigh3 = Math.max(...prev3.map((x) => x.high));
  const prevLow3 = Math.min(...prev3.map((x) => x.low));

  const range = Math.max(c.high - c.low, 1e-9);
  const body = Math.abs(c.close - c.open);
  const displacement = body / range >= 0.35;
  const bosBuy = c.close > prevHigh6;
  const bosSell = c.close < prevLow6;
  const mssBuy = c.close > prevHigh3;
  const mssSell = c.close < prevLow3;

  const buySweep = recentSweep(a, 'BUY');
  const sellSweep = recentSweep(a, 'SELL');
  const sweepBuy = Boolean(buySweep && buySweep.confirmIndex === a.length - 1);
  const sweepSell = Boolean(sellSweep && sellSweep.confirmIndex === a.length - 1);

  const zone = a.slice(-40, -1);
  const support = Math.min(...zone.map((x) => x.low));
  const resistance = Math.max(...zone.map((x) => x.high));
  const zoneTolerance = Math.max(recentRange(a, 40) * 0.06, 0.5);
  const nearSupport = Math.abs(c.low - support) <= zoneTolerance || (c.low <= support + zoneTolerance && c.close > support);
  const nearResistance = Math.abs(c.high - resistance) <= zoneTolerance || (c.high >= resistance - zoneTolerance && c.close < resistance);
  const supportReject = nearSupport && c.close > c.open && c.close > support;
  const resistanceReject = nearResistance && c.close < c.open && c.close < resistance;

  const bullContext = st1 !== 'BEARISH' && st15 !== 'BEARISH';
  const bearContext = st1 !== 'BULLISH' && st15 !== 'BULLISH';

  // Direction is now selected by independent directional evidence instead of
  // BUY-first precedence. If both sides qualify, the stronger side wins only
  // when the difference is meaningful; otherwise we stay flat.
  const buyReversal = Boolean(buySweep && (buySweep.mss || buySweep.bos));
  const sellReversal = Boolean(sellSweep && (sellSweep.mss || sellSweep.bos));
  const buyContinuation = bullContext && bosBuy && displacement;
  const sellContinuation = bearContext && bosSell && displacement;
  const buyRejection = supportReject && (sweepBuy || mssBuy) && displacement;
  const sellRejection = resistanceReject && (sweepSell || mssSell) && displacement;

  const buyEvidence = [buyReversal, buyContinuation, buyRejection, mssBuy, bosBuy, sweepBuy].filter(Boolean).length;
  const sellEvidence = [sellReversal, sellContinuation, sellRejection, mssSell, bosSell, sweepSell].filter(Boolean).length;

  let direction = null;
  let setup = '';
  if (buyReversal || buyContinuation || buyRejection) {
    direction = 'BUY';
    setup = buyReversal ? 'LIQUIDITY_SWEEP_MSS' : buyRejection ? 'SUPPORT_REJECTION' : 'STRUCTURE_CONTINUATION';
  }
  if (sellReversal || sellContinuation || sellRejection) {
    if (!direction || sellEvidence > buyEvidence) {
      direction = 'SELL';
      setup = sellReversal ? 'LIQUIDITY_SWEEP_MSS' : sellRejection ? 'RESISTANCE_REJECTION' : 'STRUCTURE_CONTINUATION';
    } else if (sellEvidence === buyEvidence) {
      // Conflicting directional evidence is not a trade.
      return null;
    }
  }
  if (!direction) return null;

  const sweep = direction === 'BUY' ? sweepBuy : sweepSell;
  const mss = direction === 'BUY' ? mssBuy : mssSell;
  const bos = direction === 'BUY' ? bosBuy : bosSell;
  const context = direction === 'BUY' ? bullContext : bearContext;
  const rejection = direction === 'BUY' ? supportReject : resistanceReject;
  const sweepData = direction === 'BUY' ? buySweep : sellSweep;
  const ob = detectOrderBlock(a, direction);
  const fvg = detectFvg(a, direction);
  const fibData = fib(a);
  const fibMatch = nearestFib(fibData, c.close);

  let score = 0;
  if (mss) score += 2;
  if (bos) score += 2;
  if (sweep) score += 2;
  if (displacement) score += 1;
  if (context) score += 1;
  if (rejection) score += 1;
  if (fibMatch) score += fibMatch.dist <= Math.max((fibData?.range || 0) * 0.03, 0.25) ? 2 : 1;
  score = Math.min(MAX_SCORE, score);

  const primaryTrigger = Boolean(sweepData && (sweepData.mss || sweepData.bos)) || Boolean(bos && displacement) || Boolean(rejection && (mss || sweep) && displacement);
  if (!primaryTrigger) return null;
  if (score < MIN_SCORE) return null;

  const entry = c.close;
  const swingLow = Math.min(...a.slice(-12).map((x) => x.low));
  const swingHigh = Math.max(...a.slice(-12).map((x) => x.high));
  const structuralRange = Math.max(recentRange(a, 12), range, 0.5);
  let risk = direction === 'BUY' ? entry - swingLow : swingHigh - entry;
  risk = Math.max(structuralRange * 0.25, Math.min(structuralRange * 1.5, risk));
  if (!Number.isFinite(risk) || risk <= 0) return null;

  return {
    direction,
    setup,
    entry,
    sl: direction === 'BUY' ? entry - risk : entry + risk,
    tp1: direction === 'BUY' ? entry + risk : entry - risk,
    tp2: direction === 'BUY' ? entry + 2 * risk : entry - 2 * risk,
    score,
    candleTime: c.time,
    h4: st4,
    h1: st1,
    m15: st15,
    bos,
    mss,
    sweep,
    displacement,
    rejection,
    ob,
    fvg,
    fib: fibMatch,
    fibLevel: fibMatch?.level ?? null,
  };
}

let signal = null;
for (let i = closed.length - 1; i >= Math.max(0, closed.length - 4); i -= 1) {
  const candidate = signalAt(i);
  if (candidate && NOW - candidate.candleTime <= SIGNAL_MAX_AGE) {
    signal = candidate;
    break;
  }
}

if (!signal) {
  console.log('NO CURRENT QUALIFYING SIGNAL (SMC + structure + Fibonacci; EMA/ATR disabled)');
  process.exit(0);
}

console.log(`QUALIFYING SIGNAL: ${signal.direction} ${signal.setup} score=${signal.score}/10 candle=${new Date(signal.candleTime).toISOString()}`);

const state = load(STATE, {});
const key = `${signal.direction}|${signal.setup}|${signal.candleTime}|${signal.entry.toFixed(2)}`;
if (state.lastSignalKey === key) {
  console.log('DUPLICATE SIGNAL — not sent');
  process.exit(0);
}

function iranTime(ts) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(normalizeTs(ts)));
}

async function send(s) {
  if (!TOKEN || !CHAT) throw Error('Telegram secrets missing');
  const strength = s.score >= 9 ? '🟢 STRONG' : '🟡 VALID';
  const setupName = s.setup === 'LIQUIDITY_SWEEP_MSS' ? 'Liquidity Sweep + MSS' : s.setup === 'SUPPORT_REJECTION' ? 'Support Rejection' : s.setup === 'RESISTANCE_REJECTION' ? 'Resistance Rejection' : 'Structure Continuation';
  const fibLine = s.fib ? `Fib: ${s.fibLevel.toFixed(3)} @ ${s.fib.price.toFixed(2)}` : 'Fib: no nearby level';
  const text = [
    `${s.direction === 'BUY' ? '🟢' : '🔴'} XAUUSD ${s.direction} V5`,
    '', `${strength} | Score ${s.score}/10`, `📌 Setup: ${setupName}`,
    `🕐 Signal: ${iranTime(s.candleTime)} (Iran)`, '',
    `Entry: ${s.entry.toFixed(2)}`, `SL: ${s.sl.toFixed(2)}`,
    `TP1: ${s.tp1.toFixed(2)}`, `TP2: ${s.tp2.toFixed(2)} (Extended Target)`, '',
    `H4: ${s.h4} | H1: ${s.h1} | M15: ${s.m15}`,
    `BOS: ${s.bos ? 'YES' : 'NO'} | MSS: ${s.mss ? 'YES' : 'NO'} | Sweep: ${s.sweep ? 'YES' : 'NO'}`,
    `OB: ${s.ob ? 'YES' : 'NO'} | FVG: ${s.fvg ? 'YES' : 'NO'}`,
    fibLine, '', 'EMA: OFF | ATR: OFF',
  ].join('\n');

  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw Error(`Telegram send failed: ${data.description || response.status}`);
  console.log('Telegram signal sent successfully.');
}

send(signal)
  .then(() => save(STATE, { ...state, lastSignalKey: key, lastSignalAt: signal.candleTime, lastDirection: signal.direction }))
  .catch((err) => { console.error(err); process.exitCode = 1; });
