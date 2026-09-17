import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';

export const MANIFEST_VERSION = 2;
export const MANIFEST_FORMAT = 'jsonl';
export const SOURCE_VERSION = 'input@1';
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

export function canonicalizeInput(input) {
  if (input && typeof input === 'object' && canonicalMinimalJobInputs.has(input)) {
    return JSON.stringify(input);
  }
  return canonicalValue(input) ?? 'null';
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const jobRecordDigestCache = new WeakMap();
const relatedJobProjectionCache = new WeakMap();

function digestJobRecord(job) {
  if (!job || typeof job !== 'object') return sha256('{}');
  const cachedDigest = jobRecordDigestCache.get(job);
  if (cachedDigest !== undefined) return cachedDigest;

  // The assembler preserves source JSON key order. A shallow filter keeps the
  // full record covered without recursively canonicalizing its large fields.
  const keys = Object.keys(job);
  let record = job;
  if (keys.some((key) => isRuntimeInputKey(key))) {
    record = {};
    for (const key of keys) {
      if (!isRuntimeInputKey(key)) record[key] = job[key];
    }
  }
  // Job records do not carry fetch-only `fetchedAt`; `updatedAt`, `crawledAt`,
  // and posting dates are retained because they are source/freshness inputs to
  // the rendered JobPosting. Only generated build metadata is excluded above.
  const digest = sha256(JSON.stringify(record));
  jobRecordDigestCache.set(job, digest);
  return digest;
}

function projectRelatedJob(relatedJob, locale) {
  const isRecord = relatedJob && typeof relatedJob === 'object';
  const id = isRecord ? stableJobId(relatedJob) : String(relatedJob ?? '');
  if (!id) return null;
  if (!isRecord) return { id, slug: '', digest: null };
  let projectionsByLocale = relatedJobProjectionCache.get(relatedJob);
  if (!projectionsByLocale) {
    projectionsByLocale = new Map();
    relatedJobProjectionCache.set(relatedJob, projectionsByLocale);
  }
  const cachedProjection = projectionsByLocale.get(locale);
  if (cachedProjection) return cachedProjection;
  const projection = {
    id,
    slug: String(relatedJob?.slugByLocale?.[locale] || relatedJob?.slug || ''),
    digest: digestJobRecord(relatedJob),
  };
  projectionsByLocale.set(locale, projection);
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
  return sha256(`${kind}\n${templateVersion}\n${canonical}`);
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
 * Build the input passed to the shadow hash. The full job record is represented
 * by a cheap digest; only the small related-job projection enters the
 * canonicalizer.
 */
export function buildMinimalJobInput(job, locale, slug, relatedJobs = []) {
  const relatedJobList = Array.isArray(relatedJobs) ? relatedJobs : [];
  const relatedJobProjections = relatedJobList
    .map((relatedJob) => projectRelatedJob(relatedJob, locale))
    .filter(Boolean);
  canonicalRelatedJobProjectionLists.add(relatedJobProjections);

  const input = {
    jobId: stableJobId(job),
    jobRecordDigest: digestJobRecord(job),
    jobVersion: stableJobVersion(job),
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
    this.entriesByKind = new Map(PAGE_KINDS.map((kind) => [kind, new Map()]));
    this.kindMetadata = new Map();
    this.jobsSeoEmitterFingerprint = null;
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

    for (const [existingKind, entries] of this.entriesByKind) {
      if (existingKind !== kind) entries.delete(normalizedPath);
    }
    this.entriesByKind.get(kind).set(normalizedPath, {
      hash: computeInputHash(input, kind, templateVersion),
      postWalk: compactPostWalkMetadata(input),
    });
  }

  hasPath(pagePath) {
    const normalizedPath = normalizeManifestPath(pagePath);
    for (const entries of this.entriesByKind.values()) {
      if (entries.has(normalizedPath)) return true;
    }
    return false;
  }

  getHash(pagePath, kind = null) {
    if (!pagePath) return null;
    const normalizedPath = normalizeManifestPath(pagePath);
    if (kind) return this.entriesByKind.get(kind)?.get(normalizedPath) ?? null;
    for (const entries of this.entriesByKind.values()) {
      const hash = entries.get(normalizedPath);
      if (hash) return hash;
    }
    return null;
  }

  counts() {
    const byKind = Object.fromEntries(
      PAGE_KINDS.map((kind) => [kind, this.entriesByKind.get(kind).size]),
    );
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
      });
      for (const kind of PAGE_KINDS) {
        const entries = this.entriesByKind.get(kind);
        if (entries.size === 0) continue;
        writeLine({ type: 'kind', kind, ...this.kindMetadata.get(kind) });
        const sortedPaths = [...entries.keys()].sort(compareStrings);
        for (const pagePath of sortedPaths) {
          const entry = entries.get(pagePath);
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

function assertManifestCounts(file, counts, entries) {
  if (!counts || !Number.isInteger(counts.total) || !counts.byKind || typeof counts.byKind !== 'object') {
    throw new Error(`${file}: footer counts non valido`);
  }
  if (counts.total !== entries.size) {
    throw new Error(`${file}: footer total=${counts.total}, osservate ${entries.size} entry`);
  }
  const byKind = Object.fromEntries(PAGE_KINDS.map((kind) => [kind, 0]));
  for (const entry of entries.values()) byKind[entry.kind] += 1;
  for (const kind of PAGE_KINDS) {
    const declared = counts.byKind[kind];
    if (declared === undefined && LEGACY_OPTIONAL_KINDS.has(kind)) continue;
    if (declared !== byKind[kind]) {
      throw new Error(`${file}: footer byKind.${kind}=${counts.byKind[kind]}, osservate ${byKind[kind]}`);
    }
  }
}

/**
 * Read one manifest without materialising any HTML. The same strict reader is
 * shared by CI reporting and the optional jobs-SEO disk cache so both paths
 * agree on what constitutes a usable previous snapshot.
 */
export async function loadIncrementalManifest(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let footer = null;
  let currentKind = null;
  let sawFooter = false;
  let jobsSeoEmitterFingerprint = null;
  let lineNumber = 0;
  const kinds = new Map();
  const entries = new Map();

  try {
    for await (const rawLine of reader) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;
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
        continue;
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
        continue;
      }

      if (record.type === 'footer') {
        assertManifestCounts(file, record.counts, entries);
        if (record.jobsSeoEmitterFingerprint !== undefined) {
          jobsSeoEmitterFingerprint = normalizeJobsSeoEmitterFingerprint(record.jobsSeoEmitterFingerprint);
        }
        footer = record;
        sawFooter = true;
        continue;
      }

      if (record.type !== undefined) {
        throw new Error(`${file}:${lineNumber}: record type non valido`);
      }
      if (!currentKind) throw new Error(`${file}:${lineNumber}: entry senza kind`);
      if (typeof record.path !== 'string' || record.path.length === 0 || typeof record.hash !== 'string') {
        throw new Error(`${file}:${lineNumber}: entry non valida`);
      }
      if (entries.has(record.path)) throw new Error(`${file}:${lineNumber}: path duplicato ${record.path}`);
      const entry = { path: record.path, inputHash: record.hash, kind: currentKind };
      // POST_WALK_INCREMENTAL (#8942) adds a compact identity/reference index
      // per entry; the planner proves same-job and explicit path dependencies
      // from it, so the shared loader must carry it through.
      if (record.postWalk !== undefined) entry.postWalk = record.postWalk;
      entries.set(record.path, entry);
    }
  } finally {
    reader.close();
  }

  if (!header) throw new Error(`${file}: header mancante`);
  if (!footer) throw new Error(`${file}: footer mancante`);
  assertManifestCounts(file, footer.counts, entries);
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
    entries,
  };
}
