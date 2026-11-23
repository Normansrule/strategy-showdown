// Trading floor (docs/floor.html): the synthetic market, paper trading and the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { createMarket, step, depth, aggregateBars, vwap, findInstrument, clock, INSTRUMENTS, TICK, SESSION_OPEN, SECONDS_PER_YEAR } from '../../docs/engine/floor/market.js';
import { createAccount, submit, onTick, cancel, applyFill, markToMarket, checkOrder } from '../../docs/engine/floor/paper.js';
import { parse, complete } from '../../docs/engine/floor/commands.js';

const onTickGrid = px => Math.abs(Math.round(px / TICK) * TICK - px) < 1e-9;

// ---------------------------------------------------------------- market
test('same seed, same market; different seed, different market', () => {
  const a = createMarket({ seed: 11, warmup: 900 });
  const b = createMarket({ seed: 11, warmup: 900 });
  const c = createMarket({ seed: 12, warmup: 900 });
  assert.deepEqual(a.inst.map(s => [s.bid, s.ask, s.volume]), b.inst.map(s => [s.bid, s.ask, s.volume]));
  assert.deepEqual(depth(a, 3), depth(b, 3));
  assert.notDeepEqual(a.inst.map(s => s.bid), c.inst.map(s => s.bid));
});

test('every instrument is marked as simulated', () => {
  for (const d of INSTRUMENTS) assert.match(d.sym, /^[A-Z]{4}\.SIM$/);
});

test('quotes, trades and bars stay internally consistent over a long session', () => {
  const m = createMarket({ seed: 5 });
  for (let k = 0; k < 6 * 3600; k++) {
    const trades = step(m);
    for (const s of m.inst) {
      assert.ok(s.bid > 0 && s.ask > s.bid, `${s.sym} crossed or locked at ${m.t}`);
      assert.ok(onTickGrid(s.bid) && onTickGrid(s.ask), 'quotes on the 0.01 grid');
    }
    for (const tr of trades) {
      const s = m.inst[findInstrument(m, tr.sym)];
      assert.equal(tr.px, tr.side === 'B' ? s.ask : s.bid, 'buyer-initiated at the ask, seller-initiated at the bid');
      assert.ok(tr.size >= 100 && tr.size % 100 === 0, 'round lots');
    }
  }
  for (const s of m.inst) {
    const barVol = s.bars.reduce((a, b) => a + b.v, 0);
    assert.equal(barVol, s.volume, `${s.sym}: bar volume = day volume`);
    for (const b of s.bars) assert.ok(b.l <= Math.min(b.o, b.c) + 1e-9 && b.h >= Math.max(b.o, b.c) - 1e-9, 'OHLC ordering');
    assert.ok(s.dayLow <= vwap(s) && vwap(s) <= s.dayHigh, 'VWAP inside the day range');
  }
});

test('realised volatility is in the neighbourhood of each target (GARCH noise allowed)', () => {
  const m = createMarket({ seed: 3 });
  const rets = m.inst.map(() => []);
  for (let k = 0; k < 20 * 23400; k++) { step(m); m.inst.forEach((s, i) => rets[i].push(s.lastRet)); }
  m.inst.forEach((s, i) => {
    const r = rets[i];
    const mu = r.reduce((a, b) => a + b, 0) / r.length;
    const v = r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1);
    const ann = Math.sqrt(v * SECONDS_PER_YEAR);
    assert.ok(ann > s.vol * 0.7 && ann < s.vol * 1.4, `${s.sym}: realised ${ann.toFixed(3)} vs target ${s.vol}`);
  });
});

test('depth: ten levels a side, one tick apart, starting at the touch', () => {
  const m = createMarket({ seed: 1, warmup: 120 });
  const s = m.inst[0];
  const { bids, asks } = depth(m, 0);
  assert.equal(bids.length, 10); assert.equal(asks.length, 10);
  assert.equal(bids[0].px, s.bid); assert.equal(asks[0].px, s.ask);
  for (let k = 1; k < 10; k++) {
    assert.ok(Math.abs(bids[k - 1].px - bids[k].px - TICK) < 1e-9);
    assert.ok(Math.abs(asks[k].px - asks[k - 1].px - TICK) < 1e-9);
  }
});

