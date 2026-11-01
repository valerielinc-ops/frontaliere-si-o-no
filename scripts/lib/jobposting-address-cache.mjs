import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_JOBPOSTING_ADDRESS_CACHE = 'data/prospector/jobposting-address-cache.json';
export const JOBPOSTING_ADDRESS_CACHE_TTL_MS = 180 * 86_400_000;

export function normalizeCompanyAddressKeyPart(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function jobpostingAddressCacheKey(companyName, locality, region) {
  const name = normalizeCompanyAddressKeyPart(companyName);
  const city = normalizeCompanyAddressKeyPart(locality);
  const canton = String(region ?? '').trim().toUpperCase();
  if (!name || !city || !/^[A-Z]{2}$/.test(canton)) return '';
  return `${name}|${city}|${canton}`;
}

/** Load the reusable Zefix/LINDAS lookup cache once at a crawler write boundary. */
export function readJobpostingAddressCache({ root = process.cwd(), filePath } = {}) {
  const resolvedPath = filePath
    ? path.resolve(root, filePath)
    : path.resolve(root, DEFAULT_JOBPOSTING_ADDRESS_CACHE);
  try {
    const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8'));
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return {};
    return parsed.entries;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Unable to read JobPosting address cache ${resolvedPath}: ${error.message}`);
  }
}

/**
 * Attach only a cache record whose employer, city, canton and address all match
 * the job key. The source's registered seat is never projected into another
 * city merely because the employer name matches.
 */
export function cachedRegisteredCompanyAddress(job, cache = {}) {
  const locality = job?.addressLocality || job?.city || job?.location;
  const region = job?.addressRegion || job?.canton;
  const key = jobpostingAddressCacheKey(job?.company, locality, region);
  if (!key) return null;
  const entry = cache?.[key];
  if (!entry || entry.status !== 'matched' || entry.source !== 'zefix-lindas') return null;
  const checkedAt = Date.parse(String(entry.checkedAt || ''));
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > JOBPOSTING_ADDRESS_CACHE_TTL_MS) return null;
  if (!String(entry.streetAddress ?? '').trim() || !String(entry.addressLocality ?? '').trim()) return null;
  if (jobpostingAddressCacheKey(entry.companyName, entry.addressLocality, entry.addressRegion) !== key) return null;
  return entry;
}
