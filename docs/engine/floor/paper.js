// Paper trading against the SIMULATED market in market.js. No order ever leaves the page: there is no broker, no
// account and no network. The fill model is deliberately simple and is stated on the floor page:
//   • market orders walk the simulated depth of book at the current tick (so large orders pay for size);
//   • a marketable limit order takes what the book shows within its limit and rests the remainder;
//   • a resting limit order fills in full at the touch once the touch reaches its price (no queue position, no
//     partial fills while resting, no market impact after the fill);
//   • no fees, borrow costs or short-sale constraints.
// Positions use average cost; realised P&L is booked when a position is reduced, closed or flipped.
import { depth, findInstrument } from './market.js';

export const MAX_QTY = 1_000_000;
export const PRICE_BAND = 0.10; // limit prices more than 10% from the mid are refused (fat-finger check)

export function createAccount() {
  return { nextId: 1, orders: [], fills: [], positions: new Map(), log: [] };
}

const sign = side => (side === 'B' ? 1 : -1);
const round2 = x => Math.round(x * 100) / 100;

/** Book one fill into the account's positions (average cost; realised P&L on reductions and flips). */
export function applyFill(acct, fill) {
  const p = acct.positions.get(fill.sym) || { sym: fill.sym, qty: 0, avgPx: 0, realized: 0 };
  const dq = sign(fill.side) * fill.qty;
  if (p.qty === 0 || Math.sign(p.qty) === Math.sign(dq)) {
    const q = Math.abs(p.qty) + fill.qty;
    p.avgPx = (p.avgPx * Math.abs(p.qty) + fill.px * fill.qty) / q;
    p.qty += dq;
  } else {
    const closing = Math.min(fill.qty, Math.abs(p.qty));
    p.realized += closing * (fill.px - p.avgPx) * Math.sign(p.qty);
    const remaining = p.qty + dq;
    if (remaining === 0) p.avgPx = 0;
    else if (Math.sign(remaining) !== Math.sign(p.qty)) p.avgPx = fill.px; // flipped through zero
    p.qty = remaining;
  }
  acct.positions.set(fill.sym, p);
  acct.fills.push(fill);
}

/** Validate an order ticket; returns an error message or null. */
export function checkOrder(mkt, { side, qty, sym, type, limit }) {
  if (side !== 'B' && side !== 'S') return 'Side must be buy or sell.';
  if (!Number.isInteger(qty) || qty <= 0) return 'Quantity must be a whole number of shares above zero.';
  if (qty > MAX_QTY) return `Quantity above the ${MAX_QTY.toLocaleString('en-US')} share limit.`;
  const i = findInstrument(mkt, sym);
  if (i < 0) return `Unknown symbol ${sym}.`;
  if (type === 'limit') {
    if (!Number.isFinite(limit) || limit <= 0) return 'Limit price must be a positive number.';
    if (Math.abs(Math.round(limit * 100) - limit * 100) > 1e-6) return 'Limit price must be on the 0.01 tick.';
    const mid = mkt.inst[i].mid;
    if (Math.abs(limit / mid - 1) > PRICE_BAND) return `Limit ${limit.toFixed(2)} is more than ${PRICE_BAND * 100}% from the mid (${mid.toFixed(2)}): refused as a likely typo.`;
  } else if (type !== 'market') return 'Order type must be market or limit.';
  return null;
}

/** Fill `qty` against one side of the simulated book; returns the per-level fills. */
function walk(levels, qty, overflow) {
  const fills = [];
  let left = qty;
  for (const lv of levels) {
    if (left <= 0) break;
    const q = Math.min(left, lv.size);
    fills.push({ px: lv.px, qty: q });
    left -= q;
  }
  if (left > 0 && overflow && levels.length) { const lastPx = levels[levels.length - 1].px; fills.push({ px: lastPx, qty: left }); } // beyond shown depth: fill at the worst level shown
  return fills;
}

/**
 * Submit a paper order. Returns { order } or { error }. A marketable order fills at once against the simulated
 * depth; a resting limit order waits for onTick().
 */
export function submit(acct, mkt, ticket) {
  const error = checkOrder(mkt, ticket);
  if (error) return { error };
  const i = findInstrument(mkt, ticket.sym);
  const s = mkt.inst[i];
  const order = { id: acct.nextId++, t: mkt.t, sym: s.sym, side: ticket.side, qty: ticket.qty, type: ticket.type,
    limit: ticket.type === 'limit' ? round2(ticket.limit) : null, filled: 0, avgPx: null, status: 'working' };
  acct.orders.push(order);
  const book = depth(mkt, i);
  const levels = order.side === 'B' ? book.asks : book.bids;
  const marketable = order.type === 'market' || (order.side === 'B' ? order.limit >= s.ask : order.limit <= s.bid);
  if (marketable) {
    const usable = order.type === 'market' ? levels : levels.filter(l => (order.side === 'B' ? l.px <= order.limit : l.px >= order.limit));
    // A market order beyond the shown depth fills the rest at the worst level shown; a limit order fills only what
    // the book offers within its limit and leaves the rest working.
    fillOrder(acct, order, walk(usable, order.qty, order.type === 'market'), mkt.t);
  }
  return { order };
}

function fillOrder(acct, order, parts, t) {
  let notional = (order.avgPx || 0) * order.filled, q = order.filled;
  for (const p of parts) {
    applyFill(acct, { orderId: order.id, t, sym: order.sym, side: order.side, qty: p.qty, px: p.px });
    notional += p.px * p.qty; q += p.qty;
  }
  order.filled = q;
  order.avgPx = q ? notional / q : null;
  order.status = q >= order.qty ? 'filled' : 'working';
}

/** After each market step: fill resting limit orders whose price the touch has reached. Returns orders filled. */
export function onTick(acct, mkt) {
  const done = [];
  for (const o of acct.orders) {
    if (o.status !== 'working') continue;
    const s = mkt.inst[findInstrument(mkt, o.sym)];
    const left = o.qty - o.filled;
    if (o.side === 'B' && s.ask <= o.limit) { fillOrder(acct, o, [{ px: s.ask, qty: left }], mkt.t); done.push(o); }
    else if (o.side === 'S' && s.bid >= o.limit) { fillOrder(acct, o, [{ px: s.bid, qty: left }], mkt.t); done.push(o); }
  }
  return done;
}

/** Cancel one working order by id, or every working order with 'all'. Returns the number cancelled. */
export function cancel(acct, which) {
  let n = 0;
  for (const o of acct.orders) {
    if (o.status !== 'working') continue;
    if (which === 'all' || o.id === which) { o.status = 'cancelled'; n++; }
  }
  return n;
}

/** Positions marked to the simulated mid, plus account totals. */
export function markToMarket(acct, mkt) {
  const rows = [];
  let unreal = 0, real = 0, gross = 0;
  for (const p of acct.positions.values()) {
    const s = mkt.inst[findInstrument(mkt, p.sym)];
    const u = p.qty ? (s.mid - p.avgPx) * p.qty : 0;
    rows.push({ ...p, mark: s.mid, unrealized: u, value: p.qty * s.mid });
    unreal += u; real += p.realized; gross += Math.abs(p.qty * s.mid);
  }
  rows.sort((a, b) => a.sym.localeCompare(b.sym));
  return { rows, unrealized: unreal, realized: real, total: unreal + real, gross };
}
