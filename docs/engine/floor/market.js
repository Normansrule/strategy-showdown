// Synthetic market for the trading floor (docs/floor.html). Every number it produces is SIMULATED: no real
// instrument, quote or trade is represented, and the instruments carry a ".SIM" suffix so they cannot be mistaken
// for listed tickers.
//
// Model, per simulated second (one "tick"):
//   • a market factor and each instrument's idiosyncratic part follow GARCH(1,1) variance (Bollerslev 1986), so
//     volatility clusters and the unconditional distribution of returns has fat tails, as in the stylized facts on
//     markets.html (Cont 2001);
//   • instrument log return r = β·m + e, with the idiosyncratic variance set so the total annualised volatility
//     matches the instrument's target;
//   • quotes: bid/ask on a 0.01 tick grid around the mid, spread widening with current volatility;
//   • trades: a Poisson number per tick (more when volatility is high), buyer-initiated at the ask, seller-initiated
//     at the bid, size in round lots;
//   • one-minute OHLCV bars built from those trades.
// Deterministic for a given seed: the same seed gives the same market, tick for tick (tests/js/floor.test.mjs).
import { makeRng } from '../mathx.js';

export const TICK = 0.01;
export const SESSION_OPEN = 9.5 * 3600; // 09:30:00 in seconds after midnight (simulated clock)
export const SECONDS_PER_YEAR = 252 * 6.5 * 3600;
export const BAR_SECONDS = 60;
const MAX_BARS = 2000;
const MAX_TAPE = 250;

// Fictional instruments. Names are invented; the .SIM suffix marks every symbol as simulated.
export const INSTRUMENTS = Object.freeze([
  { sym: 'ALFA.SIM', name: 'Alfa Industrials', sector: 'Industrials', px0: 84.20, beta: 1.05, vol: 0.28, spreadBp: 2.0, lam: 0.9 },
  { sym: 'BRVO.SIM', name: 'Bravo Semiconductor', sector: 'Technology', px0: 212.75, beta: 1.45, vol: 0.46, spreadBp: 1.6, lam: 1.4 },
  { sym: 'CRDN.SIM', name: 'Cardinal Bancorp', sector: 'Financials', px0: 47.36, beta: 1.15, vol: 0.31, spreadBp: 3.0, lam: 0.7 },
  { sym: 'DLTA.SIM', name: 'Delta Utilities', sector: 'Utilities', px0: 63.10, beta: 0.45, vol: 0.18, spreadBp: 3.2, lam: 0.4 },
  { sym: 'ECHO.SIM', name: 'Echo Consumer Brands', sector: 'Staples', px0: 128.40, beta: 0.60, vol: 0.20, spreadBp: 2.2, lam: 0.6 },
  { sym: 'FXTR.SIM', name: 'Foxtrot Energy', sector: 'Energy', px0: 92.85, beta: 0.95, vol: 0.36, spreadBp: 2.6, lam: 0.8 },
  { sym: 'GLFA.SIM', name: 'Gulf Pharma', sector: 'Health care', px0: 156.20, beta: 0.75, vol: 0.27, spreadBp: 2.4, lam: 0.6 },
  { sym: 'HTEL.SIM', name: 'Hotel Networks', sector: 'Communication', px0: 31.05, beta: 1.25, vol: 0.52, spreadBp: 4.5, lam: 0.9 },
]);

export const MARKET_VOL = 0.17; // annualised volatility of the market factor
const GARCH = { alpha: 0.06, beta: 0.93 }; // persistence 0.99 per simulated second-step

const perTickVar = annVol => (annVol * annVol) / SECONDS_PER_YEAR;
export const roundTick = px => Math.round(px / TICK) * TICK;
const fix = px => Number(px.toFixed(2));

/** Small integer hash so book depth at (seed, instrument, tick) is reproducible without storing it. */
function mix(...xs) {
  let hsh = 0x811c9dc5;
  for (const x of xs) { hsh ^= x >>> 0; hsh = Math.imul(hsh, 0x01000193) >>> 0; hsh ^= hsh >>> 13; }
  return hsh >>> 0;
}

function poisson(rng, lam) {
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng.next(); } while (p > L && k < 50);
  return k - 1;
}

function quote(s) {
  const volRatio = Math.sqrt(s.h / s.h0);
  const ticks = Math.max(1, Math.round((s.spreadBp * volRatio * s.mid) / 1e4 / TICK));
  const bid = fix(Math.floor((s.mid - (ticks * TICK) / 2) / TICK + 1e-9) * TICK);
  const ask = fix(bid + ticks * TICK);
  return { bid, ask };
}

function newBar(t, px) { return { t, o: px, h: px, l: px, c: px, v: 0, n: 0 }; }

/**
 * Create a simulated market. `warmup` seconds are simulated immediately so charts open with history.
 * @param {{seed?: number, warmup?: number, instruments?: typeof INSTRUMENTS}} opts
 */
export function createMarket({ seed = 7, warmup = 0, instruments = INSTRUMENTS } = {}) {
  const rng = makeRng(seed);
  const hm0 = perTickVar(MARKET_VOL);
  const mkt = {
    seed, t: SESSION_OPEN, step: 0, rng,
    factor: { h: hm0, h0: hm0, eps: 0 },
    inst: instruments.map((d) => {
      const total = perTickVar(d.vol);
      const idio = Math.max(total - d.beta * d.beta * hm0, total * 0.15);
      const s = { ...d, mid: d.px0, h: idio, h0: idio, eps: 0, totalVar: total, prevClose: d.px0, open: null,
        last: d.px0, dayHigh: d.px0, dayLow: d.px0, volume: 0, notional: 0, trades: 0, bars: [], tape: [], lastRet: 0 };
      Object.assign(s, quote(s));
      s.bars.push(newBar(SESSION_OPEN, d.px0));
      return s;
    }),
  };
  for (let i = 0; i < warmup; i++) step(mkt);
  return mkt;
}

