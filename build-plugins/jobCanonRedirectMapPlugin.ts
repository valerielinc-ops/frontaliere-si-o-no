/**
 * Emit the v2 /job-canon maps (the v1 prefix shards were retired after the S3
 * zero-use receipt; manifest schema 3 has no v1 section) without retaining the complete registry
 * or the complete output graph in V8. Registry records are spooled per shard
 * and applied to one output shard at a time in closeBundle.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { iterateJsonArrayFile, readJsonFile } from '../scripts/lib/read-large-json.mjs';
import type { Plugin } from 'vite';
import {
  iterateAllKnownJobSlugPartEntries,
  knownSlugsManifestFile,
} from '../scripts/lib/all-known-job-slugs-store.mjs';
import { loadWinners } from '../services/previousSlugWinners';
import {
  JOB_CANON_V2_SHARD_COUNT,
  jobSlugShardIndexForCount,
} from '../services/jobSlugShards';
import {
  resolveCantonFromSection,
  resolveJobCanton,
  SECTION_LEGACY_TI_ROOT,
} from './shared/cantonSection';
import { resolveLegacyGermanSectionPath } from './shared/legacyGermanSectionAliases';
import { getSafeDistPageTargets, isDistPathOverFilesystemLimits, isSafeDistPath } from './shared/distPathSafety';
import { buildCanonicalJobDetailPath } from './shared/jobDetailPath';
import { localizedActiveJobSlug } from './shared/activeJobPageSelection';
import {
  JOB_PAGES_MANIFEST_FILE,
  createJobPagesManifestLookup,
  decodeSortedSlugs,
  encodeSortedSlugs,
  normalizeJobPagePath,
} from './shared/jobPagesManifest.mjs';
import {
  clearJobCanonOrderingFields,
  getJobCanonOrderingFields,
  restoreJobCanonOrderingFields,
} from './shared/jobCanonInputs';
import {
  emitActiveJobCanonAliases,
  JOB_CANON_LOCALES,
  JOB_CANON_REGISTRY_ALIAS_LOCALES,
  type ActiveJobAliasStats,
  type ActiveJobSlugMapRow,
  type JobCanonLocale,
} from './shared/jobCanonBridgePaths';
import {
  jobsSeoPagesFlushed,
  shouldAwaitJobsSeoPagesFlushed,
  shouldRequireJobsSeoActivePageManifest,
} from './shared/buildSignals';

const OUT_SUBDIR = 'job-canon';
const V2_SUBDIR = 'v2';
const V2_BUCKET_COUNT = JOB_CANON_V2_SHARD_COUNT;
// Schema 3 = schema 2 without the retired `v1` section. Digests use emitted
// key order, so integrity is computed while writing.
const MANIFEST_SCHEMA_VERSION = 3;
const MANIFEST_LOCALE_ORDER = ['it', 'en', 'de', 'fr'] as const satisfies readonly JobCanonLocale[];
const STAGE_OPERATIONS = [
  'prefix',
  'registry-alias',
  'active-alias',
  'active-prefix',
  'active-prefix-remove',
  'active-job',
] as const;
const LOCALE_INDEX = new Map<JobCanonLocale, number>(JOB_CANON_LOCALES.map((locale, index) => [locale, index]));
const WORKER_LOCALE_MASK = (1 << JOB_CANON_LOCALES.length) - 1;
const WORKER_CANDIDATE_FLAG = 1 << 12;
const WORKER_ACTIVE_ROUTE_FLAG = 1 << 13;
const WORKER_DIRECT_FACT_MASK = WORKER_LOCALE_MASK | (WORKER_LOCALE_MASK << 4);
const WORKER_NATIVE_NON_TI_MASK = WORKER_LOCALE_MASK << 8;
const WORKER_REPLACED_MAP_FACT_MASK = WORKER_DIRECT_FACT_MASK | WORKER_NATIVE_NON_TI_MASK;
// Per-locale bit: this slug is the CURRENT slug, in that locale, of an active
// job. Set once from the active input, never replaced by registry rows.
const WORKER_CURRENT_IN_LOCALE_SHIFT = 16;

type StageOperation = (typeof STAGE_OPERATIONS)[number];
type LocaleEntry = Partial<Record<JobCanonLocale, string>> & {
  alias?: Partial<Record<JobCanonLocale, string>>;
};
type StageBuffer = Record<StageOperation, Map<string, string[]>> & { rows: number };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Only the complete build artifact may prove that an active route is absent. */
function isCompleteActivePageManifest(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value) || !isPlainRecord(value.pages) || !isPlainRecord(value.counts)) return false;
  const counts = value.counts;
  if (typeof value.generatedAt !== 'string'
    || typeof value.buildCommit !== 'string'
    || typeof value.contentSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.contentSha256)
    || typeof counts.pages !== 'number'
    || !Number.isSafeInteger(counts.pages)
    || counts.pages < 0
    || typeof counts.sections !== 'number'
    || !Number.isSafeInteger(counts.sections)
    || counts.sections < 0) return false;

  const directories = Object.keys(value.pages).sort();
  const digest = createHash('sha256');
  let pageCount = 0;
  for (const directory of directories) {
    if (!directory
      || directory === '/'
      || normalizeJobPagePath(directory) !== directory
      || directory.includes('//')
      || directory.includes('|')) return false;
    const encoded = value.pages[directory];
    if (!Array.isArray(encoded)
      || encoded.length === 0
      || encoded.some((entry) => typeof entry !== 'string')) return false;
    const decoded = decodeSortedSlugs(encoded);
    for (let index = 0; index < decoded.length; index += 1) {
      const slug = decoded[index];
      if (!slug || slug.includes('/') || slug.includes('|')) return false;
      if (index > 0 && decoded[index - 1] >= slug) return false;
    }
    const canonicalEncoding = encodeSortedSlugs(decoded);
    if (canonicalEncoding.length !== encoded.length
      || canonicalEncoding.some((entry, index) => entry !== encoded[index])) return false;
    pageCount += decoded.length;
    digest.update(`${directory}\n${decoded.join('\n')}\n`);
  }
  return counts.pages === pageCount
    && counts.sections === directories.length
    && value.contentSha256 === digest.digest('hex');
}

type CompactRegistryIndex = {
  hashes: Uint32Array;
  orders: Uint32Array;
  parts: Uint16Array;
  prefixMasks: Uint8Array;
  buckets: Uint16Array;
  hashSlots: Uint32Array;
  size: number;
  find(key: string): number;
  upsert(key: string, part: number, order: number, bucket: number): number;
  setPrefixMask(index: number, mask: number): void;
  clear(): void;
};

type JobCanonFileManifest = {
  bytes: number;
  sha256: string;
  entries: number;
  aliases: number;
  canonicalEntriesSha256: string;
};

function canonicalJobCanonEntry(entry: LocaleEntry): LocaleEntry {
  const canonical: LocaleEntry = {};
  for (const locale of MANIFEST_LOCALE_ORDER) {
    if (typeof entry[locale] === 'string') canonical[locale] = entry[locale];
  }
  if (entry.alias && typeof entry.alias === 'object') {
    const alias: Partial<Record<JobCanonLocale, string>> = {};
    for (const locale of MANIFEST_LOCALE_ORDER) {
      if (typeof entry.alias[locale] === 'string') alias[locale] = entry.alias[locale];
    }
    if (Object.keys(alias).length > 0) canonical.alias = alias;
  }
  return canonical;
}

function updateCanonicalEntryDigest(
  hash: ReturnType<typeof createHash>,
  slug: string,
  entry: LocaleEntry,
): void {
  hash.update(JSON.stringify(slug));
  hash.update(':');
  hash.update(JSON.stringify(canonicalJobCanonEntry(entry)));
  hash.update('\n');
}

function countAliases(entry: LocaleEntry): number {
  if (!entry.alias) return 0;
  let count = 0;
  for (const locale of MANIFEST_LOCALE_ORDER) {
    if (typeof entry.alias[locale] === 'string') count += 1;
  }
  return count;
}

/** Section prefix the consumers join with `${slug}/`. */
function sectionPrefix(canonicalPath: string): string | null {
  const segments = canonicalPath.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return '/' + segments.slice(0, segments.length - 1).join('/');
}

function pathSlug(value: string): string {
  return value.replace(/\/+$/, '').split('/').pop() || '';
}

function registryAliasKey(locale: JobCanonLocale, slug: string): string {
  return `${locale}\u0000${slug}`;
}

function hashIndexKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

