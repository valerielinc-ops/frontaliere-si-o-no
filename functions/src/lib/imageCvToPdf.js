import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { detectCvFileType } from '../assistedApplicationCvCheck.js';

export const MAX_CV_OUTPUT_BYTES = 5 * 1024 * 1024;
export const MAX_CV_IMAGE_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MIN_EMAIL_IMAGE_DIMENSION_PX = 200;
const MIN_SMALL_SIGNATURE_BYTES = 25 * 1024;
const SMALL_SIGNATURE_DIMENSION_PX = 500;
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

const IMAGE_COMPRESSION_LADDER = [
  { maxWidth: 2480, maxHeight: 3508, quality: 88 },
  { maxWidth: 2000, maxHeight: 2828, quality: 78 },
  { maxWidth: 1654, maxHeight: 2339, quality: 68 },
  { maxWidth: 1240, maxHeight: 1754, quality: 58 },
];

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

function matchesBytes(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

/**
 * Inspects file magic bytes to identify supported raster CV image formats.
 * Never trusts MIME headers or file extensions alone.
 * @param {Uint8Array|Buffer} head
 * @returns {'jpeg'|'png'|'webp'|'gif'|'tiff'|'heif'|null}
 */
export function detectCvImageType(head) {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  if (matchesBytes(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (matchesBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (matchesBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && matchesBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (matchesBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || matchesBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'gif';
  if (matchesBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) || matchesBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (bytes.length >= 12 && matchesBytes(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString('ascii').toLowerCase();
    if (HEIF_BRANDS.has(brand)) return 'heif';
  }
  return null;
}

/**
 * Converts one or more raster CV images into a single A4-proportioned PDF
 * bounded cleanly below `maxOutputBytes`.
 * @param {Array<Buffer|Uint8Array>} buffers
 * @param {{ maxOutputBytes?: number }} [options]
 * @returns {Promise<{ pdf: Buffer, pageCount: number }|null>}
 */
export async function convertCvImagesToPdf(buffers, { maxOutputBytes = MAX_CV_OUTPUT_BYTES } = {}) {
  const inputs = (Array.isArray(buffers) ? buffers : [buffers])
    .filter((item) => item && item.length > 0)
    .map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item)));
  if (!inputs.length) return null;

  for (const step of IMAGE_COMPRESSION_LADDER) {
    const doc = await PDFDocument.create();
    for (const input of inputs) {
      const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize({
          width: step.maxWidth,
          height: step.maxHeight,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: step.quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });

      const embedded = await doc.embedJpg(data);
      const scale = Math.min(A4_WIDTH_PT / info.width, A4_HEIGHT_PT / info.height);
      const pageWidth = info.width * scale;
      const pageHeight = info.height * scale;
      const page = doc.addPage([pageWidth, pageHeight]);
      page.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    }
    const pdf = Buffer.from(await doc.save());
    if (pdf.length <= maxOutputBytes) {
      return { pdf, pageCount: inputs.length };
    }
  }
  return null;
}

async function isQualifyingCvImage(buffer) {
  try {
    const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const width = Number(meta?.width) || 0;
    const height = Number(meta?.height) || 0;
    if (width < MIN_EMAIL_IMAGE_DIMENSION_PX || height < MIN_EMAIL_IMAGE_DIMENSION_PX) return false;
    if (buffer.length < MIN_SMALL_SIGNATURE_BYTES && Math.max(width, height) < SMALL_SIGNATURE_DIMENSION_PX) return false;
    return true;
  } catch {
    return false;
  }
}

function pdfFileNameFrom(name) {
  const base = String(name || 'cv').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() || 'cv';
  return `${base}.pdf`;
}

function isInlineEmailImage(item) {
  const disposition = String(item?.contentDisposition ?? item?.disposition ?? '').trim().toLowerCase();
  if (disposition.startsWith('inline') || item?.isInline === true) return true;
  return Boolean(String(item?.contentId || '').trim());
}

/**
 * Selects the CV from inbound email attachments: prefers verified document
 * formats (PDF/DOC/DOCX) and otherwise converts qualifying raster CV images
 * into a single multi-page PDF.
 * @param {Array<{filename?: string, contentDisposition?: string, contentId?: string, content: Buffer}>} attachments
 * @param {{ maxDocumentBytes?: number, maxImageInputBytes?: number }} [options]
 * @returns {Promise<{filename: string, type: 'pdf'|'doc'|'docx', content: Buffer, convertedFrom?: string, pageCount?: number}|null>}
 */
export async function resolveCvAttachmentFromEmail(
  attachments,
  { maxDocumentBytes = MAX_CV_OUTPUT_BYTES, maxImageInputBytes = MAX_CV_IMAGE_INPUT_BYTES } = {},
) {
  const list = Array.isArray(attachments) ? attachments : [];
  for (const item of list) {
    if (!Buffer.isBuffer(item?.content) || item.content.length === 0 || item.content.length > maxDocumentBytes) continue;
    const docType = detectCvFileType(item.content.subarray(0, 8));
    if (docType) return { ...item, type: docType };
  }

  const imageCandidates = [];
  for (const item of list) {
    if (!Buffer.isBuffer(item?.content) || item.content.length === 0 || item.content.length > maxImageInputBytes) continue;
    if (isInlineEmailImage(item)) continue;
    const imageType = detectCvImageType(item.content.subarray(0, 16));
    if (!imageType) continue;
    if (await isQualifyingCvImage(item.content)) {
      imageCandidates.push({ ...item, imageType });
    }
  }
  if (!imageCandidates.length) return null;

  const converted = await convertCvImagesToPdf(
    imageCandidates.map((item) => item.content),
    { maxOutputBytes: maxDocumentBytes },
  );
  if (!converted) return null;

  return {
    filename: pdfFileNameFrom(imageCandidates[0].filename),
    type: 'pdf',
    content: converted.pdf,
    convertedFrom: imageCandidates[0].imageType,
    pageCount: converted.pageCount,
  };
}

/**
 * Validates an uploaded CV buffer (document or raster image) and normalizes
 * raster images into a `%PDF-` buffer bounded within `maxDocumentBytes`.
 * @param {Buffer} buffer
 * @param {{ maxDocumentBytes?: number, maxImageInputBytes?: number }} [options]
 * @returns {Promise<{ buffer: Buffer, type: 'pdf'|'doc'|'docx', convertedFrom?: string }|null>}
 */
export async function normalizeUploadedCvBuffer(
  buffer,
  { maxDocumentBytes = MAX_CV_OUTPUT_BYTES, maxImageInputBytes = MAX_CV_IMAGE_INPUT_BYTES } = {},
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const docType = detectCvFileType(buffer.subarray(0, 8));
  if (docType) {
    return buffer.length <= maxDocumentBytes ? { buffer, type: docType } : null;
  }
  const imageType = detectCvImageType(buffer.subarray(0, 16));
  if (!imageType || buffer.length > maxImageInputBytes) return null;
  try {
    const converted = await convertCvImagesToPdf([buffer], { maxOutputBytes: maxDocumentBytes });
    if (!converted) return null;
    return { buffer: converted.pdf, type: 'pdf', convertedFrom: imageType };
  } catch {
    return null;
  }
}
