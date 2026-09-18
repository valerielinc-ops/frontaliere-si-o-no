import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Version 3 adds the optional jobs-emitter fingerprint to the header.  A
// fingerprint mismatch invalidates the whole post-walk delta, so an old
// snapshot must fail closed into the existing full pass instead of being
// compared entry by entry.
export const MANIFEST_VERSION = 3;
export const MANIFEST_FORMAT = 'jsonl';
export const SOURCE_VERSION = 'input@1';
// The emitter fingerprint includes this value. Bumping it makes the first
// build after a change to the canonical job digest/input shape miss old HTML
// reuse entries even when the page input happens to hash identically.
// job-digest@3: active pages hash the six rendered related jobs plus a compact
// full-pool membership signature; full-content bridge pages reference the
// canonical active input hash instead of re-hashing the source record/pool.
// The reusable job-page input now carries the UTC build-day bucket used by
// deterministic JobPosting fallbacks. Bump the digest contract explicitly so
// manifests produced before that field cannot be mistaken for current input.
// job-digest@5: HTML cache files are keyed by page + emitter kind + input hash,
// so transient writers for one URL cannot read or overwrite another variant.
export const JOB_DIGEST_ALGORITHM_VERSION = 'job-digest@5';
export const INCREMENTAL_MANIFEST_ENABLED = process.env.INCREMENTAL_MANIFEST === '1';

export const PAGE_KINDS = Object.freeze([
  'active-job',
  'expired-soft-landing',
  'legacy-slug-bridge',
  'previous-slugs-full-content',
  'cross-locale-reconciliation',
  'related-search-cluster',
  'related-search-sitemap',
]);

export const TEMPLATE_VERSIONS = Object.freeze({
  'active-job': 'active-job@1',
  'expired-soft-landing': 'expired-soft-landing@1',
  'legacy-slug-bridge': 'legacy-slug-bridge@1',
  'previous-slugs-full-content': 'previous-slugs-full-content@1',
  'cross-locale-reconciliation': 'cross-locale-reconciliation@1',
  'related-search-cluster': 'related-search-cluster@1',
  'related-search-sitemap': 'related-search-sitemap@1',
});

// Added after the first manifest format was deployed. Treat the missing field
// as zero so readers can compare an old snapshot with a new one; newly written
// manifests still always serialize the key.
export const LEGACY_OPTIONAL_KINDS = new Set(['related-search-sitemap']);

const RUNTIME_INPUT_KEYS = new Set([
  'ftbuildid',
  'buildid',
  'buildidtxt',
  'deploybuildid',
  'runid',
  'runnumber',
  'commithash',
  'commitid',
  'lastmod',
  'lastmodified',
  'generatedat',
  'generatedon',
  'generationdate',
  'generationtimestamp',
  'dategenerated',
  'datestamp',
]);

// `buildMinimalJobInput()` creates these fixed-order scalar projections;
// marking their fresh arrays avoids recursively revalidating them per hash.
const canonicalRelatedJobProjectionLists = new WeakSet();
const canonicalMinimalJobInputs = new WeakSet();
const CANONICAL_JSON = Symbol('incrementalManifestCanonicalJson');

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeJobsSeoEmitterFingerprint(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Jobs SEO emitter fingerprint must be an object');
  }
  const entries = Object.entries(value);
  if (entries.some(([kind, fingerprint]) => (
    !kind
    || typeof fingerprint !== 'string'
    || fingerprint.length === 0
  ))) {
    throw new Error('Jobs SEO emitter fingerprint entries are invalid');
  }
  return Object.fromEntries(entries.sort(([left], [right]) => compareStrings(left, right)));
}

function isRuntimeInputKey(key) {
  return RUNTIME_INPUT_KEYS.has(normalizedKey(key));
}

function isCanonicalJsonReady(value, inArray = false) {
  if (value === undefined) return inArray;
  if (value === null) return true;
  if (value instanceof Date) return true;
  if (Array.isArray(value) && canonicalRelatedJobProjectionLists.has(value)) return true;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (Array.isArray(value)) return value.every((item) => isCanonicalJsonReady(item, true));
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length; i += 1) {
        if (isRuntimeInputKey(keys[i]) || (i > 0 && compareStrings(keys[i - 1], keys[i]) > 0)) {
          return false;
        }
        if (!isCanonicalJsonReady(value[keys[i]])) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function canonicalValue(value, inArray = false) {
  if (value === undefined) return inArray ? 'null' : undefined;
  if (value === null) return 'null';

  if (typeof value === 'object' && value?.[CANONICAL_JSON] !== undefined) {
    return value[CANONICAL_JSON];
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (typeof value === 'object' && isCanonicalJsonReady(value, inArray)) {
    return JSON.stringify(value);
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      return JSON.stringify(String(value));
    case 'function':
    case 'symbol':
      return inArray ? 'null' : undefined;
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalValue(item, true)).join(',')}]`;
      }

      const entries = Object.entries(value)
        .filter(([key, item]) => !isRuntimeInputKey(key) && item !== undefined)
      let isSorted = true;
      for (let i = 1; i < entries.length; i += 1) {
        if (compareStrings(entries[i - 1][0], entries[i][0]) > 0) {
          isSorted = false;
          break;
        }
      }
      if (!isSorted) entries.sort(([left], [right]) => compareStrings(left, right));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(',')}}`;
    }
    default:
      return inArray ? 'null' : undefined;
  }
}

