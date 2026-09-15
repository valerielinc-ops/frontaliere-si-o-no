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
import { isGreyGlobe, LOGO_BOT_USER_AGENT } from './google-favicon.mjs';

export const DEFAULT_ASSET_BASE_URL = 'https://cdn.frontaliereticino.ch';
export const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
export const MAX_LOGO_BODY_BYTES = 2 * 1024 * 1024;

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
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (contentLength > MAX_LOGO_BODY_BYTES) return { response, contentType, body: null };
    const body = Buffer.from(await response.arrayBuffer());
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
    const { response, contentType, body } = await fetchLogo(url, options);
    if (!response.ok) {
      return { status: 'broken', reason: `http-${response.status}`, statusCode: response.status, contentType };
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
    return {
      status: 'valid',
      body,
      extension,
      bytes: body.length,
      statusCode: response.status,
      contentType,
      url: response.url || url,
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
    return { status: kind, reference: value, url: null };
  }
  if (kind === 'invalid') {
    return { status: 'broken', reference: value, url: null, reason: 'invalid-logo-reference' };
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
  let status = 'ok';
  if (counts.valid === 0) {
    if (counts.broken > 0 && counts.missing + counts.initials + counts.unverified === 0) status = 'broken';
    else if (counts.unverified > 0 && counts.missing + counts.initials + counts.broken === 0) status = 'unverified';
    else status = 'missing';
  } else if (invalid > 0) {
    status = 'partial';
  }
  return { ...counts, invalid, status };
}

function companyEntry(companyKey, records, counts) {
  const missingRecords = records.filter((r) => r.validation.status === 'missing' || r.validation.status === 'initials');
  const brokenRecords = records.filter((r) => r.validation.status === 'broken');
  const sourceCrawlers = [...new Set(records.map((r) => sourceCrawlerForJob(r.job)).filter(Boolean))].sort();
  return {
    companyKey,
    companyName: mostCommonCompanyName(records, companyKey),
    jobCount: records.length,
    missingJobCount: counts.missing + counts.initials,
    brokenJobCount: counts.broken,
    unverifiedJobCount: counts.unverified,
    affectedJobCount: counts.invalid,
    status: counts.status,
    exampleUrl: firstExample(records, (r) => r.job?.url) || null,
    examples: {
      missing: firstExample(missingRecords, (r) => r.job?.url),
      broken: firstExample(brokenRecords, (r) => r.job?.url),
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
    (reference) => reference.status === 'broken' || reference.status === 'unverified',
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
    partialJobCount: partialCompanies.reduce((sum, c) => sum + c.affectedJobCount, 0),
    unverified: unverifiedCompanies.length,
    unverifiedJobCount: unverifiedCompanies.reduce((sum, c) => sum + c.affectedJobCount, 0),
    referenceCount: checkedReferences.length,
    validReferenceCount: checkedReferences.filter((reference) => reference.status === 'valid').length,
    affectedCompanies: affectedCompanies,
    companies: noLogoCompanies,
    brokenCompanies,
    partialCompanies,
    unverifiedCompanies,
    references: problemReferences,
  };
}