test('bar aggregation keeps volume and the high/low range', () => {
  const m = createMarket({ seed: 2, warmup: 3600 });
  const one = m.inst[1].bars;
  const five = aggregateBars(one, 5);
  assert.equal(five.reduce((a, b) => a + b.v, 0), one.reduce((a, b) => a + b.v, 0));
  assert.equal(Math.max(...five.map(b => b.h)), Math.max(...one.filter(b => b.n).map(b => b.h)));
  for (const b of five) assert.equal((b.t - SESSION_OPEN) % 300, 0, 'aligned to the open');
});

test('symbol lookup and clock', () => {
  const m = createMarket();
  assert.equal(findInstrument(m, 'alfa'), 0);
  assert.equal(findInstrument(m, 'ALFA.sim'), 0);
  assert.equal(findInstrument(m, 'AAPL'), -1);
  assert.equal(clock(SESSION_OPEN), '09:30:00');
  assert.equal(clock(SESSION_OPEN + 3725), '10:32:05');
});

// ---------------------------------------------------------------- paper trading
test('average cost, partial close, flip and realised P&L', () => {
  const a = createAccount();
  applyFill(a, { sym: 'X', side: 'B', qty: 100, px: 10 });
  applyFill(a, { sym: 'X', side: 'B', qty: 100, px: 12 });
  let p = a.positions.get('X');
  assert.equal(p.qty, 200); assert.equal(p.avgPx, 11);
  applyFill(a, { sym: 'X', side: 'S', qty: 50, px: 13 });
  p = a.positions.get('X');
  assert.equal(p.qty, 150); assert.equal(p.avgPx, 11); assert.equal(p.realized, 100);
  applyFill(a, { sym: 'X', side: 'S', qty: 250, px: 9 }); // close 150 at −2, open 100 short at 9
  p = a.positions.get('X');
  assert.equal(p.qty, -100); assert.equal(p.avgPx, 9); assert.equal(p.realized, 100 - 300);
  applyFill(a, { sym: 'X', side: 'B', qty: 100, px: 8 });
  p = a.positions.get('X');
  assert.equal(p.qty, 0); assert.equal(p.avgPx, 0); assert.equal(p.realized, -200 + 100);
});

test('market order walks the simulated book', () => {
  const m = createMarket({ seed: 9, warmup: 60 });
  const book = depth(m, 1);
  const qty = book.asks[0].size + book.asks[1].size + 100;
  const a = createAccount();
  const { order } = submit(a, m, { side: 'B', qty, sym: 'brvo', type: 'market' });
  assert.equal(order.status, 'filled');
  assert.equal(order.filled, qty);
  const expected = (book.asks[0].px * book.asks[0].size + book.asks[1].px * book.asks[1].size + book.asks[2].px * 100) / qty;
  assert.ok(Math.abs(order.avgPx - expected) < 1e-9);
  assert.ok(order.avgPx > m.inst[1].ask, 'size pays more than the touch');
});

test('resting limit fills at the touch once reached; cancel stops it', () => {
  const m = createMarket({ seed: 4, warmup: 60 });
  const a = createAccount();
  const s = m.inst[0];
  const limit = Number((s.bid - 0.05).toFixed(2));
  const { order } = submit(a, m, { side: 'B', qty: 300, sym: 'alfa', type: 'limit', limit });
  assert.equal(order.status, 'working');
  let n = 0;
  while (order.status === 'working' && n++ < 20000) { step(m); onTick(a, m); }
  assert.equal(order.status, 'filled');
  assert.ok(order.avgPx <= limit, 'never worse than the limit');
  const { order: o2 } = submit(a, m, { side: 'S', qty: 100, sym: 'alfa', type: 'limit', limit: Number((m.inst[0].ask + 0.5).toFixed(2)) });
  assert.equal(cancel(a, o2.id), 1);
  assert.equal(o2.status, 'cancelled');
  assert.equal(cancel(a, 'all'), 0);
});

test('order checks refuse bad tickets (fat-finger band, tick, size, symbol)', () => {
  const m = createMarket({ seed: 1 });
  const mid = m.inst[0].mid;
  assert.match(checkOrder(m, { side: 'B', qty: 100, sym: 'alfa', type: 'limit', limit: Number((mid * 1.5).toFixed(2)) }), /typo/);
  assert.match(checkOrder(m, { side: 'B', qty: 100, sym: 'alfa', type: 'limit', limit: 84.123 }), /tick/);
  assert.match(checkOrder(m, { side: 'B', qty: 0, sym: 'alfa', type: 'market' }), /Quantity/);
  assert.match(checkOrder(m, { side: 'B', qty: 2_000_000, sym: 'alfa', type: 'market' }), /limit/);
  assert.match(checkOrder(m, { side: 'B', qty: 100, sym: 'msft', type: 'market' }), /Unknown symbol/);
  assert.equal(checkOrder(m, { side: 'S', qty: 100, sym: 'alfa', type: 'market' }), null);
});

