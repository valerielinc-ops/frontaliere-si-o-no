import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson, digestDocument } from './canonical-json-digest.mjs';

export const TRANSLATION_SHADOW_PREFLIGHT_V2_SCHEMA_VERSION = 2;
export const TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES = 8 * 1024 * 1024;
export const TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS = Object.freeze({
  inputJobs: 10_000,
  inputUnits: 25_000,
  selectedJobs: 250,
  selectedUnits: 250,
});
export const TRANSLATION_SHADOW_PREFLIGHT_V2_SOFT_BUDGET_MS = 5_000;
export const TRANSLATION_SHADOW_PREFLIGHT_V2_HARD_BUDGET_MS = 10_000;
export const TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS = Object.freeze({
  maxJobBytes: 1024 * 1024,
  maxAggregateBytes: 1024 * 1024 * 1024,
  // The live origin/main data/job-popularity.json is 5,725,310 bytes.
  maxMetadataBytes: 64 * 1024 * 1024,
  // 2026-09-02 assembled data/jobs.json: 22,516 keys, p99=30 B,
  // max=42 B. 256 B preserves >6x headroom without permitting amplification.
  maxCompanyKeyCodeUnits: 256,
  maxCompanyKeyUtf8Bytes: 256,
  // The measured assembled dataset is 22,516 jobs; this rejects hostile sparse
  // cardinalities before any clock read or length-proportional observer work.
  maxArrayLength: 100_000,
  maxJobFields: 256,
  maxDepth: 64,
});

const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const SAMPLE_LIMIT = 20;

class ObserverTimeout extends Error {
  constructor() {
    super('observer_timeout');
    this.name = 'ObserverTimeout';
  }
}

class InputBoundViolation extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'InputBoundViolation';
    this.reason = reason;
  }
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function digestBoundedCompanyKey(value) {
  const reason = inspectBoundedCompanyKey(value);
  if (reason) throw new InputBoundViolation(reason);
  return digestBytes(value);
}

function checkDeadline(deadlineMs, now = Date.now) {
  if (now() > deadlineMs) throw new ObserverTimeout();
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).sort(compareText).join('\0') === [...keys].sort(compareText).join('\0');
}

function nullableFiniteNumber(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function expectedSourceRuntimeContractDigest(sourceCommit) {
  return digestDocument({
    baselineMainSha: sourceCommit,
    hook: 'scripts/relocalize-pending-jobs.mjs:post_company_keys',
    observer: 'scripts/lib/translation-shadow-preflight-v2.mjs',
    schemaVersion: TRANSLATION_SHADOW_PREFLIGHT_V2_SCHEMA_VERSION,
  });
}

function normalizeRunBinding(runBinding, sourceCommit) {
  if (!exactKeys(runBinding, [
    'repository', 'runAttempt', 'runId', 'sourceCommit', 'workflow', 'workflowBlobSha',
  ]) || !nonEmptyString(runBinding.repository) || !nonEmptyString(runBinding.workflow)
      || !POSITIVE_DECIMAL_PATTERN.test(runBinding.runId ?? '')
      || !POSITIVE_DECIMAL_PATTERN.test(runBinding.runAttempt ?? '')
      || !SHA_PATTERN.test(runBinding.sourceCommit ?? '')
      || runBinding.sourceCommit !== sourceCommit
      || (runBinding.workflowBlobSha !== null
        && !SHA_PATTERN.test(runBinding.workflowBlobSha ?? ''))) return null;
  const payload = {
    repository: runBinding.repository,
    workflow: runBinding.workflow,
    runId: runBinding.runId,
    runAttempt: runBinding.runAttempt,
    sourceCommit: runBinding.sourceCommit,
    workflowBlobSha: runBinding.workflowBlobSha,
  };
  return { ...payload, digest: digestDocument(payload) };
}

function validRunBindingDocument(runBinding) {
  if (!exactKeys(runBinding, [
    'digest', 'repository', 'runAttempt', 'runId', 'sourceCommit', 'workflow', 'workflowBlobSha',
  ])) return false;
  const { digest, ...payload } = runBinding;
  const normalized = normalizeRunBinding(payload, payload.sourceCommit);
  return normalized !== null && digest === normalized.digest;
}

function addBoundedTextBytes(currentBytes, value, limit, reason) {
  const chunkSize = 64 * 1024;
  let bytes = currentBytes;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    bytes += Buffer.byteLength(value.slice(offset, offset + chunkSize));
    if (bytes > limit) throw new InputBoundViolation(reason);
  }
  return bytes;
}

function addBoundedJsonStringBytes(currentBytes, value, limit, reason) {
  const chunkSize = 64 * 1024;
  let bytes = addBoundedByteCount(currentBytes, 2, limit, reason);
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + chunkSize, value.length);
    if (end < value.length) {
      const lastCodeUnit = value.charCodeAt(end - 1);
      const nextCodeUnit = value.charCodeAt(end);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
          && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        end -= 1;
      }
    }
    const encoded = JSON.stringify(value.slice(offset, end));
    bytes += Buffer.byteLength(encoded) - 2;
    if (bytes > limit) throw new InputBoundViolation(reason);
    offset = end;
  }
  return bytes;
}

function addBoundedByteCount(currentBytes, addedBytes, limit, reason) {
  const bytes = currentBytes + addedBytes;
  if (bytes > limit) throw new InputBoundViolation(reason);
  return bytes;
}

function measureJobBytes(root, deadlineMs, now, {
  limit = TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxJobBytes,
  reason = 'input_bound_job_bytes_exceeded',
} = {}) {
  const ancestors = new WeakSet();
  const stack = [{ type: 'enter', value: root, depth: 0 }];
  let bytes = 0;
  while (stack.length > 0) {
    checkDeadline(deadlineMs, now);
    const frame = stack.pop();
    const value = frame.value;
    if (frame.type === 'exit') {
      ancestors.delete(value);
      continue;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      bytes = addBoundedTextBytes(bytes, JSON.stringify(value) ?? 'null', limit, reason);
      continue;
    }
    if (typeof value === 'string') {
      bytes = addBoundedJsonStringBytes(bytes, value, limit, reason);
      continue;
    }
    if (value === undefined) {
      bytes = addBoundedTextBytes(bytes, 'null', limit, reason);
      continue;
    }
    if (typeof value !== 'object' || (!Array.isArray(value) && !isPlainObject(value))) {
      throw new InputBoundViolation('input_bound_unsupported_value');
    }
    if (frame.depth > TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxDepth) {
      throw new InputBoundViolation('input_bound_depth_exceeded');
    }
    if (ancestors.has(value)) throw new InputBoundViolation('input_bound_cycle_detected');
    ancestors.add(value);
    stack.push({ type: 'exit', value, depth: frame.depth });
    if (Array.isArray(value)) {
      bytes = addBoundedByteCount(bytes, Math.max(2, value.length + 1), limit, reason);
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor && !Object.hasOwn(descriptor, 'value')) {
          throw new InputBoundViolation('input_bound_accessor_unsupported');
        }
        stack.push({
          type: 'enter',
          value: descriptor ? descriptor.value : null,
          depth: frame.depth + 1,
        });
      }
    } else {
      const entries = [];
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw new InputBoundViolation('input_bound_accessor_unsupported');
        }
        entries.push([key, descriptor.value]);
      }
      bytes = addBoundedByteCount(bytes, Math.max(2, entries.length + 1), limit, reason);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, entry] = entries[index];
        bytes = addBoundedJsonStringBytes(bytes, key, limit, reason);
        bytes = addBoundedTextBytes(bytes, ':', limit, reason);
        stack.push({ type: 'enter', value: entry, depth: frame.depth + 1 });
      }
    }
  }
  return bytes;
}

function inspectArrayEnvelope(input) {
  if (!isPlainObject(input)) return { reasons: ['input_not_plain_object'], oversized: false };
  const reasons = [];
  let oversized = false;
  for (const name of ['jobs', 'pendingJobs', 'orderedPending', 'capWindow']) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor) {
      if (name === 'jobs' || name === 'pendingJobs') reasons.push(`${name}_not_array`);
      continue;
    }
    if ((name === 'orderedPending' || name === 'capWindow') && descriptor.value === undefined) {
      continue;
    }
    if (!Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value)) {
      reasons.push(`${name}_not_array`);
      continue;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(descriptor.value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
        || !boundedInteger(lengthDescriptor.value)) {
      reasons.push(`${name}_length_invalid`);
      continue;
    }
    if (lengthDescriptor.value > TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxArrayLength) {
      oversized = true;
    }
  }
  return { reasons, oversized };
}

function inspectBoundedCompanyKey(value) {
  if (typeof value !== 'string') return 'company_key_not_string';
  if (value.length > TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxCompanyKeyCodeUnits) {
    return 'input_bound_company_key_code_units_exceeded';
  }
  if (Buffer.byteLength(value, 'utf8')
      > TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxCompanyKeyUtf8Bytes) {
    return 'input_bound_company_key_bytes_exceeded';
  }
  return null;
}

export function digestTranslationShadowDefaultCompanyKeyV2(value) {
  const rawReason = inspectBoundedCompanyKey(value);
  if (rawReason) throw new TypeError(rawReason);
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const normalizedReason = inspectBoundedCompanyKey(normalized);
  if (normalizedReason) throw new TypeError(normalizedReason);
  return digestBytes(normalized);
}

