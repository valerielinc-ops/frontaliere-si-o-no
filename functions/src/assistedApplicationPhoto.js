import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { CV_PORTRAIT_RECOVERY_VERSION } from './assistedApplicationConstants.js';
import { MAX_CV_SOURCE_BYTES } from './assistedApplicationAiDocuments.js';
import { isAssistedApplicationCvKey, detectCvFileType } from './assistedApplicationCvCheck.js';
import {
  MAX_PORTAL_PHOTO_BYTES,
  photoFileAccepted,
  photoFilesOf,
  requiredDocumentsFor,
} from './assistedApplicationExtraDocuments.js';

export { CV_PORTRAIT_RECOVERY_VERSION };
export { MAX_PORTAL_PHOTO_BYTES };
const MAX_PDF_PAGES = 80;
const MAX_IMAGE_PIXELS = 16_777_216;
const MIN_PORTRAIT_SIDE = 150;
const MAX_IMAGE_OPERATIONS = 400;
const MAX_PDF_EXTRACTION_MS = 15_000;
const JPEG_QUALITIES = Object.freeze([84, 76, 68, 60, 52]);
const isByteArray = (value) => value instanceof Uint8Array || value instanceof Uint8ClampedArray;

function beforeDeadline(promise, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.reject(new Error('pdf_extraction_timeout'));
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('pdf_extraction_timeout')), remainingMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function plausiblePortraitDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < MIN_PORTRAIT_SIDE || height < MIN_PORTRAIT_SIDE
    || width * height > MAX_IMAGE_PIXELS) return false;
  const ratio = width / height;
  return ratio >= 0.6 && ratio <= 1.4;
}

async function jpegWithinLimit(image, maxBytes = MAX_PORTAL_PHOTO_BYTES, deadline = Infinity) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  const pixels = width * height;
  const raw = image?.data;
  if (!plausiblePortraitDimensions(width, height) || !isByteArray(raw) || !pixels) return null;
  const channels = raw.byteLength / pixels;
  if (![1, 3, 4].includes(channels)) return null;
  const input = Buffer.from(raw);
  const sizes = [1600, 1200, 900];
  for (const maxSide of sizes) {
    for (const quality of JPEG_QUALITIES) {
      if (Date.now() >= deadline) return null;
      const output = await beforeDeadline(sharp(input, { raw: { width, height, channels } })
        .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer(), deadline);
      if (output.length <= maxBytes) return output;
    }
  }
  return null;
}

function imageOperationIds(operatorList, OPS) {
  const imageOps = new Set([
    OPS.paintImageXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintJpegXObject,
  ].filter(Number.isInteger));
  const inlineOps = new Set([
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
  ].filter(Number.isInteger));
  const ids = [];
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (imageOps.has(operation) && typeof args?.[0] === 'string') ids.push(args[0]);
    else if (inlineOps.has(operation) && args?.[0] && typeof args[0] === 'object') ids.push(args[0]);
  }
  return ids;
}

async function pageImage(page, idOrData) {
  if (typeof idOrData !== 'string') return idOrData;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value || null);
    };
    const timer = setTimeout(() => finish(null), 1000);
    timer.unref?.();
    try {
      const existing = page.objs.get(idOrData, finish);
      if (existing) finish(existing);
    } catch {
      finish(null);
    }
  });
}

/**
 * Extract the sole plausible portrait from a PDF. This intentionally uses
 * dimensions and uniqueness only: without a vision result, other image
 * content remains unknown and is never selected when more than one candidate
 * exists.
 */
export async function extractCvPortraitFromPdf(input, { signal = null, maxBytes = MAX_PORTAL_PHOTO_BYTES } = {}) {
  signal?.throwIfAborted();
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, MAX_PORTAL_PHOTO_BYTES) : MAX_PORTAL_PHOTO_BYTES;
  const source = Buffer.from(input || []);
  if (source.length < 8 || source.length > MAX_CV_SOURCE_BYTES || detectCvFileType(source) !== 'pdf') return null;

  let loadingTask = null;
  const candidates = new Map();
  const deadline = Date.now() + MAX_PDF_EXTRACTION_MS;
  try {
    const { getResolvedPDFJS } = await import('unpdf');
    const { getDocument, OPS } = await getResolvedPDFJS();
    loadingTask = getDocument({
      data: new Uint8Array(source),
      isEvalSupported: false,
      maxImageSize: MAX_IMAGE_PIXELS,
      useSystemFonts: true,
    });
    const pdf = await beforeDeadline(loadingTask.promise, deadline);
    const pageCount = Number(pdf?.numPages);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGES) return null;
    let imageOperations = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      signal?.throwIfAborted();
      const page = await beforeDeadline(pdf.getPage(pageNumber), deadline);
      try {
        const operators = await beforeDeadline(page.getOperatorList(), deadline);
        const seenOnPage = new Set();
        for (const idOrData of imageOperationIds(operators, OPS)) {
          imageOperations += 1;
          if (imageOperations > MAX_IMAGE_OPERATIONS) return null;
          const image = await beforeDeadline(pageImage(page, idOrData), deadline);
          const width = Number(image?.width);
          const height = Number(image?.height);
          if (!plausiblePortraitDimensions(width, height)) continue;
          const pixels = width * height;
          const data = image?.data;
          if (!isByteArray(data) || !pixels) continue;
          const channels = data.byteLength / pixels;
          if (![1, 3, 4].includes(channels)) continue;
          const key = createHash('sha256').update(`${width}x${height}:`).update(data).digest('hex');
          if (seenOnPage.has(key)) continue;
          seenOnPage.add(key);
          let candidate = candidates.get(key);
          if (!candidate) {
            const jpeg = await jpegWithinLimit(image, byteLimit, deadline);
            if (!jpeg) continue;
            candidate = { jpeg, pages: new Set() };
            candidates.set(key, candidate);
          }
          candidate.pages.add(pageNumber);
          if (candidates.size > 1) return null;
        }
      } finally {
        page.cleanup?.();
      }
    }
    const [candidate] = candidates.values();
    if (!candidate || (pageCount > 1 && candidate.pages.size === pageCount)) return null;
    return candidate.jpeg;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  } finally {
    try { await beforeDeadline(loadingTask?.destroy(), Date.now() + 1000); } catch { /* Keep extraction best effort. */ }
  }
}

