# Security model

Strategy Showdown is a static, local-first web page plus an optional local server. It has no accounts, no
database, no back end and no analytics. This page lists what could go wrong and what stops it.
How to report a problem: [SECURITY.md](../SECURITY.md).

## 1. What we protect

| Asset | Why it matters |
|---|---|
| The integrity of the code users run | A tampered page could show false results or attack the visitor's browser. |
| Honest results | Wrong numbers presented as right would mislead learners (see [EVIDENCE_POLICY.md](EVIDENCE_POLICY.md)). |
| Files users load | Files dropped on the page must stay on their computer. |
| The user's computer (desktop mode) | The local server must not expose files to other people or other websites. |

## 2. Threats and controls

### 2.1 The website (GitHub Pages, `docs/`)

- **Static only.** Plain HTML, CSS and JavaScript modules. No server code runs on the host.
- **Strict Content Security Policy** required in every page (a `<meta http-equiv="Content-Security-Policy">`; the desktop server copies the policy from `docs/index.html`): scripts, styles, fonts, images and `connect-src` from the
  same origin only; `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`. No inline scripts, no
  `eval`, no remote CDNs. Third-party libraries (ECharts, KaTeX) are vendored into `docs/vendor/`.
- **No network calls to third parties**, no cookies, no analytics, no fonts or images from elsewhere.
- **No redistribution of licensed data.** `docs/data/local/` is gitignored; CI fails if anything under it is
  tracked; the Pages workflow copies `docs/` to a staging folder without it and fails if any `.zip`/`.csv` slips in.

### 2.2 Untrusted input (files the user drops on the page, `docs/engine/data/`)

Every file is treated as hostile.

- **ZIP reader** (`zip.js`): reads the central directory first and checks it before decompressing anything;
  supports only "stored" and "deflate"; rejects encryption, ZIP64 and spanned archives; rejects absolute paths,
  `..`, backslashes and control characters in names; caps the total uncompressed size at 50 MB and at most
  200 entries; stops inflating the moment output exceeds the declared size (ZIP bombs); verifies CRC-32.
- **CSV parser** (`french-csv.js`): 50 MB cap; strict number syntax (no `NaN`/`Infinity` strings); column-count,
  month-validity and ordering checks; errors name the offending line.
- **Dataset validation** (`prepareDataset` in `runner.js`): dates well formed and strictly increasing, every
  series the same length, every value finite and in (−1, 10].
- **Rendering** (a rule for all UI code): data values are written with `textContent`/DOM APIs, never `innerHTML`; nothing is evaluated.
- **Privacy**: files are read with the File API in the browser and never uploaded.

### 2.3 Desktop mode (`desktop/server.mjs`, `npm run serve`)

- Binds to **127.0.0.1 only** (not reachable from the network), random free port.
- **Per-session token** (24 random bytes). The first request with `?token=` sets an `HttpOnly; SameSite=Strict`
  cookie and redirects to a clean URL; every other request without the cookie gets **403**. Other local users
  and other websites open in the same browser cannot read the app.
- **Host header allow-list** (`127.0.0.1:PORT`, `localhost:PORT`) against DNS-rebinding.
- **GET/HEAD only**, static files only, no directory listings, dotfiles hidden.
- **Path traversal**: rejects `..`, encoded slashes/backslashes (`%2f`, `%5c`), NUL bytes, bad percent-encoding;
  resolves the path and checks it stays inside `docs/`, then resolves symlinks and checks again.
- **Headers** on every response: the pages' CSP (plus `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`,
  `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`.
- **Node built-ins only**, no outbound connections.

### 2.3b Desktop app (`desktop/electron/`, `npm run desktop`, release installers)

The installer wraps the same `docs/` files in Electron 44. It has **no server and no open port**: pages load from a
private `app://showdown/` scheme handled in the main process.

- **Renderer locked down:** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload script
  and no IPC channel, so page code cannot reach Node.js, the file system or the main process. `app.enableSandbox()`
  sandboxes every renderer.
