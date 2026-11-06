import { buildStableJobIdentity } from './job-identity.mjs';
import { extractStableJobId } from './job-match-key.mjs';

const AMBIGUOUS_RECORD = Symbol('ambiguous crawler location record');

function normalizeJobId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCrawler(value) {
  return String(value || '').trim();
}

function sourceOrigin(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return '';
    return parsed.origin.toLowerCase();
  } catch {
    return '';
  }
}

function sourceJobId(job) {
  for (const field of ['externalId', 'sourceJobId', 'jobId', 'sourceId', 'identifier']) {
    const value = String(job?.[field] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function sourceIdentity(job) {
  const sourceUrl = String(job?.url || '').trim();
  const stableIdFromUrl = extractStableJobId(sourceUrl);
  const explicitSourceJobId = sourceJobId(job);
  return {
    sourceUrl,
    sourceStableId: stableIdFromUrl || (explicitSourceJobId ? `id:${normalizeJobId(explicitSourceJobId)}` : ''),
    sourceJobId: explicitSourceJobId || (stableIdFromUrl.startsWith('num:') ? stableIdFromUrl.slice(4) : ''),
  };
}

function sourceStableIndexKey(identity) {
  const stableId = String(identity?.sourceStableId || '').trim();
  if (!stableId) return '';
  // `extractStableJobId()` deliberately returns hostless numeric keys; keep
  // separate source origins from collapsing into one collision bucket.
  const origin = sourceOrigin(identity?.sourceUrl || '');
  return origin ? `${origin}|${stableId}` : stableId;
}

function locationRecord(job, { crawler = '', includeProvenance = false } = {}, identity = sourceIdentity(job)) {
  const sourceLocationCanton = String(job.sourceLocationCanton || '').trim().toUpperCase();
  const record = {
    crawler: normalizeCrawler(crawler),
    canton: String(job.canton || '').trim().toUpperCase(),
    city: String(job.addressLocality || job.location || '').trim(),
    location: String(job.location || '').trim(),
    ...(sourceLocationCanton ? { sourceLocationCanton } : {}),
  };

  if (!includeProvenance) return record;

  const sourceUrl = String(job.url || '').trim();
  return {
    ...record,
    sourceStableId: identity.sourceStableId,
    sourceJobId: identity.sourceJobId,
    sourceUrl,
    sourceRegion: String(job.addressRegion || job.region || '').trim(),
    sourcePostalCode: String(job.postalCode || '').trim(),
  };
}

function sameLocationRecord(left, right, leftIdentity = {}, rightIdentity = {}) {
  const leftSource = left.sourceLocationCanton || '';
  const rightSource = right.sourceLocationCanton || '';
  const leftSourceStableId = leftIdentity.sourceStableId || left.sourceStableId || '';
  const rightSourceStableId = rightIdentity.sourceStableId || right.sourceStableId || '';
  const leftSourceUrl = leftIdentity.sourceUrl || left.sourceUrl || '';
  const rightSourceUrl = rightIdentity.sourceUrl || right.sourceUrl || '';
  const leftSourceJobId = leftIdentity.sourceJobId || left.sourceJobId || '';
  const rightSourceJobId = rightIdentity.sourceJobId || right.sourceJobId || '';
  const sameSourceStableId = leftSourceStableId && rightSourceStableId
    ? leftSourceStableId === rightSourceStableId
    : (!leftSourceUrl || !rightSourceUrl || leftSourceUrl === rightSourceUrl);
  const sameSourceJobId = !leftSourceJobId || !rightSourceJobId
    || normalizeJobId(leftSourceJobId) === normalizeJobId(rightSourceJobId);
  return left.crawler === right.crawler
    && left.canton === right.canton
    && left.city === right.city
    && left.location === right.location
    && (!leftSource || !rightSource || leftSource === rightSource)
    && sameSourceStableId
    && sameSourceJobId;
}

function addUniqueRecord(index, key, record, identityByRecord) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, record);
    return;
  }

  const previous = index.get(key);
  if (previous !== AMBIGUOUS_RECORD && !sameLocationRecord(
    previous,
    record,
    identityByRecord.get(previous),
    identityByRecord.get(record),
  )) {
    index.set(key, AMBIGUOUS_RECORD);
  }
}

function lookupRecord(job, byJobId, bySourceStableId, byStableIdentity, identityByRecord) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return { record: null, status: 'missing' };
  }

  const jobId = normalizeJobId(job.id);
  if (jobId && byJobId.has(jobId)) {
    const record = byJobId.get(jobId);
    return record === AMBIGUOUS_RECORD
      ? { record: null, status: 'ambiguous' }
      : { record, status: 'found' };
  }

  const sourceIdentityValue = sourceIdentity(job);
  const sourceStableKey = sourceStableIndexKey(sourceIdentityValue);
  if (sourceStableKey && bySourceStableId.has(sourceStableKey)) {
    const record = bySourceStableId.get(sourceStableKey);
    if (record === AMBIGUOUS_RECORD) return { record: null, status: 'ambiguous' };

    const indexedIdentity = identityByRecord.get(record);
    const indexedSourceJobId = indexedIdentity?.sourceJobId || record.sourceJobId || '';
    const targetSourceJobId = sourceIdentityValue.sourceJobId || '';
    if (indexedSourceJobId && targetSourceJobId
      && normalizeJobId(indexedSourceJobId) !== normalizeJobId(targetSourceJobId)) {
      return { record: null, status: 'ambiguous' };
    }
    return { record, status: 'found' };
  }

  const stableIdentity = buildStableJobIdentity(job);
  if (!stableIdentity || !byStableIdentity.has(stableIdentity)) {
    return { record: null, status: 'missing' };
  }
  const record = byStableIdentity.get(stableIdentity);
  return record === AMBIGUOUS_RECORD
    ? { record: null, status: 'ambiguous' }
    : { record, status: 'found' };
}

/**
 * Index crawler location evidence by the per-record ID, with source-stable and
 * URL identities as fallbacks only when they map consistently to one record.
 *
 * `crawler` is supplied by the slice loader, rather than inferred from the
 * company name: one crawler can publish several brands and the parser file is
 * the actionable provenance the audit must expose.
 */
export function createCrawlerLocationRecordIndex({ includeProvenance = false } = {}) {
  const byJobId = new Map();
  const bySourceStableId = new Map();
  const byStableIdentity = new Map();
  const identityByRecord = new WeakMap();
  let size = 0;

  return {
    add(job, source = {}) {
      if (!job || typeof job !== 'object' || Array.isArray(job)) return;

      const identity = sourceIdentity(job);
      const record = locationRecord(job, { ...source, includeProvenance }, identity);
      if (!record.canton && !record.city) return;
      size += 1;

      // Keep source identity metadata available for collision checks even when
      // the caller does not request provenance fields on the returned record.
      identityByRecord.set(record, identity);
      addUniqueRecord(byJobId, normalizeJobId(job.id), record, identityByRecord);
      addUniqueRecord(bySourceStableId, sourceStableIndexKey(identity), record, identityByRecord);
      addUniqueRecord(byStableIdentity, buildStableJobIdentity(job), record, identityByRecord);
    },

    getWithStatus(job) {
      return lookupRecord(job, byJobId, bySourceStableId, byStableIdentity, identityByRecord);
    },

    get(job) {
      return lookupRecord(job, byJobId, bySourceStableId, byStableIdentity, identityByRecord).record;
    },

    get size() {
      return size;
    },
  };
}