function canonicalMinimalJobInput(input) {
  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => compareStrings(left, right));
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${canonicalValue(value)}`).join(',')}}`;
}

export function canonicalizeInput(input) {
  if (input && typeof input === 'object' && canonicalMinimalJobInputs.has(input)) {
    return canonicalMinimalJobInput(input);
  }
  return canonicalValue(input) ?? 'null';
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Parts(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part, 'utf8');
  return hash.digest('hex');
}

function markCanonicalJson(value, canonicalJson) {
  Object.defineProperty(value, CANONICAL_JSON, {
    value: canonicalJson,
    enumerable: false,
  });
  return value;
}

/**
 * Keep the digest input aligned with the fields available to the renderer.
 * Generated build metadata is excluded, but source fields are retained in
 * full: dates, organization, location, salary, description, and every other
 * value that can affect the JobPosting or page content must invalidate reuse.
 */
function jobRecordForDigest(job) {
  const keys = Object.keys(job);
  if (!keys.some((key) => isRuntimeInputKey(key))) return job;
  const record = {};
  for (const key of keys) {
    if (!isRuntimeInputKey(key)) record[key] = job[key];
  }
  return record;
}

export function createIncrementalManifestInputCache() {
  const cache = {
    jobDigestsById: new Map(),
    relatedJobProjectionsByKey: new Map(),
  };
  Object.defineProperty(cache, '_metrics', {
    value: {
      jobDigestComputations: 0,
      relatedProjectionComputations: 0,
    },
    enumerable: false,
  });
  Object.defineProperty(cache, '_estimatedBytes', {
    value: {
      jobDigestsById: 0,
      relatedJobProjectionsByKey: 0,
    },
    enumerable: false,
  });
  return cache;
}

const jobRecordDigestCache = new WeakMap();
const relatedJobProjectionCache = new WeakMap();

function estimateStringBytes(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') + 16 : 0;
}

function estimateValueBytes(value, seen = new Set()) {
  if (value === null || value === undefined) return 8;
  if (typeof value === 'string') return estimateStringBytes(value);
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return 24 + value.reduce((total, item) => total + estimateValueBytes(item, seen), 0);
  }
  return 40 + Object.entries(value).reduce(
    (total, [key, item]) => total + estimateStringBytes(key) + estimateValueBytes(item, seen),
    0,
  );
}

function estimateMapEntryBytes(key, value) {
  return 48 + estimateStringBytes(key) + estimateValueBytes(value);
}

function setInputCacheEntry(inputCache, mapName, key, value) {
  const map = inputCache[mapName];
  const previous = map.get(key);
  if (previous) inputCache._estimatedBytes[mapName] -= estimateMapEntryBytes(key, previous);
  map.set(key, value);
  inputCache._estimatedBytes[mapName] += estimateMapEntryBytes(key, value);
}

/**
 * Shallow signature of a job record: primitives by value, arrays by length,
 * nested objects by reference. It is what the WeakMap identity fast path
 * checks before trusting a cached digest, so an in-place `Array.push` or a
 * top-level reassignment by a downstream plugin forces a recompute. Nested
 * object mutation (`job.foo.bar = x`) is not detected: the assembler does not
 * do that, and a deep check would cost as much as the digest itself.
 */
function shallowJobRecordSignature(job) {
  const keys = Object.keys(job);
  const signature = new Array(keys.length * 2);
  let index = 0;
  for (const key of keys) {
    const value = job[key];
    signature[index++] = key;
    signature[index++] = Array.isArray(value) ? value.length : value;
  }
  return signature;
}