function inspectCompanyKeyEnvelope(input) {
  if (!isPlainObject(input)) return [];
  const reasons = [];
  const addKey = (value, { nullable = false } = {}) => {
    if (nullable && value === null) return;
    const reason = inspectBoundedCompanyKey(value);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };
  const inspectArray = (name, readEntry) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || descriptor.value === undefined) return;
    if (!Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value)) return;
    const values = descriptor.value;
    if (values.length > TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxArrayLength) {
      if (!reasons.includes('input_bound_company_key_entries_exceeded')) {
        reasons.push('input_bound_company_key_entries_exceeded');
      }
      return;
    }
    for (let index = 0; index < values.length; index += 1) {
      const entryDescriptor = Object.getOwnPropertyDescriptor(values, String(index));
      if (!entryDescriptor || !Object.hasOwn(entryDescriptor, 'value')) {
        if (entryDescriptor && !reasons.includes('input_bound_accessor_unsupported')) {
          reasons.push('input_bound_accessor_unsupported');
        }
        continue;
      }
      readEntry(entryDescriptor.value, addKey);
    }
  };
  inspectArray('capWindowCompanyKeys', (value, add) => add(value, { nullable: true }));
  inspectArray('companyBudgets', (entry, add) => {
    if (!isPlainObject(entry)) return;
    const keyDescriptor = Object.getOwnPropertyDescriptor(entry, 'companyKey');
    if (!keyDescriptor || !Object.hasOwn(keyDescriptor, 'value')) {
      if (keyDescriptor && !reasons.includes('input_bound_accessor_unsupported')) {
        reasons.push('input_bound_accessor_unsupported');
      }
      return;
    }
    add(keyDescriptor.value);
  });
  const seenJobs = new WeakSet();
  for (const name of ['jobs', 'pendingJobs', 'orderedPending', 'capWindow']) {
    inspectArray(name, (job, add) => {
      if (!isPlainObject(job) || seenJobs.has(job)) return;
      seenJobs.add(job);
      const keyDescriptor = Object.getOwnPropertyDescriptor(job, 'companyKey');
      if (!keyDescriptor) return;
      if (!Object.hasOwn(keyDescriptor, 'value')) {
        if (!reasons.includes('input_bound_accessor_unsupported')) {
          reasons.push('input_bound_accessor_unsupported');
        }
        return;
      }
      if (keyDescriptor.value !== undefined) add(keyDescriptor.value);
    });
  }
  const legacyDescriptor = Object.getOwnPropertyDescriptor(input, 'legacy');
  if (legacyDescriptor && Object.hasOwn(legacyDescriptor, 'value')
      && isPlainObject(legacyDescriptor.value)) {
    const filterDescriptor = Object.getOwnPropertyDescriptor(legacyDescriptor.value, 'companyFilter');
    if (filterDescriptor && Object.hasOwn(filterDescriptor, 'value')
        && isPlainObject(filterDescriptor.value)) {
      const valueDescriptor = Object.getOwnPropertyDescriptor(filterDescriptor.value, 'value');
      if (valueDescriptor && Object.hasOwn(valueDescriptor, 'value')) {
        addKey(valueDescriptor.value, { nullable: true });
      } else if (valueDescriptor) {
        reasons.push('input_bound_accessor_unsupported');
      }
    }
  }
  return [...new Set(reasons)];
}

function validateJobRoot(value) {
  if (value === null || typeof value !== 'object') return;
  if (!isPlainObject(value)) throw new InputBoundViolation('input_bound_job_schema_invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.length > TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxJobFields) {
    throw new InputBoundViolation('input_bound_job_fields_exceeded');
  }
  for (const key of keys) {
    if (typeof key !== 'string') throw new InputBoundViolation('input_bound_job_schema_invalid');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new InputBoundViolation('input_bound_accessor_unsupported');
    }
  }
}

function preScanJobInputs(input, deadlineMs, now) {
  const rootCache = new WeakMap();
  let aggregateBytes = 0;
  for (const name of ['jobs', 'pendingJobs', 'orderedPending', 'capWindow']) {
    const values = Array.isArray(input?.[name]) ? input[name] : [];
    for (const value of values) {
      checkDeadline(deadlineMs, now);
      validateJobRoot(value);
      let bytes;
      if (value !== null && typeof value === 'object') {
        bytes = rootCache.get(value);
        if (bytes !== undefined) continue;
        bytes = measureJobBytes(value, deadlineMs, now);
        rootCache.set(value, bytes);
      } else {
        bytes = measureJobBytes(value, deadlineMs, now);
      }
      aggregateBytes += bytes;
      if (aggregateBytes > TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxAggregateBytes) {
        throw new InputBoundViolation('input_bound_aggregate_bytes_exceeded');
      }
    }
  }
  const metadata = isPlainObject(input) ? {
    baselineMainSha: input.baselineMainSha,
    dryRun: input.dryRun,
    notAttemptedReason: input.notAttemptedReason,
    legacy: input.legacy,
    traffic: input.traffic,
    capWindowCompanyKeys: input.capWindowCompanyKeys,
    companyBudgets: input.companyBudgets,
  } : input;
  measureJobBytes(metadata, deadlineMs, now, {
    limit: TRANSLATION_SHADOW_PREFLIGHT_V2_INPUT_BOUNDS.maxMetadataBytes,
    reason: 'input_bound_metadata_bytes_exceeded',
  });
  checkDeadline(deadlineMs, now);
  return { aggregateBytes };
}

function jobRef(job) {
  const explicit = [job?.id, job?.url, job?.slug]
    .find((value) => typeof value === 'string' && value.trim().length > 0);
  if (explicit) return `job-ref:v2:${digestBytes(String(explicit).trim()).slice('sha256:'.length)}`;
  return `job-ref:v2:${digestDocument(job ?? null).slice('sha256:'.length)}`;
}

function canonicalRuntimeValue(value, inArray = false) {
  if (value === undefined) return inArray ? null : undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => canonicalRuntimeValue(entry, true));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [key, canonicalRuntimeValue(entry, false)])
      .filter(([, entry]) => entry !== undefined));
  }
  return String(value);
}

function digestFullInventory(jobs, deadlineMs, hashCache = new WeakMap(), now = Date.now) {
  const hashes = [];
  for (let index = 0; index < jobs.length; index += 1) {
    checkDeadline(deadlineMs, now);
    const current = jobs[index];
    let hash = current && typeof current === 'object' ? hashCache.get(current) : null;
    if (!hash) {
      hash = digestDocument(canonicalRuntimeValue(current, true));
      if (current && typeof current === 'object') hashCache.set(current, hash);
    }
    hashes.push(hash);
  }
  const digest = digestDocument(hashes);
  checkDeadline(deadlineMs, now);
  return digest;
}

