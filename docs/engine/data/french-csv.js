// Parser for Kenneth R. French Data Library CSV files. Zero dependencies; browsers and Node 22.
// A Python twin with identical behaviour lives in scripts/french_csv.py; both are tested on tests/fixtures/french/.
//
// Layout (checked against copies of real library files, see docs/EVIDENCE_POLICY.md "Data files"):
//   free-text description lines ("This file was created ... using the 202607 CRSP database.")
//   optional section title, e.g. "  Average Value Weighted Returns -- Monthly"
//   a column-header line that starts with a comma, e.g. ",Mkt-RF,SMB,HML,RF"
//   data rows "YYYYMM,   v1,   v2, ..." in PERCENT (annual sections use "YYYY"; daily files use "YYYYMMDD")
//   blank line(s), then further titled sections, and a closing "Copyright ..." line.
//   Missing values are -99.99 or -999. Line endings may be CRLF; column names may carry trailing spaces.
//
// Only MONTHLY rows (first field of exactly 6 digits, valid month) are kept. Annual and daily rows are counted
// in `ignoredRows` so callers can tell an annual/daily section apart from an empty one. Values stay in percent;
// missing values become null. Anything that does not fit the layout throws an Error naming the line.

export const MISSING_CODES = Object.freeze([-99.99, -999]);
export const MAX_CSV_CHARS = 50 * 1024 * 1024;

const HEADER_RE = /^\s*,/;
const ROW_RE = /^\s*(\d{4}|\d{6}|\d{8})\s*,(.*)$/;
const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function parseValue(cell, lineNo) {
  const s = cell.trim();
  if (s === '') return null;
  if (!NUM_RE.test(s)) throw new Error(`French CSV line ${lineNo}: "${s}" is not a number.`);
  const v = Number(s);
  if (MISSING_CODES.includes(v)) return null;
  return v;
}

/**
 * @param {string} text
 * @returns {{preamble: string, sections: Array<{title: string, columns: string[], rows: Array<{period: string, values: (number|null)[]}>, ignoredRows: number}>, trailer: string, vintage: string|null}}
 */
export function parseFrenchCsv(text) {
  if (typeof text !== 'string') throw new Error('parseFrenchCsv expects text.');
  if (text.length > MAX_CSV_CHARS) throw new Error('CSV file is larger than 50 MB; refusing it.');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // byte-order mark
  const lines = text.split(/\r\n|\n|\r/);

  const preambleLines = [];
  const sections = [];
  let pending = []; // text lines seen since the last section's data ended
  let current = null;
  let prevBlank = true;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') { prevBlank = true; continue; }

    if (HEADER_RE.test(line)) {
      // Title = the text line directly above the header (no blank line between); otherwise untitled.
      let title = '';
      if (!prevBlank && pending.length) title = pending.pop().trim();
      if (sections.length === 0) preambleLines.push(...pending);
      pending = [];
      const columns = line.replace(/^\s*,/, '').split(',').map(c => c.trim());
      if (columns.some(c => c === '')) throw new Error(`French CSV line ${lineNo}: the column header has an empty column name.`);
      current = { title, columns, rows: [], ignoredRows: 0 };
      sections.push(current);
      prevBlank = false;
      continue;
    }

    const m = ROW_RE.exec(line);
    if (m && current && pending.length === 0) {
      const key = m[1];
      const cells = m[2].split(',');
      if (cells.length !== current.columns.length) {
        throw new Error(`French CSV line ${lineNo}: expected ${current.columns.length} values, found ${cells.length}.`);
      }
      if (key.length !== 6) { current.ignoredRows++; prevBlank = false; continue; }
      const month = Number(key.slice(4));
      if (month < 1 || month > 12) throw new Error(`French CSV line ${lineNo}: "${key}" is not a valid YYYYMM month.`);
      const period = `${key.slice(0, 4)}-${key.slice(4)}`;
      const last = current.rows[current.rows.length - 1];
      if (last && period <= last.period) throw new Error(`French CSV line ${lineNo}: month ${period} is out of order or repeated.`);
      current.rows.push({ period, values: cells.map(c => parseValue(c, lineNo)) });
      prevBlank = false;
      continue;
    }
    if (m && !current) throw new Error(`French CSV line ${lineNo}: data row before any column header.`);
    if (m) throw new Error(`French CSV line ${lineNo}: data row after text without a new column header.`);

    // Free text: preamble, a section title (if a header follows directly), or the trailer.
    pending.push(line);
    prevBlank = false;
  }

  const preamble = preambleLines.map(l => l.trim()).join('\n');
  const trailer = pending.map(l => l.trim()).join('\n');
  const vm = /using the (\d{6}) CRSP database/i.exec(preamble);
  return { preamble, sections, trailer, vintage: vm ? vm[1] : null };
}