- **Network:** every request from the window that is not `app://showdown/…` (or a page-made `data:`/`blob:` URL) is
  cancelled by `webRequest`, on top of the page CSP (`connect-src 'self'`). The launch test checks that a page
  `fetch('https://…')` fails.
- **Files served:** read-only from the bundled `docs/` (inside the app's asar archive), plus `/data/local/*`, which maps
  to the user's own app-data folder (`<userData>/data/`). Same traversal/dotfile rules as `desktop/server.mjs`
  (`resolveSafe`); the CSP and security headers are sent on every response.
- **Navigation and windows:** new windows are always refused; `https:` links open in the system browser; navigation
  away from `app://` is refused; `<webview>` is blocked; all permission requests (camera, notifications, …) are denied.
- **The only outbound requests** are the French library downloads in **Data → Download French Data Library files…**:
  made by the main process after the user confirms, to an exact-URL allowlist (`FRENCH_FILES` in
  `docs/engine/data/loaders.js`), in a separate in-memory session, 25 MB cap per file, parsed by the same tested
  code as the browser (zip limits, CSV parser), and saved to `<userData>/data/french.json`. Nothing is uploaded.
- **Electron fuses** (set at build time): `RunAsNode` off, `NODE_OPTIONS` and `--inspect` flags ignored, cookie
  encryption on, app loaded only from the asar archive, with asar integrity validation (macOS/Windows).
- **Dev tools** are available only when running from source (`npm run desktop`), not in packaged builds.
- **Releases:** installers for Windows (NSIS setup and portable `.exe`), macOS (`.dmg`) and Linux (`.AppImage`,
  `.deb`) are built in CI from the tagged commit, listed in `SHA256SUMS.txt` and covered by a Sigstore build-provenance
  attestation (`gh attestation verify <file> -R Normansrule/strategy-showdown`). They are **not code-signed** yet, so
  Windows SmartScreen and macOS Gatekeeper will warn on first launch.

### 2.4 Supply chain ([OWASP Top 10:2025 A03 Software Supply Chain Failures](https://owasp.org/Top10/2025/A03_2025-Software_Supply_Chain_Failures/))

| Control | Where |
|---|---|
| No runtime dependencies in the browser beyond two vendored libraries, checked against `docs/vendor/SHA256SUMS` in CI and before every deploy | `docs/vendor/`, `ci.yml`, `pages.yml` |
| npm installs from the lockfile only (`npm ci --ignore-scripts`) | `package-lock.json`, `ci.yml` |
| Python dev dependencies pinned **with hashes** (`pip install --require-hashes`) | `requirements-dev.txt` |
| Every GitHub Action pinned to a full commit SHA (version in a comment) | `.github/workflows/*` |
| Least-privilege tokens: `contents: read` at the top of every workflow; write scopes only on the job that needs them; `persist-credentials: false` | `.github/workflows/*` |
| Dependabot updates for npm, pip and Actions (weekly) | `.github/dependabot.yml` |
| Static analysis: CodeQL (JavaScript, Python, Actions workflows) | `codeql.yml` |
| Secret scanning: gitleaks on every push and PR | `ci.yml` |
| OpenSSF Scorecard, results published | `scorecard.yml` |
| Releases: source zip from `git archive`, SPDX SBOM, SHA-256 checksums, signed build-provenance attestation | `release.yml` |
| Citation integrity: DOIs checked against Crossref weekly | `citations.yml` |

Verify a release: `gh attestation verify strategy-showdown-vX.Y.Z.zip --repo Normansrule/strategy-showdown`
and `sha256sum --check SHA256SUMS.txt`.

## 3. Out of scope

- Compromise of the user's own computer or browser, or of GitHub itself.
- The accuracy of the Kenneth R. French Data Library files (we record their hashes and vintage, and check the
  momentum factor's internal consistency, but we cannot audit CRSP).
- Financial loss from acting on results. This is not an investment tool ([DISCLAIMER.md](DISCLAIMER.md)).
- Denial of service against a user's own local server (it only listens on loopback).
- Browsers without `DecompressionStream` (they get a clear error and can load the unzipped `.csv` instead).
