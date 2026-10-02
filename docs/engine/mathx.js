// Numeric building blocks used by the engine. No dependencies; runs in browsers and Node.
// Every function here is cross-checked against NumPy/SciPy in tests/js/crosscheck.test.mjs.

export const EULER_GAMMA = 0.5772156649015329;

export function sum(xs) {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
}

export function mean(xs) {
  if (xs.length === 0) return NaN;
  return sum(xs) / xs.length;
}

/** Sample variance with denominator (n - ddof). ddof = 1 gives the unbiased estimator. */
export function variance(xs, ddof = 1) {
  const n = xs.length;
  if (n - ddof <= 0) return NaN;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - m) ** 2;
  return s / (n - ddof);
}

export function std(xs, ddof = 1) {
  return Math.sqrt(variance(xs, ddof));
}

/** Sample skewness (population moments, i.e. biased; matches scipy.stats.skew(bias=True)). */
export function skewness(xs) {
  const n = xs.length;
  const m = mean(xs);
  let m2 = 0, m3 = 0;
  for (const x of xs) { const d = x - m; m2 += d * d; m3 += d * d * d; }
  m2 /= n; m3 /= n;
  return m3 / Math.pow(m2, 1.5);
}

/** RAW (non-excess) kurtosis: a normal distribution gives 3. Matches scipy.stats.kurtosis(fisher=False, bias=True).
 *  Bailey & López de Prado's PSR/DSR use this convention (verified by reproducing their worked example). */
export function kurtosisRaw(xs) {
  const n = xs.length;
  const m = mean(xs);
  let m2 = 0, m4 = 0;
  for (const x of xs) { const d = x - m; const d2 = d * d; m2 += d2; m4 += d2 * d2; }
  m2 /= n; m4 /= n;
  return m4 / (m2 * m2);
}

/** Sample autocorrelation at lag k (standard estimator: autocovariance / variance, both divided by n). */
export function autocorr(xs, k) {
  const n = xs.length;
  if (k <= 0 || k >= n) return NaN;
  const m = mean(xs);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (xs[i] - m) ** 2;
  for (let i = k; i < n; i++) num += (xs[i] - m) * (xs[i - k] - m);
  return num / den;
}

export function correlation(a, b) {
  const n = a.length;
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}

// ---------- Normal distribution ----------

/** Standard normal CDF via the complementary error function (W. J. Cody-style rational approximation,
 *  accurate to ~1e-15 relative in double precision for the ranges used here). */
export function normCdf(x) {
  return 0.5 * erfc(-x / Math.SQRT2);
}

function erfc(x) {
  // Power series for small |x|, Lentz continued fraction otherwise. Checked against scipy.special.erfc.
  const z = Math.abs(x);
  const r = z < 2 ? 1 - erfSeries(z) : erfcContinuedFraction(z);
  return x >= 0 ? r : 2 - r;
}

function erfSeries(z) {
  // erf(z) = 2/sqrt(pi) * sum_{n} (-1)^n z^(2n+1) / (n! (2n+1))
  let term = z, s = z, n = 0;
  const z2 = z * z;
  while (Math.abs(term) > 1e-17 * Math.abs(s) && n < 200) {
    n++;
    term *= -z2 / n;
    s += term / (2 * n + 1);
  }
  return (2 / Math.sqrt(Math.PI)) * s;
}

function erfcContinuedFraction(z) {
  // Lentz's algorithm for erfc(z) = exp(-z^2)/sqrt(pi) * 1/(z + 1/2/(z + 1/(z + 3/2/(z + ...))))
  const tiny = 1e-300;
  let f = z, C = z, D = 0;
  for (let i = 1; i < 500; i++) {
    const a = i / 2;
    D = z + a * D; if (Math.abs(D) < tiny) D = tiny; D = 1 / D;
    C = z + a / C; if (Math.abs(C) < tiny) C = tiny;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-z * z) / (Math.sqrt(Math.PI) * f);
}

/** Inverse standard normal CDF (Acklam's algorithm refined by one Halley step). Upper-tail inputs are reflected
 *  (1 − p is exact for p ≥ 0.5), so both tails are evaluated where the refinement step is accurate. */
export function normInv(p) {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  if (p > 0.5) return -normInv(1 - p);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let x;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // One Halley refinement step.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  x = x - u / (1 + x * u / 2);
  return x;
}

