# ADR 0001: A narrow preload bridge for the desktop trading floor

- **Status:** Proposed (not built). Must be accepted, and the matching entry in
  [SECURITY_MODEL.md](../SECURITY_MODEL.md) §2.3c moved from "planned" to "in force", before any preload script ships.
- **Date:** 2026-11-23
- **Scope:** the Electron desktop app (`desktop/electron/`). The website is unaffected: it never has a bridge.

An ADR (Architecture Decision Record) records one significant design decision, the options weighed and why one was
chosen.

## Context

Today the desktop renderer has **no preload script and no IPC (inter-process communication)**: the page is sandboxed,
context-isolated, and can reach only its own `app://showdown/` origin. That is the strongest Electron posture there is,
and the trading floor added in v0.4.x (`docs/floor.html`) keeps it: the floor runs on a simulated market entirely inside
the page.

The next gate (G5) wants the floor to show **real delayed or end-of-day data** and to place **paper orders with a
broker's paper-trading API** (Alpaca's paper environment is the candidate; see the G0 terms check, 2026-11-11). That
needs three things the page must not have: network access to third-party hosts, an API key, and a place to keep the
key. The project rules already fix where those live:

- network calls only in the **main process**, to an **exact-host allowlist**;
- keys stored with Electron **`safeStorage`** and never logged; Electron 45 deprecates the synchronous `safeStorage`
  calls and Electron 46 removes them, so the **asynchronous API** is required;
- **paper trading only**.

So the page needs *some* way to ask the main process for data and to submit paper orders. The question is the shape of
that channel.

## Options considered

1. **No bridge; the main process pushes everything** (for example by writing JSON files the page polls over
   `app://showdown/data/local/`). No new attack surface in the renderer, but no way for the user to submit an order or
   request a symbol, and polling files is fragile. Rejected: it cannot do the job.
2. **Expose `ipcRenderer` (or a generic `invoke(channel, ...args)`) through `contextBridge`.** Simple, but any script
   that ever runs in the page could call any channel with any arguments. Electron's own security guide warns against
   exactly this. Rejected.
3. **A narrow, typed bridge: a fixed set of named functions, each validating its arguments in the preload and again in
   the main process.** Chosen.
4. **Turn off the sandbox or context isolation and call Node from the page.** Rejected outright.

## Decision

Add one preload script, `desktop/electron/preload.cjs`, loaded only into the main window, with `sandbox: true` and
`contextIsolation: true` unchanged. It exposes exactly one frozen object, `window.floorBridge`, through
`contextBridge.exposeInMainWorld`, with these functions and nothing else:

| Function | Main-process handler does | Arguments (validated twice) | Returns |
|---|---|---|---|
| `getBars(symbol, timeframe, limit)` | fetches delayed or end-of-day bars from an allowlisted data host | symbol `^[A-Z]{1,5}$`; timeframe from a fixed list; limit 1–1000 | plain JSON array |
| `getAccount()` | reads the **paper** account summary | none | plain JSON object |
| `submitPaperOrder(ticket)` | submits to the **paper** endpoint only | side `buy`/`sell`; qty positive integer ≤ a configured cap; type `market`/`limit`; limit price on the tick and within a band of the last price | order id and status |
| `cancelPaperOrder(id)` | cancels on the paper endpoint | id matching the broker's id format | status |
| `keyStatus()` | says whether a key is stored, never the key | none | `{ stored: boolean }` |

Rules that come with it:

- **Channels are fixed strings** in one shared module; `ipcMain.handle` is registered only for those names, and each
  handler checks `event.senderFrame.url` starts with `app://showdown/` before doing anything.
- **No function returns or accepts a key.** The key is entered in a main-process dialog (not the page), encrypted with
  `safeStorage.encryptStringAsync`, written to `<userData>`, and decrypted only inside the request that needs it.
  Logs and error messages are scrubbed of headers.
- **Paper only, enforced in the main process:** the order handler has one base URL, the paper one, as a constant; there
  is no code path or setting that points it at a live-trading endpoint. A test asserts the live host appears nowhere in
  `desktop/`.
- **Exact-host allowlist** in `routes.mjs` gains only the hosts G5 needs, each written out in full; requests from the
  window's own session stay blocked as today, and outbound calls use a separate in-memory session as the French and
  Shiller downloads already do.
- **Rate limits** are enforced in the main process below each provider's published limit (for Alpaca Basic, 200 calls a
  minute as checked on 2026-11-11), so a misbehaving page cannot get the user's key throttled or banned.
- **Data stays local.** Responses are returned to the page and may be cached under `<userData>` for the user's own use;
  nothing is bundled, committed or redistributed, in line with each provider's terms (re-read at G5).
- The website build never ships `preload.cjs`; the floor detects `window.floorBridge` and falls back to the simulation
  when it is absent.

## Consequences

- The renderer gains a small, auditable surface: five functions, each with a fixed argument shape. Reviewing a change
  to the bridge means reading one preload file and one handler module.
- Every handler needs unit tests for argument rejection (wrong types, extra fields, out-of-range numbers, prototype
  pollution keys) and a desktop launch test that checks `window.floorBridge` has exactly these keys and that
  `require`, `process` and `ipcRenderer` stay undefined in the page.
- `SECURITY_MODEL.md` §2.3b ("no preload script and no IPC channel") stops being true when this ships and must be
  rewritten in the same pull request.
- If a future feature needs a sixth function, it gets its own ADR or an amendment to this one.

## References

- Electron security checklist, items on context isolation, process sandboxing, not exposing Electron APIs to untrusted
  web content, and validating the sender of all IPC messages: <https://www.electronjs.org/docs/latest/tutorial/security>
  (to be re-read against the Electron version in use when this ADR is accepted).
- Electron `safeStorage` API and the Electron 45 deprecation of its synchronous methods (project memory, G1,
  2026-11-18).
- G0 terms check for Alpaca, FRED and SEC EDGAR (2026-11-11), to be re-verified at G5.
