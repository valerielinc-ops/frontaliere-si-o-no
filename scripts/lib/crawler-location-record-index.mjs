import { buildStableJobIdentity } from './job-identity.mjs';

const AMBIGUOUS_RECORD = Symbol('ambiguous crawler location record');

function normalizeJobId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCrawler(value) {
  return String(value || '').trim();
}

function locationRecord(job, { crawler = '' } = {}) {
  const sourceLocationCanton = String(job.sourceLocationCanton || '').trim().toUpperCase();
  return {
    crawler: normalizeCrawler(crawler),
    canton: String(job.canton || '').trim().toUpperCase(),
    city: String(job.addressLocality || job.location || '').trim(),
    location: String(job.location || '').trim(),
    ...(sourceLocationCanton ? { sourceLocationCanton } : {}),
  };
}

function sameLocationRecord(left, right) {
  const leftSource = left.sourceLocationCanton || '';
  const rightSource = right.sourceLocationCanton || '';
  return left.crawler === right.crawler
    && left.canton === right.canton
    && left.city === right.city
    && left.location === right.location
    && (!leftSource || !rightSource || leftSource === rightSource);
}

function addUniqueRecord(index, key, record) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, record);
    return;
  }

  const previous = index.get(key);
  if (previous !== AMBIGUOUS_RECORD && !sameLocationRecord(previous, record)) {
    index.set(key, AMBIGUOUS_RECORD);
  }
}

function lookupRecord(job, byJobId, byStableIdentity) {
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

  const identity = buildStableJobIdentity(job);
  if (!identity || !byStableIdentity.has(identity)) {
    return { record: null, status: 'missing' };
  }
  const record = byStableIdentity.get(identity);
  return record === AMBIGUOUS_RECORD
    ? { record: null, status: 'ambiguous' }
    : { record, status: 'found' };
}

/**
 * Index crawler location evidence by the per-record ID, with URL identity as
 * a fallback only when it maps consistently to one location record.
 *
 * `crawler` is supplied by the slice loader, rather than inferred from the
 * company name: one crawler can publish several brands and the parser file is
 * the actionable provenance the audit must expose.
 */
export function createCrawlerLocationRecordIndex() {
  const byJobId = new Map();
  const byStableIdentity = new Map();
  let size = 0;

  return {
    add(job, source = {}) {
      if (!job || typeof job !== 'object' || Array.isArray(job)) return;

      const record = locationRecord(job, source);
      if (!record.canton && !record.city) return;
      size += 1;

      addUniqueRecord(byJobId, normalizeJobId(job.id), record);
      addUniqueRecord(byStableIdentity, buildStableJobIdentity(job), record);
    },

    getWithStatus(job) {
      return lookupRecord(job, byJobId, byStableIdentity);
    },

    get(job) {
      return lookupRecord(job, byJobId, byStableIdentity).record;
    },

    get size() {
      return size;
    },
  };
}
