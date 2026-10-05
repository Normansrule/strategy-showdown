// Optimal execution with linear market impact: Almgren & Chriss (2000), "Optimal Execution of Portfolio
// Transactions". Equation numbers follow the authors' December 2000 manuscript (read at
// https://www.smallake.kr/wp-content/uploads/2016/03/optliq.pdf); the published Journal of Risk version
// (doi:10.21314/JOR.2001.041) was not read. See docs/ENGINE_SPEC.md §12.
//
// Sell X shares over time T in N intervals of length τ = T/N. Holdings x_0 = X, …, x_N = 0; n_k = x_{k−1} − x_k.
//   permanent impact g(v) = γ v,   temporary impact h(v) = ε sgn(n) + (η/τ) n
//   E(x) = ½γX² + ε Σ|n_k| + (η̃/τ) Σ n_k²,   η̃ = η − ½γτ          (eq. 8)
//   V(x) = σ² Σ τ x_k²                                                (eq. 5)
//   optimal for risk aversion λ:  x_j = sinh(κ(T − t_j)) / sinh(κT) · X  (eq. 17)
//   with 2/τ² (cosh(κτ) − 1) = κ̃² = λσ²/η̃                            (text after eq. 16)

export function expectedCost(x, { gamma, eps, eta, tau }) {
  const X = x[0];
  const etaT = eta - 0.5 * gamma * tau;
  let sAbs = 0, sSq = 0;
  for (let k = 1; k < x.length; k++) { const n = x[k - 1] - x[k]; sAbs += Math.abs(n); sSq += n * n; }
  return 0.5 * gamma * X * X + eps * sAbs + (etaT / tau) * sSq;
}

export function costVariance(x, { sigma, tau }) {
  let s = 0;
  for (let k = 1; k < x.length; k++) s += tau * x[k] * x[k];
  return sigma * sigma * s;
}

/** Holdings path x_0..x_N for risk aversion λ (λ = 0 gives the straight-line, TWAP-like schedule). */
export function optimalTrajectory({ X, T, N, sigma, eta, gamma, lambda }) {
  const tau = T / N;
  const etaT = eta - 0.5 * gamma * tau;
  if (!(etaT > 0)) throw new Error('η̃ = η − ½γτ must be positive.');
  const x = [];
  if (lambda <= 0) { for (let j = 0; j <= N; j++) x.push(X * (1 - j / N)); return x; }
  const kTilde2 = lambda * sigma * sigma / etaT;
  const kappa = Math.acosh(1 + kTilde2 * tau * tau / 2) / tau;
  const den = Math.sinh(kappa * T);
  for (let j = 0; j <= N; j++) x.push(Number.isFinite(den) && den > 0 ? Math.sinh(kappa * (T - j * tau)) / den * X : (j === 0 ? X : 0));
  return x;
}

/** Closed forms for the straight-line schedule (eqs. 10–11). */
export function linearScheduleClosedForm({ X, T, N, sigma, eta, gamma, eps }) {
  const tau = T / N;
  return {
    E: 0.5 * gamma * X * X + eps * X + (eta - 0.5 * gamma * tau) * X * X / T,
    V: (1 / 3) * sigma * sigma * X * X * T * (1 - 1 / N) * (1 - 1 / (2 * N)),
  };
}

/** Efficient frontier: (V, E) for a grid of λ values, plus each schedule. */
export function frontier(p, lambdas) {
  const tau = p.T / p.N;
  return lambdas.map(lambda => {
    const x = optimalTrajectory({ ...p, lambda });
    return { lambda, x, E: expectedCost(x, { ...p, tau }), V: costVariance(x, { ...p, tau }) };
  });
}
