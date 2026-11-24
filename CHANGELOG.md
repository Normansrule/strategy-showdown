# Changelog

Release notes for every version. Versions up to v0.3.0 were published as "Strategy Showdown"
(github.com/Normansrule/strategy-showdown).

## Unreleased (v0.4.0)
- Renamed to **Trading Floor Strategy Showdown** (repository `Normansrule/trading-floor-strategy-showdown`; website
  `normansrule.github.io/trading-floor-strategy-showdown/`). Old repository and clone URLs redirect; GitHub Pages does
  not redirect, so `normansrule.github.io/strategy-showdown/` stops working.
- Desktop app: installers, window title and data folder use the new name. On first launch the app copies the data you
  downloaded with an earlier version from the old "Strategy Showdown" data folder, checks every file by SHA-256, and
  leaves the old folder untouched. The light/dark theme choice is not carried over.
- Added a test that fails on any stray use of the old name outside this file.
- New **Trading floor** page (`floor.html`, also in the desktop app): watchlist, candlestick chart with volume and VWAP,
  depth ladder, time and sales, paper orders and P&L on a simulated market (eight invented `.SIM` instruments, GARCH
  volatility). Command line: `buy 100 alfa`, `sell 200 brvo @ 213.10`, `cancel all`, `flatten`, `max chart`, `help`.
  Nothing is fetched or stored.
- ADR 0001 proposes the narrow preload bridge the floor will need for real delayed data and broker paper orders
  (not built; the desktop app still has no preload script and no IPC).

## v0.3.0 (2026-10-05)
How markets move, market timing, algorithm atlas, terminal and open-source survey pages.

## v0.2.0 (2026-10-02)
See the v0.2.0 release on GitHub.

## v0.1.0
Strategy Showdown v0.1.0: published trading algorithms side by side, web and desktop.