function shallowSignatureMatches(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function digestJobRecord(job, inputCache = null) {
  if (!job || typeof job !== 'object') return sha256('{}');
  const stableId = stableJobId(job);
  const signature = shallowJobRecordSignature(job);
  const cachedDigest = jobRecordDigestCache.get(job);
  if (cachedDigest && shallowSignatureMatches(cachedDigest.signature, signature)) {
    rememberDigestById(inputCache, stableId, cachedDigest);
    return cachedDigest.digest;
  }

  // The assembler preserves source JSON key order. A shallow filter keeps the
  // full record covered without recursively canonicalizing its large fields.
  const record = jobRecordForDigest(job);
  if (inputCache?._metrics) inputCache._metrics.jobDigestComputations += 1;
  const digest = sha256(JSON.stringify(record));
  // Do NOT freeze the record to make the identity cache sound: downstream
  // closeBundle plugins push into its arrays and a frozen record fails the
  // whole build (deploy 35397312111, `object is not extensible`). The shallow
  // signature above detects those mutations instead.
  const cacheEntry = { digest, signature };
  jobRecordDigestCache.set(job, cacheEntry);
  rememberDigestById(inputCache, stableId, cacheEntry);
  return digest;
}

// Content-identical clones of a stable id share the by-id entry: only a
// different digest replaces it (keeps the input-cache footprint stable).
function rememberDigestById(inputCache, stableId, entry) {
  if (!inputCache || !stableId) return;
  if (inputCache.jobDigestsById.get(stableId)?.digest === entry.digest) return;
  setInputCacheEntry(inputCache, 'jobDigestsById', stableId, entry);
}

function projectRelatedJob(relatedJob, locale, inputCache = null) {
  const isRecord = relatedJob && typeof relatedJob === 'object';
  const id = isRecord ? stableJobId(relatedJob) : String(relatedJob ?? '');
  if (!id) return null;
  if (!isRecord) return { id, slug: '', digest: null };
  const cacheKey = inputCache ? `${String(locale)}\u0000${id}` : null;
  const digest = digestJobRecord(relatedJob, inputCache);
  if (cacheKey) {
    const cachedById = inputCache.relatedJobProjectionsByKey.get(cacheKey);
    if (cachedById?.digest === digest) return cachedById.projection;
  }
  let projectionsByLocale = relatedJobProjectionCache.get(relatedJob);
  if (!projectionsByLocale) {
    projectionsByLocale = new Map();
    relatedJobProjectionCache.set(relatedJob, projectionsByLocale);
  }
  const cachedProjection = projectionsByLocale.get(locale);
  if (cachedProjection?.digest === digest) {
    if (cacheKey) setInputCacheEntry(inputCache, 'relatedJobProjectionsByKey', cacheKey, cachedProjection);
    return cachedProjection.projection;
  }
  const projection = {
    id,
    slug: String(relatedJob?.slugByLocale?.[locale] || relatedJob?.slug || ''),
    digest,
  };
  if (inputCache?._metrics) inputCache._metrics.relatedProjectionComputations += 1;
  const cacheEntry = {
    digest,
    projection,
  };
  projectionsByLocale.set(locale, cacheEntry);
  if (cacheKey) setInputCacheEntry(inputCache, 'relatedJobProjectionsByKey', cacheKey, cacheEntry);
  return projection;
}

export function templateVersionForKind(kind) {
  const version = TEMPLATE_VERSIONS[kind];
  if (!version) throw new Error(`Unknown incremental manifest page kind: ${kind}`);
  return version;
}

export function computeInputHash(input, kind, templateVersion = templateVersionForKind(kind)) {
  if (!PAGE_KINDS.includes(kind)) throw new Error(`Unknown incremental manifest page kind: ${kind}`);
  const canonical = canonicalizeInput(input);
  return sha256Parts([kind, '\n', templateVersion, '\n', canonical]);
}

/**
 * Return the smallest stable identity available for a source job. The build
 * data has no universal source-record hash, so prefer one when a crawler
 * provides it and otherwise fall back to the stable job id/slug plus the
 * dataset's existing version-like fields.
 */
export function stableJobId(job) {
  return String(job?.id ?? job?.slug ?? '');
}

export function stableJobVersion(job) {
  return String(
    job?.sourceRecordHash
    ?? job?.sourceHash
    ?? job?.updatedAt
    ?? job?.lastUpdatedAt
    ?? job?.datePosted
    ?? job?.postedDate
    ?? job?.firstSeenAt
    ?? '',
  );
}

/**
 * Fingerprint the complete related-job candidate pool without retaining or
 * serializing its records. The renderer chooses only six entries from this
 * ordered pool; the compact signature keeps additions/removals/reordering and
 * the slug used by the selection guard in the page dependency set.
 */
export function computeRelatedJobPoolSignature(relatedJobs = []) {
  const jobs = Array.isArray(relatedJobs) ? relatedJobs : [];
  const membership = jobs.map((relatedJob) => (
    relatedJob && typeof relatedJob === 'object'
      ? [stableJobId(relatedJob), String(relatedJob.slug ?? '')]
      : [String(relatedJob ?? ''), '']
  ));
  return sha256(JSON.stringify(membership));
}

/**
 * Build the input passed to the shadow hash. The full job record is represented
 * by a cheap digest; only the small related-job projection enters the
 * canonicalizer.
 */
export function buildMinimalJobInput(
  job,
  locale,
  slug,
  relatedJobs = [],
  inputCache = null,
  canonicalJob = null,
) {
  // Bridge page records may carry a page-local id/slug or other route fields.
  // Keep those fields in the page input below, but always derive the job
  // identity/version/digest from the canonical source record when supplied.
  const sourceJob = canonicalJob && typeof canonicalJob === 'object' ? canonicalJob : job;
  const relatedJobList = Array.isArray(relatedJobs) ? relatedJobs : [];
  const relatedJobProjections = relatedJobList
    .map((relatedJob) => projectRelatedJob(relatedJob, locale, inputCache))
    .filter(Boolean);
  canonicalRelatedJobProjectionLists.add(relatedJobProjections);
  markCanonicalJson(relatedJobProjections, JSON.stringify(relatedJobProjections));

  const input = {
    jobId: stableJobId(sourceJob),
    jobRecordDigest: digestJobRecord(sourceJob, inputCache),
    jobVersion: stableJobVersion(sourceJob),
    locale: String(locale),
    relatedJobs: relatedJobProjections,
    slug: String(slug ?? ''),
  };
  canonicalMinimalJobInputs.add(input);
  return input;
}

export function verifyRuntimeInputExclusion() {
  const base = {
    content: { title: 'Role', description: 'Description' },
    nested: { values: ['a', 'b'] },
  };
  const withRuntimeFields = {
    ...base,
    'ft-build-id': '34956104680',
    buildId: '1789466830893',
    lastmod: '2026-09-16',
    generatedAt: '2026-09-16T12:00:00.000Z',
    nested: {
      ...base.nested,
      commit_hash: '0475bae099f92b761165050384a9a867635eb9fd',
      dateGenerated: '2026-09-16',
    },
  };
  const baseHash = computeInputHash(base, 'active-job');
  const runtimeHash = computeInputHash(withRuntimeFields, 'active-job');
  if (baseHash !== runtimeHash) {
    throw new Error('Runtime fields changed the incremental input hash');
  }
  return true;
}

export function normalizeManifestPath(pagePath) {
  const normalized = String(pagePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized) throw new Error('Incremental manifest path cannot be empty');
  return normalized;
}

/**
 * The regular shadow manifest intentionally stores only hashes. The opt-in
 * post-walk planner additionally needs a small reverse-edge index for removals
 * and same-job aliases; keep that index compact and out of the default shadow
 * output so POST_WALK_INCREMENTAL=0 remains byte-for-byte unchanged.
 */
function compactPostWalkMetadata(input) {
  if (process.env.POST_WALK_INCREMENTAL !== '1') return undefined;

  const jobIds = new Set();
  const slugs = new Set();
  const references = new Set();
  const seen = new WeakSet();
  const visit = (value, key = '') => {
    if (typeof value === 'string') {
      const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (normalizedKey === 'jobid' || normalizedKey === 'winnerid') jobIds.add(value);
      if (normalizedKey.includes('slug')) slugs.add(value);
      if (
        normalizedKey.includes('path')
        || normalizedKey.includes('url')
        || normalizedKey.includes('href')
        || normalizedKey.includes('file')
        || normalizedKey.includes('candidate')
        || normalizedKey.includes('tracking')
        || normalizedKey.includes('prose')
        || normalizedKey.includes('reference')
        || normalizedKey === 'sourcepath'
        || normalizedKey === 'targetpath'
      ) {
        references.add(value);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
  };
  visit(input);

  const sorted = (values) => [...values].filter(Boolean).sort(compareStrings);
  const metadata = {};
  const sortedJobIds = sorted(jobIds);
  const sortedSlugs = sorted(slugs);
  const sortedReferences = sorted(references);
  if (sortedJobIds.length > 0) metadata.jobIds = sortedJobIds;
  if (sortedSlugs.length > 0) metadata.slugs = sortedSlugs;
  if (sortedReferences.length > 0) metadata.references = sortedReferences;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function safeLocaleFileName(locale) {
  const name = String(locale || '').trim();
  if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
    throw new Error(`Invalid incremental manifest locale: ${locale}`);
  }
  return `${name}.jsonl`;
}

export class IncrementalManifest {
  constructor(locale) {
    this.locale = String(locale);
    this.entriesByPath = new Map();
    this.kindMetadata = new Map();
    this.jobsSeoEmitterFingerprint = null;
    this.estimatedEntryBytes = 0;
  }

  setJobsSeoEmitterFingerprint(fingerprint) {
    const normalized = normalizeJobsSeoEmitterFingerprint(fingerprint);
    if (this.jobsSeoEmitterFingerprint && JSON.stringify(this.jobsSeoEmitterFingerprint) !== JSON.stringify(normalized)) {
      throw new Error(`Jobs SEO emitter fingerprint changed within locale: ${this.locale}`);
    }
    this.jobsSeoEmitterFingerprint = normalized;
    return this;
  }

  register(pagePath, kind, input, templateVersion = templateVersionForKind(kind), sourceVersion = SOURCE_VERSION) {
    if (!PAGE_KINDS.includes(kind)) throw new Error(`Unknown incremental manifest page kind: ${kind}`);
    const normalizedPath = normalizeManifestPath(pagePath);
    const previousMetadata = this.kindMetadata.get(kind);
    if (previousMetadata && (
      previousMetadata.templateVersion !== templateVersion
      || previousMetadata.sourceVersion !== sourceVersion
      || previousMetadata.state !== 'live'
    )) {
      throw new Error(`Incremental manifest metadata changed within kind: ${kind}`);
    }
    if (!previousMetadata) {
      this.kindMetadata.set(kind, { templateVersion, sourceVersion, state: 'live' });
    }

    const postWalk = compactPostWalkMetadata(input);
    const entry = {
      kind,
      hash: computeInputHash(input, kind, templateVersion),
      templateVersion,
      ...(postWalk ? { postWalk } : {}),
    };
    const previousEntry = this.entriesByPath.get(normalizedPath);
    if (previousEntry) this.estimatedEntryBytes -= estimateMapEntryBytes(normalizedPath, previousEntry);
    this.entriesByPath.set(normalizedPath, entry);
    this.estimatedEntryBytes += estimateMapEntryBytes(normalizedPath, entry);
  }

  hasPath(pagePath) {
    return this.entriesByPath.has(normalizeManifestPath(pagePath));
  }

  getHash(pagePath, kind = null) {
    if (!pagePath) return null;
    const entry = this.entriesByPath.get(normalizeManifestPath(pagePath));
    if (!entry || (kind && entry.kind !== kind)) return null;
    return entry.hash;
  }

  counts() {
    const byKind = Object.fromEntries(PAGE_KINDS.map((kind) => [kind, 0]));
    for (const entry of this.entriesByPath.values()) byKind[entry.kind] += 1;
    return {
      total: Object.values(byKind).reduce((sum, count) => sum + count, 0),
      byKind,
    };
  }

  toJSON() {
    const summary = {
      manifestVersion: MANIFEST_VERSION,
      format: MANIFEST_FORMAT,
      locale: this.locale,
      counts: this.counts(),
      kinds: Object.fromEntries(
        PAGE_KINDS
          .filter((kind) => this.kindMetadata.has(kind))
          .map((kind) => [kind, this.kindMetadata.get(kind)]),
      ),
    };
    if (this.jobsSeoEmitterFingerprint) {
      summary.jobsSeoEmitterFingerprint = this.jobsSeoEmitterFingerprint;
    }
    return summary;
  }

  write(rootDir, manifestDir = path.join(rootDir, '.cache', 'incremental-manifest')) {
    fs.mkdirSync(manifestDir, { recursive: true });
    const fileName = safeLocaleFileName(this.locale);
    const target = path.join(manifestDir, fileName);
    const temp = path.join(manifestDir, `.${fileName}.${process.pid}.tmp`);
    const summary = this.toJSON();
    let fd = null;
    try {
      fd = fs.openSync(temp, 'w');
      const writeLine = (record) => fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      writeLine({
        type: 'header',
        manifestVersion: MANIFEST_VERSION,
        format: MANIFEST_FORMAT,
        locale: this.locale,
        ...(this.jobsSeoEmitterFingerprint
          ? { jobsSeoEmitterFingerprint: this.jobsSeoEmitterFingerprint }
          : {}),
      });
      const entriesForKind = new Map(PAGE_KINDS.map((kind) => [kind, []]));
      for (const [pagePath, entry] of this.entriesByPath) {
        entriesForKind.get(entry.kind).push([pagePath, entry]);
      }
      for (const kind of PAGE_KINDS) {
        const entries = entriesForKind.get(kind);
        if (entries.length === 0) continue;
        writeLine({ type: 'kind', kind, ...this.kindMetadata.get(kind) });
        entries.sort(([left], [right]) => compareStrings(left, right));
        for (const [pagePath, entry] of entries) {
          writeLine({
            path: pagePath,
            hash: entry.hash,
            ...(entry.postWalk ? { postWalk: entry.postWalk } : {}),
          });
        }
      }
      const footer = { type: 'footer', counts: summary.counts };
      if (this.jobsSeoEmitterFingerprint) {
        footer.jobsSeoEmitterFingerprint = this.jobsSeoEmitterFingerprint;
      }
      writeLine(footer);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, target);
    } finally {
      if (fd !== null) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return target;
  }
}

// Both the jobs and related-search plugins run closeBundle hooks in parallel.
// Keep one manifest instance per build root/locale so their writes compose in
// memory and the later writer cannot overwrite the other plugin's kinds.
const manifestMapsByRoot = new Map();
const manifestInputCachesByRoot = new Map();

export function getIncrementalManifestInputCache(rootDir) {
  if (!INCREMENTAL_MANIFEST_ENABLED) return null;
  const rootKey = path.resolve(String(rootDir));
  let inputCache = manifestInputCachesByRoot.get(rootKey);
  if (!inputCache) {
    inputCache = createIncrementalManifestInputCache();
    manifestInputCachesByRoot.set(rootKey, inputCache);
  }
  return inputCache;
}

function manifestMemoryStats(manifest) {
  return {
    entries: manifest.entriesByPath.size,
    estimatedBytes: Math.max(0, Math.round(manifest.estimatedEntryBytes)),
  };
}

function inputCacheMemoryStats(inputCache) {
  const statsFor = (name) => ({
    entries: inputCache?.[name]?.size ?? 0,
    estimatedBytes: Math.max(0, Math.round(inputCache?._estimatedBytes?.[name] ?? 0)),
  });
  const relatedProjectionLists = inputCache?.relatedProjectionListsByKey;
  const relatedProjectionListsEstimatedBytes = relatedProjectionLists
    ? [...relatedProjectionLists.entries()].reduce(
      (total, [key, value]) => total + estimateMapEntryBytes(key, value),
      0,
    )
    : 0;
  return {
    jobDigestsById: statsFor('jobDigestsById'),
    relatedJobProjectionsByKey: statsFor('relatedJobProjectionsByKey'),
    // Kept in the report so CI can prove that the old per-list retention stays
    // absent. Related projections are rebuilt as a short-lived array per input.
    relatedProjectionListsByKey: {
      entries: relatedProjectionLists?.size ?? 0,
      estimatedBytes: Math.max(0, Math.round(relatedProjectionListsEstimatedBytes)),
    },
    computations: {
      jobDigestComputations: inputCache?._metrics?.jobDigestComputations ?? 0,
      relatedProjectionComputations: inputCache?._metrics?.relatedProjectionComputations ?? 0,
    },
  };
}

export function getIncrementalManifestMemoryStats(rootDir) {
  const rootKey = path.resolve(String(rootDir));
  const manifests = manifestMapsByRoot.get(rootKey);
  const inputCache = manifestInputCachesByRoot.get(rootKey);
  const manifestStats = manifests
    ? Object.fromEntries([...manifests.entries()].map(([locale, manifest]) => [locale, manifestMemoryStats(manifest)]))
    : {};
  const records = Object.values(manifestStats).reduce(
    (total, stats) => ({
      entries: total.entries + stats.entries,
      estimatedBytes: total.estimatedBytes + stats.estimatedBytes,
    }),
    { entries: 0, estimatedBytes: 0 },
  );
  const inputCacheStats = inputCacheMemoryStats(inputCache);
  const inputCacheTotal = Object.values(inputCacheStats)
    .filter((stats) => stats && typeof stats.estimatedBytes === 'number')
    .reduce(
      (total, stats) => total + stats.estimatedBytes,
      0,
    );
  return {
    manifests: {
      locales: Object.keys(manifestStats).length,
      byLocale: manifestStats,
    },
    inputCache: inputCacheStats,
    records,
    weakMaps: {
      jobRecordDigestCache: { entries: null, estimatedBytes: null },
      relatedJobProjectionCache: { entries: null, estimatedBytes: null },
    },
    estimatedBytes: {
      inputCache: inputCacheTotal,
      records: records.estimatedBytes,
      knownTotal: inputCacheTotal + records.estimatedBytes,
    },
  };
}

export function logIncrementalManifestMemory(rootDir, phase) {
  const stats = getIncrementalManifestMemoryStats(rootDir);
  // eslint-disable-next-line no-console
  console.log(`[incremental-manifest] memory phase=${phase} ${JSON.stringify(stats)}`);
  return stats;
}

export function resetIncrementalManifestInputCache(rootDir) {
  // Digest/projection entries are valid only for the build that populated them.
  const rootKey = path.resolve(String(rootDir));
  manifestInputCachesByRoot.delete(rootKey);
}

/**
 * The post-walk coordinator is the last consumer of the build-scoped manifest
 * maps.  Dropping only its local `manifests` variable leaves the two global
 * maps (and their ~GB-scale input projections) reachable.  Release both
 * roots explicitly once the writers have finished.
 */
export function releaseIncrementalManifestState(rootDir) {
  const rootKey = path.resolve(String(rootDir));
  const manifests = manifestMapsByRoot.get(rootKey);
  if (manifests) {
    for (const manifest of manifests.values()) {
      manifest.entriesByPath.clear();
      manifest.kindMetadata.clear();
      manifest.jobsSeoEmitterFingerprint = null;
      manifest.estimatedEntryBytes = 0;
    }
    manifests.clear();
  }
  manifestMapsByRoot.delete(rootKey);
  manifestInputCachesByRoot.delete(rootKey);
}

export function getIncrementalManifestMap(rootDir, locales, force = false) {
  if (!INCREMENTAL_MANIFEST_ENABLED && !force) return null;
  const rootKey = path.resolve(String(rootDir));
  let manifests = manifestMapsByRoot.get(rootKey);
  if (!manifests) {
    manifests = new Map();
    manifestMapsByRoot.set(rootKey, manifests);
  }

  const selected = new Map();
  for (const locale of locales) {
    const key = String(locale);
    let manifest = manifests.get(key);
    if (!manifest) {
      manifest = new IncrementalManifest(key);
      manifests.set(key, manifest);
    }
    selected.set(key, manifest);
  }
  return selected;
}

function parseManifestJsonLine(file, lineNumber, line) {
  try {
    const record = JSON.parse(line);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('record deve essere un oggetto');
    }
    return record;
  } catch (error) {
    throw new Error(`${file}:${lineNumber}: JSONL non valido (${error?.message || error})`);
  }
}

/**
 * Read only the first JSONL record. The header carries the producer
 * fingerprint, so the coordinator can reject an incompatible previous cache
 * before materialising the current 650k-entry map.
 */
export function readIncrementalManifestHeader(file) {
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let carry = '';
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      carry += decoder.write(buffer.subarray(0, bytesRead));
      const newline = carry.indexOf('\n');
      if (newline === -1) continue;
      carry = carry.slice(0, newline).trim();
      break;
    }
    if (!carry) {
      carry = decoder.end().trim();
    }
    if (!carry) throw new Error(`${file}: header mancante`);
    const header = parseManifestJsonLine(file, 1, carry);
    if (
      header.type !== 'header'
      || header.manifestVersion !== MANIFEST_VERSION
      || header.format !== MANIFEST_FORMAT
      || typeof header.locale !== 'string'
    ) {
      throw new Error(`${file}: header manifest non valido`);
    }
    return {
      locale: header.locale,
      jobsSeoEmitterFingerprint: header.jobsSeoEmitterFingerprint === undefined
        ? undefined
        : normalizeJobsSeoEmitterFingerprint(header.jobsSeoEmitterFingerprint),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertManifestCounts(file, counts, entryCount, observedByKind) {
  if (!counts || !Number.isInteger(counts.total) || !counts.byKind || typeof counts.byKind !== 'object') {
    throw new Error(`${file}: footer counts non valido`);
  }
  if (counts.total !== entryCount) {
    throw new Error(`${file}: footer total=${counts.total}, osservate ${entryCount} entry`);
  }
  for (const kind of PAGE_KINDS) {
    const declared = counts.byKind[kind];
    if (declared === undefined && LEGACY_OPTIONAL_KINDS.has(kind)) continue;
    if (declared !== observedByKind[kind]) {
      throw new Error(`${file}: footer byKind.${kind}=${counts.byKind[kind]}, osservate ${observedByKind[kind]}`);
    }
  }
}

/**
 * Read one manifest without materialising any HTML or retaining its entries.
 * The post-walk planner uses this callback form to keep only the projection it
 * needs while the JSONL stream is open. The default duplicate check is kept for
 * callers that need the same strictness as loadIncrementalManifest(); the
 * planner can disable it for a previous snapshot because it already proves
 * duplicates that can affect the current tree while consuming the stream.
 */
export async function streamIncrementalManifest(file, onEntry, options = {}) {
  // `readline` + async iteration creates one Promise/iterator step per JSONL
  // record.  A 650k-entry manifest paid that scheduling cost twice (and up to
  // four times for add/remove references).  Keep the stream bounded, but scan
  // it with a chunk decoder and a single line callback.
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let carry = '';
  let header = null;
  let footer = null;
  let currentKind = null;
  let sawFooter = false;
  let jobsSeoEmitterFingerprint = null;
  let lineNumber = 0;
  const kinds = new Map();
  const observedByKind = Object.fromEntries(PAGE_KINDS.map((kind) => [kind, 0]));
  const validateUniquePaths = options.validateUniquePaths !== false;
  const seenPaths = validateUniquePaths ? new Set() : null;
  let entryCount = 0;

  const handleLine = (rawLine) => {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) return;
    const record = parseManifestJsonLine(file, lineNumber, line);
    if (sawFooter) throw new Error(`${file}:${lineNumber}: record dopo il footer`);

    if (record.type === 'header') {
      if (header) throw new Error(`${file}:${lineNumber}: header duplicato`);
      if (
        record.manifestVersion !== MANIFEST_VERSION
        || record.format !== MANIFEST_FORMAT
        || typeof record.locale !== 'string'
      ) {
        throw new Error(`${file}:${lineNumber}: header manifest non valido`);
      }
      header = record;
      if (record.jobsSeoEmitterFingerprint !== undefined) {
        jobsSeoEmitterFingerprint = normalizeJobsSeoEmitterFingerprint(record.jobsSeoEmitterFingerprint);
      }
      return;
    }
    if (!header) throw new Error(`${file}:${lineNumber}: header mancante`);

    if (record.type === 'kind') {
      if (!PAGE_KINDS.includes(record.kind)) {
        throw new Error(`${file}:${lineNumber}: kind non valido`);
      }
      if (kinds.has(record.kind)) {
        throw new Error(`${file}:${lineNumber}: kind duplicato ${record.kind}`);
      }
      for (const field of ['templateVersion', 'sourceVersion', 'state']) {
        if (typeof record[field] !== 'string' || record[field].length === 0) {
          throw new Error(`${file}:${lineNumber}: metadata ${field} non valida`);
        }
      }
      kinds.set(record.kind, {
        templateVersion: record.templateVersion,
        sourceVersion: record.sourceVersion,
        state: record.state,
      });
      currentKind = record.kind;
      return;
    }

    if (record.type === 'footer') {
      assertManifestCounts(file, record.counts, entryCount, observedByKind);
      if (record.jobsSeoEmitterFingerprint !== undefined) {
        const footerFingerprint = normalizeJobsSeoEmitterFingerprint(record.jobsSeoEmitterFingerprint);
        if (
          jobsSeoEmitterFingerprint
          && JSON.stringify(jobsSeoEmitterFingerprint) !== JSON.stringify(footerFingerprint)
        ) {
          throw new Error(`${file}:${lineNumber}: jobs SEO emitter fingerprint divergente`);
        }
        jobsSeoEmitterFingerprint = footerFingerprint;
      }
      footer = record;
      sawFooter = true;
      return;
    }

    if (record.type !== undefined) {
      throw new Error(`${file}:${lineNumber}: record type non valido`);
    }
    if (!currentKind) throw new Error(`${file}:${lineNumber}: entry senza kind`);
    if (typeof record.path !== 'string' || record.path.length === 0 || typeof record.hash !== 'string') {
      throw new Error(`${file}:${lineNumber}: entry non valida`);
    }
    if (seenPaths?.has(record.path)) throw new Error(`${file}:${lineNumber}: path duplicato ${record.path}`);
    seenPaths?.add(record.path);
    entryCount += 1;
    observedByKind[currentKind] += 1;
    const entry = { path: record.path, inputHash: record.hash, kind: currentKind };
    // POST_WALK_INCREMENTAL (#8942) adds a compact identity/reference index
    // per entry; consumers decide which projection to retain.
    if (record.postWalk !== undefined) entry.postWalk = record.postWalk;
    onEntry(entry);
  };

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      carry += decoder.write(buffer.subarray(0, bytesRead));
      let newline;
      while ((newline = carry.indexOf('\n')) !== -1) {
        const rawLine = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        handleLine(rawLine);
      }
    }
    carry += decoder.end();
    if (carry.length > 0) handleLine(carry);
  } finally {
    fs.closeSync(fd);
  }

  if (!header) throw new Error(`${file}: header mancante`);
  if (!footer) throw new Error(`${file}: footer mancante`);
  assertManifestCounts(file, footer.counts, entryCount, observedByKind);
  const data = {
    manifestVersion: header.manifestVersion,
    format: header.format,
    locale: header.locale,
    counts: footer.counts,
    kinds: Object.fromEntries(kinds),
  };
  if (jobsSeoEmitterFingerprint) data.jobsSeoEmitterFingerprint = jobsSeoEmitterFingerprint;
  return {
    file,
    data,
    entryCount,
    jobsSeoEmitterFingerprint,
  };
}

/**
 * Read one manifest into the legacy Map-shaped result. This remains available
 * to reporting/cache callers; memory-sensitive post-walk code uses the stream
 * API above instead.
 */
export async function loadIncrementalManifest(file) {
  const entries = new Map();
  const streamed = await streamIncrementalManifest(
    file,
    (entry) => {
      entries.set(entry.path, entry);
    },
    { validateUniquePaths: true },
  );
  return {
    file,
    data: streamed.data,
    entries,
  };
}
