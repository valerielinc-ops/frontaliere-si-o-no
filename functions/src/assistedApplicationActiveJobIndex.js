/** Published site's exact active-job membership contract for refund corroboration. */
export const ACTIVE_JOB_IDS_FILE_NAME = 'jobs-active-ids.json';
export const JOB_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
export const ACTIVE_JOB_INDEX_SCHEMA_VERSION = 1;

export const MAX_ACTIVE_JOB_INDEX_BYTES = 1_000_000;
const MAX_JOB_IDS = 100_000;
const MAX_INDEX_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** @param {Array<{id?: unknown, slug?: unknown}>} jobs */
export function buildActiveJobIdIndex(jobs, generatedAt = new Date().toISOString()) {
  const ids = [...new Set((Array.isArray(jobs) ? jobs : []).map((job) => {
    const id = typeof job?.id === 'string' ? job.id.trim() : '';
    const slug = typeof job?.slug === 'string' ? job.slug.trim() : '';
    return id || slug;
  }).filter(Boolean))].sort();

  return {
    schemaVersion: ACTIVE_JOB_INDEX_SCHEMA_VERSION,
    generatedAt,
    total: ids.length,
    ids,
  };
}

/**
 * Parse only a complete, recent index. Returning null means the caller must
 * fail closed and must not infer that a posting left the published inventory.
 * @param {ArrayBuffer | Uint8Array} bytes
 * @param {number} [nowMs]
 * @returns {Set<string> | null}
 */
export function parseActiveJobIdIndex(bytes, nowMs = Date.now()) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength === 0 || data.byteLength > MAX_ACTIVE_JOB_INDEX_BYTES) return null;

  let index;
  try {
    index = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
  if (index?.schemaVersion !== ACTIVE_JOB_INDEX_SCHEMA_VERSION || !Array.isArray(index.ids)
    || !Number.isSafeInteger(index.total) || index.total === 0 || index.total !== index.ids.length
    || index.ids.length > MAX_JOB_IDS) return null;

  const generatedAt = Date.parse(index.generatedAt);
  const ageMs = nowMs - generatedAt;
  if (!Number.isFinite(generatedAt) || ageMs < -MAX_FUTURE_SKEW_MS || ageMs > MAX_INDEX_AGE_MS) return null;
  if (!index.ids.every((id) => typeof id === 'string' && JOB_ID_RE.test(id)
    && id.trim() === id)) return null;

  const ids = new Set(index.ids);
  if (ids.size !== index.ids.length) return null;
  return ids;
}
