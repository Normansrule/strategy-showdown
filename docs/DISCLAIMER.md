# Disclaimer

**Strategy Showdown is an educational tool. It is not investment advice.**

- **No recommendations.** Nothing here recommends buying, selling or holding any security, fund or strategy,
  or says a strategy is suitable for you.
- **No trading.** The software cannot place orders, connect to a broker or exchange, or hold money. Every result
  is a paper (hypothetical) calculation.
- **Backtests are hypothetical.** They are computed after the fact, on historical data, with simplifying
  assumptions about trading costs, borrowing, taxes and execution. Real trading would have produced different
  results. **Past performance does not predict future results.** A strategy that looks good in a backtest
  is often the result of trying many ideas (see the deflated Sharpe ratio on each comparison).
- **Assumptions are shown, not hidden.** Cost presets are assumptions, not measurements. Each run reports the
  trading cost at which its advantage would disappear.
- **No claims about private firms.** The algorithms here come from published academic papers and public
  descriptions. We do not have, show or claim to reproduce any firm's proprietary code, parameters or results.
- **Synthetic data are random numbers.** The demo dataset is generated noise, labelled "SYNTHETIC — not market
  data". Any strategy that looks good on it is showing luck or extra market exposure.

## Data attribution

Market data come from the **Kenneth R. French Data Library** (Tuck School of Business, Dartmouth),
<https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html>. The factors and portfolios are
built by Eugene F. Fama and Kenneth R. French from CRSP data.

**Why the data are not included in this project:** the library publishes no licence or redistribution terms,
and a notice in its page source reserves rights to its images and code. Redistribution rights for the data files are
therefore unclear. So this repository and the public website never contain or serve the data. You download
the files yourself from the library (by running `python scripts/fetch_french.py`, or by downloading the zips and
dropping them on the page, where they are read in your browser and never uploaded).

French revises past returns when CRSP updates its data, so results depend on when the files were downloaded;
each dataset records the CRSP vintage stated in its files.

## No warranty

The software is provided "as is", without warranty of any kind (see [LICENSE](../LICENSE)). Formulas and
parameters are documented with their sources and verification level in [EVIDENCE_POLICY.md](EVIDENCE_POLICY.md);
errors are possible. Please report them.