function exactReferenceMultiset(values, deadlineMs, now) {
  const counts = new Map();
  for (const value of values) {
    checkDeadline(deadlineMs, now);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function sameReferenceMultiset(left, right, deadlineMs, now) {
  if (left.length !== right.length) return false;
  const counts = exactReferenceMultiset(left, deadlineMs, now);
  for (const value of right) {
    checkDeadline(deadlineMs, now);
    const remaining = counts.get(value) ?? 0;
    if (remaining === 0) return false;
    if (remaining === 1) counts.delete(value);
    else counts.set(value, remaining - 1);
  }
  return counts.size === 0;
}

function validLegacyInput(legacy, deadlineMs, now) {
  if (!exactKeys(legacy, [
    'allowNoTraffic', 'companyFilter', 'maxJobs', 'postClear', 'preClear', 'trafficSource',
  ]) || typeof legacy.allowNoTraffic !== 'boolean' || !boundedInteger(legacy.maxJobs)
      || legacy.maxJobs < 1 || !nonEmptyString(legacy.trafficSource)) return false;
  const filter = legacy.companyFilter;
  const preClear = legacy.preClear;
  const postClear = legacy.postClear;
  if (!exactKeys(filter, ['after', 'before', 'population', 'reappliedAfterPreClear', 'value'])
      || filter.population !== 'assembled_company_filtered'
      || (filter.value !== null && !nonEmptyString(filter.value))
      || !boundedInteger(filter.before) || !boundedInteger(filter.after)
      || typeof filter.reappliedAfterPreClear !== 'boolean'
      || !exactKeys(preClear, ['assembled', 'direct', 'filteredPending'])
      || !exactKeys(preClear.direct, ['cleared', 'population', 'reset'])
      || preClear.direct.population !== 'all_per_crawler_occurrences'
      || !boundedInteger(preClear.direct.cleared) || !boundedInteger(preClear.direct.reset)
      || !exactKeys(preClear.assembled, ['flagsCleared', 'population'])
      || preClear.assembled.population !== 'all_assembled_jobs'
      || !boundedInteger(preClear.assembled.flagsCleared)
      || !exactKeys(preClear.filteredPending, ['before', 'population'])
      || preClear.filteredPending.population !== 'assembled_company_filtered'
      || !boundedInteger(preClear.filteredPending.before)
      || !exactKeys(postClear, ['pending', 'population'])
      || postClear.population !== 'assembled_company_filtered'
      || !boundedInteger(postClear.pending)) return false;
  checkDeadline(deadlineMs, now);
  return preClear.filteredPending.before >= postClear.pending;
}

function validTrafficStats(stats, deadlineMs = Number.POSITIVE_INFINITY, now = Date.now) {
  if (!exactKeys(stats, [
    'age', 'matchRate', 'matched', 'queued', 'reserveForOldest', 'totalViews', 'trafficEntries',
  ]) || !boundedInteger(stats.queued) || !boundedInteger(stats.trafficEntries)
      || !boundedInteger(stats.matched) || !boundedInteger(stats.totalViews)
      || typeof stats.matchRate !== 'number' || !Number.isFinite(stats.matchRate)
      || stats.matchRate < 0 || stats.matchRate > 1
      || typeof stats.reserveForOldest !== 'number' || !Number.isFinite(stats.reserveForOldest)
      || stats.reserveForOldest < 0 || stats.reserveForOldest > 1) return false;
  const age = stats.age;
  if (!exactKeys(age, [
    'alert', 'alertDays', 'buckets', 'count', 'oldestAgeDays', 'p50AgeDays', 'p90AgeDays', 'withTimestamp',
  ]) || typeof age.alert !== 'boolean' || !boundedInteger(age.alertDays)
      || !boundedInteger(age.count) || !boundedInteger(age.withTimestamp)
      || !nullableFiniteNumber(age.oldestAgeDays) || !nullableFiniteNumber(age.p50AgeDays)
      || !nullableFiniteNumber(age.p90AgeDays)
      || !exactKeys(age.buckets, ['0-7d', '180d+', '30-90d', '7-30d', '90-180d'])) return false;
  for (const value of Object.values(age.buckets)) {
    checkDeadline(deadlineMs, now);
    if (!boundedInteger(value)) return false;
  }
  return true;
}

function validTrafficInput(traffic, deadlineMs, now) {
  if (!exactKeys(traffic, ['popularity', 'stats']) || !isPlainObject(traffic.popularity)) return false;
  for (const [slug, views] of Object.entries(traffic.popularity)) {
    checkDeadline(deadlineMs, now);
    if (!nonEmptyString(slug) || typeof views !== 'number' || !Number.isFinite(views) || views < 0) return false;
  }
  return validTrafficStats(traffic.stats, deadlineMs, now);
}

function inputCoherenceReasons(input, deadlineMs, now) {
  const reasons = [];
  if (!isPlainObject(input)) return ['input_not_plain_object'];
  checkDeadline(deadlineMs, now);
  if (!SHA_PATTERN.test(input.baselineMainSha ?? '')) reasons.push('baseline_main_sha_invalid');
  if (!normalizeRunBinding(input.runBinding, input.baselineMainSha)) reasons.push('run_binding_invalid');
  if (typeof input.dryRun !== 'boolean') reasons.push('dry_run_invalid');
  const hasNotAttemptedReason = Object.hasOwn(input, 'notAttemptedReason')
    && input.notAttemptedReason !== undefined;
  if (hasNotAttemptedReason && !nonEmptyString(input.notAttemptedReason)) {
    reasons.push('not_attempted_reason_invalid');
  }
  for (const name of ['jobs', 'pendingJobs']) {
    if (!Array.isArray(input[name])) reasons.push(`${name}_not_array`);
  }
  if (!isPlainObject(input.legacy)) reasons.push('legacy_contract_invalid');
  if (reasons.length > 0) return reasons;
  if (input.dryRun === true || nonEmptyString(input.notAttemptedReason)) return reasons;
  for (const name of ['orderedPending', 'capWindow', 'capWindowCompanyKeys', 'companyBudgets']) {
    if (!Array.isArray(input[name])) reasons.push(`${name}_not_array`);
  }
  if (!isPlainObject(input.traffic)) {
    reasons.push('traffic_capture_missing');
  } else {
    if (!isPlainObject(input.traffic.popularity)) reasons.push('traffic_popularity_invalid');
    if (!isPlainObject(input.traffic.stats)) reasons.push('traffic_stats_invalid');
  }
  if (reasons.length > 0) return reasons;
  if (!validLegacyInput(input.legacy, deadlineMs, now)) reasons.push('legacy_contract_invalid');
  if (!validTrafficInput(input.traffic, deadlineMs, now)) reasons.push('traffic_capture_invalid');
  if (reasons.length > 0) return reasons;
  if (!sameReferenceMultiset(input.pendingJobs, input.orderedPending, deadlineMs, now)) {
    reasons.push('traffic_order_not_same_pending_objects');
  }
  if (!boundedInteger(input.legacy.maxJobs) || input.legacy.maxJobs < 1) {
    reasons.push('legacy_max_jobs_invalid');
    return reasons;
  }
  const expectedCapLength = Math.min(input.legacy.maxJobs, input.orderedPending.length);
  let capPrefixMatches = input.capWindow.length === expectedCapLength;
  for (let index = 0; capPrefixMatches && index < input.capWindow.length; index += 1) {
    checkDeadline(deadlineMs, now);
    capPrefixMatches = input.capWindow[index] === input.orderedPending[index];
  }
  if (!capPrefixMatches) {
    reasons.push('cap_window_not_ordered_prefix');
  }
  let alignedKeysValid = input.capWindowCompanyKeys.length === input.capWindow.length;
  for (const key of input.capWindowCompanyKeys) {
    checkDeadline(deadlineMs, now);
    if (key !== null && !nonEmptyString(key)) alignedKeysValid = false;
  }
  if (!alignedKeysValid) {
    reasons.push('cap_window_company_keys_incoherent');
    return reasons;
  }
  const expectedBudgets = new Map();
  for (const key of input.capWindowCompanyKeys) {
    checkDeadline(deadlineMs, now);
    if (key !== null) expectedBudgets.set(key, (expectedBudgets.get(key) ?? 0) + 1);
  }
  const seenBudgets = new Set();
  let validBudgets = true;
  for (const entry of input.companyBudgets) {
    checkDeadline(deadlineMs, now);
    if (!exactKeys(entry, ['companyKey', 'jobs']) || !nonEmptyString(entry.companyKey)
        || !boundedInteger(entry.jobs) || entry.jobs < 1 || seenBudgets.has(entry.companyKey)) {
      validBudgets = false;
      continue;
    }
    seenBudgets.add(entry.companyKey);
  }
  const expectedEntries = [...expectedBudgets];
  let budgetsMatch = validBudgets && input.companyBudgets.length === expectedEntries.length;
  for (let index = 0; budgetsMatch && index < input.companyBudgets.length; index += 1) {
    checkDeadline(deadlineMs, now);
    const entry = input.companyBudgets[index];
    budgetsMatch = entry.companyKey === expectedEntries[index]?.[0]
      && entry.jobs === expectedEntries[index]?.[1];
  }
  if (!budgetsMatch) {
    reasons.push('company_budgets_incoherent');
  }
  return reasons;
}

function missingUnitsForJob(job) {
  const units = [];
  const titleByLocale = isPlainObject(job?.titleByLocale) ? job.titleByLocale : {};
  const descriptionByLocale = isPlainObject(job?.descriptionByLocale) ? job.descriptionByLocale : {};
  for (const locale of LOCALES) {
    const title = typeof titleByLocale[locale] === 'string' ? titleByLocale[locale].trim() : '';
    const description = typeof descriptionByLocale[locale] === 'string'
      ? descriptionByLocale[locale].trim() : '';
    if (title.length < 3) units.push(`${locale}:title`);
    if (description.length < 120) units.push(`${locale}:description`);
  }
  return units;
}

function collectMappingEvidence(pendingJobs, deadlineMs, now = Date.now) {
  const records = [];
  const recordsByReference = new Map();
  const reasonCounts = {};
  let demonstrableMissingUnits = 0;
  let maxDemonstrableUnitsPerJob = 0;
  const addReason = (reason) => { reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1; };
  for (let index = 0; index < pendingJobs.length; index += 1) {
    checkDeadline(deadlineMs, now);
    const job = pendingJobs[index];
    const units = missingUnitsForJob(job);
    const reasons = [];
    if (!LOCALES.includes(job?.sourceLang)) reasons.push('source_lang_unavailable');
    if (typeof job?.companyKey !== 'string' || job.companyKey.trim().length === 0) {
      reasons.push('explicit_company_key_unavailable');
    }
    if (![job?.id, job?.url, job?.slug].some((value) => typeof value === 'string' && value.trim())) {
      reasons.push('job_identity_unavailable');
    }
    if (job?.needsRetranslation === true && units.length === 0) {
      reasons.push('flagged_without_field_level_mapping');
    }
    reasons.push('queued_at_unavailable');
    for (const reason of reasons) addReason(reason);
    demonstrableMissingUnits += units.length;
    maxDemonstrableUnitsPerJob = Math.max(maxDemonstrableUnitsPerJob, units.length);
    const reference = jobRef(job);
    const jobDigest = digestDocument(canonicalRuntimeValue(job, true));
    checkDeadline(deadlineMs, now);
    const occurrenceOrdinal = index;
    const record = {
      occurrenceKey: `job-occurrence:v2:${digestDocument({
        jobDigest,
        occurrenceOrdinal,
      }).slice('sha256:'.length)}`,
      occurrenceOrdinal,
      jobRef: reference,
      jobDigest,
      demonstrableMissingUnits: units.length,
      missingUnitRefs: units,
      reasons: [...new Set(reasons)].sort(compareText),
    };
    records.push(record);
    const referenceRecords = recordsByReference.get(job) ?? [];
    referenceRecords.push(record);
    recordsByReference.set(job, referenceRecords);
  }
  const evidence = {
    complete: false,
    completeness: 'lower_bound',
    demonstrableMissingUnits,
    maxDemonstrableUnitsPerJob,
    reasonCounts: Object.fromEntries(Object.entries(reasonCounts).sort(([a], [b]) => compareText(a, b))),
    digest: digestDocument(records),
    records,
    samples: records.slice(0, SAMPLE_LIMIT),
    selectedRecords: [],
  };
  checkDeadline(deadlineMs, now);
  return { evidence, recordsByReference };
}

function collectSelectedMappingRecords(capWindow, recordsByReference, deadlineMs, now = Date.now) {
  const consumedByReference = new Map();
  const selectedRecords = [];
  for (const job of capWindow) {
    checkDeadline(deadlineMs, now);
    const consumed = consumedByReference.get(job) ?? 0;
    const mappingRecord = recordsByReference.get(job)?.[consumed];
    if (!mappingRecord) throw new InputBoundViolation('selected_mapping_reference_incoherent');
    consumedByReference.set(job, consumed + 1);
    selectedRecords.push({
      occurrenceKey: mappingRecord.occurrenceKey,
      demonstrableMissingUnits: mappingRecord.demonstrableMissingUnits,
    });
  }
  return selectedRecords;
}

function normalizeLegacyContract(input, capWindowDigest, deadlineMs, now) {
  const sourceLegacy = isPlainObject(input.legacy) ? input.legacy : {};
  const notAttemptedReason = input.dryRun
    ? 'legacy_dry_run_before_execution_plan'
    : nonEmptyString(input.notAttemptedReason) ? input.notAttemptedReason : null;
  const companyBudgets = [];
  for (const entry of Array.isArray(input.companyBudgets) ? input.companyBudgets : []) {
    checkDeadline(deadlineMs, now);
    if (isPlainObject(entry) && typeof entry.companyKey === 'string'
        && boundedInteger(entry.jobs) && entry.jobs > 0) {
      companyBudgets.push({
        companyKeyDigest: digestBoundedCompanyKey(entry.companyKey),
        jobs: entry.jobs,
      });
    }
  }
  const alignedCompanyKeys = Array.isArray(input.capWindowCompanyKeys) ? input.capWindowCompanyKeys : null;
  const companyKeyWitness = [];
  for (const key of alignedCompanyKeys ?? []) {
    checkDeadline(deadlineMs, now);
    companyKeyWitness.push(key === null ? null : digestBoundedCompanyKey(key));
  }
  let keylessCount = alignedCompanyKeys ? 0 : null;
  const keylessSamples = [];
  for (let index = 0; alignedCompanyKeys && index < alignedCompanyKeys.length; index += 1) {
    checkDeadline(deadlineMs, now);
    if (alignedCompanyKeys[index] === null) {
      keylessCount += 1;
      if (Array.isArray(input.capWindow)) {
        keylessSamples.push(jobRef(input.capWindow[index]));
        keylessSamples.sort(compareText);
        if (keylessSamples.length > SAMPLE_LIMIT) keylessSamples.pop();
      }
    }
  }
  return {
    executionGranularity: 'company_budget',
    queuedAt: { availability: 'unavailable', value: null },
    preClear: sourceLegacy.preClear ?? null,
    postClear: sourceLegacy.postClear ?? null,
    companyFilter: isPlainObject(sourceLegacy.companyFilter) ? {
      population: sourceLegacy.companyFilter.population,
      companyKeyDigest: sourceLegacy.companyFilter.value === null
        ? null : digestBoundedCompanyKey(sourceLegacy.companyFilter.value),
      before: sourceLegacy.companyFilter.before,
      after: sourceLegacy.companyFilter.after,
      ...(Object.hasOwn(sourceLegacy.companyFilter, 'reappliedAfterPreClear')
        ? { reappliedAfterPreClear: sourceLegacy.companyFilter.reappliedAfterPreClear }
        : {}),
    } : null,
    maxJobs: sourceLegacy.maxJobs ?? null,
    traffic: notAttemptedReason ? {
      status: 'not_read',
      reason: notAttemptedReason,
      allowNoTraffic: sourceLegacy.allowNoTraffic === true,
      source: sourceLegacy.trafficSource ?? null,
      digest: null,
    } : {
      status: 'observed',
      allowNoTraffic: sourceLegacy.allowNoTraffic === true,
      source: sourceLegacy.trafficSource ?? null,
      digest: digestDocument({ popularity: input.traffic.popularity, stats: input.traffic.stats }),
      stats: input.traffic.stats,
    },
    capWindow: {
      count: Array.isArray(input.capWindow) ? input.capWindow.length : null,
      digest: capWindowDigest,
      certainty: 'queued_company_budgets_not_executed_jobs',
    },
    companyBudgets,
    companyKeyWitness,
    keyless: {
      count: keylessCount,
      reasons: keylessCount > 0 ? ['legacy_company_key_resolution_empty'] : [],
      samples: keylessSamples,
    },
  };
}

function preflightDecisionArtifactBudget({
  deadlineMs, legacy, mapping, now, runBinding, verdictReasons,
}) {
  // Structural fields, digests and scalar contracts stay below this fixed
  // allowance; variable witnesses are charged individually before payload construction.
  let projectedBytes = 768 * 1024;
  const charge = (value) => {
    checkDeadline(deadlineMs, now);
    const fragment = canonicalJson(value);
    projectedBytes = addBoundedByteCount(
      projectedBytes,
      Buffer.byteLength(fragment, 'utf8'),
      TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES,
      'artifact_capacity_exceeded',
    );
  };
  for (const value of [
    runBinding,
    verdictReasons,
    mapping.reasonCounts,
    legacy.companyFilter,
    legacy.keyless,
    legacy.preClear,
    legacy.postClear,
    legacy.traffic,
  ]) charge(value);
  for (const record of mapping.records) charge(record);
  for (const record of mapping.samples) {
    charge(record); // mapping.samples
    charge(record); // v2.deferred.samples
  }
  for (const record of mapping.selectedRecords) charge(record);
  for (const entry of legacy.companyBudgets) charge(entry);
  for (const digest of legacy.companyKeyWitness) charge(digest);
  return projectedBytes;
}

function decisionReason({ coherenceReasons, notAttemptedReason, dryRun, capacityExceeded, mappingComplete, versionsBound }) {
  if (coherenceReasons.length > 0) return 'input_incoherent';
  if (dryRun) return 'legacy_dry_run_before_execution_plan';
  if (notAttemptedReason) return notAttemptedReason;
  if (capacityExceeded.length > 0) return 'capacity_exceeded';
  if (!mappingComplete) return 'mapping_incomplete';
  if (!versionsBound) return 'version_unbound';
  return 'measure_only';
}

function attachSelfDigest(payload, field) {
  return { ...payload, [field]: digestDocument(payload) };
}

function inputIncoherentDecision(input, reasons) {
  const baselineMainSha = SHA_PATTERN.test(input?.baselineMainSha ?? '') ? input.baselineMainSha : null;
  const runBinding = baselineMainSha ? normalizeRunBinding(input?.runBinding, baselineMainSha) : null;
  const payload = {
    schemaVersion: TRANSLATION_SHADOW_PREFLIGHT_V2_SCHEMA_VERSION,
    kind: 'translation_shadow_preflight_decision',
    mode: 'measure_only',
    runBinding,
    verdict: {
      outcome: 'reject',
      primaryReason: 'input_incoherent',
      reasons: [...new Set(['input_incoherent', ...reasons])].sort(compareText),
    },
    snapshot: {
      baselineMainSha,
      scanDigest: null,
      jobs: Array.isArray(input?.jobs) ? { count: input.jobs.length, digest: null } : null,
      pending: Array.isArray(input?.pendingJobs) ? { count: input.pendingJobs.length, digest: null } : null,
      orderedPending: null,
      capWindow: null,
      legacyCompanyBudgetSlice: null,
      traffic: { digest: null },
      sourceRuntimeContractDigest: baselineMainSha
        ? expectedSourceRuntimeContractDigest(baselineMainSha) : null,
    },
    capacity: { limits: TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS, observed: null, exceeded: [] },
    legacy: null,
    mapping: {
      complete: false,
      completeness: 'not_evaluated_input_incoherent',
      demonstrableMissingUnits: null,
      maxDemonstrableUnitsPerJob: null,
      reasonCounts: {},
      digest: null,
      samples: [],
    },
    v2: {
      state: { mode: 'not_read', reason: 'preflight_capacity_exceeded', value: null },
      plan: null,
      selection: null,
      cache: null,
      replay: null,
      fairness: { status: 'not_evaluated', numerator: 1, denominator: 5 },
      deferred: { counts: null, digest: null, samples: [] },
      plannerCallCount: 0,
    },
    quality: { status: 'unchanged', gateInvocations: 0, productionWrites: 0, paidCalls: 0 },
  };
  const decision = attachSelfDigest(payload, 'decisionDigest');
  if (Buffer.byteLength(`${canonicalJson(decision)}\n`) > TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES) {
    throw new TypeError('translation shadow preflight incoherent decision exceeds 8 MiB');
  }
  return decision;
}

function inputJobsCapacityExceededDecision(input) {
  const baselineMainSha = SHA_PATTERN.test(input?.baselineMainSha ?? '') ? input.baselineMainSha : null;
  const runBinding = baselineMainSha ? normalizeRunBinding(input?.runBinding, baselineMainSha) : null;
  const jobsCount = Array.isArray(input?.jobs) ? input.jobs.length : null;
  const pendingCount = Array.isArray(input?.pendingJobs) ? input.pendingJobs.length : null;
  return attachSelfDigest({
    schemaVersion: TRANSLATION_SHADOW_PREFLIGHT_V2_SCHEMA_VERSION,
    kind: 'translation_shadow_preflight_decision',
    mode: 'measure_only',
    runBinding,
    verdict: {
      outcome: 'reject',
      primaryReason: 'capacity_exceeded',
      reasons: ['capacity_exceeded:input_jobs', 'mapping_incomplete', 'version_unbound'],
    },
    snapshot: {
      baselineMainSha,
      scanDigest: null,
      jobs: jobsCount === null ? null : { count: jobsCount, digest: null },
      pending: pendingCount === null ? null : { count: pendingCount, digest: null },
      orderedPending: null,
      capWindow: null,
      legacyCompanyBudgetSlice: null,
      traffic: { digest: null },
      sourceRuntimeContractDigest: baselineMainSha
        ? expectedSourceRuntimeContractDigest(baselineMainSha) : null,
    },
    capacity: {
      limits: TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS,
      observed: {
        datasetJobs: jobsCount,
        pendingJobs: pendingCount,
        demonstrableMissingUnits: null,
        selectedDemonstrableMissingUnits: null,
        maxDemonstrableUnitsPerJob: null,
        maxLegacyCompanyBudgetJobs: null,
        capWindowJobs: null,
      },
      exceeded: ['input_jobs'],
    },
    legacy: null,
    mapping: {
      complete: false,
      completeness: 'not_evaluated_capacity_exceeded',
      demonstrableMissingUnits: null,
      maxDemonstrableUnitsPerJob: null,
      reasonCounts: pendingCount === null ? {} : {
        field_mapping_skipped_input_jobs_capacity: pendingCount,
      },
      digest: null,
      records: [],
      samples: [],
      selectedRecords: [],
    },
    v2: {
      state: { mode: 'not_read', reason: 'preflight_capacity_exceeded', value: null },
      plan: null,
      selection: null,
      cache: null,
      replay: null,
      fairness: { status: 'not_evaluated', numerator: 1, denominator: 5 },
      deferred: { counts: null, digest: null, samples: [] },
      plannerCallCount: 0,
    },
    quality: { status: 'unchanged', gateInvocations: 0, productionWrites: 0, paidCalls: 0 },
  }, 'decisionDigest');
}

function timeoutDecision(input) {
  const baselineMainSha = SHA_PATTERN.test(input?.baselineMainSha ?? '') ? input.baselineMainSha : null;
  const runBinding = baselineMainSha ? normalizeRunBinding(input?.runBinding, baselineMainSha) : null;
  return attachSelfDigest({
    schemaVersion: TRANSLATION_SHADOW_PREFLIGHT_V2_SCHEMA_VERSION,
    kind: 'translation_shadow_preflight_decision',
    mode: 'measure_only',
    runBinding,
    verdict: { outcome: 'reject', primaryReason: 'observer_timeout', reasons: ['observer_timeout'] },
    snapshot: { baselineMainSha, scanDigest: null, jobs: null, pending: null, capWindow: null, traffic: null },
    capacity: { limits: TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS, observed: null, exceeded: [] },
    legacy: null,
    mapping: { complete: false, completeness: 'not_evaluated', demonstrableMissingUnits: null },
    v2: {
      state: { mode: 'not_read', reason: 'observer_timeout', value: null },
      plan: null,
      selection: null,
      cache: null,
      replay: null,
      fairness: { status: 'not_evaluated', numerator: 1, denominator: 5 },
      deferred: { counts: null, digest: null, samples: [] },
      plannerCallCount: 0,
    },
    quality: { status: 'unchanged', gateInvocations: 0, productionWrites: 0, paidCalls: 0 },
  }, 'decisionDigest');
}

export function createTranslationShadowPreflightDecisionV2(input, {
  hardBudgetMs = TRANSLATION_SHADOW_PREFLIGHT_V2_HARD_BUDGET_MS,
  now = Date.now,
} = {}) {
  if (!Number.isFinite(hardBudgetMs) || hardBudgetMs <= 0
      || hardBudgetMs > TRANSLATION_SHADOW_PREFLIGHT_V2_HARD_BUDGET_MS) {
    return inputIncoherentDecision(input, ['hard_budget_invalid']);
  }
  let envelope;
  try {
    envelope = inspectArrayEnvelope(input);
  } catch {
    return inputIncoherentDecision(null, ['input_descriptor_invalid']);
  }
  if (envelope.oversized) return inputJobsCapacityExceededDecision(input);
  if (envelope.reasons.length > 0) return inputIncoherentDecision(input, envelope.reasons);
  let companyKeyReasons;
  try {
    companyKeyReasons = inspectCompanyKeyEnvelope(input);
  } catch {
    return inputIncoherentDecision(null, ['input_descriptor_invalid']);
  }
  if (companyKeyReasons.length > 0) return inputIncoherentDecision(input, companyKeyReasons);
  if (typeof now !== 'function') return inputIncoherentDecision(input, ['clock_invalid']);
  const startedMs = now();
  if (!Number.isFinite(startedMs)) return inputIncoherentDecision(input, ['clock_invalid']);
  const deadlineMs = startedMs + hardBudgetMs;
  try {
    preScanJobInputs(input, deadlineMs, now);
    const coherenceReasons = inputCoherenceReasons(input, deadlineMs, now);
    if (coherenceReasons.length > 0) {
      checkDeadline(deadlineMs, now);
      return inputIncoherentDecision(input, coherenceReasons);
    }
    const jobs = Array.isArray(input?.jobs) ? input.jobs : [];
    const pendingJobs = Array.isArray(input?.pendingJobs) ? input.pendingJobs : [];
    const capWindow = Array.isArray(input?.capWindow) ? input.capWindow : [];
    const orderedPending = Array.isArray(input?.orderedPending) ? input.orderedPending : [];
    const runBinding = normalizeRunBinding(input.runBinding, input.baselineMainSha);
    const inventoryHashCache = new WeakMap();
    const jobsDigest = digestFullInventory(jobs, deadlineMs, inventoryHashCache, now);
    const pendingDigest = digestFullInventory(pendingJobs, deadlineMs, inventoryHashCache, now);
    const notAttempted = input?.dryRun === true || nonEmptyString(input?.notAttemptedReason);
    const orderedDigest = notAttempted
      ? null : digestFullInventory(orderedPending, deadlineMs, inventoryHashCache, now);
    const capWindowDigest = notAttempted
      ? null : digestFullInventory(capWindow, deadlineMs, inventoryHashCache, now);
    const jobsCapacityExceeded = pendingJobs.length > TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS.inputJobs;
    const mappingCollection = jobsCapacityExceeded ? null
      : collectMappingEvidence(pendingJobs, deadlineMs, now);
    const mapping = jobsCapacityExceeded ? {
      complete: false,
      completeness: 'not_evaluated_capacity_exceeded',
      demonstrableMissingUnits: null,
      maxDemonstrableUnitsPerJob: null,
      reasonCounts: { field_mapping_skipped_input_jobs_capacity: pendingJobs.length },
      digest: digestDocument({ pendingDigest, status: 'not_evaluated_capacity_exceeded' }),
      records: [],
      samples: [],
      selectedRecords: [],
    } : mappingCollection.evidence;
    const selectedWitnessAvailable = !jobsCapacityExceeded && !notAttempted
      && capWindow.length <= TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS.selectedJobs;
    if (selectedWitnessAvailable) {
      mapping.selectedRecords = collectSelectedMappingRecords(
        capWindow, mappingCollection.recordsByReference, deadlineMs, now,
      );
    }
    const selectedDemonstrableMissingUnits = selectedWitnessAvailable
      ? mapping.selectedRecords.reduce((sum, record) => {
        checkDeadline(deadlineMs, now);
        return sum + record.demonstrableMissingUnits;
      }, 0)
      : null;
    const capacityExceeded = [];
    if (jobsCapacityExceeded) capacityExceeded.push('input_jobs');
    if (mapping.demonstrableMissingUnits > TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS.inputUnits) {
      capacityExceeded.push('input_units_lower_bound');
    }
    if (capWindow.length > TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS.selectedJobs) capacityExceeded.push('selected_jobs');
    if (selectedDemonstrableMissingUnits !== null
        && selectedDemonstrableMissingUnits > TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS.selectedUnits) {
      capacityExceeded.push('selected_units_lower_bound');
    }
    const trafficDigest = notAttempted || !isPlainObject(input?.traffic)
      ? null : digestDocument({ popularity: input.traffic.popularity, stats: input.traffic.stats });
    checkDeadline(deadlineMs, now);
    const scanDigest = digestDocument({
      baselineMainSha: input?.baselineMainSha ?? null,
      jobsDigest,
      pendingDigest,
      orderedDigest,
      capWindowDigest,
      trafficDigest,
      runBindingDigest: runBinding.digest,
    });
    checkDeadline(deadlineMs, now);
    const primaryReason = decisionReason({
      coherenceReasons,
      notAttemptedReason: input?.notAttemptedReason,
      dryRun: input?.dryRun === true,
      capacityExceeded,
      mappingComplete: mapping.complete,
      versionsBound: false,
    });
    const reasons = [...new Set([
      ...coherenceReasons,
      ...capacityExceeded.map((reason) => `capacity_exceeded:${reason}`),
      ...(!mapping.complete ? ['mapping_incomplete'] : []),
      'version_unbound',
    ])];
    const legacy = normalizeLegacyContract(input, capWindowDigest, deadlineMs, now);
    const companyBudgetSliceDigest = notAttempted ? null : digestDocument(legacy.companyBudgets);
    checkDeadline(deadlineMs, now);
    let maxLegacyCompanyBudgetJobs = null;
    if (!notAttempted) {
      for (const entry of legacy.companyBudgets) {
        checkDeadline(deadlineMs, now);
        maxLegacyCompanyBudgetJobs = maxLegacyCompanyBudgetJobs === null
          ? entry.jobs : Math.max(maxLegacyCompanyBudgetJobs, entry.jobs);
      }
    }
    preflightDecisionArtifactBudget({
      deadlineMs,
      legacy,
      mapping,
      now,
      runBinding,
      verdictReasons: notAttempted ? [primaryReason] : reasons,
    });
    const payload = {
      schemaVersion: TRANSLATION_SHADOW_PREFLIGHT_V2_SCHEMA_VERSION,
      kind: 'translation_shadow_preflight_decision',
      mode: 'measure_only',
      runBinding,
      verdict: {
        outcome: 'reject',
        primaryReason,
        reasons: notAttempted ? [primaryReason] : reasons,
      },
      snapshot: {
        baselineMainSha: SHA_PATTERN.test(input?.baselineMainSha ?? '') ? input.baselineMainSha : null,
        scanDigest,
        jobs: { count: jobs.length, digest: jobsDigest },
        pending: { count: pendingJobs.length, digest: pendingDigest },
        orderedPending: { count: notAttempted ? null : orderedPending.length, digest: orderedDigest },
        capWindow: { count: notAttempted ? null : capWindow.length, digest: capWindowDigest },
        legacyCompanyBudgetSlice: {
          count: notAttempted ? null : legacy.companyBudgets.length,
          digest: companyBudgetSliceDigest,
          source: notAttempted ? null : 'post_traffic_cap_company_budgets',
        },
        traffic: { digest: trafficDigest },
        sourceRuntimeContractDigest: expectedSourceRuntimeContractDigest(input.baselineMainSha),
      },
      capacity: {
        limits: TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS,
        observed: {
          datasetJobs: jobs.length,
          pendingJobs: pendingJobs.length,
          demonstrableMissingUnits: mapping.demonstrableMissingUnits,
          selectedDemonstrableMissingUnits,
          maxDemonstrableUnitsPerJob: mapping.maxDemonstrableUnitsPerJob,
          maxLegacyCompanyBudgetJobs,
          capWindowJobs: notAttempted ? null : capWindow.length,
        },
        exceeded: capacityExceeded,
      },
      legacy,
      mapping,
      v2: {
        state: { mode: 'not_read', reason: 'preflight_capacity_exceeded', value: null },
        plan: null,
        selection: null,
        cache: null,
        replay: null,
        fairness: { status: 'not_evaluated', numerator: 1, denominator: 5 },
        deferred: {
          counts: {
            jobs: pendingJobs.length,
            demonstrableMissingUnits: mapping.demonstrableMissingUnits,
          },
          digest: mapping.digest,
          samples: mapping.samples,
        },
        plannerCallCount: 0,
      },
      quality: { status: 'unchanged', gateInvocations: 0, productionWrites: 0, paidCalls: 0 },
    };
    const decision = attachSelfDigest(payload, 'decisionDigest');
    const bytes = Buffer.byteLength(`${canonicalJson(decision)}\n`);
    if (bytes > TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES) {
      return inputIncoherentDecision(input, ['artifact_capacity_exceeded']);
    }
    checkDeadline(deadlineMs, now);
    return decision;
  } catch (error) {
    if (error instanceof ObserverTimeout) return timeoutDecision(input);
    if (error instanceof InputBoundViolation) {
      try {
        checkDeadline(deadlineMs, now);
        return inputIncoherentDecision(input, [error.reason]);
      } catch (deadlineError) {
        if (deadlineError instanceof ObserverTimeout) return timeoutDecision(input);
        throw deadlineError;
      }
    }
    throw error;
  }
}

function canonicalExistingDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('runner temp must be passed explicitly');
  }
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root || !fs.existsSync(resolved)
      || !fs.statSync(resolved).isDirectory() || fs.lstatSync(resolved).isSymbolicLink()) {
    throw new TypeError('runner temp must be a real, existing, non-root directory');
  }
  const canonical = fs.realpathSync(resolved);
  let cursor = canonical;
  while (true) {
    if (fs.existsSync(path.join(cursor, '.git'))) {
      throw new TypeError('runner temp may not be inside a git worktree');
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return canonical;
}

export function assertSafeTranslationShadowOutputPath(outputPath, runnerTemp) {
  const root = canonicalExistingDirectory(runnerTemp);
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new TypeError('shadow output path is required');
  }
  const suppliedRoot = path.resolve(runnerTemp);
  const suppliedCandidate = path.resolve(outputPath);
  if (path.dirname(suppliedCandidate) !== suppliedRoot) {
    throw new TypeError('shadow output must be a flat file directly below runner temp');
  }
  const candidate = path.join(root, path.basename(suppliedCandidate));
  let stat = null;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TypeError('shadow output must be a regular non-symlink file');
    }
  }
  if (fs.realpathSync(path.dirname(candidate)) !== root) {
    throw new TypeError('shadow output must be a regular file');
  }
  return candidate;
}

