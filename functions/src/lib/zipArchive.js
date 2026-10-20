/**
 * A ZIP archive read and written again with one entry changed: what the
 * in-place DOCX needs (phase 5 of the CV study, 2026-10-02). Every entry the
 * caller does not replace is copied byte for byte, compressed as it was, so
 * styles, fonts and pictures of the candidate's file are not touched.
 * `createZip` writes a new archive from names and bytes (the candidate's Word
 * copy, assistedApplicationDocx.js).
 *
 * Only what Word and LibreOffice write is accepted: methods `stored` (0) and
 * `deflate` (8), no encryption, no ZIP64. Sizes are read from the central
 * directory, so local headers with a data descriptor are read too.
 */

import zlib from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const MAX_ENTRIES = 2000;
const UTF8_NAMES = 0x0800;

export class ZipError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

let crcTable = null;
function crc32Table(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** zlib.crc32 where Node has it (22.2+), the table otherwise. */
export const crc32 = (buffer) => (typeof zlib.crc32 === 'function' ? zlib.crc32(buffer) >>> 0 : crc32Table(buffer));

function endOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) === END) return offset;
  }
  return -1;
}

/**
 * The entries of an archive, in their order, each with its compressed bytes.
 * @param {Buffer} input
 * @returns {Array<{name:string, method:number, flags:number, time:number, date:number, crc:number, size:number, compressed:Buffer, internalAttributes:number, externalAttributes:number}>}
 */
export function readZip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const end = buffer.length >= 22 ? endOfCentralDirectory(buffer) : -1;
  if (end < 0) throw new ZipError('not_a_zip');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new ZipError('zip64');
  if (count > MAX_ENTRIES) throw new ZipError('too_many_entries');
  const entries = [];
  const names = new Set();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL) throw new ZipError('broken_directory');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 1) throw new ZipError('encrypted');
    if (method !== 0 && method !== 8) throw new ZipError('unsupported_method');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('zip64');
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (names.has(name)) throw new ZipError('duplicate_entry');
    names.add(name);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) throw new ZipError('broken_entry');
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buffer.length) throw new ZipError('broken_entry');
    entries.push({
      name,
      method,
      flags,
      time: buffer.readUInt16LE(offset + 12),
      date: buffer.readUInt16LE(offset + 14),
      crc: buffer.readUInt32LE(offset + 16),
      size,
      compressed: buffer.subarray(start, start + compressedSize),
      internalAttributes: buffer.readUInt16LE(offset + 36),
      externalAttributes: buffer.readUInt32LE(offset + 38),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * The uncompressed bytes of one entry, at most `maxBytes` (zip-bomb guard).
 * @returns {Buffer}
 */
export function entryData(entry, maxBytes) {
  if (entry.size > maxBytes) throw new ZipError('entry_too_large');
  const data = entry.method === 0 ? Buffer.from(entry.compressed) : zlib.inflateRawSync(entry.compressed, { maxOutputLength: maxBytes });
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError('bad_crc');
  return data;
}

/**
 * The archive again, with the entries of `replace` (name → new uncompressed
 * bytes) deflated anew and every other entry copied as it was.
 * @param {ReturnType<typeof readZip>} entries
 * @param {Map<string, Buffer>} replace
 * @returns {Buffer}
 */
export function writeZip(entries, replace = new Map()) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = replace.get(entry.name);
    const item = data
      ? { ...entry, method: 8, crc: crc32(data), size: data.length, compressed: zlib.deflateRawSync(data, { level: 9 }) }
      : entry;
    const name = Buffer.from(item.name, 'utf8');
    // No data descriptor: sizes and CRC are known and written in the header.
    const flags = (item.flags & ~0x0008) | (/[^\x20-\x7e]/.test(item.name) ? UTF8_NAMES : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(item.method, 8);
    local.writeUInt16LE(item.time, 10);
    local.writeUInt16LE(item.date, 12);
    local.writeUInt32LE(item.crc, 14);
    local.writeUInt32LE(item.compressed.length, 18);
    local.writeUInt32LE(item.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(item.method, 10);
    central.writeUInt16LE(item.time, 12);
    central.writeUInt16LE(item.date, 14);
    central.writeUInt32LE(item.crc, 16);
    central.writeUInt32LE(item.compressed.length, 20);
    central.writeUInt32LE(item.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(item.internalAttributes || 0, 36);
    central.writeUInt32LE(item.externalAttributes || 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, item.compressed);
    centrals.push(central, name);
    offset += local.length + name.length + item.compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// 1980-01-01 00:00, the first date a ZIP entry can carry: the same input always gives the same bytes.
const DOS_EPOCH_DATE = 0x0021;

/**
 * A new archive from names and bytes, in the given order, every entry deflated.
 * @param {Array<{name:string, data:Buffer}>} files
 * @returns {Buffer}
 */
export function createZip(files) {
  const names = new Set();
  for (const { name } of files) {
    // writeZip would write a second entry of the same name, and readZip then refuses the archive.
    if (names.has(name)) throw new ZipError('duplicate_entry');
    names.add(name);
  }
  const entries = files.map(({ name }) => ({ name, flags: 0, time: 0, date: DOS_EPOCH_DATE, internalAttributes: 0, externalAttributes: 0 }));
  return writeZip(entries, new Map(files.map(({ name, data }) => [name, Buffer.from(data)])));
}
