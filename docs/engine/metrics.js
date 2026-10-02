// Performance metrics and the statistics used to compare strategies honestly.
// Each export documents its formula and source key (see docs/data/citations.json).
import {
  mean, std, variance, skewness, kurtosisRaw, autocorr, normCdf, normInv, EULER_GAMMA,
} from './mathx.js';

/** Wealth index starting at 1 from simple returns. */
export function wealthIndex(returns) {
  const w = new Array(returns.length);
  let v = 1;
  for (let i = 0; i < returns.length; i++) { v *= 1 + returns[i]; w[i] = v; }
  return w;
}

/** Drawdown series DD_t = W_t / max_{s<=t} W_s − 1, plus the maximum drawdown and its longest underwater spell. */
export function drawdowns(returns) {
  const w = wealthIndex(returns);
  let peak = 1, maxDD = 0, underwater = 0, longest = 0;
  const dd = new Array(w.length);
  for (let i = 0; i < w.length; i++) {
    peak = Math.max(peak, w[i]);
    dd[i] = w[i] / peak - 1;
    if (dd[i] < maxDD) maxDD = dd[i];
    underwater = dd[i] < 0 ? underwater + 1 : 0;
    longest = Math.max(longest, underwater);
  }
  return { series: dd, maxDrawdown: maxDD, longestUnderwater: longest };
}

/** Compound annual growth rate: W_T^(q/T) − 1. */
export function cagr(returns, q) {
  const w = wealthIndex(returns);
  return Math.pow(w[w.length - 1], q / returns.length) - 1;
}

/** Per-period Sharpe ratio of excess returns (sample mean / sample std, ddof = 1). Sharpe (1966). */
export function sharpe(excess) {
  return mean(excess) / std(excess);
}

/** Lo (2002) Eq. (9): IID standard error of the per-period Sharpe ratio, sqrt((1 + SR²/2) / T). */
export function sharpeStdErrIID(sr, T) {
  return Math.sqrt((1 + sr * sr / 2) / T);
}

/** Lo (2002) Eq. (20): η(q) = q / sqrt(q + 2 Σ_{k=1}^{q−1} (q−k) ρ_k). Annualized SR = η(q) · SR. */
export function loEta(q, rhos) {
  let s = 0;
  for (let k = 1; k < q; k++) s += (q - k) * rhos[k - 1];
  return q / Math.sqrt(q + 2 * s);
}

/**
 * Probabilistic Sharpe Ratio, Bailey & López de Prado (2012) Eq. (11):
 * PSR(SR*) = Φ[ (SR − SR*) √(T−1) / √(1 − γ3·SR + (γ4−1)/4 · SR²) ], with SR per period and γ4 RAW kurtosis.
 */
export function probabilisticSharpe(sr, srStar, T, skew, kurtRaw) {
  const denom = Math.sqrt(1 - skew * sr + ((kurtRaw - 1) / 4) * sr * sr);
  return normCdf(((sr - srStar) * Math.sqrt(T - 1)) / denom);
}

/**
 * Expected maximum Sharpe ratio among N independent unskilled trials, Bailey & López de Prado (2014) Eq. (1) with μ = 0:
 * SR0 = √V · ((1 − γ) Φ⁻¹(1 − 1/N) + γ Φ⁻¹(1 − 1/(N e))), γ = Euler–Mascheroni constant.
 * `varianceOfTrialSRs` must be in the same (per-period) units as the Sharpe ratio being deflated.
 */
export function expectedMaxSharpe(varianceOfTrialSRs, N) {
  if (N < 2) return 0;
  return Math.sqrt(varianceOfTrialSRs) *
    ((1 - EULER_GAMMA) * normInv(1 - 1 / N) + EULER_GAMMA * normInv(1 - 1 / (N * Math.E)));
}