export function serializeTranslationShadowArtifactV2(document) {
  const text = `${canonicalJson(document)}\n`;
  if (Buffer.byteLength(text) > TRANSLATION_SHADOW_PREFLIGHT_V2_MAX_BYTES) {
    throw new TypeError('translation shadow artifact exceeds 8 MiB');
  }
  return text;
}

export function writeTranslationShadowArtifactAtomicV2(outputPath, document, { runnerTemp } = {}) {
  const canonicalRunnerTemp = canonicalExistingDirectory(runnerTemp);
  const safeOutput = assertSafeTranslationShadowOutputPath(outputPath, runnerTemp);
  const text = serializeTranslationShadowArtifactV2(document);
  const privateTemporaryDirectory = fs.mkdtempSync(
    path.join(canonicalRunnerTemp, '.translation-shadow-preflight-v2-'),
  );
  const temporary = path.join(privateTemporaryDirectory, 'artifact.tmp');
  try {
    fs.chmodSync(privateTemporaryDirectory, 0o700);
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const recheckedOutput = assertSafeTranslationShadowOutputPath(outputPath, runnerTemp);
    if (recheckedOutput !== safeOutput) {
      throw new TypeError('shadow output path changed before publish');
    }
    if (fs.realpathSync(path.dirname(safeOutput)) !== canonicalRunnerTemp) {
      throw new TypeError('shadow output parent changed before publish');
    }
    fs.renameSync(temporary, safeOutput);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  } finally {
    try { fs.rmdirSync(privateTemporaryDirectory); } catch { /* best-effort cleanup */ }
  }
  return { bytes: Buffer.byteLength(text), outputPath: safeOutput };
}

