import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
]);

export const TEMPLATE_VERSIONS = Object.freeze({
  'active-job': 'active-job@1',
  'expired-soft-landing': 'expired-soft-landing@1',
  'legacy-slug-bridge': 'legacy-slug-bridge@1',
  'previous-slugs-full-content': 'previous-slugs-full-content@1',
  'cross-locale-reconciliation': 'cross-locale-reconciliation@1',
  'related-search-cluster': 'related-search-cluster@1',
});

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

function normalizeManifestPath(pagePath) {
  const normalized = String(pagePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized) throw new Error('Incremental manifest path cannot be empty');
  return normalized;
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
    this.entriesByKind.get(kind).set(
      normalizedPath,
      computeInputHash(input, kind, templateVersion),
    );
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
    return {
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
          writeLine({ path: pagePath, hash: entries.get(pagePath) });
        }
      }
      writeLine({ type: 'footer', counts: summary.counts });
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
