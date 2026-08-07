// imageIntrinsicSize.ts
//
// Read the REAL pixel dimensions of an image by parsing its container header.
//
// Why this exists (issue #5001, "immagine >=1200px"): article pages declared
// their hero size from constants and from hand-authored `structuredData.image`
// literals, and both drifted from the files on disk. Measured live on
// 2026-08-07 across the it/en/de/fr article corpus:
//
//   JSON-LD said        width: 1344, height: 756
//   the <img> said      width="800"  height="320"
//   the file actually   1200 x <varies: 675, 900, 800, 803, 179, 2469, ...>
//
// A declared width that does not match the bytes is a false statement served to
// crawlers, and a declared HEIGHT that does not match is also CLS: the
// width/height pair is what reserves the box before the image lands, which
// Non-Negotiable #7 requires us to fix by reserving correctly (never by
// suppressing the ad that inherits the shift).
//
// No dependency: `packages/articles` is confinement-tested
// (tests/packages-articles-confinement.test.ts) and may import only Node
// builtins plus its own declared deps — `sharp` is neither. Header parsing is
// a few dozen bytes per format anyway, and reading 64 KiB beats decoding a
// 3.500-file corpus.

import fs from 'node:fs';

export type IntrinsicSize = { width: number; height: number };

/** Bytes read from the head of the file. Every header below fits far inside this. */
const HEADER_BYTES = 65536;

function webp(b: Buffer): IntrinsicSize | null {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = b.toString('ascii', 12, 16);
  // Extended format: canvas size is a 24-bit "minus one" pair.
  if (fourcc === 'VP8X') {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  // Lossy: dimensions follow the 0x9d012a start code in the VP8 frame header.
  if (fourcc === 'VP8 ') {
    const i = b.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (i < 0 || i > 40 || b.length < i + 7) return null;
    return { width: b.readUInt16LE(i + 3) & 0x3fff, height: b.readUInt16LE(i + 5) & 0x3fff };
  }
  // Lossless: 14 bits each, packed after the 0x2f signature byte.
  if (fourcc === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function png(b: Buffer): IntrinsicSize | null {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpeg(b: Buffer): IntrinsicSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    // SOF0..SOF15 except the non-frame DHT/JPG/DAC markers (0xc4/0xc8/0xcc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function gif(b: Buffer): IntrinsicSize | null {
  if (b.length < 10 || b.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function avif(b: Buffer): IntrinsicSize | null {
  // `ftyp` brand check first, so a stray "ispe" inside some other format's
  // payload cannot be mistaken for an image-spatial-extents box.
  if (b.length < 12 || b.toString('ascii', 4, 8) !== 'ftyp') return null;
  const i = b.indexOf('ispe', 0, 'ascii');
  if (i < 0 || b.length < i + 16) return null;
  return { width: b.readUInt32BE(i + 8), height: b.readUInt32BE(i + 12) };
}

const PARSERS = [webp, png, jpeg, gif, avif];

/** Parse dimensions out of a header buffer. Returns null when nothing matches. */
export function intrinsicSizeFromBuffer(buf: Buffer): IntrinsicSize | null {
  for (const parse of PARSERS) {
    let size: IntrinsicSize | null = null;
    try { size = parse(buf); } catch { size = null; }
    if (size && size.width > 0 && size.height > 0) return size;
  }
  return null;
}

/**
 * Measure the image at `absPath`. Returns null when the path is missing, is not
 * a regular file, or is not a format we can parse — callers decide the fallback,
 * because "unknown" and "wrong" must not collapse into the same value.
 */
export function readImageIntrinsicSize(absPath: string): IntrinsicSize | null {
  let fd: number | undefined;
  try {
    if (!fs.statSync(absPath).isFile()) return null;
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.allocUnsafe(HEADER_BYTES);
    const read = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    return intrinsicSizeFromBuffer(buf.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}