export function runTranslationShadowPreflightV2(input, { outputPath, runnerTemp, hardBudgetMs } = {}) {
  const decision = createTranslationShadowPreflightDecisionV2(input, { hardBudgetMs });
  writeTranslationShadowArtifactAtomicV2(outputPath, decision, { runnerTemp });
  return decision;
}

export function validateTranslationShadowDecisionDigestV2(decision) {
  if (!isPlainObject(decision) || !DIGEST_PATTERN.test(decision.decisionDigest ?? '')) return false;
  const { decisionDigest, ...payload } = decision;
  try {
    return digestDocument(payload) === decisionDigest;
  } catch {
    return false;
  }
}

const VERDICT_REASON_ALLOWLIST = new Set([
  'capacity_exceeded',
  'capacity_exceeded:input_jobs',
  'capacity_exceeded:input_units_lower_bound',
  'capacity_exceeded:selected_jobs',
  'capacity_exceeded:selected_units_lower_bound',
  'legacy_dry_run_before_execution_plan',
  'legacy_no_pending_before_execution_plan',
  'legacy_preclear_emptied_execution_plan',
  'mapping_incomplete',
  'version_unbound',
]);
const MAPPING_REASON_ALLOWLIST = new Set([
  'explicit_company_key_unavailable',
  'field_mapping_skipped_input_jobs_capacity',
  'flagged_without_field_level_mapping',
  'job_identity_unavailable',
  'queued_at_unavailable',
  'source_lang_unavailable',
]);
const UNIT_REF_ORDER = LOCALES.flatMap((locale) => [
  `${locale}:title`, `${locale}:description`,
]);
const UNIT_REF_ALLOWLIST = new Set(UNIT_REF_ORDER);
const JOB_REF_PATTERN = /^job-ref:v2:[a-f0-9]{64}$/;
const OCCURRENCE_KEY_PATTERN = /^job-occurrence:v2:[a-f0-9]{64}$/;