test('mark to market sums realised and unrealised', () => {
  const m = createMarket({ seed: 6, warmup: 30 });
  const a = createAccount();
  submit(a, m, { side: 'B', qty: 100, sym: 'echo', type: 'market' });
  for (let k = 0; k < 600; k++) step(m);
  const r = markToMarket(a, m);
  const p = r.rows[0];
  assert.ok(Math.abs(p.unrealized - (m.inst[4].mid - p.avgPx) * 100) < 1e-9);
  assert.ok(Math.abs(r.total - (r.realized + r.unrealized)) < 1e-9);
});

// ---------------------------------------------------------------- command line
test('command parsing', () => {
  assert.deepEqual(parse('buy 100 alfa'), { cmd: 'order', side: 'B', qty: 100, sym: 'alfa', type: 'market' });
  assert.deepEqual(parse('SELL 1,500 brvo @ 212.40'), { cmd: 'order', side: 'S', qty: 1500, sym: 'brvo', type: 'limit', limit: 212.4 });
  assert.deepEqual(parse('buy alfa 200 @84.1'), { cmd: 'order', side: 'B', qty: 200, sym: 'alfa', type: 'limit', limit: 84.1 });
  assert.deepEqual(parse('ALFA.SIM'), { cmd: 'load', sym: 'ALFA.SIM' });
  assert.deepEqual(parse('cancel all'), { cmd: 'cancel', id: 'all' });
  assert.deepEqual(parse('cancel 7'), { cmd: 'cancel', id: 7 });
  assert.deepEqual(parse('interval 5m'), { cmd: 'interval', minutes: 5 });
  assert.deepEqual(parse('speed 10'), { cmd: 'speed', speed: 10 });
  assert.deepEqual(parse('max depth'), { cmd: 'max', panel: 'depth' });
  assert.deepEqual(parse('reset 42'), { cmd: 'reset', seed: 42 });
  assert.deepEqual(parse('flatten'), { cmd: 'flatten', sym: 'all' });
  for (const bad of ['buy', 'buy -5 alfa', 'buy 100 alfa @', 'buy 1.5 alfa', 'speed 3', 'max news', 'interval 2h', 'rm -rf /', 'buy 100 alfa @ abc'])
    assert.ok(parse(bad).error, `should reject "${bad}"`);
  assert.deepEqual(parse('   '), { cmd: 'noop' });
});

test('tab completion', () => {
  const syms = INSTRUMENTS.map(d => d.sym.replace('.SIM', ''));
  assert.equal(complete('bu', syms).input, 'buy ');
  assert.equal(complete('buy 100 br', syms).input, 'buy 100 brvo ');
  assert.equal(complete('max de', syms).input, 'max depth ');
  assert.deepEqual(complete('s', syms).options.sort(), ['sell', 'speed'].sort());
});

// ---------------------------------------------------------------- isolation
test('floor code never touches the network or Node', () => {
  const files = [
    ...readdirSync('docs/engine/floor').map(f => path.join('docs/engine/floor', f)),
    'docs/assets/js/floor.js',
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/, `${f} makes network calls`);
    assert.doesNotMatch(src, /https?:\/\//, `${f} names a remote URL`);
    assert.doesNotMatch(src, /\binnerHTML\b|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/, `${f} builds HTML from strings or evaluates code`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/, `${f} persists state (paper trades must stay in memory)`);
  }
});

test('the floor page carries the disclaimer, the simulated-data label and the shared CSP', () => {
  const html = readFileSync('docs/floor.html', 'utf8');
  assert.match(html, /not investment advice/i);
  assert.match(html, /simulated/i);
  assert.match(html, /paper/i);
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self';/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
  assert.doesNotMatch(html, /\sstyle="/, 'no inline styles');
  assert.doesNotMatch(html, /bloomberg/i, 'no vendor names');
});
