/**
 * Emit the v1 and v2 /job-canon maps without retaining the complete registry
 * or the complete output graph in V8. Registry records are spooled per shard
 * and applied to one output shard at a time in closeBundle.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { readJsonFile } from '../scripts/lib/read-large-json.mjs';
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
import { getSafeDistPageTargets, isDistPathOverFilesystemLimits, isSafeDistPath } from './shared/distPathSafety';
import { buildCanonicalJobDetailPath } from './shared/jobDetailPath';
import { localizedActiveJobSlug } from './shared/activeJobPageSelection';
import { clearJobCanonOrderingFields, getJobCanonOrderingFields } from './shared/jobCanonInputs';
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
} from './shared/buildSignals';

const OUT_SUBDIR = 'job-canon';
const V2_SUBDIR = 'v2';
const V2_BUCKET_COUNT = JOB_CANON_V2_SHARD_COUNT;
const V2_MAX_SHARD_BYTES = 256 * 1024;
const STAGE_OPERATIONS = ['prefix', 'registry-alias', 'active-alias', 'active-prefix'] as const;
const LOCALE_INDEX = new Map<JobCanonLocale, number>(JOB_CANON_LOCALES.map((locale, index) => [locale, index]));
const WORKER_LOCALE_MASK = (1 << JOB_CANON_LOCALES.length) - 1;
const WORKER_CANDIDATE_FLAG = 1 << 12;
const WORKER_ACTIVE_ROUTE_FLAG = 1 << 13;
const WORKER_DIRECT_FACT_MASK = WORKER_LOCALE_MASK | (WORKER_LOCALE_MASK << 4);
const WORKER_NATIVE_NON_TI_MASK = WORKER_LOCALE_MASK << 8;
const WORKER_REPLACED_MAP_FACT_MASK = WORKER_DIRECT_FACT_MASK | WORKER_NATIVE_NON_TI_MASK;

type StageOperation = (typeof STAGE_OPERATIONS)[number];
type LocaleEntry = Partial<Record<JobCanonLocale, string>> & {
  alias?: Partial<Record<JobCanonLocale, string>>;
};
type StageBuffer = Record<StageOperation, Map<string, string[]>> & { rows: number };

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

function shardKey(slug: string): string {
  const value = slug.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, '_');
  return value.length === 2 ? value : (value + '__').slice(0, 2);
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

export function assertJobCanonV2ShardWithinLimit(bytes: number, maximumBytes = V2_MAX_SHARD_BYTES): void {
  if (bytes > maximumBytes) {
    throw new Error(`job-canon v2 shard is ${bytes} bytes, above ${maximumBytes} bytes`);
  }
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

export function jobCanonRedirectMapPlugin(rootDir: string): Plugin {
  return {
    name: 'job-canon-redirect-map',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (shouldAwaitJobsSeoPagesFlushed()) {
        console.log('[job-canon-redirect-map] waiting for jobs SEO to flush the reconciled Worker slug map');
        await jobsSeoPagesFlushed;
      }

      const distDir = path.resolve(rootDir, 'dist');
      const buildLocale = (process.env.BUILD_LOCALE ?? '').trim();
      const ownsWorkerMap = buildLocale === '' || buildLocale === 'it';
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
            if (currentPartIndex >= 0) flushAll(prefixBuffer);
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
        if (currentPartIndex >= 0) flushAll(prefixBuffer);
        sampleHeap();
        markHeap('phase-b1-prefixes-staged');

        // Phase (b2): aliases follow every prefix and are omitted if any
        // source record already resolves the registry slug in that locale.
        currentHeapPhase = 'phase-b2-alias-staging';
        currentPartIndex = -1;
        let aliasBuffer = newBuffer();
        for (const [key, paths, entryPartIndex] of iterateAllKnownJobSlugPartEntries(rootDir)) {
          if (entryPartIndex !== currentPartIndex) {
            if (currentPartIndex >= 0) flushAll(aliasBuffer);
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
        if (currentPartIndex >= 0) flushAll(aliasBuffer);
        sampleHeap();
        slugIndex!.clear();
        slugIndex = null;
        markHeap('phase-b-registry-staged');
        console.log(
          `[job-canon-redirect-map] phase b registry: parts=${registryParts}, records=${stagedRecordCount}, `
          + `heap=${heapCheckpoints['phase-b-registry-staged']}`,
        );

        const slugMapPath = path.join(distDir, 'data', 'jobs-slug-map.json');
        let jobs: ActiveJobSlugMapRow[] = [];
        let activeJobsRaw: unknown[] = [];
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
          nonRoutableGermanChanged: 0,
          activeSlugPrefixConflict: 0,
          conflictExamples: [] as Array<{ locale: JobCanonLocale; slug: string; prefixes: string[] }>,
        };

        if (ownsWorkerMap) {
          if (!fs.existsSync(slugMapPath)) {
            throw new Error(
              `[job-canon-redirect-map] ${buildLocale === '' ? 'all-locale build' : 'BUILD_LOCALE=it'} `
              + `requires ${path.relative(rootDir, slugMapPath)} from jobsSeoPagesPlugin`,
            );
          }
          const raw = readJsonFile(slugMapPath) as unknown;
          if (!Array.isArray(raw)) {
            throw new Error(
              `[job-canon-redirect-map] ${path.relative(rootDir, slugMapPath)} must contain an array`,
            );
          }
          activeJobsRaw = raw;
          jobs = raw as ActiveJobSlugMapRow[];
          markHeap('active-slug-map-loaded');

          const {
            buildReservedHubSlugs,
            compareActiveJobsByStableOrder,
          } = await import('./jobsSeoPagesPlugin');
          let orderingFieldsById = getJobCanonOrderingFields();
          if (!orderingFieldsById) {
            throw new Error('[job-canon-redirect-map] localeJobsSplitPlugin did not provide ordering fields in this Vite process');
          }
          let writeIndex = 0;
          for (const row of jobs) {
            if (!row || typeof row !== 'object') continue;
            const stableId = String(row.id || row.slug || '').trim();
            const orderingFields = stableId ? orderingFieldsById.get(stableId) : undefined;
            if (!orderingFields) {
              throw new Error('[job-canon-redirect-map] slug map and in-memory ordering fields do not match');
            }
            Object.assign(row, orderingFields);
            jobs[writeIndex++] = row;
          }
          jobs.length = writeIndex;
          jobs.sort(compareActiveJobsByStableOrder);
          orderingFieldsById = null;
          clearJobCanonOrderingFields();
          markHeap('active-jobs-ordered');

          // Keep one compact candidate map for the Worker predicate instead
          // of separate active-route, candidate, and recovery collections.
          const workerFlagsBySlug = new Map<string, number>();
          // Keep native-fact provenance so replacing one route map revokes its
          // own facts without erasing another route's evidence for the slug.
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
          const jobsByV2Bucket: ActiveJobSlugMapRow[][] = Array.from(
            { length: V2_BUCKET_COUNT },
            () => [],
          );
          currentHeapPhase = 'active-prefix-staging';
          const stageBuffer = newBuffer();
          let activePrefixRows = 0;
          let activePrefixBufferRows = 0;
          for (const job of jobs) {
            const bucketIndexes = new Set<number>();
            const trackSlugBucket = (slug: unknown): void => {
              if (typeof slug === 'string' && slug) {
                bucketIndexes.add(jobSlugShardIndexForCount(slug, V2_BUCKET_COUNT));
              }
            };
            if (typeof job.slug === 'string' && job.slug) {
              addWorkerSlugFlags(job.slug, WORKER_CANDIDATE_FLAG | WORKER_ACTIVE_ROUTE_FLAG);
              trackSlugBucket(job.slug);
            }
            const canton = resolveJobCanton(job);
            for (const locale of JOB_CANON_LOCALES) {
              const currentSlug = localizedActiveJobSlug(job, locale);
              if (currentSlug) {
                addWorkerSlugFlags(currentSlug, WORKER_CANDIDATE_FLAG | WORKER_ACTIVE_ROUTE_FLAG);
                trackSlugBucket(currentSlug);
                const currentPath = buildCanonicalJobDetailPath(locale, job, currentSlug, canton);
                const prefix = sectionPrefix(currentPath);
                if (prefix) {
                  pushRecord(stageBuffer, 'active-prefix', currentSlug, locale, prefix);
                  activePrefixRows += 1;
                  activePrefixBufferRows += 1;
                  if (activePrefixBufferRows >= 8192) {
                    flushAll(stageBuffer);
                    clearStageBuffer(stageBuffer);
                    activePrefixBufferRows = 0;
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
            for (const bucketIndex of bucketIndexes) jobsByV2Bucket[bucketIndex].push(job);
          }
          flushAll(stageBuffer);
          clearStageBuffer(stageBuffer);
          markHeap('active-prefixes-staged');
          console.log(
            `[job-canon-redirect-map] active input: jobs=${jobs.length}, currentPrefixes=${activePrefixRows}, `
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
                flags |= directExistsBit;
                if (target === `${legacyRoots[locale]}/${key}`) flags |= directIsTiBit;
                else flags &= ~directIsTiBit;
                workerFlagsBySlug.set(key, flags);
              }
              const targetCandidateFlags = workerFlagsBySlug.get(targetSlug) ?? 0;
              if (
                (keyCandidateFlags & WORKER_ACTIVE_ROUTE_FLAG) !== 0
                && (targetCandidateFlags & WORKER_CANDIDATE_FLAG) !== 0
              ) {
                // buildNativeJobPrefixIndex excludes IT, and skips only the
                // exact one-slug legacy TI path. Its last non-TI prefix wins.
                if (prefix !== legacyRoots[locale]) {
                  const localeBit = LOCALE_INDEX.get(locale)!;
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
            const bucketJobs = jobsByV2Bucket[bucketIndex];
            if (bucketJobs.length === 0) continue;
            const bucketKey = bucketIndex.toString(16).padStart(3, '0');
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
              onHeapSample: (phase) => sampleHeap(phase ? `active-${phase}` : 'active-aliases'),
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
            jobsByV2Bucket[bucketIndex] = [];
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
          jobsByV2Bucket.length = 0;
          jobs.length = 0;
          activeJobsRaw.length = 0;
          workerFlagsBySlug.clear();
          nativeTargetsByRouteSlug.clear();
          nativeContributionCounts.clear();
          activeAliasExampleKeys.clear();
          clearJobCanonOrderingFields();
          markHeap('inputs-released');
        }

        markHeap('bucket-serialization-start');
        const outDir = path.join(distDir, OUT_SUBDIR);
        const v2Dir = path.join(outDir, V2_SUBDIR);
        fs.mkdirSync(outDir, { recursive: true });
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
            nonRoutableGermanChanged: 0,
            activeSlugPrefixConflict: 0,
            conflictExamples: [] as Array<{ locale: JobCanonLocale; slug: string; prefixes: string[] }>,
          },
        };

        const v1Dir = outDir;
        const v1BufferByShard = new Map<string, Buffer[]>();
        const v1BufferBytesByShard = new Map<string, number>();
        const v1Started = new Set<string>();
        const v1HasEntries = new Set<string>();
        const v1Keys = new Set<string>();
        const flushV1Buffer = (key: string): void => {
          const pending = v1BufferByShard.get(key);
          if (!pending) return;
          fs.appendFileSync(path.join(v1Dir, `${key}.json`), Buffer.concat(pending));
          v1BufferByShard.delete(key);
          v1BufferBytesByShard.delete(key);
        };
        const appendV1Entry = (slug: string, entry: LocaleEntry): void => {
          const key = shardKey(slug);
          v1Keys.add(key);
          const outputPath = path.join(v1Dir, `${key}.json`);
          if (!v1Started.has(key)) {
            fs.writeFileSync(outputPath, '{', 'utf8');
            v1Started.add(key);
          }
          const pending = v1BufferByShard.get(key) ?? [];
          const separator = v1HasEntries.has(key) ? ',' : '';
          v1HasEntries.add(key);
          const fragment = Buffer.from(`${separator}${JSON.stringify(slug)}:${JSON.stringify(entry)}`, 'utf8');
          pending.push(fragment);
          v1BufferByShard.set(key, pending);
          const bufferedBytes = (v1BufferBytesByShard.get(key) ?? 0) + fragment.length;
          v1BufferBytesByShard.set(key, bufferedBytes);
          if (bufferedBytes >= 16 * 1024) flushV1Buffer(key);
        };

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

          logicalStats.entries += Object.keys(bucket).length;
          for (const slug in bucket) {
            const alias = bucket[slug].alias;
            if (!alias) continue;
            for (const locale of JOB_CANON_LOCALES) {
              if (typeof alias[locale] === 'string') {
                logicalStats.aliases += 1;
                logicalStats.aliasesByLocale[locale] += 1;
              }
            }
          }

          const serialized = JSON.stringify(bucket);
          const bytes = Buffer.byteLength(serialized, 'utf8');
          assertJobCanonV2ShardWithinLimit(bytes);
          fs.writeFileSync(path.join(v2Dir, `${key}.json`), serialized, 'utf8');
          // Every slug belongs to exactly one hash bucket. Append each finished
          // v2 entry to its v1 file in bounded chunks so the 29 MB `ve` shard
          // never becomes an in-memory object or one giant JSON string.
          for (const slug in bucket) appendV1Entry(slug, bucket[slug]);
          prefixOrderBySlugLocale.clear();
          currentPrefixes.clear();
          for (const slug in bucket) delete bucket[slug];
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
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        for (const key of [...v1BufferByShard.keys()]) flushV1Buffer(key);
        for (const key of v1Keys) fs.appendFileSync(path.join(v1Dir, `${key}.json`), '}', 'utf8');
        const v1Bytes = [...v1Keys].map((key) => fs.statSync(path.join(v1Dir, `${key}.json`)).size);
        markHeap('v1-and-v2-written');
        markHeap('v2-written');
        console.log(
          `[job-canon-redirect-map] v1: ${JSON.stringify(summarizeBytes(v1Bytes))}, `
          + `v2: ${JSON.stringify(summarizeBytes(v2Bytes))}, `
          + `maxShardLimit=${V2_MAX_SHARD_BYTES}, heap=${heapCheckpoints['v2-written']}`,
        );

        activePrefixStats.changedByLocale = logicalStats.activePrefixes.changedByLocale;
        activePrefixStats.addedByLocale = logicalStats.activePrefixes.addedByLocale;
        activePrefixStats.nonRoutableGermanChanged = logicalStats.activePrefixes.nonRoutableGermanChanged;
        activePrefixStats.activeSlugPrefixConflict = logicalStats.activePrefixes.activeSlugPrefixConflict;
        activePrefixStats.conflictExamples = logicalStats.activePrefixes.conflictExamples;
        const peakDeltaBytes = peakHeapUsed - heapCheckpoints.start;
        const v1Summary = summarizeBytes(v1Bytes);
        const v2Summary = summarizeBytes(v2Bytes);
        const uploadedBytes = v1Summary.total + v2Summary.total;
        console.log(
          `[job-canon-redirect-map] logical entries=${logicalStats.entries}, aliases=${logicalStats.aliases}, `
          + `aliasesByLocale=${JSON.stringify(logicalStats.aliasesByLocale)}`,
        );
        console.log(`[job-canon-redirect-map] active prefixes=${JSON.stringify(activePrefixStats)}`);
        console.log(
          `[job-canon-redirect-map] first upload: v1Files=${v1Summary.count}, v1Bytes=${v1Summary.total}; `
          + `v2Files=${v2Summary.count}, v2Bytes=${v2Summary.total}; combinedBytes=${uploadedBytes}; `
          + `estimated ${(4 * Math.max(
            (v1Summary.count + v2Summary.count) / Math.max(1, v1Summary.count),
            uploadedBytes / Math.max(1, v1Summary.total),
          )).toFixed(1)}-`
          + `${(6 * Math.max(
            (v1Summary.count + v2Summary.count) / Math.max(1, v1Summary.count),
            uploadedBytes / Math.max(1, v1Summary.total),
          )).toFixed(1)}s from the 4-6s v1 baseline `
          + `(120s _r2_sync budget).`,
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
