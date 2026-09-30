/**
 * Document helpers for the AI draft of an assisted application.
 *
 * Two jobs, both dependency-free beyond `unpdf` (already a functions dep):
 *  - read the text of the customer's CV, so the fact gate
 *    (assistedApplicationAiFactCheck.js) can prove every number in the
 *    generated letter comes from the candidate, not from the model;
 *  - write the generated cover letter as a one-file PDF the operator can
 *    upload to an employer portal or attach to the application email.
 *
 * The PDF writer uses the standard Helvetica font with WinAnsi encoding, so
 * every Italian, German and French letter renders without embedding a font.
 */

import { inflateRawSync } from 'node:zlib';

const MAX_CV_TEXT_CHARS = 40_000;
const MAX_DOCX_XML_BYTES = 8 * 1024 * 1024;

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CV_TEXT_CHARS);
}

// ── DOCX (Office Open XML is a ZIP archive) ────────────────────────────────

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

/**
 * Return the uncompressed bytes of one ZIP entry, or null when absent.
 * Only `stored` (0) and `deflate` (8) are supported — the two methods Word
 * writes. `maxBytes` bounds the inflated size (zip-bomb guard).
 */
export function readZipEntry(input, entryName, maxBytes = MAX_DOCX_XML_BYTES) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) return null;
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === entryName) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return data.length <= maxBytes ? Buffer.from(data) : null;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
      return null;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Plain text of a Word `document.xml`: paragraphs, tabs and breaks kept. */
export function docxXmlToText(xml) {
  const text = String(xml || '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:(?:br|cr)\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return normalizeWhitespace(decodeXmlEntities(text));
}

export function extractDocxText(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml');
  return xml ? docxXmlToText(xml.toString('utf8')) : '';
}

// ── PDF text ───────────────────────────────────────────────────────────────

export async function extractPdfText(buffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return normalizeWhitespace(Array.isArray(text) ? text.join('\n') : text);
}

/**
 * Best-effort CV text. `type` is the server-side magic-byte verdict from
 * assistedApplicationCvCheck.js. A scanned PDF yields '' — the caller then
 * relies on the model reading the PDF itself.
 */
export async function extractCvText(buffer, type) {
  if (type === 'pdf') return extractPdfText(buffer);
  if (type === 'docx') return extractDocxText(buffer);
  return '';
}

// ── Minimal PDF writer (cover letter) ─────────────────────────────────────

// Helvetica advance widths (Adobe AFM, 1/1000 em) for ASCII 32..126.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// Unicode → WinAnsi (cp1252) for the 0x80–0x9F block; Latin-1 maps 1:1.
const WIN_ANSI_EXTRA = new Map([
  ['€', 0x80], ['‚', 0x82], ['„', 0x84], ['…', 0x85], ['‘', 0x91], ['’', 0x92],
  ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97], ['™', 0x99],
  ['Š', 0x8a], ['š', 0x9a], ['Œ', 0x8c], ['œ', 0x9c], ['Ž', 0x8e], ['ž', 0x9e], ['Ÿ', 0x9f],
]);

function winAnsiCode(char) {
  if (WIN_ANSI_EXTRA.has(char)) return WIN_ANSI_EXTRA.get(char);
  const code = char.codePointAt(0);
  if (code === 0x09) return 0x20;
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return 0x3f; // '?' for anything the standard font cannot show
}

function charWidth(char) {
  const code = winAnsiCode(char);
  if (code >= 32 && code <= 126) return HELVETICA_WIDTHS[code - 32];
  // Accented Latin-1 letters share their base letter's advance closely enough
  // for line breaking; 556 is the lowercase average.
  return 556;
}

export function textWidth(text, fontSize) {
  let units = 0;
  for (const char of String(text || '')) units += charWidth(char);
  return (units * fontSize) / 1000;
}

/** Greedy word wrap on measured widths; over-long words are hard-split. */
export function wrapText(text, fontSize, maxWidth) {
  const lines = [];
  for (const paragraph of String(text || '').split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (let word of words) {
      while (textWidth(word, fontSize) > maxWidth) {
        let cut = word.length - 1;
        while (cut > 1 && textWidth(word.slice(0, cut), fontSize) > maxWidth) cut -= 1;
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, fontSize) <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function pdfHexString(text) {
  let hex = '';
  for (const char of String(text || '')) hex += winAnsiCode(char).toString(16).padStart(2, '0');
  return `<${hex}>`;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 64;
const BODY_SIZE = 10.5;
const LEADING = 15;

/**
 * Lay out blocks top-to-bottom and return a PDF Buffer.
 * @param {Array<{text:string, bold?:boolean, size?:number, gapBefore?:number, align?:'left'|'right'}>} blocks
 */
export function renderPdf(blocks, { title = '' } = {}) {
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const pages = [[]];
  let y = PAGE_HEIGHT - MARGIN;
  for (const block of blocks) {
    const size = block.size || BODY_SIZE;
    const leading = Math.max(LEADING, size * 1.4);
    y -= block.gapBefore || 0;
    for (const line of wrapText(block.text, size, maxWidth)) {
      if (y - leading < MARGIN) {
        pages.push([]);
        y = PAGE_HEIGHT - MARGIN;
      }
      y -= leading;
      if (!line) continue;
      const x = block.align === 'right' ? PAGE_WIDTH - MARGIN - textWidth(line, size) : MARGIN;
      pages[pages.length - 1].push(
        `BT /${block.bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfHexString(line)} Tj ET`,
      );
    }
  }

  // Object numbers: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info,
  // then one (page, content) pair per page.
  const objects = [];
  const pageRefs = pages.map((_, index) => `${6 + index * 2} 0 R`);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = `<< /Title ${pdfHexString(title)} /Producer (frontaliereticino.ch) >>`;
  pages.forEach((commands, index) => {
    const pageId = 6 + index * 2;
    const contentId = pageId + 1;
    const stream = commands.join('\n');
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/**
 * The cover letter as Swiss business-letter blocks: sender, recipient,
 * place/date, subject in bold, body, signature.
 */
export function buildCoverLetterPdf({
  senderLines = [],
  recipientLines = [],
  placeDate = '',
  subject = '',
  salutation = '',
  paragraphs = [],
  closing = '',
  signature = '',
  title = '',
}) {
  const blocks = [];
  for (const line of senderLines.filter(Boolean)) blocks.push({ text: line, size: 9.5 });
  blocks.push({ text: '', gapBefore: 18 });
  for (const line of recipientLines.filter(Boolean)) blocks.push({ text: line });
  if (placeDate) blocks.push({ text: placeDate, align: 'right', gapBefore: 18 });
  if (subject) blocks.push({ text: subject, bold: true, gapBefore: 18 });
  if (salutation) blocks.push({ text: salutation, gapBefore: 14 });
  paragraphs.filter(Boolean).forEach((paragraph, index) => {
    blocks.push({ text: paragraph, gapBefore: index === 0 ? 8 : 7 });
  });
  if (closing) blocks.push({ text: closing, gapBefore: 12 });
  if (signature) blocks.push({ text: signature, gapBefore: 22 });
  return renderPdf(blocks, { title });
}
