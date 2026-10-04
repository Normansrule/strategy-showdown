// Derivative-free minimization (Nelder–Mead simplex), used to fit the price models by maximum likelihood.
// Standard coefficients: reflection 1, expansion 2, contraction 0.5, shrink 0.5 (Nelder & Mead 1965; the
// textbook form as in Lagarias et al. 1998). Deterministic: same start, same answer.

/**
 * @param {(x: number[]) => number} f  objective (non-finite values are treated as +Infinity)
 * @param {number[]} x0  starting point
 * @param {{step?: number|number[], maxIter?: number, tolF?: number, tolX?: number}} options
 * @returns {{x: number[], f: number, iterations: number, converged: boolean}}
 */
export function nelderMead(f, x0, { step = 0.1, maxIter = 4000, tolF = 1e-10, tolX = 1e-9 } = {}) {
  const n = x0.length;
  const F = x => { const v = f(x); return Number.isFinite(v) ? v : Infinity; };
  const steps = Array.isArray(step) ? step : new Array(n).fill(step);
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += steps[i] !== 0 ? steps[i] : 0.00025;
    simplex.push(p);
  }
  let values = simplex.map(F);
  let iter = 0;
  const add = (a, b, s) => a.map((v, i) => v + s * (b[i] - v)); // a + s(b − a)
  for (; iter < maxIter; iter++) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map(i => simplex[i]);
    values = order.map(i => values[i]);
    const spreadF = Math.abs(values[n] - values[0]);
    let spreadX = 0;
    for (let i = 1; i <= n; i++) for (let j = 0; j < n; j++) spreadX = Math.max(spreadX, Math.abs(simplex[i][j] - simplex[0][j]));
    if (spreadF <= tolF * (Math.abs(values[0]) + tolF) && spreadX <= tolX * (1 + Math.max(...simplex[0].map(Math.abs)))) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const xr = add(centroid, simplex[n], -1); const fr = F(xr);
    if (fr < values[0]) {
      const xe = add(centroid, simplex[n], -2); const fe = F(xe);
      if (fe < fr) { simplex[n] = xe; values[n] = fe; } else { simplex[n] = xr; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr; values[n] = fr;
    } else {
      const outside = fr < values[n];
      const xc = outside ? add(centroid, xr, 0.5) : add(centroid, simplex[n], 0.5);
      const fc = F(xc);
      if (fc < (outside ? fr : values[n])) { simplex[n] = xc; values[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) { simplex[i] = add(simplex[0], simplex[i], 0.5); values[i] = F(simplex[i]); }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= n; i++) if (values[i] < values[best]) best = i;
  return { x: simplex[best], f: values[best], iterations: iter, converged: iter < maxIter };
}

/** Run nelderMead from several starts and keep the best (guards against local optima). */
export function multiStart(f, starts, options) {
  let best = null;
  for (const s of starts) {
    let r = nelderMead(f, s, options);
    r = nelderMead(f, r.x, options); // restart once from the end point (standard remedy for premature collapse)
    if (!best || r.f < best.f) best = r;
  }
  return best;
}