function nextPowerOfTwo(value: number): number {
  let capacity = 16;
  while (capacity < value) capacity *= 2;
  return capacity;
}

function createCompactRegistryIndex(expectedSlugs: number): CompactRegistryIndex {
  const recordCapacity = Math.max(16, expectedSlugs);
  const makeSlots = (size: number): Uint32Array =>
    new Uint32Array(nextPowerOfTwo(Math.ceil(size / 0.68)));
  let hashes = new Uint32Array(recordCapacity);
  let orders = new Uint32Array(recordCapacity);
  let parts = new Uint16Array(recordCapacity);
  let prefixMasks = new Uint8Array(recordCapacity);
  let buckets = new Uint16Array(recordCapacity);
  let hashSlots = makeSlots(recordCapacity);
  let keyOffsets = new Uint32Array(recordCapacity);
  let keyLengths = new Uint32Array(recordCapacity);
  let keyBytes = Buffer.allocUnsafe(Math.max(4096, recordCapacity * 64));
  let keyBytesLength = 0;
  const keyEncoder = new TextEncoder();
  const queryScratch = new Uint8Array(4096);
  let size = 0;

  const matchesKey = (index: number, encoded: Uint8Array, encodedLength: number): boolean => {
    const offset = keyOffsets[index];
    const length = keyLengths[index];
    return length === encodedLength
      && keyBytes.compare(encoded, 0, length, offset, offset + length) === 0;
  };

  const appendKey = (index: number, encoded: Uint8Array, encodedLength: number): void => {
    const requiredLength = keyBytesLength + encodedLength;
    if (requiredLength > keyBytes.length) {
      const next = Buffer.allocUnsafe(Math.max(requiredLength, keyBytes.length * 2));
      keyBytes.copy(next, 0, 0, keyBytesLength);
      keyBytes = next;
    }
    keyOffsets[index] = keyBytesLength;
    keyLengths[index] = encodedLength;
    for (let byteIndex = 0; byteIndex < encodedLength; byteIndex += 1) {
      keyBytes[keyBytesLength + byteIndex] = encoded[byteIndex];
    }
    keyBytesLength = requiredLength;
  };

  const findEncoded = (encoded: Uint8Array, encodedLength: number, hash: number): number => {
    let slot = hash & (hashSlots.length - 1);
    while (hashSlots[slot] !== 0) {
      const candidate = hashSlots[slot] - 1;
      if (hashes[candidate] === hash && matchesKey(candidate, encoded, encodedLength)) return candidate;
      slot = (slot + 1) & (hashSlots.length - 1);
    }
    return -1;
  };

  const find = (key: string): number => {
    const hash = hashIndexKey(key);
    const encoding = keyEncoder.encodeInto(key, queryScratch);
    if (encoding.read === key.length) return findEncoded(queryScratch, encoding.written, hash);
    const encoded = keyEncoder.encode(key);
    return findEncoded(encoded, encoded.length, hash);
  };

  const rehash = (slots: Uint32Array): void => {
    hashSlots = slots;
    for (let index = 0; index < size; index += 1) {
      let slot = hashes[index] & (hashSlots.length - 1);
      while (hashSlots[slot] !== 0) slot = (slot + 1) & (hashSlots.length - 1);
      hashSlots[slot] = index + 1;
    }
  };

  const growRecords = (): void => {
    const capacity = Math.max(16, hashes.length * 2);
    const nextHashes = new Uint32Array(capacity);
    const nextOrders = new Uint32Array(capacity);
    const nextParts = new Uint16Array(capacity);
    const nextPrefixMasks = new Uint8Array(capacity);
    const nextBuckets = new Uint16Array(capacity);
    const nextKeyOffsets = new Uint32Array(capacity);
    const nextKeyLengths = new Uint32Array(capacity);
    nextHashes.set(hashes);
    nextOrders.set(orders);
    nextParts.set(parts);
    nextPrefixMasks.set(prefixMasks);
    nextBuckets.set(buckets);
    nextKeyOffsets.set(keyOffsets);
    nextKeyLengths.set(keyLengths);
    hashes = nextHashes;
    orders = nextOrders;
    parts = nextParts;
    prefixMasks = nextPrefixMasks;
    buckets = nextBuckets;
    keyOffsets = nextKeyOffsets;
    keyLengths = nextKeyLengths;
  };

  return {
    get hashes() { return hashes; },
    get orders() { return orders; },
    get parts() { return parts; },
    get prefixMasks() { return prefixMasks; },
    get buckets() { return buckets; },
    get hashSlots() { return hashSlots; },
    get size() { return size; },
    find,
    upsert(key, part, order, bucket) {
      const hash = hashIndexKey(key);
      const encoding = keyEncoder.encodeInto(key, queryScratch);
      const encoded = encoding.read === key.length ? queryScratch : keyEncoder.encode(key);
      const encodedLength = encoding.read === key.length ? encoding.written : encoded.length;
      let slot = hash & (hashSlots.length - 1);
      while (hashSlots[slot] !== 0) {
        const candidate = hashSlots[slot] - 1;
        if (hashes[candidate] === hash && matchesKey(candidate, encoded, encodedLength)) {
          parts[candidate] = part;
          return candidate;
        }
        slot = (slot + 1) & (hashSlots.length - 1);
      }
      if (size >= hashes.length) growRecords();
      if (size + 1 > hashSlots.length * 0.68) {
        rehash(new Uint32Array(hashSlots.length * 2));
        slot = hash & (hashSlots.length - 1);
        while (hashSlots[slot] !== 0) slot = (slot + 1) & (hashSlots.length - 1);
      }
      const index = size;
      hashes[index] = hash;
      orders[index] = order;
      parts[index] = part;
      prefixMasks[index] = 0;
      buckets[index] = bucket;
      appendKey(index, encoded, encodedLength);
      hashSlots[slot] = index + 1;
      size += 1;
      return index;
    },
    setPrefixMask(index, mask) {
      prefixMasks[index] = mask;
    },
    clear() {
      size = 0;
      hashSlots = new Uint32Array(0);
      hashes = new Uint32Array(0);
      orders = new Uint32Array(0);
      parts = new Uint16Array(0);
      prefixMasks = new Uint8Array(0);
      buckets = new Uint16Array(0);
      keyBytes = Buffer.alloc(0);
      keyOffsets = new Uint32Array(0);
      keyLengths = new Uint32Array(0);
      keyBytesLength = 0;
    },
  };
}

function createStageBuffer(): StageBuffer {
  const buffer = {} as StageBuffer;
  buffer.rows = 0;
  for (const operation of STAGE_OPERATIONS) buffer[operation] = new Map();
  return buffer;
}

function stageValue(
  buffer: StageBuffer,
  operation: StageOperation,
  key: string,
  line: string,
): void {
  const bucket = buffer[operation].get(key);
  if (bucket) bucket.push(line);
  else buffer[operation].set(key, [line]);
  buffer.rows += 1;
}

function flushStageBuffer(stageDir: string, buffer: StageBuffer): void {
  for (const operation of STAGE_OPERATIONS) {
    const byBucket = buffer[operation];
    for (const [key, records] of byBucket) {
      if (records.length === 0) continue;
      const directory = path.join(stageDir, 'v2', operation);
      fs.mkdirSync(directory, { recursive: true });
      fs.appendFileSync(path.join(directory, `${key}.jsonl`), records.join(''), 'utf8');
    }
  }
}

function clearStageBuffer(buffer: StageBuffer): void {
  for (const operation of STAGE_OPERATIONS) buffer[operation].clear();
  buffer.rows = 0;
}

async function readStagedJobs(file: string): Promise<ActiveJobSlugMapRow[]> {
  const jobs: ActiveJobSlugMapRow[] = [];
  if (!fs.existsSync(file)) return jobs;
  const reader = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line) continue;
    const row: unknown = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`[job-canon-redirect-map] invalid active-job stage row in ${path.basename(file)}`);
    }
    jobs.push(row as ActiveJobSlugMapRow);
  }
  return jobs;
}

