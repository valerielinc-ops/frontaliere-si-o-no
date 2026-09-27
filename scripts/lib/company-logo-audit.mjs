/**
 * Shared company-logo audit primitives.
 *
 * The audit must inspect the same canonical job population that the site
 * builds and the same resolver that the SPA/static card renderer uses.  It
 * deliberately does not fall back to crawler slices: an empty or truncated
 * canonical dataset is a failed audit, not a zero-logo result.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readBoundedResponseBytes } from './bounded-response-body.mjs';
import { isGreyGlobe, LOGO_BOT_USER_AGENT } from './google-favicon.mjs';

export const DEFAULT_ASSET_BASE_URL = 'https://cdn.frontaliereticino.ch';
export const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
export const MAX_LOGO_BODY_BYTES = 2 * 1024 * 1024;
// The largest rendered employer-logo slot is 80px. Keep a small source-size
// buffer so raster logos are not served at (or above) their native resolution.
export const MIN_LOGO_QUALITY_DIMENSION_PX = 96;

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function companyKeyForJob(job) {
  return String(job?.companyKey || '').trim()
    || slugify(job?.company || job?.employer || '');
}

export function extractJobs(value, sourcePath = '') {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.jobs)) return value.jobs;
  throw new Error(`Canonical job dataset must be an array or { jobs: [] }: ${sourcePath}`);
}

/**
 * Load the assembled dataset.  `data/jobs.json` is the pre-build canonical
 * input; `public/data/jobs.json` is accepted for replay/audit environments.
 * A present-but-invalid file is fatal and never silently falls through.
 */