function validSnapshotEntry(entry, { nullable = false } = {}) {
  if (!exactKeys(entry, ['count', 'digest'])) return false;
  if (nullable && entry.count === null && entry.digest === null) return true;
  return boundedInteger(entry.count) && DIGEST_PATTERN.test(entry.digest ?? '');
}

function validMappingRecord(record) {
  if (!exactKeys(record, [
    'demonstrableMissingUnits', 'jobDigest', 'jobRef', 'missingUnitRefs', 'occurrenceKey',
    'occurrenceOrdinal', 'reasons',
  ]) || !JOB_REF_PATTERN.test(record.jobRef ?? '')
      || !DIGEST_PATTERN.test(record.jobDigest ?? '')
      || !OCCURRENCE_KEY_PATTERN.test(record.occurrenceKey ?? '')
      || !boundedInteger(record.occurrenceOrdinal)
      || record.occurrenceKey !== `job-occurrence:v2:${digestDocument({
        jobDigest: record.jobDigest,
        occurrenceOrdinal: record.occurrenceOrdinal,
      }).slice('sha256:'.length)}`
      || !boundedInteger(record.demonstrableMissingUnits)
      || record.demonstrableMissingUnits > 8
      || !Array.isArray(record.missingUnitRefs)
      || record.missingUnitRefs.length !== record.demonstrableMissingUnits
      || record.missingUnitRefs.some((unit) => !UNIT_REF_ALLOWLIST.has(unit))
      || canonicalJson(record.missingUnitRefs) !== canonicalJson(
        UNIT_REF_ORDER.filter((unit) => record.missingUnitRefs.includes(unit)),
      )
      || !Array.isArray(record.reasons)
      || !record.reasons.includes('queued_at_unavailable')
      || record.reasons.some((reason) => !MAPPING_REASON_ALLOWLIST.has(reason))) return false;
  return canonicalJson(record.reasons)
    === canonicalJson([...new Set(record.reasons)].sort(compareText));
}

function validSelectedRecord(record) {
  return exactKeys(record, ['demonstrableMissingUnits', 'occurrenceKey'])
    && OCCURRENCE_KEY_PATTERN.test(record.occurrenceKey ?? '')
    && boundedInteger(record.demonstrableMissingUnits)
    && record.demonstrableMissingUnits <= 8;
}