function hasTopLevelJsonArrayStart(file: string): boolean {
  const descriptor = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(16 * 1024);
  let position = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, position);
      if (bytesRead === 0) return false;
      position += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = chunk[index];
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
        return byte === 0x5b;
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function forEachStagedLine(
  file: string,
  visit: (slug: string, locale: JobCanonLocale, value: string, order: number) => void,
): void {
  if (!fs.existsSync(file)) return;
  const input = fs.readFileSync(file);
  let offset = 0;
  while (offset < input.length) {
    const newline = input.indexOf(0x0a, offset);
    const end = newline < 0 ? input.length : newline;
    if (end > offset) {
      const first = input.indexOf(0x09, offset);
      const second = first < end ? input.indexOf(0x09, first + 1) : -1;
      const third = second < end ? input.indexOf(0x09, second + 1) : -1;
      if (first > offset && second > first && third > second && third < end) {
        const locale = input.toString('ascii', first + 1, second) as JobCanonLocale;
        const order = Number(input.toString('ascii', second + 1, third));
        if (LOCALE_INDEX.has(locale) && Number.isSafeInteger(order)) {
          visit(
            input.toString('utf8', offset, first),
            locale,
            input.toString('utf8', third + 1, end),
            order,
          );
        }
      }
    }
    offset = newline < 0 ? input.length : newline + 1;
  }
}

function recordLine(slug: string, locale: JobCanonLocale, value: string, order = 0): string {
  return `${slug}\t${locale}\t${order}\t${value}\n`;
}

function entryFor(bucket: Record<string, LocaleEntry>, slug: string): LocaleEntry {
  let entry = bucket[slug];
  if (!entry) {
    entry = Object.create(null) as LocaleEntry;
    bucket[slug] = entry;
  }
  return entry;
}

function isGermanLegacyNonRoutablePrefix(prefix: string): boolean {
  if (!prefix.startsWith('/de/jobs-im-') || prefix === SECTION_LEGACY_TI_ROOT.de) return false;
  const section = prefix.split('/').pop() || '';
  return resolveCantonFromSection('de', section) === null;
}

/**
 * Routable form of a German job-canon prefix. A legacy `/de/jobs-im-<canton>`
 * prefix that the site cannot route becomes its canonical `/de/jobs-in-<canton>`
 * section when the canton is known; an unknown legacy prefix yields null (no
 * redirect is better than a 301 to a 404). Routable prefixes pass unchanged.
 */
export function routableGermanJobCanonPrefix(prefix: string): string | null {
  if (!isGermanLegacyNonRoutablePrefix(prefix)) return prefix;
  const canonical = resolveLegacyGermanSectionPath(prefix)?.canonicalPath;
  return canonical ? canonical.replace(/\/+$/, '') : null;
}

export function assertMaxShardGrowthWithinPercent(
  baselineShardBytes: readonly number[],
  currentShardBytes: readonly number[],
  maximumGrowthPercent: number,
): number {
  let baselineMaximum = 0;
  let currentMaximum = 0;
  for (const bytes of baselineShardBytes) baselineMaximum = Math.max(baselineMaximum, bytes);
  for (const bytes of currentShardBytes) currentMaximum = Math.max(currentMaximum, bytes);
  const growthPercent = baselineMaximum === 0
    ? (currentMaximum === 0 ? 0 : Number.POSITIVE_INFINITY)
    : ((currentMaximum - baselineMaximum) / baselineMaximum) * 100;
  if (growthPercent > maximumGrowthPercent) {
    throw new Error(
      `maximum job-canon shard grew ${growthPercent.toFixed(2)}%, above ${maximumGrowthPercent}%`,
    );
  }
  return growthPercent;
}

function summarizeBytes(values: readonly number[]): { count: number; total: number; max: number; median: number } {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length === 0
    ? 0
    : ordered.length % 2 === 1
      ? ordered[middle]
      : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
  return {
    count: values.length,
    total: values.reduce((sum, value) => sum + value, 0),
    max: ordered.at(-1) ?? 0,
    median,
  };
}

