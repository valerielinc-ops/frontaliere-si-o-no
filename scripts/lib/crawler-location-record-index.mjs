import { buildStableJobIdentity } from './job-identity.mjs';

const AMBIGUOUS_RECORD = Symbol('ambiguous crawler location record');

function normalizeJobId(value) {
  return String(value || '').trim().toLowerCase();
}

function locationRecord(job) {
  return {
    canton: String(job.canton || '').trim().toUpperCase(),
    city: String(job.addressLocality || job.location || '').trim(),
    location: String(job.location || '').trim(),
  };
}

function sameLocationRecord(left, right) {
  return left.canton === right.canton
    && left.city === right.city
    && left.location === right.location;
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
 */
export function createCrawlerLocationRecordIndex() {
  const byJobId = new Map();
  const byStableIdentity = new Map();
  let size = 0;

  return {
    add(job) {
      if (!job || typeof job !== 'object' || Array.isArray(job)) return;

      const record = locationRecord(job);
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
