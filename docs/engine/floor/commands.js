// Command line grammar for the trading floor. Pure (no DOM), so it is unit-tested in Node.
// Command names are this project's own; they are not modelled on any terminal vendor's commands.

export const PANELS = ['watch', 'chart', 'depth', 'tape', 'blotter', 'risk'];
export const SPEEDS = [1, 2, 5, 10, 30, 60];
export const INTERVALS = { '1m': 1, '5m': 5, '15m': 15 };

export const HELP = [
  ['<symbol>', 'Load a symbol into the chart, depth and tape (e.g. alfa or ALFA.SIM).'],
  ['buy <qty> <symbol> [@ <price>]', 'Paper buy: market order, or a limit order with @ price.'],
  ['sell <qty> <symbol> [@ <price>]', 'Paper sell (short sales allowed in the simulation).'],
  ['cancel <id> | cancel all', 'Cancel a working paper order.'],
  ['flatten [<symbol> | all]', 'Close paper positions with market orders.'],
  ['interval 1m | 5m | 15m', 'Chart bar length.'],
  ['speed 1 | 2 | 5 | 10 | 30 | 60', 'Simulated seconds per real second.'],
  ['pause | play', 'Stop or restart the simulated clock.'],
  ['max <panel> | restore', `Enlarge one panel (${PANELS.join(', ')}), or go back to the grid.`],
  ['reset [<seed>]', 'Start a new simulated session (clears paper orders and positions).'],
  ['clear', 'Clear the message log.'],
  ['help', 'This list. Keys: / focuses the command line, Esc leaves it, ↑/↓ recall history, Tab completes.'],
];

const num = s => (/^[+]?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);
const int = s => (/^\d+$/.test(s) ? Number(s) : NaN);
const err = error => ({ error });

/**
 * Parse one command line into { cmd, ...args } or { error }. Symbols are passed through as typed; the caller
 * resolves them against the market.
 */
export function parse(input) {
  const words = String(input || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { cmd: 'noop' };
  const [head, ...rest] = words;
  const w = head.toLowerCase();
  switch (w) {
    case 'help': case '?': return { cmd: 'help' };
    case 'clear': case 'cls': return { cmd: 'clear' };
    case 'pause': case 'stop': return { cmd: 'pause' };
    case 'play': case 'resume': case 'go': return { cmd: 'play' };
    case 'restore': return { cmd: 'restore' };
    case 'buy': case 'sell': return parseOrder(w === 'buy' ? 'B' : 'S', rest);
    case 'cancel': case 'cxl': {
      if (rest[0]?.toLowerCase() === 'all') return { cmd: 'cancel', id: 'all' };
      const id = int(rest[0] || '');
      return Number.isFinite(id) ? { cmd: 'cancel', id } : err('Usage: cancel <id> | cancel all');
    }
    case 'flatten': case 'flat': {
      const t = rest[0];
      return { cmd: 'flatten', sym: !t || t.toLowerCase() === 'all' ? 'all' : t };
    }
    case 'interval': case 'int': {
      const k = INTERVALS[(rest[0] || '').toLowerCase()];
      return k ? { cmd: 'interval', minutes: k } : err('Usage: interval 1m | 5m | 15m');
    }
    case 'speed': {
      const k = int(rest[0] || '');
      return SPEEDS.includes(k) ? { cmd: 'speed', speed: k } : err(`Usage: speed ${SPEEDS.join(' | ')}`);
    }
    case 'max': {
      const p = (rest[0] || '').toLowerCase();
      return PANELS.includes(p) ? { cmd: 'max', panel: p } : err(`Usage: max ${PANELS.join(' | ')}`);
    }
    case 'reset': {
      if (!rest.length) return { cmd: 'reset' };
      const seed = int(rest[0]);
      return Number.isFinite(seed) && seed < 2 ** 32 ? { cmd: 'reset', seed } : err('Usage: reset [seed], seed a whole number');
    }
    default:
      if (words.length === 1 && /^[a-z]{1,8}(\.sim)?$/i.test(head)) return { cmd: 'load', sym: head };
      return err(`Unknown command "${head}". Type help.`);
  }
}

// buy 100 alfa | buy 100 alfa @ 84.10 | buy 100 alfa @84.10 | buy alfa 100 @ 84.10
function parseOrder(side, rest) {
  const usage = `Usage: ${side === 'B' ? 'buy' : 'sell'} <qty> <symbol> [@ <price>]`;
  const toks = rest.join(' ').replace(/@/g, ' @ ').split(/\s+/).filter(Boolean);
  const at = toks.indexOf('@');
  const main = at >= 0 ? toks.slice(0, at) : toks;
  const after = at >= 0 ? toks.slice(at + 1) : [];
  if (main.length !== 2 || (at >= 0 && after.length !== 1)) return err(usage);
  let [a, b] = main;
  if (Number.isFinite(int(b)) && !Number.isFinite(int(a))) [a, b] = [b, a];
  const qty = int(a.replace(/,/g, ''));
  if (!Number.isFinite(qty)) return err(usage);
  if (!/^[a-z]{1,8}(\.sim)?$/i.test(b)) return err(usage);
  if (at < 0) return { cmd: 'order', side, qty, sym: b, type: 'market' };
  const limit = num(after[0]);
  return Number.isFinite(limit) ? { cmd: 'order', side, qty, sym: b, type: 'limit', limit } : err(usage);
}

/** Tab completion: the commands, panels and symbols that start with the last word typed. */
export function complete(input, symbols) {
  const words = String(input).split(/\s+/);
  const last = (words[words.length - 1] || '').toLowerCase();
  const first = words[0].toLowerCase();
  let pool;
  if (words.length === 1) pool = ['help', 'buy', 'sell', 'cancel', 'flatten', 'interval', 'speed', 'pause', 'play', 'max', 'restore', 'reset', 'clear', ...symbols.map(s => s.toLowerCase())];
  else if (first === 'max') pool = PANELS;
  else if (first === 'interval') pool = Object.keys(INTERVALS);
  else pool = symbols.map(s => s.toLowerCase());
  const hits = pool.filter(p => p.startsWith(last));
  if (hits.length !== 1) return { input, options: hits };
  words[words.length - 1] = hits[0];
  return { input: words.join(' ') + ' ', options: hits };
}