/** Read BUILD_JOB_CANON_ORDERING_HANDOFF_PATH and restore it; every failure names the path. */
export function restoreJobCanonOrderingHandoffFromEnv(): void {
  const handoffPath = process.env.BUILD_JOB_CANON_ORDERING_HANDOFF_PATH;
  if (!handoffPath) {
    throw new Error('[job-canon-redirect-map] staged SSG build requires BUILD_JOB_CANON_ORDERING_HANDOFF_PATH (the bundle ordering-fields handoff)');
  }
  if (!fs.existsSync(handoffPath)) {
    throw new Error(`[job-canon-redirect-map] ordering fields handoff missing at ${handoffPath}: the bundle stage did not write it`);
  }
  let serialized: string;
  try {
    serialized = fs.readFileSync(handoffPath, 'utf8');
  } catch (error) {
    throw new Error(`[job-canon-redirect-map] ordering fields handoff unreadable at ${handoffPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    restoreJobCanonOrderingFields(serialized);
  } catch (error) {
    throw new Error(`[job-canon-redirect-map] ordering fields handoff malformed at ${handoffPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isNoJobsBuild(rootDir: string): boolean {
  const dataDir = path.resolve(rootDir, 'data');
  return fs.existsSync(dataDir)
    && fs.statSync(dataDir).isDirectory()
    && !fs.existsSync(path.join(dataDir, 'jobs.json'));
}

export function jobCanonRedirectMapPlugin(rootDir: string): Plugin {
  return {
    name: 'job-canon-redirect-map',
    apply: 'build',
    enforce: 'post',
    // Staged build (BUILD_STAGE=ssg, the second Vite process): restore the ordering
    // fields written by localeJobsSplitPlugin in the first process before any SSG work.
    buildStart() {
      if (process.env.BUILD_STAGE !== 'ssg' || process.env.BUILD_LOCALE !== 'it') return;
      // An initialized data directory with no jobs.json is the no-jobs input.
      // A fixture root without data/ has no dataset signal, so keep requiring
      // the staged handoff instead of silently classifying it as no jobs.
      if (isNoJobsBuild(rootDir)) {
        clearJobCanonOrderingFields();
        return;
      }
      restoreJobCanonOrderingHandoffFromEnv();
    },
    async closeBundle() {
      const buildLocale = (process.env.BUILD_LOCALE ?? '').trim();
      const ownsWorkerMap = buildLocale === '' || buildLocale === 'it';
      const buildStage = process.env.BUILD_STAGE || 'single';
      const distDir = path.resolve(rootDir, 'dist');
      if (ownsWorkerMap && isNoJobsBuild(rootDir)) {
        console.log(
          '[job-canon-redirect-map] data/jobs.json missing; skipping Worker map generation',
        );
        clearJobCanonOrderingFields();
        return;
      }

      const jobsSeoProducerExpected = shouldAwaitJobsSeoPagesFlushed();
      const activePagesManifestExpected = shouldRequireJobsSeoActivePageManifest();
      if (jobsSeoProducerExpected) {
        console.log('[job-canon-redirect-map] waiting for jobs SEO to flush the reconciled Worker slug map');
        await jobsSeoPagesFlushed;
      }

      if (!fs.existsSync(distDir)) {
        if (ownsWorkerMap) {
          const slugMapPath = path.join(distDir, 'data', 'jobs-slug-map.json');
          throw new Error(
            `[job-canon-redirect-map] ${buildLocale === '' ? 'all-locale build' : 'BUILD_LOCALE=it'} `
            + `requires ${path.relative(rootDir, slugMapPath)} from jobsSeoPagesPlugin`,
          );
        }
        return;
      }
      if (!ownsWorkerMap) {
        console.log(
          `[job-canon-redirect-map] BUILD_LOCALE=${buildLocale} does not own the Worker map; `
          + 'the IT or all-locale build emits it',
        );
        clearJobCanonOrderingFields();
        return;
      }
      console.log(`[job-canon-redirect-map] Worker map owner=${buildLocale || 'all-locale'}`);

      // Production runs after jobsSeoPagesPlugin and consumes its exact active
      // page inventory.  This prevents a current slug from overwriting the
      // registry with a canton prefix whose destination was not published.
      // Isolated plugin fixtures have no registered producer and retain their
      // self-contained input contract. Fast-lane producers register only the
      // flush barrier and are handled below without granting new prefixes.
      let activeJobPageLookup: ReturnType<typeof createJobPagesManifestLookup> | null = null;
      if (activePagesManifestExpected) {
        const activePagesManifestPath = path.join(distDir, JOB_PAGES_MANIFEST_FILE);
        if (!fs.existsSync(activePagesManifestPath)) {
          throw new Error(
            `[job-canon-redirect-map] jobs SEO completed without ${path.relative(rootDir, activePagesManifestPath)}`,
          );
        }
        const activePagesManifest = JSON.parse(fs.readFileSync(activePagesManifestPath, 'utf8')) as unknown;
        if (!isCompleteActivePageManifest(activePagesManifest)) {
          throw new Error(
            `[job-canon-redirect-map] ${path.relative(rootDir, activePagesManifestPath)} is incomplete`,
          );
        }
        activeJobPageLookup = createJobPagesManifestLookup(activePagesManifest);
        if (!activeJobPageLookup) {
          throw new Error(
            `[job-canon-redirect-map] ${path.relative(rootDir, activePagesManifestPath)} is malformed`,
          );
        }
      }

      let orderingFieldsById = getJobCanonOrderingFields();
      if (!orderingFieldsById && process.env.BUILD_STAGE === 'ssg') {
        // Second defence: buildStart normally restored it.
        restoreJobCanonOrderingHandoffFromEnv();
        orderingFieldsById = getJobCanonOrderingFields();
      }
      if (!orderingFieldsById) {
        throw new Error('[job-canon-redirect-map] localeJobsSplitPlugin did not provide ordering fields in this Vite process');
      }

      let peakHeapUsed = process.memoryUsage().heapUsed;
      let peakHeapPhase = 'start';
      let currentHeapPhase = 'initialization';
      const heapCheckpoints: Record<string, number> = { start: peakHeapUsed };
      const heapPeakByPhase: Record<string, number> = {};
      const sampleHeap = (phase = currentHeapPhase): void => {
        const used = process.memoryUsage().heapUsed;
        heapPeakByPhase[phase] = Math.max(heapPeakByPhase[phase] ?? 0, used);
        if (used > peakHeapUsed) {
          peakHeapUsed = used;
          peakHeapPhase = phase;
        }
      };
      const markHeap = (phase: string): void => {
        currentHeapPhase = phase;
        const used = process.memoryUsage().heapUsed;
        heapPeakByPhase[phase] = Math.max(heapPeakByPhase[phase] ?? 0, used);
        if (used > peakHeapUsed) {
          peakHeapUsed = used;
          peakHeapPhase = phase;
        }
        heapCheckpoints[phase] = used;
      };
      const collectGarbage = (): void => {
        const explicitGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
        explicitGc?.();
      };

      const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-canon-stage-'));
      let expectedSlugs = 0;
      try {
        const manifestPath = knownSlugsManifestFile(rootDir);
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { totalSlugs?: unknown };
          if (Number.isSafeInteger(manifest.totalSlugs) && Number(manifest.totalSlugs) > 0) {
            expectedSlugs = Number(manifest.totalSlugs);
          }
        }
      } catch {
        // A missing or stale manifest is handled by bounded index growth.
      }
      let slugIndex: CompactRegistryIndex | null = createCompactRegistryIndex(expectedSlugs);
      const newBuffer = (): StageBuffer => createStageBuffer();
      let stagedRecordCount = 0;

      const pushRecord = (
        buffer: StageBuffer,
        operation: StageOperation,
        slug: string,
        locale: JobCanonLocale,
        value: string,
        order = 0,
      ): void => {
        const indexedSlug = slugIndex?.find(slug) ?? -1;
        const v2 = (indexedSlug < 0
          ? jobSlugShardIndexForCount(slug, V2_BUCKET_COUNT)
          : slugIndex!.buckets[indexedSlug])
          .toString(16).padStart(3, '0');
        const line = recordLine(slug, locale, value, order);
        stageValue(buffer, operation, v2, line);
        stagedRecordCount += 1;
        if (buffer.rows >= 8192) {
          flushAll(buffer);
          clearStageBuffer(buffer);
        }
      };

      const flushAll = (buffer: StageBuffer): void => flushStageBuffer(stageDir, buffer);

      try {
        // Phase (a): index slug→bucket, plus compact precedence fields. The
        // values are discarded after each store part has been inspected.
        currentHeapPhase = 'phase-a-index-build';
        let registryKeys = 0;
        let registryParts = 0;
        let currentPartIndex = -1;
        let nextRegistryOrder = 0;
        for (const [key, , entryPartIndex] of iterateAllKnownJobSlugPartEntries(rootDir, { keysOnly: true })) {
          if (entryPartIndex !== currentPartIndex) {
            currentPartIndex = entryPartIndex;
            registryParts += 1;
            sampleHeap();
          }
          registryKeys += 1;
          const previous = slugIndex!.find(key);
          const order = previous < 0 ? nextRegistryOrder++ : slugIndex!.orders[previous];
          slugIndex!.upsert(key, entryPartIndex, order, jobSlugShardIndexForCount(key, V2_BUCKET_COUNT));
        }
        sampleHeap();
        markHeap('phase-a-index-built');
        console.log(
          `[job-canon-redirect-map] phase a: registryKeys=${registryKeys}, indexedSlugs=${slugIndex!.size}, `
          + `registryParts=${registryParts}, heap=${heapCheckpoints['phase-a-index-built']}`,
        );

        // Phase (b1): stream winning parts into bucket logs and retain only a
        // locale bitmask for registry slugs that already have a real prefix.
        currentHeapPhase = 'phase-b1-prefix-staging';
        registryParts = 0;
        currentPartIndex = -1;
        let prefixBuffer = newBuffer();
        for (const [key, paths, entryPartIndex] of iterateAllKnownJobSlugPartEntries(rootDir)) {
          if (entryPartIndex !== currentPartIndex) {
            if (currentPartIndex >= 0) {
              flushAll(prefixBuffer);
              clearStageBuffer(prefixBuffer);
              collectGarbage();
            }
            currentPartIndex = entryPartIndex;
            registryParts += 1;
            prefixBuffer = newBuffer();
            sampleHeap();
          }
          const slugIndexEntry = slugIndex!.find(key);
          if (slugIndexEntry < 0 || slugIndex!.parts[slugIndexEntry] !== entryPartIndex) continue;
          if (!paths || typeof paths !== 'object') continue;
          const order = slugIndex!.orders[slugIndexEntry];
          for (const locale of JOB_CANON_LOCALES) {
            const value = paths[locale];
            if (typeof value !== 'string') continue;
            const target = value.replace(/\/+$/, '');
            const targetSlug = pathSlug(target);
            if (!targetSlug) continue;
            const prefix = sectionPrefix(target);
            if (!prefix) continue;
            pushRecord(prefixBuffer, 'prefix', targetSlug, locale, prefix, order);
            const targetIndex = slugIndex!.find(targetSlug);
            if (targetIndex >= 0) {
              const localeBit = 1 << LOCALE_INDEX.get(locale)!;
              slugIndex!.setPrefixMask(targetIndex, slugIndex!.prefixMasks[targetIndex] | localeBit);
            }
          }
        }
        if (currentPartIndex >= 0) {
          flushAll(prefixBuffer);
          clearStageBuffer(prefixBuffer);
          collectGarbage();
        }
        sampleHeap();
        markHeap('phase-b1-prefixes-staged');

        // Phase (b2): aliases follow every prefix and are omitted if any
        // source record already resolves the registry slug in that locale.
        currentHeapPhase = 'phase-b2-alias-staging';
        currentPartIndex = -1;
        let aliasBuffer = newBuffer();
        for (const [key, paths, entryPartIndex] of iterateAllKnownJobSlugPartEntries(rootDir)) {
          if (entryPartIndex !== currentPartIndex) {
            if (currentPartIndex >= 0) {
              flushAll(aliasBuffer);
              clearStageBuffer(aliasBuffer);
              collectGarbage();
            }
            currentPartIndex = entryPartIndex;
            aliasBuffer = newBuffer();
            sampleHeap();
          }
          const slugIndexEntry = slugIndex!.find(key);
          if (slugIndexEntry < 0 || slugIndex!.parts[slugIndexEntry] !== entryPartIndex) continue;
          if (!paths || typeof paths !== 'object') continue;
          const order = slugIndex!.orders[slugIndexEntry];
          for (const locale of JOB_CANON_REGISTRY_ALIAS_LOCALES) {
            const value = paths[locale];
            if (typeof value !== 'string') continue;
            const target = value.replace(/\/+$/, '');
            const targetSlug = pathSlug(target);
            if (!targetSlug || targetSlug === key || !sectionPrefix(target)) continue;
            const localeBit = 1 << LOCALE_INDEX.get(locale)!;
            if ((slugIndex!.prefixMasks[slugIndexEntry] & localeBit) !== 0) continue;
            pushRecord(aliasBuffer, 'registry-alias', key, locale, target, order);
          }
        }
        if (currentPartIndex >= 0) {
          flushAll(aliasBuffer);
          clearStageBuffer(aliasBuffer);
          collectGarbage();
        }
        sampleHeap();
        slugIndex!.clear();
        slugIndex = null;
        markHeap('phase-b-registry-staged');
        console.log(
          `[job-canon-redirect-map] phase b registry: parts=${registryParts}, records=${stagedRecordCount}, `
          + `heap=${heapCheckpoints['phase-b-registry-staged']}`,
        );

        const slugMapPath = path.join(distDir, 'data', 'jobs-slug-map.json');
        const activeAliasStats: ActiveJobAliasStats = {
          candidateGroups: 0,
          realPageGroups: 0,
          existingRegistryAliasGroups: 0,
          ambiguousCantonGroups: 0,
          autoAliasGroups: 0,
          chainGroups: 0,
          emittedAliases: 0,
          aliasesByLocale: { it: 0, en: 0, de: 0, fr: 0 },
          ambiguousExamples: [],
        };
        const activePrefixStats = {
          changedByLocale: { it: 0, en: 0, de: 0, fr: 0 },
          addedByLocale: { it: 0, en: 0, de: 0, fr: 0 },
          removedUnpublishedByLocale: { it: 0, en: 0, de: 0, fr: 0 },
          nonRoutableGermanChanged: 0,
          nonRoutableGermanRewritten: 0,
          nonRoutableGermanDropped: 0,
          activeSlugPrefixConflict: 0,
          conflictExamples: [] as Array<{ locale: JobCanonLocale; slug: string; prefixes: string[] }>,
          nonRoutableGermanDroppedExamples: [] as Array<{ slug: string; prefix: string }>,
        };

        if (ownsWorkerMap) {
          if (!fs.existsSync(slugMapPath)) {
            throw new Error(
              `[job-canon-redirect-map] ${buildLocale === '' ? 'all-locale build' : 'BUILD_LOCALE=it'} `
              + `requires ${path.relative(rootDir, slugMapPath)} from jobsSeoPagesPlugin`,
            );
          }
          if (!hasTopLevelJsonArrayStart(slugMapPath)) {
            throw new Error(
              `[job-canon-redirect-map] ${path.relative(rootDir, slugMapPath)} must contain an array`,
            );
          }
          markHeap('active-slug-map-stream-started');

          const {
            buildReservedHubSlugs,
            compareActiveJobsByStableOrder,
          } = await import('./jobsSeoPagesPlugin');
          const activeJobsBuffer = newBuffer();
          const stageBuffer = newBuffer();
          const workerFlagsBySlug = new Map<string, number>();
          const nativeTargetsByRouteSlug = new Map<string, Array<[string, number]>>();
          const nativeContributionCounts = new Map<string, number>();
          const nativeContributionKey = (slug: string, localeBit: number): string => localeBit + ':' + slug;
          const changeNativeContribution = (slug: string, localeBit: number, delta: 1 | -1): void => {
            const contributionKey = nativeContributionKey(slug, localeBit);
            const count = (nativeContributionCounts.get(contributionKey) ?? 0) + delta;
            if (count > 0) nativeContributionCounts.set(contributionKey, count);
            else nativeContributionCounts.delete(contributionKey);
            const nativeBit = 1 << (localeBit + 8);
            const flags = workerFlagsBySlug.get(slug) ?? 0;
            workerFlagsBySlug.set(slug, count > 0 ? flags | nativeBit : flags & ~nativeBit);
          };
          const addWorkerSlugFlags = (slug: string, flags: number): void => {
            workerFlagsBySlug.set(slug, (workerFlagsBySlug.get(slug) ?? 0) | flags);
          };
          let activeJobCount = 0;
          currentHeapPhase = 'active-prefix-staging';
          let activePrefixRows = 0;
          let activePrefixBufferRows = 0;
          let stagedActiveJobRows = 0;
          for (const rawJob of iterateJsonArrayFile(slugMapPath)) {
            if (!rawJob || typeof rawJob !== 'object' || Array.isArray(rawJob)) {
              throw new Error(
                `[job-canon-redirect-map] ${path.relative(rootDir, slugMapPath)} must contain only object rows`,
              );
            }
            const job = rawJob as ActiveJobSlugMapRow;
            const stableId = String(job.id || job.slug || '').trim();
            const orderingFields = stableId ? orderingFieldsById.get(stableId) : undefined;
            if (!orderingFields) {
              const sourceName = buildStage === 'ssg' ? 'build handoff' : 'in-memory ordering fields';
              throw new Error(`[job-canon-redirect-map] slug map and ${sourceName} do not match`);
            }
            activeJobCount += 1;
            const bucketIndexes = new Set<number>();
            const trackSlugBucket = (slug: unknown): void => {
              if (typeof slug === 'string' && slug) {
                bucketIndexes.add(jobSlugShardIndexForCount(slug, V2_BUCKET_COUNT));
              }
            };
            const slugsForBucket = (values: unknown, bucketIndex: number): string[] => {
              if (!Array.isArray(values)) return [];
              const matching: string[] = [];
              for (const value of values) {
                if (
                  typeof value === 'string'
                  && value
                  && jobSlugShardIndexForCount(value, V2_BUCKET_COUNT) === bucketIndex
                ) matching.push(value);
              }
              return matching;
            };
            if (typeof job.slug === 'string' && job.slug) {
              addWorkerSlugFlags(job.slug, WORKER_CANDIDATE_FLAG | WORKER_ACTIVE_ROUTE_FLAG);
              trackSlugBucket(job.slug);
            }
            const canton = resolveJobCanton(job);
            for (const locale of JOB_CANON_LOCALES) {
              const currentSlug = localizedActiveJobSlug(job, locale);
              if (currentSlug) {
                addWorkerSlugFlags(
                  currentSlug,
                  WORKER_CANDIDATE_FLAG
                    | WORKER_ACTIVE_ROUTE_FLAG
                    | (1 << (LOCALE_INDEX.get(locale)! + WORKER_CURRENT_IN_LOCALE_SHIFT)),
                );
                trackSlugBucket(currentSlug);
                const currentPath = buildCanonicalJobDetailPath(locale, job, currentSlug, canton);
                const prefix = sectionPrefix(currentPath);
                if (prefix) {
                  // A complete manifest may positively add or negatively
                  // remove a prefix. A registered fast-lane/sync producer has
                  // only a partial inventory: preserve the registry entry and
                  // stage neither assertion. Isolated plugin invocations keep
                  // their self-contained legacy contract.
                  const operation = activeJobPageLookup !== null
                    ? (activeJobPageLookup.has(currentPath) ? 'active-prefix' : 'active-prefix-remove')
                    : (!jobsSeoProducerExpected ? 'active-prefix' : null);
                  if (operation) {
                    pushRecord(stageBuffer, operation, currentSlug, locale, prefix);
                    activePrefixRows += 1;
                    activePrefixBufferRows += 1;
                    if (activePrefixBufferRows >= 8192) {
                      flushAll(stageBuffer);
                      clearStageBuffer(stageBuffer);
                      activePrefixBufferRows = 0;
                    }
                  }
                }
              }
              const previousByLocale = job.previousSlugsByLocale;
              const oldSlugs = previousByLocale && typeof previousByLocale === 'object'
                ? previousByLocale[locale]
                : undefined;
              if (Array.isArray(oldSlugs)) {
                for (const oldSlug of oldSlugs) {
                  if (typeof oldSlug === 'string' && oldSlug) {
                    addWorkerSlugFlags(oldSlug, WORKER_CANDIDATE_FLAG);
                    trackSlugBucket(oldSlug);
                  }
                }
              }
            }
            const previousSlugs = job.previousSlugs;
            if (Array.isArray(previousSlugs)) {
              for (const oldSlug of previousSlugs) trackSlugBucket(oldSlug);
            }
            for (const bucketIndex of bucketIndexes) {
              const projectedJob: ActiveJobSlugMapRow = {
                id: job.id,
                slug: job.slug,
                slugByLocale: job.slugByLocale,
                titleByLocale: job.titleByLocale,
                title: job.title,
                company: job.company,
                location: job.location,
                canton: job.canton,
                datePosted: orderingFields.datePosted !== undefined
                  ? orderingFields.datePosted
                  : job.datePosted,
                firstSeenAt: orderingFields.firstSeenAt !== undefined
                  ? orderingFields.firstSeenAt
                  : job.firstSeenAt,
              };
              const projectedPreviousSlugs = slugsForBucket(job.previousSlugs, bucketIndex);
              if (projectedPreviousSlugs.length > 0) projectedJob.previousSlugs = projectedPreviousSlugs;
              const previousByLocale = job.previousSlugsByLocale;
              if (previousByLocale && typeof previousByLocale === 'object') {
                const projectedByLocale = Object.create(null) as Record<string, unknown>;
                for (const localeKey of Object.keys(previousByLocale)) {
                  const projectedSlugs = slugsForBucket(
                    (previousByLocale as Record<string, unknown>)[localeKey],
                    bucketIndex,
                  );
                  if (projectedSlugs.length > 0) projectedByLocale[localeKey] = projectedSlugs;
                }
                if (Object.keys(projectedByLocale).length > 0) {
                  projectedJob.previousSlugsByLocale = projectedByLocale;
                }
              }
              const bucketKey = bucketIndex.toString(16).padStart(3, '0');
              stageValue(activeJobsBuffer, 'active-job', bucketKey, `${JSON.stringify(projectedJob)}\n`);
              if (activeJobsBuffer.rows >= 2048) {
                flushAll(activeJobsBuffer);
                clearStageBuffer(activeJobsBuffer);
              }
            }
            bucketIndexes.clear();
            stagedActiveJobRows += 1;
            if (stagedActiveJobRows % 128 === 0) {
              sampleHeap('active-slug-map-streaming');
              collectGarbage();
              sampleHeap('active-slug-map-streaming');
            }
          }
          flushAll(stageBuffer);
          clearStageBuffer(stageBuffer);
          flushAll(activeJobsBuffer);
          clearStageBuffer(activeJobsBuffer);
          orderingFieldsById = null;
          clearJobCanonOrderingFields();
          collectGarbage();
          markHeap('active-slug-map-streamed');
          markHeap('active-jobs-staged');
          markHeap('active-prefixes-staged');
          console.log(
            `[job-canon-redirect-map] active input: jobs=${activeJobCount}, currentPrefixes=${activePrefixRows}, `
            + `crossLocaleCandidates=${workerFlagsBySlug.size}, heap=${heapCheckpoints['active-prefixes-staged']}`,
          );

          // Collect only the compact lookup facts that the existing SEO
          // predicate needs for cross-locale paths. This scan runs after the
          // key index has been released and never materializes registry rows.
          const legacyRoots = SECTION_LEGACY_TI_ROOT;
          let scannedPartCount = 0;
          let workerPartIndex = -1;
          currentHeapPhase = 'worker-recovery-index';
          for (const [key, paths, entryPartIndex] of iterateAllKnownJobSlugPartEntries(rootDir)) {
            if (entryPartIndex !== workerPartIndex) {
              workerPartIndex = entryPartIndex;
              scannedPartCount += 1;
              sampleHeap();
            }
            const previousNativeTargets = nativeTargetsByRouteSlug.get(key);
            if (previousNativeTargets) {
              for (const [targetSlug, localeBit] of previousNativeTargets) {
                changeNativeContribution(targetSlug, localeBit, -1);
              }
              nativeTargetsByRouteSlug.delete(key);
            }
            let keyCandidateFlags = workerFlagsBySlug.get(key) ?? 0;
            if ((keyCandidateFlags & WORKER_CANDIDATE_FLAG) !== 0) {
              // A later store part replaces this slug's complete locale map.
              // The iterator can also observe duplicate JSON keys, whose last
              // value wins under JSON.parse. Reset direct and native facts for
              // this source map; restore native facts still contributed by other
              // route keys before preserving route/candidate identity.
              keyCandidateFlags = workerFlagsBySlug.get(key) ?? keyCandidateFlags;
              keyCandidateFlags &= ~WORKER_REPLACED_MAP_FACT_MASK;
              for (const locale of JOB_CANON_LOCALES) {
                const localeBit = LOCALE_INDEX.get(locale)!;
                if ((nativeContributionCounts.get(nativeContributionKey(key, localeBit)) ?? 0) > 0) {
                  keyCandidateFlags |= 1 << (localeBit + 8);
                }
              }
              workerFlagsBySlug.set(key, keyCandidateFlags);
            }
            if (!paths || typeof paths !== 'object') continue;
            const nativeTargets: Array<[string, number]> = [];
            for (const locale of JOB_CANON_LOCALES) {
              const value = paths[locale];
              if (typeof value !== 'string') continue;
              const target = value.replace(/\/+$/, '');
              const targetSlug = pathSlug(target);
              if (!targetSlug) continue;
              const prefix = sectionPrefix(target);
              if (!prefix) continue;
              if (locale === 'it') continue;
              if ((keyCandidateFlags & WORKER_CANDIDATE_FLAG) !== 0) {
                const localeBit = LOCALE_INDEX.get(locale)!;
                const directExistsBit = 1 << localeBit;
                const directIsTiBit = 1 << (localeBit + 4);
                let flags = workerFlagsBySlug.get(key) ?? 0;
                // A registry path whose last segment is another slug is served
                // by the Worker as a verified same-locale alias, so the Worker
                // really recovers it. A path that ends in this very slug is the
                // requested URL itself: the Worker's prefix lookup lands on the
                // same path (canonical === request, no redirect) and falls to
                // the section hub, unless a page exists there. Nothing in this
                // build guarantees that page for a candidate slug, so that
                // shape is not recovery and the active alias must be emitted
                // (it also replaces the stale identity prefix).
                if (targetSlug !== key) flags |= directExistsBit;
                else flags &= ~directExistsBit;
                if (target === `${legacyRoots[locale]}/${key}`) flags |= directIsTiBit;
                else flags &= ~directIsTiBit;
                workerFlagsBySlug.set(key, flags);
              }
              const targetCandidateFlags = workerFlagsBySlug.get(targetSlug) ?? 0;
              const targetLocaleBit = LOCALE_INDEX.get(locale)!;
              if (
                (keyCandidateFlags & WORKER_ACTIVE_ROUTE_FLAG) !== 0
                && (targetCandidateFlags & WORKER_CANDIDATE_FLAG) !== 0
                // The Worker's 301 to this native path only helps when a page
                // is served there: the target slug must be an active job's
                // current slug in THIS locale. A registry path that still
                // carries another locale's slug (or a retired one) is stale;
                // treating it as recovery left the alias unemitted and the
                // request ended on the section hub.
                && (targetCandidateFlags & (1 << (targetLocaleBit + WORKER_CURRENT_IN_LOCALE_SHIFT))) !== 0
              ) {
                // buildNativeJobPrefixIndex excludes IT, and skips only the
                // exact one-slug legacy TI path. Its last non-TI prefix wins.
                if (prefix !== legacyRoots[locale]) {
                  const localeBit = targetLocaleBit;
                  changeNativeContribution(targetSlug, localeBit, 1);
                  nativeTargets.push([targetSlug, localeBit]);
                }
              }
            }
            if (nativeTargets.length > 0) nativeTargetsByRouteSlug.set(key, nativeTargets);
          }
          markHeap('worker-recovery-index-built');
          // Collapse the staging bits into only the locale mask needed by the
          // cross-locale predicate. Entries with no recovery path are dropped.
          for (const [slug, flags] of workerFlagsBySlug) {
            let recoverLocales = 0;
            for (const locale of JOB_CANON_LOCALES) {
              const localeBit = LOCALE_INDEX.get(locale)!;
              const directExists = (flags & (1 << localeBit)) !== 0;
              const directIsTi = (flags & (1 << (localeBit + 4))) !== 0;
              const nativeNonTi = (flags & (1 << (localeBit + 8))) !== 0;
              if ((directExists && !directIsTi) || nativeNonTi) recoverLocales |= 1 << localeBit;
            }
            if (recoverLocales === 0) workerFlagsBySlug.delete(slug);
            else workerFlagsBySlug.set(slug, recoverLocales);
          }
          nativeTargetsByRouteSlug.clear();
          nativeContributionCounts.clear();
          collectGarbage();
          markHeap('worker-recovery-index-compacted');
          console.log(
            `[job-canon-redirect-map] worker recovery index: parts=${scannedPartCount}, `
            + `recoverableSlugs=${workerFlagsBySlug.size}, heap=${heapCheckpoints['worker-recovery-index-compacted']}`,
          );

          const winners = loadWinners(path.resolve(rootDir, 'data', 'previous-slug-winners.json'));
          const pendingActiveAliases = newBuffer();
          let activeAliasBufferRows = 0;
          const activeAliasExampleKeys = new Set<string>();
          const flushActiveAliases = (): void => {
            flushAll(pendingActiveAliases);
            clearStageBuffer(pendingActiveAliases);
            activeAliasBufferRows = 0;
          };
          const reservedHubSlugs = buildReservedHubSlugs();
          for (let bucketIndex = 0; bucketIndex < V2_BUCKET_COUNT; bucketIndex += 1) {
            const bucketKey = bucketIndex.toString(16).padStart(3, '0');
            const activeJobsFile = path.join(stageDir, 'v2', 'active-job', `${bucketKey}.jsonl`);
            if (!fs.existsSync(activeJobsFile)) continue;
            const bucketJobs = await readStagedJobs(activeJobsFile);
            bucketJobs.sort(compareActiveJobsByStableOrder);
            const bucketRegistryAliases = new Set<string>();
            const aliasFile = path.join(stageDir, 'v2', 'registry-alias', `${bucketKey}.jsonl`);
            forEachStagedLine(aliasFile, (slug, locale) => {
              bucketRegistryAliases.add(registryAliasKey(locale, slug));
            });
            const bucketStats = emitActiveJobCanonAliases(bucketJobs, {
              winners,
              bucketIndex,
              reservedHubSlugs,
              entryForSlug: () => undefined,
              hasRegistryAlias: (slug, locale) => bucketRegistryAliases.has(registryAliasKey(locale, slug)),
              workerWouldRecover: (locale, slug) => {
                if (locale === 'it') return false;
                const flags = workerFlagsBySlug.get(slug) ?? 0;
                const localeBit = LOCALE_INDEX.get(locale)!;
                return (flags & (1 << localeBit)) !== 0;
              },
              canWriteCrossLocalePath: (bridgePath) => {
                const relPath = bridgePath.replace(/^\/+|\/+$/g, '');
                return !isDistPathOverFilesystemLimits(relPath)
                  && isSafeDistPath(relPath)
                  && getSafeDistPageTargets(distDir, relPath) !== null;
              },
              emitAlias: (slug, locale, targetPath) => {
                pushRecord(pendingActiveAliases, 'active-alias', slug, locale, targetPath);
                activeAliasBufferRows += 1;
                if (activeAliasBufferRows >= 8192) flushActiveAliases();
              },
              onHeapSample: () => sampleHeap('active-aliases'),
            });
            for (const field of [
              'candidateGroups',
              'realPageGroups',
              'existingRegistryAliasGroups',
              'ambiguousCantonGroups',
              'autoAliasGroups',
              'chainGroups',
              'emittedAliases',
            ] as const) {
              activeAliasStats[field] += bucketStats[field];
            }
            for (const locale of JOB_CANON_LOCALES) {
              activeAliasStats.aliasesByLocale[locale] += bucketStats.aliasesByLocale[locale];
            }
            for (const example of bucketStats.ambiguousExamples) {
              if (activeAliasStats.ambiguousExamples.length >= 3) break;
              const exampleKey = registryAliasKey(example.locale, example.slug);
              if (activeAliasExampleKeys.has(exampleKey)) continue;
              activeAliasExampleKeys.add(exampleKey);
              activeAliasStats.ambiguousExamples.push(example);
            }
            flushActiveAliases();
            bucketRegistryAliases.clear();
            bucketJobs.length = 0;
            fs.rmSync(activeJobsFile, { force: true });
            if ((bucketIndex + 1) % 32 === 0) collectGarbage();
            sampleHeap('active-alias-bucket-released');
          }
          flushActiveAliases();
          markHeap('active-aliases-staged');
          console.log(
            `[job-canon-redirect-map] active aliases: ${JSON.stringify(activeAliasStats)}, `
            + `heap=${heapCheckpoints['active-aliases-staged']}`,
          );

          // Release every input/index structure before output bucket objects
          // and JSON strings are allocated.
          workerFlagsBySlug.clear();
          nativeTargetsByRouteSlug.clear();
          nativeContributionCounts.clear();
          activeAliasExampleKeys.clear();
          clearJobCanonOrderingFields();
          collectGarbage();
          markHeap('inputs-released');
        }

        markHeap('bucket-serialization-start');
        const outDir = path.join(distDir, OUT_SUBDIR);
        const v2Dir = path.join(outDir, V2_SUBDIR);
        fs.mkdirSync(outDir, { recursive: true });
        const releaseManifestPath = path.join(outDir, 'manifest.json');
        fs.rmSync(releaseManifestPath, { force: true });
        fs.rmSync(v2Dir, { recursive: true, force: true });
        fs.mkdirSync(v2Dir, { recursive: true });
        for (const file of fs.readdirSync(outDir)) {
          if (/^[a-z0-9_]{2}\.json$/.test(file)) fs.rmSync(path.join(outDir, file), { force: true });
        }

        const logicalStats = {
          entries: 0,
          aliases: 0,
          aliasesByLocale: { it: 0, en: 0, de: 0, fr: 0 },
          activePrefixes: {
            changedByLocale: { it: 0, en: 0, de: 0, fr: 0 },
            addedByLocale: { it: 0, en: 0, de: 0, fr: 0 },
            removedUnpublishedByLocale: { it: 0, en: 0, de: 0, fr: 0 },
            nonRoutableGermanChanged: 0,
            nonRoutableGermanRewritten: 0,
            nonRoutableGermanDropped: 0,
            activeSlugPrefixConflict: 0,
            conflictExamples: [] as Array<{ locale: JobCanonLocale; slug: string; prefixes: string[] }>,
            nonRoutableGermanDroppedExamples: [] as Array<{ slug: string; prefix: string }>,
          },
        };

        const v2FileManifest: Record<string, JobCanonFileManifest> = Object.create(null) as Record<string, JobCanonFileManifest>;
        const logicalEntriesDigest = createHash('sha256');
        const emitV2Bucket = (key: string): number | null => {
          const operationPath = (operation: StageOperation): string =>
            path.join(stageDir, 'v2', operation, `${key}.jsonl`);
          if (!STAGE_OPERATIONS.some((operation) => fs.existsSync(operationPath(operation)))) return null;
          const bucket: Record<string, LocaleEntry> = Object.create(null) as Record<string, LocaleEntry>;
          const prefixOrderBySlugLocale = new Map<string, number>();

          forEachStagedLine(operationPath('prefix'), (slug, locale, prefix, order) => {
            const entry = entryFor(bucket, slug);
            const keyForLocale = registryAliasKey(locale, slug);
            const priorOrder = prefixOrderBySlugLocale.get(keyForLocale);
            if (priorOrder === undefined || order < priorOrder) {
              entry[locale] = prefix;
              prefixOrderBySlugLocale.set(keyForLocale, order);
            }
          });
          forEachStagedLine(operationPath('registry-alias'), (slug, locale, target) => {
            const entry = entryFor(bucket, slug);
            if (locale in entry) return;
            const alias = (entry.alias ??= Object.create(null) as Partial<Record<JobCanonLocale, string>>);
            if (!(locale in alias)) alias[locale] = target;
          });
          forEachStagedLine(operationPath('active-alias'), (slug, locale, target) => {
            const entry = entryFor(bucket, slug);
            const alias = (entry.alias ??= Object.create(null) as Partial<Record<JobCanonLocale, string>>);
            if (locale in alias) return;
            alias[locale] = target;
            // The Worker and 404 consumer select a prefix before an alias.
            // Remove only the historical prefix shadowed by this active alias.
            delete entry[locale];
          });

          const currentPrefixes = new Map<string, Partial<Record<JobCanonLocale, string>>>();
          forEachStagedLine(operationPath('active-prefix'), (slug, locale, prefix) => {
            const prior = currentPrefixes.get(slug) ?? {};
            const previous = prior[locale];
            if (previous !== undefined && previous !== prefix) {
              prior[locale] = '\u0000active-prefix-conflict';
            } else if (previous === undefined) {
              prior[locale] = prefix;
            }
            currentPrefixes.set(slug, prior);
          });
          const unpublishedPrefixes = new Map<string, Set<JobCanonLocale>>();
          forEachStagedLine(operationPath('active-prefix-remove'), (slug, locale) => {
            const locales = unpublishedPrefixes.get(slug) ?? new Set<JobCanonLocale>();
            locales.add(locale);
            unpublishedPrefixes.set(slug, locales);
          });
          for (const [slug, locales] of unpublishedPrefixes) {
            const current = currentPrefixes.get(slug);
            for (const locale of locales) {
              const publishedPrefix = current?.[locale];
              if (publishedPrefix && publishedPrefix !== '\u0000active-prefix-conflict') continue;
              const entry = bucket[slug];
              if (!entry || typeof entry[locale] !== 'string') continue;
              delete entry[locale];
              logicalStats.activePrefixes.removedUnpublishedByLocale[locale] += 1;
            }
          }
          for (const [slug, prefixes] of currentPrefixes) {
            for (const locale of JOB_CANON_LOCALES) {
              const prefix = prefixes[locale];
              if (!prefix) continue;
              if (prefix === '\u0000active-prefix-conflict') {
                {
                  logicalStats.activePrefixes.activeSlugPrefixConflict += 1;
                  if (logicalStats.activePrefixes.conflictExamples.length < 3) {
                    const allValues = new Set<string>();
                    forEachStagedLine(operationPath('active-prefix'), (candidateSlug, candidateLocale, candidatePrefix) => {
                      if (candidateSlug === slug && candidateLocale === locale) allValues.add(candidatePrefix);
                    });
                    logicalStats.activePrefixes.conflictExamples.push({ locale, slug, prefixes: [...allValues].sort() });
                  }
                }
                continue;
              }
              const entry = entryFor(bucket, slug);
              const oldPrefix = entry[locale];
              if (oldPrefix === prefix) continue;
              if (oldPrefix) {
                logicalStats.activePrefixes.changedByLocale[locale] += 1;
                if (locale === 'de' && isGermanLegacyNonRoutablePrefix(oldPrefix)) {
                  logicalStats.activePrefixes.nonRoutableGermanChanged += 1;
                }
              } else {
                logicalStats.activePrefixes.addedByLocale[locale] += 1;
              }
              if (entry.alias) {
                delete entry.alias[locale];
                if (Object.keys(entry.alias).length === 0) delete entry.alias;
              }
              entry[locale] = prefix;
            }
          }

          // Active prefixes were re-aligned above; what remains non-routable is
          // historical/expired. The Worker 301s to the stored prefix, so a
          // legacy `/de/jobs-im-<x>` there becomes a 404: rewrite it to the
          // canonical section, or drop it when the canton is unknown.
          for (const slug in bucket) {
            const entry = bucket[slug];
            const dePrefix = entry.de;
            if (typeof dePrefix !== 'string') continue;
            // A prefix published by a current page is where that page lives.
            const activeDe = currentPrefixes.get(slug)?.de;
            if (activeDe !== undefined && activeDe !== '\u0000active-prefix-conflict') continue;
            const routable = routableGermanJobCanonPrefix(dePrefix);
            if (routable === dePrefix) continue;
            if (routable) {
              entry.de = routable;
              logicalStats.activePrefixes.nonRoutableGermanRewritten += 1;
            } else {
              delete entry.de;
              logicalStats.activePrefixes.nonRoutableGermanDropped += 1;
              // A dropped redirect is a /de/ URL that stops redirecting: keep the
              // first few slug/prefix pairs in the build log so it is traceable.
              if (logicalStats.activePrefixes.nonRoutableGermanDroppedExamples.length < 5) {
                logicalStats.activePrefixes.nonRoutableGermanDroppedExamples.push({ slug, prefix: dePrefix });
              }
            }
          }

          const slugs = Object.keys(bucket).sort();
          if (slugs.length === 0) {
            prefixOrderBySlugLocale.clear();
            currentPrefixes.clear();
            return null;
          }
          const canonicalBucketDigest = createHash('sha256');
          let bucketAliasCount = 0;
          for (const slug of slugs) {
            const entry = canonicalJobCanonEntry(bucket[slug]);
            delete bucket[slug];
            bucket[slug] = entry;
            logicalStats.entries += 1;
            const entryAliases = countAliases(entry);
            logicalStats.aliases += entryAliases;
            bucketAliasCount += entryAliases;
            for (const locale of MANIFEST_LOCALE_ORDER) {
              if (typeof entry.alias?.[locale] === 'string') logicalStats.aliasesByLocale[locale] += 1;
            }
            updateCanonicalEntryDigest(logicalEntriesDigest, slug, entry);
            updateCanonicalEntryDigest(canonicalBucketDigest, slug, entry);
          }

          const serialized = JSON.stringify(bucket);
          const serializedBytes = Buffer.from(serialized, 'utf8');
          const bytes = serializedBytes.length;
          const relativeFile = `${key}.json`;
          fs.writeFileSync(path.join(v2Dir, relativeFile), serializedBytes);
          v2FileManifest[relativeFile] = {
            bytes,
            sha256: createHash('sha256').update(serializedBytes).digest('hex'),
            entries: slugs.length,
            aliases: bucketAliasCount,
            canonicalEntriesSha256: canonicalBucketDigest.digest('hex'),
          };
          prefixOrderBySlugLocale.clear();
          currentPrefixes.clear();
          for (const slug of slugs) delete bucket[slug];
          sampleHeap();
          return bytes;
        };

        const v2Bytes: number[] = [];
        for (let index = 0; index < V2_BUCKET_COUNT; index += 1) {
          const key = index.toString(16).padStart(3, '0');
          const bytes = emitV2Bucket(key);
          if (bytes !== null) v2Bytes.push(bytes);
          sampleHeap();
          if ((index + 1) % 32 === 0) {
            collectGarbage();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        const sortFileManifest = (files: Record<string, JobCanonFileManifest>): Record<string, JobCanonFileManifest> => {
          const sorted: Record<string, JobCanonFileManifest> = Object.create(null) as Record<string, JobCanonFileManifest>;
          for (const filename of Object.keys(files).sort()) sorted[filename] = files[filename];
          return sorted;
        };
        const manifest = {
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          logical: {
            entries: logicalStats.entries,
            aliases: logicalStats.aliases,
            canonicalEntriesSha256: logicalEntriesDigest.digest('hex'),
          },
          v2: { files: sortFileManifest(v2FileManifest) },
        };
        fs.writeFileSync(releaseManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
        markHeap('v2-written');
        console.log(
          `[job-canon-redirect-map] v2: ${JSON.stringify(summarizeBytes(v2Bytes))}, heap=${heapCheckpoints['v2-written']}`,
        );

        activePrefixStats.changedByLocale = logicalStats.activePrefixes.changedByLocale;
        activePrefixStats.addedByLocale = logicalStats.activePrefixes.addedByLocale;
        activePrefixStats.removedUnpublishedByLocale = logicalStats.activePrefixes.removedUnpublishedByLocale;
        activePrefixStats.nonRoutableGermanChanged = logicalStats.activePrefixes.nonRoutableGermanChanged;
        activePrefixStats.nonRoutableGermanRewritten = logicalStats.activePrefixes.nonRoutableGermanRewritten;
        activePrefixStats.nonRoutableGermanDropped = logicalStats.activePrefixes.nonRoutableGermanDropped;
        activePrefixStats.activeSlugPrefixConflict = logicalStats.activePrefixes.activeSlugPrefixConflict;
        activePrefixStats.conflictExamples = logicalStats.activePrefixes.conflictExamples;
        activePrefixStats.nonRoutableGermanDroppedExamples = logicalStats.activePrefixes.nonRoutableGermanDroppedExamples;
        const peakDeltaBytes = peakHeapUsed - heapCheckpoints.start;
        const v2Summary = summarizeBytes(v2Bytes);
        console.log(
          `[job-canon-redirect-map] logical entries=${logicalStats.entries}, aliases=${logicalStats.aliases}, `
          + `aliasesByLocale=${JSON.stringify(logicalStats.aliasesByLocale)}`,
        );
        console.log(`[job-canon-redirect-map] active prefixes=${JSON.stringify(activePrefixStats)}`);
        console.log(
          `[job-canon-redirect-map] first upload: v2Files=${v2Summary.count}, v2Bytes=${v2Summary.total}.`,
        );
        console.log(
          `[job-canon-redirect-map] closeBundle heap checkpoints=${JSON.stringify(heapCheckpoints)}, `
          + `sampledPeak=${peakHeapUsed} at ${peakHeapPhase}, phasePeaks=${JSON.stringify(heapPeakByPhase)}, `
          + `delta=${peakDeltaBytes} bytes (${(peakDeltaBytes / 1024 / 1024).toFixed(1)} MiB).`,
        );

        if (peakDeltaBytes > 150 * 1024 * 1024) {
          console.warn(`[job-canon-redirect-map] closeBundle heap delta exceeded 150 MiB: ${peakDeltaBytes} bytes`);
        }
      } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
    },
  };
}