// ---------- Linear algebra (small dense matrices) ----------

/** Solve A x = b by Gaussian elimination with partial pivoting. A is an array of rows. Returns null if singular. */
export function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col, best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

export function invert(A) {
  const n = A.length;
  const cols = [];
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0); e[j] = 1;
    const x = solve(A, e);
    if (!x) return null;
    cols.push(x);
  }
  // cols[j] is column j of the inverse
  return A.map((_, i) => cols.map(col => col[i]));
}

/** Sample covariance matrix (ddof = 1) of column series; X is an array of series (each length T). */
export function covMatrix(series) {
  const k = series.length;
  const T = series[0].length;
  const means = series.map(mean);
  const S = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (series[i][t] - means[i]) * (series[j][t] - means[j]);
      S[i][j] = S[j][i] = s / (T - 1);
    }
  }
  return S;
}

// ---------- Regression with HAC (Newey–West) standard errors ----------

/** Bartlett-kernel lag rule of thumb floor(4 (T/100)^(2/9)).
 *  Provenance: Wooldridge's textbook and Lazarus, Lewis, Stock & Watson (2018) report it; it is commonly
 *  attributed to Newey & West (1994) but that attribution is UNVERIFIED (see docs/EVIDENCE_POLICY.md). */
export function bartlettLagRuleOfThumb(T) {
  return Math.floor(4 * Math.pow(T / 100, 2 / 9));
}

/**
 * OLS of y on [1, X...] with Newey–West (1987) Bartlett-kernel HAC covariance.
 * X: array of regressors (each length T). Returns coefficients, HAC standard errors, t-stats, R².
 */
export function olsNeweyWest(y, X, lags = bartlettLagRuleOfThumb(y.length)) {
  const T = y.length;
  const k = X.length + 1;
  const row = t => [1, ...X.map(x => x[t])];
  // X'X and X'y
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let t = 0; t < T; t++) {
    const r = row(t);
    for (let i = 0; i < k; i++) {
      Xty[i] += r[i] * y[t];
      for (let j = 0; j < k; j++) XtX[i][j] += r[i] * r[j];
    }
  }
  const XtXinv = invert(XtX);
  if (!XtXinv) throw new Error('Regressors are collinear; cannot fit.');
  const beta = XtXinv.map(rowi => rowi.reduce((s, v, j) => s + v * Xty[j], 0));
  const resid = new Array(T);
  for (let t = 0; t < T; t++) {
    const r = row(t);
    resid[t] = y[t] - r.reduce((s, v, j) => s + v * beta[j], 0);
  }
  // Meat: S = sum_l w_l (Gamma_l + Gamma_l'), Gamma_l = sum_t u_t u_{t-l} x_t x_{t-l}'
  const S = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let l = 0; l <= lags; l++) {
    const w = l === 0 ? 1 : 1 - l / (lags + 1);
    for (let t = l; t < T; t++) {
      const a = row(t), b = row(t - l);
      const uu = resid[t] * resid[t - l];
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          const g = uu * a[i] * b[j];
          S[i][j] += l === 0 ? g : w * g;
          if (l > 0) S[j][i] += w * g;
        }
      }
    }
  }
  const V = matMul(matMul(XtXinv, S), XtXinv);
  const se = V.map((r, i) => Math.sqrt(Math.max(r[i], 0)));
  const ym = mean(y);
  let ssr = 0, sst = 0;
  for (let t = 0; t < T; t++) { ssr += resid[t] ** 2; sst += (y[t] - ym) ** 2; }
  return { beta, se, t: beta.map((b, i) => b / se[i]), r2: 1 - ssr / sst, lags, n: T };
}

export function matMul(A, B) {
  const n = A.length, m = B[0].length, p = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let k = 0; k < p; k++) {
    const a = A[i][k];
    if (a === 0) continue;
    for (let j = 0; j < m; j++) C[i][j] += a * B[k][j];
  }
  return C;
}

// ---------- Deterministic random numbers (for simulations and bootstrap) ----------

/** Mulberry32 PRNG: small, fast, deterministic given a 32-bit seed. Not cryptographic. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, s;
    do { u = 2 * next() - 1; v = 2 * next() - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m;
    return u * m;
  };
  return { next, normal };
}