/** Deflated Sharpe Ratio, Bailey & López de Prado (2014) Eq. (2): DSR = PSR(SR0). */
export function deflatedSharpe(sr, T, skew, kurtRaw, varianceOfTrialSRs, N) {
  const sr0 = expectedMaxSharpe(varianceOfTrialSRs, N);
  return { sr0, dsr: probabilisticSharpe(sr, sr0, T, skew, kurtRaw) };
}

/** Minimum track record length in observations, Bailey & López de Prado (2012) Eq. (13). */
export function minTrackRecordLength(sr, srStar, skew, kurtRaw, confidence = 0.95) {
  const z = normInv(confidence);
  return 1 + (1 - skew * sr + ((kurtRaw - 1) / 4) * sr * sr) * (z / (sr - srStar)) ** 2;
}

/**
 * Downside deviation relative to a minimum acceptable return (MAR), dividing by ALL observations.
 * Definition as documented by R PerformanceAnalytics ("full" method); Sortino & Price (1994) text itself is
 * unverified here — see docs/EVIDENCE_POLICY.md.
 */
export function downsideDeviation(returns, mar = 0) {
  let s = 0;
  for (const r of returns) { const d = Math.min(r - mar, 0); s += d * d; }
  return Math.sqrt(s / returns.length);
}

/**
 * Test H0: SR_a = SR_b for two return series observed over the same periods, using the delta method on
 * v = (μa, μb, E[a²], E[b²]) with a HAC (Bartlett / Newey–West 1987) long-run covariance.
 * Ledoit & Wolf (2008) discuss this HAC approach; they RECOMMEND a studentized block bootstrap instead,
 * which is on the roadmap. Kernel and bandwidth here are our documented choice.
 */
export function sharpeDifferenceTest(a, b, lags) {
  const T = a.length;
  if (b.length !== T) throw new Error('Series must cover identical periods.');
  const L = lags ?? Math.floor(4 * Math.pow(T / 100, 2 / 9));
  const mu1 = mean(a), mu2 = mean(b);
  const g1 = mean(a.map(x => x * x)), g2 = mean(b.map(x => x * x));
  const s1 = g1 - mu1 * mu1, s2 = g2 - mu2 * mu2;
  const delta = mu1 / Math.sqrt(s1) - mu2 / Math.sqrt(s2);
  const grad = [g1 / s1 ** 1.5, -g2 / s2 ** 1.5, -mu1 / (2 * s1 ** 1.5), mu2 / (2 * s2 ** 1.5)];
  const y = [];
  for (let t = 0; t < T; t++) y.push([a[t] - mu1, b[t] - mu2, a[t] * a[t] - g1, b[t] * b[t] - g2]);
  const Psi = Array.from({ length: 4 }, () => new Array(4).fill(0));
  for (let l = 0; l <= L; l++) {
    const w = l === 0 ? 1 : 1 - l / (L + 1);
    for (let t = l; t < T; t++) {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const g = y[t][i] * y[t - l][j] / T;
        Psi[i][j] += l === 0 ? g : w * g;
        if (l > 0) Psi[j][i] += w * g;
      }
    }
  }
  let q = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) q += grad[i] * Psi[i][j] * grad[j];
  const se = Math.sqrt(q / T);
  const z = delta / se;
  return { delta, se, z, pValue: 2 * (1 - normCdf(Math.abs(z))), lags: L };
}

/**
 * All headline metrics for one strategy run.
 * run: { net, excessNet, grossExcess, turnover, grossExposure, netExposure } arrays over the evaluation window.
 */
