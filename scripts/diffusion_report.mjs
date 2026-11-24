// Print the information-diffusion diagnostics (docs/engine/diffusion.js) for the locally fetched French data.
//
//   python3 scripts/fetch_french.py && node scripts/diffusion_report.mjs [path/to/french.json]
//
// Reads docs/data/local/french.json (gitignored; never committed). Prints numbers only; no network.
import { readFileSync } from 'node:fs';
import { momentumBySize, leadLag } from '../docs/engine/diffusion.js';

const file = process.argv[2] || new URL('../docs/data/local/french.json', import.meta.url);
const ds = JSON.parse(readFileSync(file, 'utf8'));
if (!ds.sizeMomentum?.available) {
  console.error(ds.sizeMomentum?.reason || 'No 6 size/momentum series in this dataset: fetch 6_Portfolios_ME_Prior_12_2_CSV.zip too.');
  process.exit(1);
}
const input = { dates: ds.dates, ...ds.sizeMomentum.series };
const pct = x => (100 * x).toFixed(2).padStart(7);
const f2 = x => x.toFixed(2).padStart(6);
console.log(`${ds.title}\n${ds.dates[0]} to ${ds.dates.at(-1)}; gross of costs; paper portfolios. History is a base rate, not a forecast.\n`);
console.log('Momentum (winners minus losers), annualised mean % and Newey-West t');
console.log('period                          months   small    t     big     t     gap     t');
for (const r of momentumBySize(input)) {
  if (!r.available) { console.log(`${r.id.padEnd(30)} ${String(r.T).padStart(6)}  ${r.reason}`); continue; }
  console.log(`${r.id.padEnd(30)} ${String(r.T).padStart(6)} ${pct(r.small.annMean)} ${f2(r.small.t)} ${pct(r.big.annMean)} ${f2(r.big.t)} ${pct(r.gap.annMean)} ${f2(r.gap.t)}`);
}
console.log('\nLead-lag at one month (correlations; ±2·corrSE is a rough 95% band under no dependence)');
console.log('period          months  small~big(-1)  big~small(-1)  asymmetry  2·SE   b(big-1) t');
for (const r of leadLag(input)) {
  if (!r.available) { console.log(`${r.id.padEnd(15)} ${String(r.T).padStart(6)}  ${r.reason}`); continue; }
  console.log(`${r.id.padEnd(15)} ${String(r.T).padStart(6)} ${f2(r.corrSmallOnLagBig).padStart(14)} ${f2(r.corrBigOnLagSmall).padStart(14)} ${f2(r.asymmetry).padStart(10)} ${f2(2 * r.corrSE)} ${f2(r.smallOnLag.beta[1])} ${f2(r.smallOnLag.t[1])}`);
}
