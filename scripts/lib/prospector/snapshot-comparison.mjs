import { createHash } from 'node:crypto';

const ALIGNMENT_WINDOW_MS = 6 * 60 * 60 * 1000;

function identityValue(row) {
  const value = row?.url || row?.sourceUrl || row?.id || row?.externalId || '';
  if (!value) return '';
  try {
    const url = new URL(String(value));
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return String(value).trim().toLowerCase();
  }
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function idsFor(rows) {
  return [...new Set((Array.isArray(rows) ? rows : [])
    .map(identityValue).filter(Boolean).map(shortHash))].sort();
}

function fingerprint(ids) {
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 24);
}

/** Persist hashed stable identities so later comparisons do not expose full URL inventories. */
export function createValidationSnapshot(rows, observedAt = new Date().toISOString()) {
  const ids = idsFor(rows);
  return {
    observedAt,
    rowCount: Array.isArray(rows) ? rows.length : 0,
    uniqueIdentityCount: ids.length,
    ids,
    fingerprint: fingerprint(ids),
  };
}

/** Compare validation and public crawler output only when their timestamps align. */
export function comparePublicationSnapshots(validationSnapshot, publishedSlice) {
  const base = {
    classification: 'unmeasured',
    validationAt: validationSnapshot?.observedAt || null,
    publishedAt: publishedSlice?.assembledAt || null,
    validationCount: Number(validationSnapshot?.rowCount) || 0,
    publishedCount: Array.isArray(publishedSlice?.jobs) ? publishedSlice.jobs.length : 0,
    shared: null,
    validationOnly: null,
    publishedOnly: null,
    deltaHours: null,
  };
  if (!publishedSlice) return { ...base, classification: 'missing', reason: 'published_slice_missing' };
  if (!Array.isArray(validationSnapshot?.ids) || !Array.isArray(publishedSlice.jobs)
    || Number(validationSnapshot?.rowCount) === 0) {
    return { ...base, reason: 'snapshot_ids_unavailable' };
  }
  const validationAt = Date.parse(String(validationSnapshot.observedAt || ''));
  const publishedAt = Date.parse(String(publishedSlice.assembledAt || ''));
  if (!Number.isFinite(validationAt) || !Number.isFinite(publishedAt)) {
    return { ...base, reason: 'snapshot_timestamp_unavailable' };
  }
  const deltaMs = Math.abs(validationAt - publishedAt);
  const validationIds = new Set(validationSnapshot.ids);
  const publishedIds = new Set(idsFor(publishedSlice.jobs));
  let shared = 0;
  for (const id of validationIds) if (publishedIds.has(id)) shared++;
  const counts = {
    shared,
    validationOnly: Math.max(0, validationIds.size - shared),
    publishedOnly: Math.max(0, publishedIds.size - shared),
    deltaHours: Number((deltaMs / 3_600_000).toFixed(2)),
  };
  if (deltaMs > ALIGNMENT_WINDOW_MS) {
    return { ...base, ...counts, classification: 'near_time_delta', reason: 'snapshots_more_than_6h_apart' };
  }
  return {
    ...base,
    ...counts,
    classification: counts.validationOnly === 0 && counts.publishedOnly === 0 ? 'matched' : 'different_snapshot',
    reason: null,
  };
}