function validateTranslationShadowDecisionSemanticsV2(decision) {
  try {
    if (!exactKeys(decision, [
      'capacity', 'decisionDigest', 'kind', 'legacy', 'mapping', 'mode', 'quality',
      'runBinding', 'schemaVersion', 'snapshot', 'v2', 'verdict',
    ]) || decision.schemaVersion !== TRANSLATION_SHADOW_PREFLIGHT_V2_SCHEMA_VERSION
        || decision.kind !== 'translation_shadow_preflight_decision'
        || decision.mode !== 'measure_only'
        || !validRunBindingDocument(decision.runBinding)
        || !exactKeys(decision.verdict, ['outcome', 'primaryReason', 'reasons'])
        || decision.verdict.outcome !== 'reject'
        || !VERDICT_REASON_ALLOWLIST.has(decision.verdict.primaryReason)
        || !Array.isArray(decision.verdict.reasons)
        || decision.verdict.reasons.length === 0
        || decision.verdict.reasons.some((reason) => !VERDICT_REASON_ALLOWLIST.has(reason))) return false;

    const snapshot = decision.snapshot;
    if (!exactKeys(snapshot, [
      'baselineMainSha', 'capWindow', 'jobs', 'legacyCompanyBudgetSlice', 'orderedPending',
      'pending', 'scanDigest', 'sourceRuntimeContractDigest', 'traffic',
    ]) || !SHA_PATTERN.test(snapshot.baselineMainSha ?? '')
        || !DIGEST_PATTERN.test(snapshot.scanDigest ?? '')
        || !validSnapshotEntry(snapshot.jobs) || !validSnapshotEntry(snapshot.pending)
        || !validSnapshotEntry(snapshot.orderedPending, { nullable: true })
        || !validSnapshotEntry(snapshot.capWindow, { nullable: true })
        || !exactKeys(snapshot.traffic, ['digest'])
        || (snapshot.traffic.digest !== null && !DIGEST_PATTERN.test(snapshot.traffic.digest ?? ''))
        || !exactKeys(snapshot.legacyCompanyBudgetSlice, ['count', 'digest', 'source'])
        || !DIGEST_PATTERN.test(snapshot.sourceRuntimeContractDigest ?? '')) return false;
    const notAttempted = snapshot.orderedPending.count === null;
    if (notAttempted !== (snapshot.capWindow.count === null)
        || notAttempted !== (snapshot.traffic.digest === null)
        || (!notAttempted && snapshot.orderedPending.count !== snapshot.pending.count)
        || (notAttempted && (snapshot.legacyCompanyBudgetSlice.count !== null
          || snapshot.legacyCompanyBudgetSlice.digest !== null
          || snapshot.legacyCompanyBudgetSlice.source !== null))
        || (!notAttempted && (!boundedInteger(snapshot.legacyCompanyBudgetSlice.count)
          || !DIGEST_PATTERN.test(snapshot.legacyCompanyBudgetSlice.digest ?? '')
          || snapshot.legacyCompanyBudgetSlice.source !== 'post_traffic_cap_company_budgets'))) return false;
    const expectedScanDigest = digestDocument({
      baselineMainSha: snapshot.baselineMainSha,
      jobsDigest: snapshot.jobs.digest,
      pendingDigest: snapshot.pending.digest,
      orderedDigest: snapshot.orderedPending.digest,
      capWindowDigest: snapshot.capWindow.digest,
      trafficDigest: snapshot.traffic.digest,
      runBindingDigest: decision.runBinding.digest,
    });
    if (snapshot.scanDigest !== expectedScanDigest
        || decision.runBinding.sourceCommit !== snapshot.baselineMainSha) return false;

    const capacity = decision.capacity;
    const observed = capacity?.observed;
    if (!exactKeys(capacity, ['exceeded', 'limits', 'observed'])
        || !exactKeys(capacity.limits, ['inputJobs', 'inputUnits', 'selectedJobs', 'selectedUnits'])
        || canonicalJson(capacity.limits) !== canonicalJson(TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS)
        || !exactKeys(observed, [
          'capWindowJobs', 'datasetJobs', 'demonstrableMissingUnits', 'maxDemonstrableUnitsPerJob',
          'maxLegacyCompanyBudgetJobs', 'pendingJobs', 'selectedDemonstrableMissingUnits',
        ]) || observed.datasetJobs !== snapshot.jobs.count || observed.pendingJobs !== snapshot.pending.count
        || observed.capWindowJobs !== snapshot.capWindow.count
        || !Array.isArray(capacity.exceeded)) return false;

    const mapping = decision.mapping;
    if (!exactKeys(mapping, [
      'complete', 'completeness', 'demonstrableMissingUnits', 'digest',
      'maxDemonstrableUnitsPerJob', 'reasonCounts', 'records', 'samples', 'selectedRecords',
    ]) || mapping.complete !== false
        || !['lower_bound', 'not_evaluated_capacity_exceeded'].includes(mapping.completeness)
        || !DIGEST_PATTERN.test(mapping.digest ?? '')
        || !isPlainObject(mapping.reasonCounts) || !Array.isArray(mapping.records)
        || !Array.isArray(mapping.samples) || !Array.isArray(mapping.selectedRecords)
        || mapping.records.length > TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS.inputJobs
        || mapping.samples.length > SAMPLE_LIMIT
        || mapping.selectedRecords.length > TRANSLATION_SHADOW_PREFLIGHT_V2_LIMITS.selectedJobs
        || !mapping.records.every(validMappingRecord)
        || !mapping.samples.every(validMappingRecord)
        || !mapping.selectedRecords.every(validSelectedRecord)) return false;
    for (const [reason, count] of Object.entries(mapping.reasonCounts)) {
      if (!MAPPING_REASON_ALLOWLIST.has(reason) || !boundedInteger(count) || count < 1
          || count > snapshot.pending.count) return false;
    }
    const mappingSkipped = mapping.completeness === 'not_evaluated_capacity_exceeded';
    if (mappingSkipped) {
      if (mapping.demonstrableMissingUnits !== null || mapping.maxDemonstrableUnitsPerJob !== null
          || mapping.records.length !== 0 || mapping.samples.length !== 0
          || mapping.selectedRecords.length !== 0
          || !exactKeys(mapping.reasonCounts, ['field_mapping_skipped_input_jobs_capacity'])
          || mapping.reasonCounts.field_mapping_skipped_input_jobs_capacity !== snapshot.pending.count
          || mapping.digest !== digestDocument({
            pendingDigest: snapshot.pending.digest,
            status: 'not_evaluated_capacity_exceeded',
          })) return false;
    } else if (!boundedInteger(mapping.demonstrableMissingUnits)
        || !boundedInteger(mapping.maxDemonstrableUnitsPerJob)
        || mapping.maxDemonstrableUnitsPerJob > 8
        || mapping.demonstrableMissingUnits > snapshot.pending.count * 8
        || (mapping.reasonCounts.queued_at_unavailable ?? 0) !== snapshot.pending.count
        || mapping.records.length !== snapshot.pending.count
        || mapping.samples.length !== Math.min(SAMPLE_LIMIT, snapshot.pending.count)
        || canonicalJson(mapping.samples) !== canonicalJson(mapping.records.slice(0, SAMPLE_LIMIT))) return false;
    if (!mappingSkipped) {
      let recordUnitsSum = 0;
      let recordMaxUnits = 0;
      const recordReasonCounts = {};
      const occurrenceKeys = new Set();
      for (let index = 0; index < mapping.records.length; index += 1) {
        const record = mapping.records[index];
        if (record.occurrenceOrdinal !== index || occurrenceKeys.has(record.occurrenceKey)) return false;
        occurrenceKeys.add(record.occurrenceKey);
        recordUnitsSum += record.demonstrableMissingUnits;
        recordMaxUnits = Math.max(recordMaxUnits, record.demonstrableMissingUnits);
        for (const reason of record.reasons) {
          recordReasonCounts[reason] = (recordReasonCounts[reason] ?? 0) + 1;
        }
      }
      const canonicalReasonCounts = Object.fromEntries(
        Object.entries(recordReasonCounts).sort(([left], [right]) => compareText(left, right)),
      );
      if (recordUnitsSum !== mapping.demonstrableMissingUnits
          || recordMaxUnits !== mapping.maxDemonstrableUnitsPerJob
          || canonicalJson(canonicalReasonCounts) !== canonicalJson(mapping.reasonCounts)
          || mapping.digest !== digestDocument(mapping.records)
          || snapshot.pending.digest !== digestDocument(
            mapping.records.map((record) => record.jobDigest),
          )) return false;
    }
    const selectedUnitsUnavailable = notAttempted || mappingSkipped
      || snapshot.capWindow.count > capacity.limits.selectedJobs;
    if (observed.demonstrableMissingUnits !== mapping.demonstrableMissingUnits
        || observed.maxDemonstrableUnitsPerJob !== mapping.maxDemonstrableUnitsPerJob
        || (selectedUnitsUnavailable ? observed.selectedDemonstrableMissingUnits !== null
          : !boundedInteger(observed.selectedDemonstrableMissingUnits))
        || (selectedUnitsUnavailable && mapping.selectedRecords.length !== 0)
        || (!selectedUnitsUnavailable
          && mapping.selectedRecords.length !== snapshot.capWindow.count)) return false;
    if (!selectedUnitsUnavailable) {
      const mappingRecordsByKey = new Map(mapping.records.map((record) => [record.occurrenceKey, record]));
      const selectedKeys = new Set();
      let selectedUnits = 0;
      for (const record of mapping.selectedRecords) {
        const mapped = mappingRecordsByKey.get(record.occurrenceKey);
        if (!mapped || selectedKeys.has(record.occurrenceKey)
            || record.demonstrableMissingUnits !== mapped.demonstrableMissingUnits) return false;
        selectedKeys.add(record.occurrenceKey);
        selectedUnits += record.demonstrableMissingUnits;
      }
      const selectedJobDigests = mapping.selectedRecords.map((record) => (
        mappingRecordsByKey.get(record.occurrenceKey).jobDigest
      ));
      if (selectedUnits !== observed.selectedDemonstrableMissingUnits
          || snapshot.capWindow.digest !== digestDocument(selectedJobDigests)) return false;
      if (snapshot.capWindow.count === snapshot.pending.count
          && (snapshot.capWindow.digest !== snapshot.orderedPending.digest
            || selectedKeys.size !== mapping.records.length
            || selectedUnits !== mapping.demonstrableMissingUnits)) return false;
    } else if (!notAttempted && snapshot.capWindow.count === snapshot.pending.count
        && snapshot.capWindow.digest !== snapshot.orderedPending.digest) return false;

    const legacy = decision.legacy;
    if (!exactKeys(legacy, [
      'capWindow', 'companyBudgets', 'companyFilter', 'companyKeyWitness', 'executionGranularity', 'keyless',
      'maxJobs', 'postClear', 'preClear', 'queuedAt', 'traffic',
    ]) || legacy.executionGranularity !== 'company_budget'
        || !exactKeys(legacy.queuedAt, ['availability', 'value'])
        || legacy.queuedAt.availability !== 'unavailable' || legacy.queuedAt.value !== null
        || !boundedInteger(legacy.maxJobs) || legacy.maxJobs < 1
        || !exactKeys(legacy.capWindow, ['certainty', 'count', 'digest'])
        || legacy.capWindow.certainty !== 'queued_company_budgets_not_executed_jobs'
        || legacy.capWindow.count !== snapshot.capWindow.count
        || legacy.capWindow.digest !== snapshot.capWindow.digest
        || !Array.isArray(legacy.companyBudgets) || !Array.isArray(legacy.companyKeyWitness)
        || legacy.companyKeyWitness.some((digest) => digest !== null && !DIGEST_PATTERN.test(digest))
        || !exactKeys(legacy.keyless, ['count', 'reasons', 'samples'])
        || !Array.isArray(legacy.keyless.reasons) || !Array.isArray(legacy.keyless.samples)
        || legacy.keyless.samples.length > SAMPLE_LIMIT
        || legacy.keyless.samples.some((sample) => !JOB_REF_PATTERN.test(sample))
        || canonicalJson(legacy.keyless.samples)
          !== canonicalJson([...legacy.keyless.samples].sort(compareText))) return false;
    const hasReappliedAfterPreClear = Object.hasOwn(
      legacy.companyFilter ?? {}, 'reappliedAfterPreClear',
    );
    const filterKeys = hasReappliedAfterPreClear
      ? ['after', 'before', 'companyKeyDigest', 'population', 'reappliedAfterPreClear']
      : ['after', 'before', 'companyKeyDigest', 'population'];
    const dryRunNotAttempted = notAttempted
      && decision.verdict.primaryReason === 'legacy_dry_run_before_execution_plan';
    if (!exactKeys(legacy.companyFilter, filterKeys)
        || legacy.companyFilter.population !== 'assembled_company_filtered'
        || (legacy.companyFilter.companyKeyDigest !== null
          && !DIGEST_PATTERN.test(legacy.companyFilter.companyKeyDigest ?? ''))
        || !boundedInteger(legacy.companyFilter.before) || !boundedInteger(legacy.companyFilter.after)
        || legacy.companyFilter.before < legacy.companyFilter.after
        || legacy.companyFilter.after !== snapshot.pending.count
        || (!notAttempted && !hasReappliedAfterPreClear)
        || (hasReappliedAfterPreClear
          && typeof legacy.companyFilter.reappliedAfterPreClear !== 'boolean')
        || (dryRunNotAttempted
          ? legacy.postClear !== null
          : !exactKeys(legacy.postClear, ['pending', 'population'])
            || legacy.postClear.population !== 'assembled_company_filtered'
            || !boundedInteger(legacy.postClear.pending)
            || legacy.postClear.pending !== snapshot.pending.count)) return false;
    if (dryRunNotAttempted) {
      if (!exactKeys(legacy.preClear, ['reason', 'status'])
          || legacy.preClear.status !== 'not_attempted'
          || legacy.preClear.reason !== 'legacy_dry_run_before_execution_plan') return false;
    } else if (Object.hasOwn(legacy.preClear ?? {}, 'status')) {
      if (!notAttempted || !exactKeys(legacy.preClear, ['status'])
          || legacy.preClear.status !== 'not_needed') return false;
    } else if (!exactKeys(legacy.preClear, ['assembled', 'direct', 'filteredPending'])
        || !exactKeys(legacy.preClear.direct, ['cleared', 'population', 'reset'])
        || legacy.preClear.direct.population !== 'all_per_crawler_occurrences'
        || !boundedInteger(legacy.preClear.direct.cleared)
        || !boundedInteger(legacy.preClear.direct.reset)
        || !exactKeys(legacy.preClear.assembled, ['flagsCleared', 'population'])
        || legacy.preClear.assembled.population !== 'all_assembled_jobs'
        || !boundedInteger(legacy.preClear.assembled.flagsCleared)
        || !exactKeys(legacy.preClear.filteredPending, ['before', 'population'])
        || legacy.preClear.filteredPending.population !== 'assembled_company_filtered'
        || !boundedInteger(legacy.preClear.filteredPending.before)
        || legacy.preClear.filteredPending.before < legacy.postClear.pending) return false;
    const expectedCompanyBudgets = new Map();
    let witnessKeylessCount = 0;
    for (const companyKeyDigest of legacy.companyKeyWitness) {
      if (companyKeyDigest === null) witnessKeylessCount += 1;
      else expectedCompanyBudgets.set(
        companyKeyDigest, (expectedCompanyBudgets.get(companyKeyDigest) ?? 0) + 1,
      );
    }
    const expectedCompanyBudgetEntries = [...expectedCompanyBudgets]
      .map(([companyKeyDigest, jobs]) => ({ companyKeyDigest, jobs }));
    let companyBudgetSum = 0;
    let maxCompanyBudget = null;
    const seenCompanies = new Set();
    for (const entry of legacy.companyBudgets) {
      if (!exactKeys(entry, ['companyKeyDigest', 'jobs'])
          || !DIGEST_PATTERN.test(entry.companyKeyDigest ?? '')
          || !boundedInteger(entry.jobs) || entry.jobs < 1
          || seenCompanies.has(entry.companyKeyDigest)) return false;
      seenCompanies.add(entry.companyKeyDigest);
      companyBudgetSum += entry.jobs;
      maxCompanyBudget = maxCompanyBudget === null ? entry.jobs : Math.max(maxCompanyBudget, entry.jobs);
    }
    if (notAttempted) {
      if (legacy.companyBudgets.length !== 0 || legacy.companyKeyWitness.length !== 0
          || legacy.keyless.count !== null
          || legacy.keyless.reasons.length !== 0 || legacy.keyless.samples.length !== 0
          || observed.maxLegacyCompanyBudgetJobs !== null) return false;
    } else if (legacy.companyKeyWitness.length !== snapshot.capWindow.count
        || canonicalJson(legacy.companyBudgets) !== canonicalJson(expectedCompanyBudgetEntries)
        || !boundedInteger(legacy.keyless.count)
        || legacy.keyless.count !== witnessKeylessCount
        || companyBudgetSum + legacy.keyless.count !== snapshot.capWindow.count
        || legacy.keyless.samples.length !== Math.min(SAMPLE_LIMIT, legacy.keyless.count)
        || observed.maxLegacyCompanyBudgetJobs !== maxCompanyBudget
        || snapshot.legacyCompanyBudgetSlice.count !== legacy.companyBudgets.length
        || snapshot.legacyCompanyBudgetSlice.digest !== digestDocument(legacy.companyBudgets)
        || (legacy.keyless.count > 0
          ? canonicalJson(legacy.keyless.reasons) !== canonicalJson(['legacy_company_key_resolution_empty'])
          : legacy.keyless.reasons.length !== 0)) return false;
    if (!exactKeys(legacy.traffic, notAttempted
      ? ['allowNoTraffic', 'digest', 'reason', 'source', 'status']
      : ['allowNoTraffic', 'digest', 'source', 'stats', 'status'])
        || typeof legacy.traffic.allowNoTraffic !== 'boolean'
        || !nonEmptyString(legacy.traffic.source)) return false;
    if (notAttempted) {
      if (legacy.traffic.status !== 'not_read' || legacy.traffic.digest !== null
          || legacy.traffic.reason !== decision.verdict.primaryReason) return false;
    } else if (legacy.traffic.status !== 'observed'
        || legacy.traffic.digest !== snapshot.traffic.digest
        || !validTrafficStats(legacy.traffic.stats)
        || legacy.traffic.stats.queued !== snapshot.orderedPending.count
        || legacy.traffic.stats.age.count !== snapshot.orderedPending.count
        || legacy.traffic.stats.matched > legacy.traffic.stats.queued
        || legacy.traffic.stats.age.withTimestamp > legacy.traffic.stats.age.count
        || Object.values(legacy.traffic.stats.age.buckets).reduce((sum, count) => sum + count, 0)
          !== legacy.traffic.stats.age.withTimestamp
        || snapshot.capWindow.count !== Math.min(legacy.maxJobs, snapshot.orderedPending.count)
        || legacy.companyFilter.after !== snapshot.pending.count
        || legacy.postClear.pending !== snapshot.pending.count) return false;

    const expectedExceeded = [];
    if (snapshot.pending.count > capacity.limits.inputJobs) expectedExceeded.push('input_jobs');
    if (mapping.demonstrableMissingUnits > capacity.limits.inputUnits) expectedExceeded.push('input_units_lower_bound');
    if (snapshot.capWindow.count > capacity.limits.selectedJobs) expectedExceeded.push('selected_jobs');
    if (observed.selectedDemonstrableMissingUnits > capacity.limits.selectedUnits) expectedExceeded.push('selected_units_lower_bound');
    if (canonicalJson(capacity.exceeded) !== canonicalJson(expectedExceeded)) return false;

    const v2 = decision.v2;
    if (!exactKeys(v2, ['cache', 'deferred', 'fairness', 'plan', 'plannerCallCount', 'replay', 'selection', 'state'])
        || !exactKeys(v2.state, ['mode', 'reason', 'value'])
        || v2.state.mode !== 'not_read' || v2.state.reason !== 'preflight_capacity_exceeded'
        || v2.state.value !== null || v2.plan !== null || v2.selection !== null
        || v2.cache !== null || v2.replay !== null || v2.plannerCallCount !== 0
        || !exactKeys(v2.fairness, ['denominator', 'numerator', 'status'])
        || v2.fairness.status !== 'not_evaluated' || v2.fairness.numerator !== 1
        || v2.fairness.denominator !== 5
        || !exactKeys(v2.deferred, ['counts', 'digest', 'samples'])
        || !exactKeys(v2.deferred.counts, ['demonstrableMissingUnits', 'jobs'])
        || v2.deferred.counts.jobs !== snapshot.pending.count
        || v2.deferred.counts.demonstrableMissingUnits !== mapping.demonstrableMissingUnits
        || v2.deferred.digest !== mapping.digest
        || canonicalJson(v2.deferred.samples) !== canonicalJson(mapping.samples)) return false;
    if (!exactKeys(decision.quality, ['gateInvocations', 'paidCalls', 'productionWrites', 'status'])
        || decision.quality.status !== 'unchanged' || decision.quality.gateInvocations !== 0
        || decision.quality.productionWrites !== 0 || decision.quality.paidCalls !== 0) return false;

    const expectedPrimaryReason = notAttempted ? legacy.traffic.reason
      : expectedExceeded.length > 0 ? 'capacity_exceeded' : 'mapping_incomplete';
    const expectedReasons = notAttempted ? [expectedPrimaryReason] : [
      ...expectedExceeded.map((reason) => `capacity_exceeded:${reason}`),
      'mapping_incomplete',
      'version_unbound',
    ];
    return decision.verdict.primaryReason === expectedPrimaryReason
      && canonicalJson(decision.verdict.reasons) === canonicalJson(expectedReasons);
  } catch {
    return false;
  }
}

