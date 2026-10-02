// Minimal, defensive ZIP reader for files the user supplies (e.g. Kenneth R. French Data Library downloads).
// Zero dependencies; runs in browsers and Node 22. Only what those files need is supported:
//   - compression method 0 (stored) and 8 (deflate, via DecompressionStream('deflate-raw'))
//   - no encryption, no ZIP64, no multi-disk archives
// Every archive is treated as untrusted input: sizes, entry counts and path names are checked before any
// decompression, the uncompressed byte count is enforced while inflating, and CRC-32 is verified.

export const ZIP_LIMITS = Object.freeze({
  maxTotalUncompressed: 50 * 1024 * 1024, // 50 MB across all entries
  maxEntries: 200,
  maxNameLength: 255,
});

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Reject names that could escape a folder or confuse a file system if anyone ever wrote them to disk. */
export function checkEntryName(name) {
  if (!name || name.length > ZIP_LIMITS.maxNameLength) throw new ZipError(`ZIP entry has an invalid name length (${name.length}).`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ZipError('ZIP entry name contains control characters.');
  if (name.includes('\\')) throw new ZipError(`ZIP entry name uses a backslash: ${JSON.stringify(name)}.`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ZipError(`ZIP entry has an absolute path: ${JSON.stringify(name)}.`);
  if (name.split('/').some(seg => seg === '..' || seg === '.')) throw new ZipError(`ZIP entry path contains "." or "..": ${JSON.stringify(name)}.`);
  return name;
}

function findEocd(dv) {
  // EOCD is 22 bytes plus a comment of up to 65535 bytes, at the very end of the file.
  const min = Math.max(0, dv.byteLength - 22 - 0xffff);
  for (let i = dv.byteLength - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

function decodeName(bytes, utf8) {
  // Bit 11 set = UTF-8. Otherwise CP437; French library names are ASCII, and we reject anything else.
  if (utf8) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const b of bytes) if (b > 0x7e) throw new ZipError('ZIP entry name is not ASCII or UTF-8.');
  return String.fromCharCode(...bytes);
}

async function inflateRaw(data, expectedSize, remainingBudget) {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipError('This browser cannot decompress ZIP files (DecompressionStream is missing). Unzip the file and add the .csv instead.');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > expectedSize || total > remainingBudget) {
        throw new ZipError('ZIP entry decompresses to more data than it declares (possible ZIP bomb); refusing it.');
      }
      chunks.push(value);
    }
  } catch (e) {
    try { await reader.cancel(); } catch { /* already closed */ }
    if (e instanceof ZipError) throw e;
    throw new ZipError('ZIP entry is corrupt: deflate data could not be decompressed.');
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * unzip(bytes) → Promise<[{name, bytes}]>. Directories are skipped. Throws ZipError with a readable message.
 * @param {Uint8Array} bytes
 */
export async function unzip(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new ZipError('unzip() expects a Uint8Array.');
  if (bytes.length < 22) throw new ZipError('Not a ZIP file (too short).');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(dv);
  if (eocd < 0) throw new ZipError('Not a ZIP file (end-of-central-directory record not found).');
  if (eocd >= 20 && dv.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) throw new ZipError('ZIP64 archives are not supported.');

  const diskNo = dv.getUint16(eocd + 4, true);
  const cdDisk = dv.getUint16(eocd + 6, true);
  const entriesOnDisk = dv.getUint16(eocd + 8, true);
  const entries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
  if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== entries) throw new ZipError('Multi-part (spanned) ZIP archives are not supported.');
  if (entries > ZIP_LIMITS.maxEntries) throw new ZipError(`ZIP has too many entries (${entries} > ${ZIP_LIMITS.maxEntries}).`);
  if (cdOffset + cdSize > eocd) throw new ZipError('ZIP central directory is out of bounds (corrupt file).');

  // Pass 1: read and validate the whole central directory before decompressing anything.
  const list = [];
  let p = cdOffset;
  let declaredTotal = 0;
  const seen = new Set();
  for (let i = 0; i < entries; i++) {
    if (p + 46 > eocd || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('ZIP central directory is corrupt.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen + commentLen > eocd) throw new ZipError('ZIP central directory is corrupt.');
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x0800) !== 0);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) throw new ZipError(`ZIP entry "${name}" is encrypted; encrypted archives are not supported.`);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
    checkEntryName(name);
    if (name.endsWith('/')) continue; // directory entry
    if (method !== 0 && method !== 8) throw new ZipError(`ZIP entry "${name}" uses compression method ${method}; only stored (0) and deflate (8) are supported.`);
    if (method === 0 && csize !== usize) throw new ZipError(`ZIP entry "${name}" is corrupt (stored sizes differ).`);
    if (seen.has(name)) throw new ZipError(`ZIP contains the entry "${name}" twice.`);
    seen.add(name);
    declaredTotal += usize;
    if (declaredTotal > ZIP_LIMITS.maxTotalUncompressed) {
      throw new ZipError(`ZIP would expand to more than ${ZIP_LIMITS.maxTotalUncompressed / 1024 / 1024} MB; refusing it.`);
    }
    list.push({ name, method, crc, csize, usize, localOffset });
  }

  // Pass 2: locate data through each local header and decompress with the byte budget enforced.
  const out = [];
  let budget = ZIP_LIMITS.maxTotalUncompressed;
  for (const e of list) {
    const lp = e.localOffset;
    if (lp + 30 > cdOffset || dv.getUint32(lp, true) !== SIG_LOCAL) throw new ZipError(`ZIP local header for "${e.name}" is corrupt.`);
    if (dv.getUint16(lp + 6, true) & 0x0001) throw new ZipError(`ZIP entry "${e.name}" is encrypted; encrypted archives are not supported.`);
    const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
    const end = start + e.csize;
    if (end > cdOffset) throw new ZipError(`ZIP data for "${e.name}" is out of bounds (corrupt or truncated file).`);
    const raw = bytes.subarray(start, end);
    const data = e.method === 0 ? raw.slice() : await inflateRaw(raw, e.usize, budget);
    if (data.length !== e.usize) throw new ZipError(`ZIP entry "${e.name}" has the wrong size after decompression (corrupt file).`);
    if (crc32(data) !== e.crc) throw new ZipError(`ZIP entry "${e.name}" failed its CRC-32 check (corrupt file).`);
    budget -= data.length;
    out.push({ name: e.name, bytes: data });
  }
  return out;
}