export async function loadCanonicalJobs({ root, file, minJobs = 1 } = {}) {
  const repoRoot = path.resolve(root || process.cwd());
  const candidates = file
    ? [path.resolve(repoRoot, file)]
    : [
      path.join(repoRoot, 'data', 'jobs.json'),
      path.join(repoRoot, 'public', 'data', 'jobs.json'),
    ];

  let selected = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      selected = candidate;
      break;
    }
  }
  if (!selected) {
    throw new Error(
      `Canonical job dataset not found. Run scripts/assemble-jobs-dataset.mjs first `
      + `(looked in ${candidates.join(', ')}).`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(selected, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse canonical job dataset ${selected}: ${error.message}`);
  }
  const jobs = extractJobs(parsed, selected);
  if (jobs.length < minJobs) {
    throw new Error(
      `Canonical job dataset is unexpectedly small: ${jobs.length} jobs (minimum ${minJobs}) in ${selected}.`,
    );
  }
  return { jobs, sourcePath: selected };
}

export function classifyLogoReference(resolved) {
  const value = typeof resolved === 'string' ? resolved.trim() : '';
  if (!value) return { kind: 'missing', reference: null };
  if (value.startsWith('data:image/')) return { kind: 'initials', reference: value };
  if (value.startsWith('/')) return { kind: 'local', reference: value };
  if (/^https?:\/\//i.test(value)) return { kind: 'external', reference: value };
  return { kind: 'invalid', reference: value };
}

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

function detectImageFormat(body) {
  if (!body || body.length < 4) return false;
  const sig = body.subarray(0, 8);
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) return 'png';
  if (sig[0] === 0xff && sig[1] === 0xd8) return 'jpg';
  if (sig[0] === 0x47 && sig[1] === 0x49 && sig[2] === 0x46) return 'gif';
  if (sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46) return 'webp';
  if (sig[0] === 0x00 && sig[1] === 0x00 && sig[2] === 0x01 && sig[3] === 0x00) return 'ico';
  const head = body.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<svg') || head.startsWith('<?xml') ? 'svg' : null;
}

function readUInt24LE(body, offset) {
  return body[offset] | (body[offset + 1] << 8) | (body[offset + 2] << 16);
}

function readSvgLength(value) {
  const match = String(value || '').match(/^\s*([0-9]+(?:\.[0-9]+)?)/);
  const number = match ? Number(match[1]) : 0;
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readSvgDimensions(body) {
  const root = body.subarray(0, 16 * 1024).toString('utf8').match(/<svg\b[^>]*>/i)?.[0] || '';
  const viewBox = root.match(/\bviewBox\s*=\s*["']\s*[-+0-9.e]+\s+[-+0-9.e]+\s+([-+0-9.e]+)\s+([-+0-9.e]+)\s*["']/i);
  if (viewBox) {
    const width = Number(viewBox[1]);
    const height = Number(viewBox[2]);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height };
    }
  }
  return {
    width: readSvgLength(root.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1]),
    height: readSvgLength(root.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1]),
  };
}

function readJpegDimensions(body) {
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < body.length) {
    while (offset < body.length && body[offset] === 0xff) offset++;
    if (offset >= body.length) break;
    const marker = body[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 1 >= body.length) break;
    const segmentLength = body.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > body.length) break;
    const isSof = [
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ].includes(marker);
    if (isSof && segmentLength >= 7) {
      return {
        width: body.readUInt16BE(offset + 5),
        height: body.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }
  return null;
}

/**
 * Read intrinsic dimensions without trusting the response MIME type. SVG is
 * treated as vector content even when it has no explicit width/height.
 */
export function readImageDimensions(body, format = detectImageFormat(body)) {
  if (!body || body.length === 0) return null;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (format === 'svg') return { ...readSvgDimensions(bytes), vector: true };
  if (format === 'png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), vector: false };
  }
  if (format === 'gif' && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), vector: false };
  }
  if (format === 'jpg') return { ...readJpegDimensions(bytes), vector: false };
  if (format === 'webp' && bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return {
        width: 1 + readUInt24LE(bytes, 24),
        height: 1 + readUInt24LE(bytes, 27),
        vector: false,
      };
    }
    if (chunk === 'VP8L' && bytes.length >= 26 && bytes[20] === 0x2f) {
      return {
        width: 1 + (bytes[21] | (bytes[22] << 8) | ((bytes[23] & 0x3f) << 16)),
        height: 1 + ((bytes[23] >> 6) | (bytes[24] << 2) | ((bytes[25] & 0x0f) << 10)),
        vector: false,
      };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30
      && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
        vector: false,
      };
    }
  }
  if (format === 'ico' && bytes.length >= 8) {
    const imageCount = bytes.readUInt16LE(4);
    let largest = null;
    for (let index = 0; index < imageCount; index++) {
      const entryOffset = 6 + index * 16;
      if (entryOffset + 2 > bytes.length) break;
      const width = bytes[entryOffset] || 256;
      const height = bytes[entryOffset + 1] || 256;
      if (!largest || Math.max(width, height) > Math.max(largest.width, largest.height)) {
        largest = { width, height };
      }
    }
    if (largest) return { ...largest, vector: false };
  }
  return null;
}

export function assessLogoQuality({ format, width, height, vector = false } = {}) {
  if (format === 'svg' || vector) return { status: 'good', reason: 'vector' };
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return { status: 'unverified', reason: 'dimensions-unavailable' };
  }
  const maxDimension = Math.max(width, height);
  if (maxDimension < MIN_LOGO_QUALITY_DIMENSION_PX) {
    return {
      status: 'low-quality',
      reason: 'intrinsic-dimensions-too-small',
      width,
      height,
      maxDimension,
    };
  }
  return { status: 'good', reason: 'intrinsic-dimensions-ok', width, height, maxDimension };
}

export function detectLogoExtension(body, contentType = '') {
  const format = detectImageFormat(body);
  if (!format) return null;
  return MIME_EXT[String(contentType || '').split(';')[0].trim().toLowerCase()] || format;
}

async function fetchLogo(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  accept = 'image/*,*/*;q=0.8',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: accept,
        'User-Agent': LOGO_BOT_USER_AGENT,
      },
      signal: controller.signal,
    });
    const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim();
    if (!response.ok) return { response, contentType, body: null };
    // The cap is applied while the body streams: `arrayBuffer()` and a size
    // check afterwards would download a chunked response in full first (#9729).
    const bytes = await readBoundedResponseBytes(response, MAX_LOGO_BODY_BYTES);
    if (bytes === null) return { response, contentType, body: null, tooLarge: true };
    const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { response, contentType, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and validate an image, returning its bytes for downloaders or a
 * structured failure for probes. Validation is signature-based: MIME alone
 * is not trusted because job/ATS endpoints occasionally label HTML as an
 * image.
 */
export async function fetchVerifiedLogo(url, options = {}) {
  try {
    const { response, contentType, body, tooLarge } = await fetchLogo(url, options);
    if (!response.ok) {
      return { status: 'broken', reason: `http-${response.status}`, statusCode: response.status, contentType };
    }
    if (tooLarge) {
      return { status: 'broken', reason: 'body-too-large', statusCode: response.status, contentType };
    }
    if (!body || body.length === 0) {
      return { status: 'broken', reason: 'empty-body', statusCode: response.status, contentType };
    }
    if (body.length > MAX_LOGO_BODY_BYTES) {
      return { status: 'broken', reason: 'body-too-large', statusCode: response.status, contentType };
    }
    if (isGreyGlobe(body)) {
      return { status: 'broken', reason: 'grey-globe', statusCode: response.status, contentType };
    }
    const extension = detectLogoExtension(body, contentType);
    if (!extension) {
      return { status: 'broken', reason: 'not-an-image', statusCode: response.status, contentType };
    }
    const format = detectImageFormat(body);
    const dimensions = readImageDimensions(body, format);
    const quality = assessLogoQuality({ format, ...dimensions });
    return {
      status: 'valid',
      body,
      extension,
      bytes: body.length,
      statusCode: response.status,
      contentType,
      url: response.url || url,
      width: dimensions?.width || null,
      height: dimensions?.height || null,
      qualityStatus: quality.status,
      qualityReason: quality.reason,
    };
  } catch (error) {
    return {
      status: 'broken',
      reason: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error),
      statusCode: 0,
    };
  }
}

function buildCheckUrl(reference, assetBaseUrl) {
  if (reference.kind === 'local') {
    const base = trimTrailingSlash(assetBaseUrl);
    if (!base) return null;
    return `${base}${reference.reference}`;
  }
  return reference.reference;
}

export async function validateLogoReference(reference, options = {}) {
  const { kind, reference: value } = reference;
  if (kind === 'missing' || kind === 'initials') {
    return { status: kind, reference: value, url: null, qualityStatus: 'not-applicable' };
  }
  if (kind === 'invalid') {
    return {
      status: 'broken',
      reference: value,
      url: null,
      reason: 'invalid-logo-reference',
      qualityStatus: 'not-applicable',
    };
  }

  const assetBaseUrl = options.assetBaseUrl === undefined
    ? DEFAULT_ASSET_BASE_URL
    : options.assetBaseUrl;
  const url = buildCheckUrl(reference, assetBaseUrl);
  if (!url) {
    return { status: 'unverified', reference: value, url: null, reason: 'asset-base-url-not-configured' };
  }

  try {
    const result = await fetchVerifiedLogo(url, options);
    if (result.status !== 'valid') return { ...result, reference: value, url };
    return {
      status: 'valid',
      reference: value,
      url,
      statusCode: result.statusCode,
      contentType: result.contentType,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      qualityStatus: result.qualityStatus,
      qualityReason: result.qualityReason,
    };
  } catch (error) {
    return { status: 'broken', reference: value, url, reason: String(error?.message || error), statusCode: 0 };
  }
}

function sourceCrawlerForJob(job) {
  return String(job?.__crawlerKey || job?.crawlerKey || job?.sourceCrawler || '').trim();
}

function mostCommonCompanyName(records, fallback) {
  const counts = new Map();
  for (const record of records) {
    const name = String(record.job?.company || record.job?.employer || '').trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || fallback;
}

function firstExample(records, predicate) {
  return records.find(predicate)?.job?.url || null;
}

function statusForRecords(records) {
  const counts = { valid: 0, missing: 0, initials: 0, broken: 0, unverified: 0 };
  for (const record of records) counts[record.validation.status] = (counts[record.validation.status] || 0) + 1;
  const invalid = counts.missing + counts.initials + counts.broken + counts.unverified;
  const qualityCounts = { goodQuality: 0, lowQuality: 0, qualityUnverified: 0 };
  for (const record of records) {
    if (record.validation.qualityStatus === 'good') qualityCounts.goodQuality++;
    if (record.validation.qualityStatus === 'low-quality') qualityCounts.lowQuality++;
    if (record.validation.qualityStatus === 'unverified') qualityCounts.qualityUnverified++;
  }
  const qualityMeasured = qualityCounts.goodQuality + qualityCounts.lowQuality + qualityCounts.qualityUnverified > 0;
  const qualityInvalid = qualityCounts.lowQuality + qualityCounts.qualityUnverified;
  const qualityStatus = !qualityMeasured
    ? 'not-applicable'
    : qualityCounts.lowQuality > 0
      ? 'low-quality'
      : qualityCounts.qualityUnverified > 0
        ? 'unverified'
        : 'ok';
  let coverageStatus = 'ok';
  if (counts.valid === 0) {
    if (counts.broken > 0 && counts.missing + counts.initials + counts.unverified === 0) coverageStatus = 'broken';
    else if (counts.unverified > 0 && counts.missing + counts.initials + counts.broken === 0) coverageStatus = 'unverified';
    else coverageStatus = 'missing';
  } else if (invalid > 0) {
    coverageStatus = 'partial';
  }
  const status = coverageStatus !== 'ok'
    ? coverageStatus
    : qualityStatus === 'low-quality'
      ? 'low-quality'
      : qualityStatus === 'unverified'
        ? 'quality-unverified'
        : 'ok';
  return {
    ...counts,
    invalid,
    qualityStatus,
    ...qualityCounts,
    qualityInvalid,
    affectedJobCount: invalid + qualityInvalid,
    status,
  };
}

function companyEntry(companyKey, records, counts) {
  const missingRecords = records.filter((r) => r.validation.status === 'missing' || r.validation.status === 'initials');
  const brokenRecords = records.filter((r) => r.validation.status === 'broken');
  const lowQualityRecords = records.filter((r) => r.validation.qualityStatus === 'low-quality');
  const qualityUnverifiedRecords = records.filter((r) => r.validation.qualityStatus === 'unverified');
  const sourceCrawlers = [...new Set(records.map((r) => sourceCrawlerForJob(r.job)).filter(Boolean))].sort();
  return {
    companyKey,
    companyName: mostCommonCompanyName(records, companyKey),
    jobCount: records.length,
    missingJobCount: counts.missing + counts.initials,
    brokenJobCount: counts.broken,
    unverifiedJobCount: counts.unverified,
    lowQualityJobCount: counts.lowQuality,
    qualityUnverifiedJobCount: counts.qualityUnverified,
    qualityAffectedJobCount: counts.qualityInvalid,
    invalid: counts.invalid,
    affectedJobCount: counts.affectedJobCount,
    status: counts.status,
    qualityStatus: counts.qualityStatus,
    exampleUrl: firstExample(records, (r) => r.job?.url) || null,
    examples: {
      missing: firstExample(missingRecords, (r) => r.job?.url),
      broken: firstExample(brokenRecords, (r) => r.job?.url),
      lowQuality: firstExample(lowQualityRecords, (r) => r.job?.url),
      qualityUnverified: firstExample(qualityUnverifiedRecords, (r) => r.job?.url),
    },
    sourceCrawlers,
  };
}

/**
 * Resolve and probe every unique logo reference, then aggregate by company.
 * `resolveLogo` is injected so both production scripts use the real TS
 * resolver while this module remains directly testable under Node.
 */
export async function auditCompanyLogos(jobs, {
  resolveLogo,
  assetBaseUrl = DEFAULT_ASSET_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  if (typeof resolveLogo !== 'function') throw new Error('auditCompanyLogos requires resolveLogo(job)');
  const groups = new Map();
  const references = new Map();

  for (const job of jobs) {
    const companyKey = companyKeyForJob(job);
    if (!companyKey) continue;
    if (!groups.has(companyKey)) groups.set(companyKey, []);
    let resolved;
    try {
      resolved = resolveLogo(job);
    } catch (error) {
      throw new Error(`Logo resolver failed for ${companyKey}: ${error.message}`);
    }
    const reference = classifyLogoReference(resolved);
    const refKey = reference.reference || `missing:${companyKey}`;
    if (!references.has(refKey)) {
      references.set(refKey, {
        ...reference,
        jobs: 0,
        companyKeys: new Set(),
      });
    }
    const refRecord = references.get(refKey);
    refRecord.jobs += 1;
    refRecord.companyKeys.add(companyKey);
    groups.get(companyKey).push({ job, resolved, reference, validation: null });
  }

  const validationCache = new Map();
  const refRecords = [...references.values()];
  let cursor = 0;
  const validateWorker = async () => {
    while (cursor < refRecords.length) {
      const refRecord = refRecords[cursor++];
      const cacheKey = refRecord.reference || `missing:${[...refRecord.companyKeys][0]}`;
      if (!validationCache.has(cacheKey)) {
        validationCache.set(cacheKey, await validateLogoReference(refRecord, {
          assetBaseUrl,
          fetchImpl,
          timeoutMs,
        }));
      }
      refRecord.validation = validationCache.get(cacheKey);
    }
  };
  await Promise.all(Array.from({ length: 20 }, validateWorker));

  const companies = [];
  for (const [companyKey, records] of groups) {
    for (const record of records) {
      const refKey = record.reference.reference || `missing:${companyKey}`;
      record.validation = validationCache.get(refKey);
    }
    const counts = statusForRecords(records);
    companies.push(companyEntry(companyKey, records, counts));
  }
  companies.sort((a, b) => b.affectedJobCount - a.affectedJobCount || a.companyKey.localeCompare(b.companyKey));

  const noLogoCompanies = companies.filter((c) => c.status === 'missing');
  const brokenCompanies = companies.filter((c) => c.status === 'broken');
  const partialCompanies = companies.filter((c) => c.status === 'partial');
  const unverifiedCompanies = companies.filter((c) => c.status === 'unverified');
  const lowQualityCompanies = companies.filter((c) => c.lowQualityJobCount > 0);
  const qualityUnverifiedCompanies = companies.filter((c) => c.qualityUnverifiedJobCount > 0);
  const affectedCompanies = companies.filter((c) => c.status !== 'ok');
  const referencesOutput = [...references.values()].map((r) => ({
    reference: r.reference,
    kind: r.kind,
    jobs: r.jobs,
    companyKeys: [...r.companyKeys].sort(),
    ...r.validation,
  }))
    .sort((a, b) => String(a.url || a.reference).localeCompare(String(b.url || b.reference)));
  const problemReferences = referencesOutput.filter(
    (reference) => reference.status === 'broken'
      || reference.status === 'unverified'
      || reference.qualityStatus === 'low-quality'
      || reference.qualityStatus === 'unverified',
  );
  const checkedReferences = referencesOutput.filter(
    (reference) => reference.kind === 'local'
      || reference.kind === 'external'
      || reference.kind === 'invalid',
  );

  return {
    companiesTotal: companies.length,
    withLogo: companies.filter((c) => c.status === 'ok').length,
    missing: noLogoCompanies.length,
    missingJobCount: noLogoCompanies.reduce((sum, c) => sum + c.missingJobCount, 0),
    broken: brokenCompanies.length,
    brokenJobCount: brokenCompanies.reduce((sum, c) => sum + c.brokenJobCount, 0),
    partial: partialCompanies.length,
    partialJobCount: partialCompanies.reduce((sum, c) => sum + c.invalid, 0),
    unverified: unverifiedCompanies.length,
    unverifiedJobCount: unverifiedCompanies.reduce((sum, c) => sum + c.invalid, 0),
    lowQuality: lowQualityCompanies.length,
    lowQualityJobCount: lowQualityCompanies.reduce((sum, c) => sum + c.lowQualityJobCount, 0),
    qualityUnverified: qualityUnverifiedCompanies.length,
    qualityUnverifiedJobCount: qualityUnverifiedCompanies.reduce((sum, c) => sum + c.qualityUnverifiedJobCount, 0),
    referenceCount: checkedReferences.length,
    validReferenceCount: checkedReferences.filter((reference) => reference.status === 'valid').length,
    qualityOkReferenceCount: checkedReferences.filter((reference) => reference.qualityStatus === 'good').length,
    affectedCompanies: affectedCompanies,
    companies: noLogoCompanies,
    brokenCompanies,
    partialCompanies,
    unverifiedCompanies,
    lowQualityCompanies,
    qualityUnverifiedCompanies,
    references: problemReferences,
  };
}