export function computeMetrics(run, q = 12, { ceqGamma = 1, ciLevel = 0.95 } = {}) {
  const ex = run.excessNet;
  const T = ex.length;
  const srP = sharpe(ex);
  const sk = skewness(ex);
  const ku = kurtosisRaw(ex);
  const rhos = [];
  for (let k = 1; k < q; k++) rhos.push(autocorr(ex, k));
  const eta = loEta(q, rhos);
  const seP = sharpeStdErrIID(srP, T);
  const z = normInv(0.5 + ciLevel / 2);
  const dd = drawdowns(run.net);
  const meanTurnover = mean(run.turnover);
  const meanGrossEx = mean(run.grossExcess);
  const ddev = downsideDeviation(ex, 0);
  return {
    periods: T,
    totalReturn: wealthIndex(run.net)[T - 1] - 1,
    cagr: cagr(run.net, q),
    annMeanExcess: mean(ex) * q,
    annVol: std(ex) * Math.sqrt(q),
    sharpe: srP * Math.sqrt(q),
    sharpeCI: [(srP - z * seP) * Math.sqrt(q), (srP + z * seP) * Math.sqrt(q)],
    sharpeLoAdjusted: srP * eta,
    sharpePerPeriod: srP,
    sortino: ddev > 0 ? (mean(ex) / ddev) * Math.sqrt(q) : NaN,
    maxDrawdown: dd.maxDrawdown,
    longestUnderwater: dd.longestUnderwater,
    hitRate: ex.filter(x => x > 0).length / T,
    skew: sk,
    kurtosis: ku,
    psrVsZero: probabilisticSharpe(srP, 0, T, sk, ku),
    ceq: (mean(ex) - (ceqGamma / 2) * variance(ex)) * q,
    annTurnover: meanTurnover * q,
    avgGrossExposure: mean(run.grossExposure),
    avgNetExposure: mean(run.netExposure),
    // Cost (bps per unit of one-way turnover) at which the average excess return after costs is zero.
    breakEvenCostBps: meanTurnover > 0 ? (meanGrossEx / meanTurnover) * 1e4 : Infinity,
  };
}

/** Human-readable metric definitions, shown next to every number in the UI. */
export const METRIC_INFO = {
  cagr: { label: 'CAGR', long: 'Compound annual growth rate', fmt: 'pct', sources: [] },
  annMeanExcess: { label: 'Excess return', long: 'Annualized mean return above T-bills (mean × 12)', fmt: 'pct', sources: [] },
  annVol: { label: 'Volatility', long: 'Annualized standard deviation of excess returns (σ × √12)', fmt: 'pct', sources: [] },
  sharpe: { label: 'Sharpe', long: 'Sharpe ratio, annualized with √12 (assumes IID returns)', fmt: 'num', sources: ['sharpe1966mutual', 'lo2002sharpe'] },
  sharpeLoAdjusted: { label: 'Sharpe (Lo-adj.)', long: 'Annualized with Lo (2002) η(12), which corrects for serial correlation', fmt: 'num', sources: ['lo2002sharpe'] },
  sortino: { label: 'Sortino', long: 'Mean excess return ÷ downside deviation (MAR = T-bill), annualized', fmt: 'num', sources: ['sortino1994downside'] },
  maxDrawdown: { label: 'Max drawdown', long: 'Largest peak-to-trough fall of the wealth index', fmt: 'pct', sources: [] },
  psrVsZero: { label: 'PSR(0)', long: 'Probabilistic Sharpe Ratio: probability the true Sharpe exceeds 0, accounting for skew and fat tails', fmt: 'prob', sources: ['bailey2012frontier'] },
  ceq: { label: 'CEQ', long: 'Certainty-equivalent return, γ = 1 (as in DeMiguel, Garlappi & Uppal)', fmt: 'pct', sources: ['demiguel2009naive'] },
  annTurnover: { label: 'Turnover', long: 'Annual one-way turnover: Σ|target − drifted weight| per rebalance × 12', fmt: 'x', sources: ['demiguel2009naive'] },
  avgGrossExposure: { label: 'Gross exposure', long: 'Average Σ|weights| (1.0 = fully invested, long-only)', fmt: 'x', sources: [] },
  hitRate: { label: 'Hit rate', long: 'Share of months with positive excess return', fmt: 'pct', sources: [] },
  breakEvenCostBps: { label: 'Break-even cost', long: 'Trading cost per unit turnover (bps) that would erase the average excess return', fmt: 'bps', sources: [] },
};