function uploadedPhotoFile(flow, orderId, document) {
  return photoFilesOf(flow, orderId, document)[0] || null;
}

/** Store one extracted portrait in the order's private document folder. */
export async function prepareCvPortraitDocument({
  bucket,
  orderId,
  order = {},
  draft,
  flow = {},
  cvBuffer = null,
  cvType = null,
  cvKey = null,
  nowMs = Date.now(),
} = {}) {
  const photoDocuments = requiredDocumentsFor(draft, flow)
    .filter((document) => document.required && document.kind === 'photo');
  if (photoDocuments.length !== 1) return null;
  const document = photoDocuments[0];
  if (uploadedPhotoFile(flow, orderId, document)) return null;
  if (!photoFileAccepted(document, { detectedType: 'jpg', size: 1 })) return null;
  if (!bucket?.file || !isAssistedApplicationCvKey(orderId, order.cvStorageKey)) return null;
  if (order.cvFileCheck && (order.cvFileCheck.key !== order.cvStorageKey
    || order.cvFileCheck.verdict !== 'ok' || order.cvFileCheck.detectedType !== 'pdf')) return null;

  // `cvBuffer` may be a tailored CV chosen for the portal. The portrait source
  // must be the candidate's original uploaded CV, whose key is on the order.
  let source = cvBuffer && cvKey === order.cvStorageKey ? Buffer.from(cvBuffer) : null;
  if (!source) {
    const [downloaded] = await bucket.file(order.cvStorageKey).download();
    source = Buffer.from(downloaded || []);
  }
  const detectedSourceType = detectCvFileType(source);
  if (source.length > MAX_CV_SOURCE_BYTES || detectedSourceType !== 'pdf'
    || (cvKey === order.cvStorageKey && cvType && cvType !== detectedSourceType)) return null;
  const maxBytes = Math.min(MAX_PORTAL_PHOTO_BYTES,
    Number.isSafeInteger(document.maxBytes) && document.maxBytes > 0 ? document.maxBytes : MAX_PORTAL_PHOTO_BYTES);
  const extracted = await extractCvPortraitFromPdf(source, { maxBytes });
  if (!extracted || extracted.length > maxBytes) return null;
  const jpeg = extracted;

  const digest = createHash('sha256').update(jpeg).digest('hex');
  const safeId = String(document.id).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30);
  if (!safeId) return null;
  const key = `assisted-application-uploads/${orderId}/doc-${safeId}-0-${digest.slice(0, 8)}.jpg`;
  const object = bucket.file(key);
  const [exists] = typeof object.exists === 'function' ? await object.exists() : [false];
  if (!exists) {
    await object.save(jpeg, {
      contentType: 'image/jpeg',
      resumable: false,
      metadata: { cacheControl: 'private, no-store' },
    });
  }
  return {
    documentId: document.id,
    file: { key, name: 'photo.jpg', size: jpeg.length, detectedType: 'jpg', uploadedAt: nowMs },
    source: 'cv_portrait',
    sourceCvKey: order.cvStorageKey,
  };
}

/** One bounded tick recovery for an old wait on a required portrait. */
export async function recoverCvPortraitForWait({
  bucket,
  orderId,
  order = {},
  draft,
  flow = {},
  nowMs = Date.now(),
} = {}) {
  if (!['candidate_review', 'needs_candidate_action'].includes(flow.state)) return null;
  const photoDocuments = requiredDocumentsFor(draft, flow)
    .filter((document) => document.required && document.kind === 'photo');
  if (photoDocuments.length !== 1) return null;
  const document = photoDocuments[0];
  const hold = `document:${document.id}`;
  if (!(flow.heldBy || []).includes(hold)) return null;
  const sourceCvKey = String(order.cvStorageKey || '');

  const candidatePhoto = uploadedPhotoFile(flow, orderId, document);
  if (candidatePhoto) {
    return {
      documentId: document.id,
      file: null,
      marker: { version: CV_PORTRAIT_RECOVERY_VERSION, documentId: document.id, sourceCvKey, result: 'candidate_photo', attemptedAt: nowMs },
    };
  }
  const prepared = await prepareCvPortraitDocument({ bucket, orderId, order, draft, flow, nowMs });
  return {
    ...(prepared ? { documentId: prepared.documentId, file: prepared.file } : { documentId: document.id, file: null }),
    marker: {
      version: CV_PORTRAIT_RECOVERY_VERSION,
      documentId: document.id,
      sourceCvKey,
      result: prepared ? 'portrait' : 'no_portrait',
      attemptedAt: nowMs,
    },
  };
}