const garch = (g, eps) => { g.h = g.h0 * (1 - GARCH.alpha - GARCH.beta) + GARCH.alpha * eps * eps + GARCH.beta * g.h; g.eps = eps; };

/** Advance the market by one simulated second. Returns the trades printed in that second (all instruments). */
export function step(mkt) {
  const { rng } = mkt;
  const m = Math.sqrt(mkt.factor.h) * rng.normal();
  garch(mkt.factor, m);
  mkt.t += 1; mkt.step += 1;
  const printed = [];
  for (const s of mkt.inst) {
    const e = Math.sqrt(s.h) * rng.normal();
    garch(s, e);
    const r = s.beta * m + e;
    s.mid *= Math.exp(r - s.totalVar / 2);
    s.lastRet = r;
    Object.assign(s, quote(s));
    const intensity = s.lam * Math.min(4, Math.sqrt((s.h + s.beta * s.beta * mkt.factor.h) / s.totalVar));
    const n = poisson(rng, intensity);
    const pBuy = Math.min(0.9, Math.max(0.1, 0.5 + r / (4 * Math.sqrt(s.totalVar))));
    for (let k = 0; k < n; k++) {
      const buy = rng.next() < pBuy;
      const px = buy ? s.ask : s.bid;
      const size = 100 * Math.max(1, Math.round(Math.exp(0.9 * rng.normal() + 0.6)));
      const tr = { t: mkt.t, sym: s.sym, px, size, side: buy ? 'B' : 'S' };
      record(s, tr);
      printed.push(tr);
    }
    rollBar(s, mkt.t);
  }
  return printed;
}

function record(s, tr) {
  if (s.open === null) s.open = tr.px;
  s.last = tr.px;
  s.dayHigh = Math.max(s.dayHigh, tr.px);
  s.dayLow = Math.min(s.dayLow, tr.px);
  s.volume += tr.size;
  s.notional += tr.px * tr.size;
  s.trades += 1;
  s.tape.push(tr);
  if (s.tape.length > MAX_TAPE) s.tape.splice(0, s.tape.length - MAX_TAPE);
  const bar = s.bars[s.bars.length - 1];
  if (bar.n === 0) { bar.o = bar.h = bar.l = tr.px; }
  bar.h = Math.max(bar.h, tr.px); bar.l = Math.min(bar.l, tr.px); bar.c = tr.px; bar.v += tr.size; bar.n += 1;
}

function rollBar(s, t) {
  if ((t - SESSION_OPEN) % BAR_SECONDS !== 0) return;
  const prev = s.bars[s.bars.length - 1];
  s.bars.push(newBar(t, prev.c));
  if (s.bars.length > MAX_BARS) s.bars.splice(0, s.bars.length - MAX_BARS);
}

/** Session VWAP (volume-weighted average trade price), or null before the first trade. */
export const vwap = s => (s.volume ? s.notional / s.volume : null);

/** Aggregate one-minute bars into k-minute bars (k = 1, 5, 15 …), aligned to the session open. */
export function aggregateBars(bars, k) {
  if (k <= 1) return bars.slice();
  const out = [];
  for (const b of bars) {
    const bucket = SESSION_OPEN + Math.floor((b.t - SESSION_OPEN) / (k * BAR_SECONDS)) * k * BAR_SECONDS;
    const cur = out[out.length - 1];
    if (!cur || cur.t !== bucket) { out.push({ ...b, t: bucket }); continue; }
    if (b.n > 0) {
      if (cur.n === 0) { cur.o = b.o; cur.h = b.h; cur.l = b.l; }
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l);
    }
    cur.c = b.c; cur.v += b.v; cur.n += b.n;
  }
  return out;
}

/**
 * Simulated depth of book for instrument index i at the market's current tick: `levels` price levels each side,
 * one tick apart from the touch, sizes in round lots that tend to grow away from the touch. Reproducible: it is a
 * pure function of (seed, instrument, tick, quote), so a paper order filled against it can be replayed.
 */
export function depth(mkt, i, levels = 10) {
  const s = mkt.inst[i];
  const rng = makeRng(mix(mkt.seed, i, mkt.step));
  const side = (start, dir) => Array.from({ length: levels }, (_, k) => {
    const px = fix(start + dir * k * TICK);
    const size = 100 * Math.max(1, Math.round((2 + 1.1 * k) * Math.exp(0.55 * rng.normal())));
    return { px, size };
  });
  return { bids: side(s.bid, -1), asks: side(s.ask, +1) };
}

/** Index of an instrument by symbol ("alfa", "ALFA", "alfa.sim" all match ALFA.SIM), or -1. */
export function findInstrument(mkt, text) {
  const q = String(text || '').trim().toUpperCase();
  if (!q) return -1;
  const full = q.endsWith('.SIM') ? q : `${q}.SIM`;
  return mkt.inst.findIndex(s => s.sym === full);
}

/** Simulated clock as HH:MM:SS. */
export function clock(t) {
  const s = Math.floor(t) % 86400;
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