export function createTranslationShadowObservationV2(input) {
  const decision = isPlainObject(input?.decision) ? input.decision : null;
  const sourceCommit = SHA_PATTERN.test(input?.sourceCommit ?? '') ? input.sourceCommit : null;
  const expectedRunBinding = sourceCommit
    ? normalizeRunBinding(input?.expectedRunBinding, sourceCommit) : null;
  const runBindingBound = expectedRunBinding !== null
    && validRunBindingDocument(decision?.runBinding)
    && canonicalJson(expectedRunBinding) === canonicalJson(decision.runBinding);
  const integrityValid = validateTranslationShadowDecisionDigestV2(decision) && runBindingBound;
  const semanticValid = integrityValid && validateTranslationShadowDecisionSemanticsV2(decision);
  const expectedDecisionDigest = DIGEST_PATTERN.test(input?.expectedDecisionDigest ?? '')
    ? input.expectedDecisionDigest : null;
  const expectedContractDigest = DIGEST_PATTERN.test(input?.expectedContractDigest ?? '')
    ? input.expectedContractDigest : null;
  const externalDigestBound = semanticValid && expectedDecisionDigest === decision.decisionDigest;
  const baselineBound = semanticValid && sourceCommit === decision.snapshot.baselineMainSha;
  const recomputedContractDigest = sourceCommit
    ? expectedSourceRuntimeContractDigest(sourceCommit) : null;
  const contractBound = baselineBound
    && decision.snapshot.sourceRuntimeContractDigest === recomputedContractDigest
    && expectedContractDigest === recomputedContractDigest;
  const defaultInputsProvided = Object.hasOwn(input ?? {}, 'defaultInputs');
  const rawDefaultInputs = input?.defaultInputs;
  const defaultInputsValid = !defaultInputsProvided || (exactKeys(rawDefaultInputs, [
    'companyKeyDigest', 'dryRun', 'maxJobs', 'mopupMaxJobs',
    'skipHousekeeping', 'skipTranslate',
  ]) && (rawDefaultInputs.companyKeyDigest === null
    || DIGEST_PATTERN.test(rawDefaultInputs.companyKeyDigest ?? ''))
    && typeof rawDefaultInputs.dryRun === 'boolean'
    && (rawDefaultInputs.maxJobs === null || boundedInteger(rawDefaultInputs.maxJobs))
    && (rawDefaultInputs.mopupMaxJobs === null || boundedInteger(rawDefaultInputs.mopupMaxJobs))
    && typeof rawDefaultInputs.skipHousekeeping === 'boolean'
    && typeof rawDefaultInputs.skipTranslate === 'boolean');
  const defaultInputs = defaultInputsValid && defaultInputsProvided ? {
    companyKeyDigest: rawDefaultInputs.companyKeyDigest,
    dryRun: rawDefaultInputs.dryRun,
    maxJobs: rawDefaultInputs.maxJobs,
    mopupMaxJobs: rawDefaultInputs.mopupMaxJobs,
    skipHousekeeping: rawDefaultInputs.skipHousekeeping,
    skipTranslate: rawDefaultInputs.skipTranslate,
  } : null;
  const defaultCompanyKeyBound = !defaultInputsProvided || (defaultInputsValid && semanticValid
    && defaultInputs.companyKeyDigest === decision.legacy?.companyFilter?.companyKeyDigest);
  const decisionTrusted = semanticValid && externalDigestBound && baselineBound && contractBound
    && defaultCompanyKeyBound;
  const finalTranslationCommit = SHA_PATTERN.test(input?.finalTranslationCommit ?? '')
    ? input.finalTranslationCommit : null;
  const payload = {
    schemaVersion: TRANSLATION_SHADOW_PREFLIGHT_V2_SCHEMA_VERSION,
    kind: 'translation_shadow_preflight_observation',
    event: {
      name: input?.eventName ?? null,
      action: input?.eventAction ?? null,
    },
    attempt: {
      runId: input?.runId ?? null,
      runAttempt: input?.runAttempt ?? null,
    },
    defaultInputs,
    sourceRuntime: {
      repository: input?.sourceRepository ?? null,
      sourceCommit,
      contractDigest: decisionTrusted ? decision.snapshot?.sourceRuntimeContractDigest ?? null : null,
      runBindingDigest: decisionTrusted ? decision.runBinding?.digest ?? null : null,
    },
    phases: {
      decisionRunnerMs: null,
      observationFinalizerRunnerMs: boundedInteger(input?.finalizerRunnerMs) ? input.finalizerRunnerMs : null,
    },
    decision: {
      integrityValid,
      semanticValid,
      trusted: decisionTrusted,
      digest: decisionTrusted ? decision.decisionDigest : null,
      primaryReason: decisionTrusted ? decision.verdict?.primaryReason ?? null : null,
    },
    finalTranslationCommit,
    conclusion: {
      observedJobStatus: input?.observedJobStatus ?? null,
      authority: 'not_yet_terminal',
      terminalSuccess: null,
    },
    eligibility: { status: 'external_not_evaluated' },
    streak: { status: 'external_not_evaluated' },
  };
  const observation = attachSelfDigest(payload, 'observationDigest');
  serializeTranslationShadowArtifactV2(observation);
  return observation;
}
