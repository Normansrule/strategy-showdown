# Contributing

Thank you for helping. This project has one rule that comes before everything else:
**nothing unverifiable is presented as fact.** Read [docs/EVIDENCE_POLICY.md](docs/EVIDENCE_POLICY.md) first.

## Setup

Node 22 and Python 3.12 or newer (CI uses 3.13).

```bash
npm ci
python -m venv .venv && . .venv/bin/activate
pip install --require-hashes -r requirements-dev.txt
npm test                         # JavaScript tests
python -m pytest tests/python -q # Python reference and script tests
python scripts/check_citations.py --offline
npm run serve -- --open          # local desktop mode
```

To use real data locally: `python scripts/fetch_french.py` (writes the gitignored `docs/data/local/french.json`).
**Never commit French Data Library files** (see [docs/DISCLAIMER.md](docs/DISCLAIMER.md)). CI rejects them.

## Adding a strategy

1. **Find the source.** It must be a published paper or a public description. Add it to
   `docs/data/citations.json` with its DOI (if any). `python scripts/check_citations.py` must pass against
   Crossref. Set `verification` honestly.
2. **Add a card** to `docs/engine/strategies/index.js` with every field:
   - `id`, `name`, `family`, `summary`, `intuition`
   - `evidence`: one of `published-replicable`, `published-data-restricted`, `public-description`, `definition`
   - `equations`: the formulas, each with a `where` saying which paper equation it is
   - `sources`: `[{key, where}]`, where `where` is the section, equation or table
   - `params`: defaults **from the paper**, each with a `source` string; anything that is our choice says so
   - `deviations`: every way this implementation differs from the paper (universe, frequency, estimator, data)
   - `failureModes`, `warmup(params)`, `weights(ctx, params)`
3. **Specify it** in `docs/ENGINE_SPEC.md` §6, precisely enough to re-implement from the text alone.
4. **Re-implement it independently** in `tests/python/reference.py` from the spec (not from the JS), and add
   it to the cross-check fixtures. JS and Python must agree to floating-point tolerance.
5. **Test against the paper** where possible: if the paper reports numbers you can reproduce on data we can
   use, add them as tests (`tests/js/published.test.mjs`). Only use numbers you have reproduced.
6. **Update the parameter table** in `docs/EVIDENCE_POLICY.md` with the confirmation level of each parameter.

Never describe a strategy as a firm's proprietary algorithm, and never invent parameters to "fill in" a
paper. If something is not stated in the source, say so on the card.

## Pull requests

- Keep changes focused; include tests.
- CI must pass (tests, citation schema, secret scan, CodeQL).
- New dependencies need a strong reason. Actions must be pinned by full commit SHA with the version in a comment.

By contributing you agree that your contribution is licensed under the MIT License.
