// Avellaneda & Stoikov (2008) market-making model, simulated exactly as in the paper's Sec. 3.3.
// This is a SIMULATION of the paper's stylized market, not a historical backtest: market making cannot be
// backtested honestly on monthly (or daily) bars because fills depend on the limit order book.
import { makeRng } from '../mathx.js';

export const PAPER_SETTINGS = { s0: 100, T: 1, sigma: 2, dt: 0.005, q0: 0, k: 1.5, A: 140, nSims: 1000 };

/** Reservation (indifference) price, Eq. (8)/(29): r = s − q γ σ² (T − t). */
export const reservationPrice = (s, q, t, { gamma, sigma, T }) => s - q * gamma * sigma * sigma * (T - t);

/** Optimal total spread, Eq. (30): δa + δb = γ σ² (T − t) + (2/γ) ln(1 + γ/k).
 *  The γσ²(T−t) reading is the one that reproduces the paper's reported average spreads (1.49, 1.35, 3.02). */
export const optimalSpread = (t, { gamma, sigma, T, k }) => gamma * sigma * sigma * (T - t) + (2 / gamma) * Math.log(1 + gamma / k);

/** Time average of the inventory strategy's spread over the session (deterministic in t). */
export function averageSpread(p) {
  const steps = Math.round(p.T / p.dt);
  let sum = 0;
  for (let i = 0; i < steps; i++) sum += optimalSpread(i * p.dt, p);
  return sum / steps;
}

/**
 * Run the paper's Monte Carlo for one γ. strategy: 'inventory' (time-varying optimal spread around r) or
 * 'symmetric' — the paper's benchmark, which "uses the average bid/ask spread of the inventory strategy over the
 * time period, but centres it round the mid-price" (Sec. 3.3): a CONSTANT spread around s. Price follows the paper's binomial walk s ± σ√dt; an order at distance δ fills within dt with
 * probability A·exp(−kδ)·dt.
 */
export function simulate({ gamma, strategy = 'inventory', seed = 1, ...overrides }) {
  const p = { ...PAPER_SETTINGS, ...overrides, gamma };
  const rng = makeRng(seed);
  const steps = Math.round(p.T / p.dt);
  const constSpread = averageSpread(p);
  const profits = [], finalQ = [], avgSpreads = [];
  let samplePath = null;
  for (let sim = 0; sim < p.nSims; sim++) {
    let s = p.s0, q = p.q0, cash = 0, spreadSum = 0;
    const path = sim === 0 ? [] : null;
    for (let i = 0; i < steps; i++) {
      const t = i * p.dt;
      const spread = strategy === 'inventory' ? optimalSpread(t, p) : constSpread;
      const center = strategy === 'inventory' ? reservationPrice(s, q, t, p) : s;
      const bid = center - spread / 2, ask = center + spread / 2;
      spreadSum += spread;
      const deltaA = ask - s, deltaB = s - bid;
      const probA = Math.min(1, p.A * Math.exp(-p.k * deltaA) * p.dt);
      const probB = Math.min(1, p.A * Math.exp(-p.k * deltaB) * p.dt);
      if (rng.next() < probA) { q -= 1; cash += ask; }
      if (rng.next() < probB) { q += 1; cash -= bid; }
      if (path) path.push({ t, s, bid, ask, r: center, q });
      s += rng.next() < 0.5 ? p.sigma * Math.sqrt(p.dt) : -p.sigma * Math.sqrt(p.dt);
    }
    profits.push(cash + q * s);
    finalQ.push(q);
    avgSpreads.push(spreadSum / steps);
    if (path) samplePath = path;
  }
  const m = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs => { const mu = m(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1)); };
  return {
    gamma, strategy,
    avgSpread: m(avgSpreads), profitMean: m(profits), profitStd: sd(profits),
    finalQMean: m(finalQ), finalQStd: sd(finalQ),
    profits, finalQ, samplePath,
  };
}

/** Values printed in the paper's Tables 1–3 (1000 simulations each), used as replication targets in tests. */
export const PAPER_TABLES = [
  { gamma: 0.1, strategy: 'inventory', avgSpread: 1.49, profitMean: 65.0, profitStd: 6.6, finalQMean: 0.08, finalQStd: 2.9 },
  { gamma: 0.1, strategy: 'symmetric', avgSpread: 1.49, profitMean: 68.4, profitStd: 12.7, finalQMean: 0.26, finalQStd: 8.4 },
  { gamma: 0.01, strategy: 'inventory', avgSpread: 1.35, profitMean: 68.6, profitStd: 8.7, finalQMean: 0.12, finalQStd: 5.1 },
  { gamma: 0.01, strategy: 'symmetric', avgSpread: 1.35, profitMean: 68.8, profitStd: 12.8, finalQMean: 0.09, finalQStd: 8.7 },
  { gamma: 1, strategy: 'inventory', avgSpread: 3.02, profitMean: 31.4, profitStd: 5.0, finalQMean: 0.02, finalQStd: 1.7 },
  { gamma: 1, strategy: 'symmetric', avgSpread: 3.02, profitMean: 44.0, profitStd: 11.0, finalQMean: 0.00, finalQStd: 5.1 },
];
