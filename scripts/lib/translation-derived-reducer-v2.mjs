import {
  assertTranslationPlainObjectV2,
  deepFreezeTranslationV2,
} from './translation-unit-identity-v2.mjs';
import { normalizeTranslationText } from './translation-unit-identity.mjs';
import {
  createJobTranslationUnitIdentityV2,
  resolveJobTranslationTargetKeyV2,
  validateTranslationDerivedPatchV2,
} from './translation-derived-patch-v2.mjs';

export const MAX_TRANSLATION_DERIVED_PATCH_BATCH_V2 = 250;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonData(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${label} must contain only JSON data`);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} must contain only JSON data`);
  }
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain JSON cycles`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    const indexKeys = [];
    for (const key of keys) {
      if (key === 'length') continue;
      if (
        typeof key === 'symbol'
        || !/^(?:0|[1-9]\d*)$/.test(key)
        || Number(key) >= value.length
        || Number(key) >= 0xffffffff
      ) {
        throw new TypeError(`${label} must contain only dense JSON arrays`);
      }
      indexKeys.push(key);
    }
    if (indexKeys.length !== value.length) {
      throw new TypeError(`${label} must contain only dense JSON arrays`);
    }
    for (const key of indexKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} must contain only JSON data properties`);
      }
      assertJsonData(descriptor.value, label, ancestors);
    }
  } else {
    if (!isPlainObject(value)) throw new TypeError(`${label} must contain only plain JSON objects`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw new TypeError(`${label} must not contain symbol keys`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} must contain only JSON data properties`);
      }
      assertJsonData(descriptor.value, label, ancestors);
    }
  }
  ancestors.delete(value);
}

function comparableTranslationText(value) {
  return normalizeTranslationText(value).trim().replace(/\s+/gu, ' ');
}

function sameIdentity(left, right) {
  return left.key === right.key
    && left.kind === right.kind
    && left.fieldPath === right.fieldPath
    && left.sourceLocale === right.sourceLocale
    && left.targetLocale === right.targetLocale
    && left.sourceHash === right.sourceHash
    && left.contextHash === right.contextHash;
}

function buildJobKeyIndex(jobs) {
  const indicesByJobKey = new Map();
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (!isPlainObject(job)) continue;
    let jobKey;
    try {
      jobKey = resolveJobTranslationTargetKeyV2(job);
    } catch {
      continue;
    }
    if (typeof jobKey !== 'string') continue;
    const indices = indicesByJobKey.get(jobKey) ?? [];
    indices.push(index);
    indicesByJobKey.set(jobKey, indices);
  }
  return indicesByJobKey;
}

function applyValidatedPatch(mutableSlice, patch, indicesByJobKey) {
  if (
    !Object.hasOwn(mutableSlice, 'crawlerKey')
    || !Object.hasOwn(mutableSlice, 'jobs')
    || !Array.isArray(mutableSlice.jobs)
    || typeof mutableSlice.crawlerKey !== 'string'
  ) {
    return 'malformed_target';
  }
  if (mutableSlice.crawlerKey !== patch.target.crawlerKey) return 'target_absent';

  const matches = indicesByJobKey.get(patch.target.jobKey) ?? [];
  // Absence never writes. A later re-add may reuse this patch only if every
  // target and identity guard still describes the same logical job.
  if (matches.length === 0) return 'target_absent';
  if (matches.length !== 1) return 'ambiguous_target';

  const job = mutableSlice.jobs[matches[0]];
  if (!Object.hasOwn(job, 'url') || typeof job.url !== 'string') return 'malformed_target';
  if (job.url !== patch.target.url) return 'stale_target';

  const { fieldPath, targetLocale } = patch.destination;
  if (!Object.hasOwn(job, fieldPath) || typeof job[fieldPath] !== 'string') {
    return 'malformed_target';
  }
  let currentIdentity;
  try {
    currentIdentity = createJobTranslationUnitIdentityV2(job, { fieldPath, targetLocale });
  } catch {
    return 'malformed_target';
  }
  if (!sameIdentity(currentIdentity, patch.identity)) return 'stale_source';
  if (patch.candidate.status !== 'validated' || patch.candidate.applicability !== 'applicable') {
    return 'rejected_candidate';
  }

  const comparableSource = comparableTranslationText(job[fieldPath]);
  const comparableOutput = comparableTranslationText(patch.candidate.outputText);
  if (comparableOutput.length === 0 || comparableOutput === comparableSource) {
    return 'rejected_candidate';
  }

  const localeMapField = `${fieldPath}ByLocale`;
  const hasLocaleMap = Object.hasOwn(job, localeMapField);
  const localeMap = hasLocaleMap ? job[localeMapField] : undefined;
  if (hasLocaleMap && !isPlainObject(localeMap)) return 'malformed_target';
  const hasTarget = hasLocaleMap && Object.hasOwn(localeMap, targetLocale);
  const currentTarget = hasTarget ? localeMap[targetLocale] : undefined;
  if (currentTarget !== undefined && typeof currentTarget !== 'string') return 'malformed_target';
  if (
    typeof currentTarget === 'string'
    && comparableTranslationText(currentTarget).length > 0
    && comparableTranslationText(currentTarget) !== comparableSource
  ) {
    return 'already_valid';
  }

  const nextMap = hasLocaleMap ? localeMap : {};
  Object.defineProperty(nextMap, targetLocale, {
    configurable: true,
    enumerable: true,
    value: patch.candidate.outputText,
    writable: true,
  });
  if (!hasLocaleMap) {
    Object.defineProperty(job, localeMapField, {
      configurable: true,
      enumerable: true,
      value: nextMap,
      writable: true,
    });
  }
  return 'applied';
}

export function reduceTranslationDerivedPatchBatchV2(activeSlice, rawPatches) {
  assertJsonData(activeSlice, 'active crawler slice');
  assertTranslationPlainObjectV2(activeSlice, 'active crawler slice');
  if (
    !Array.isArray(rawPatches)
    || rawPatches.length < 1
    || rawPatches.length > MAX_TRANSLATION_DERIVED_PATCH_BATCH_V2
  ) {
    throw new TypeError(
      `translation derived patch batch must contain between 1 and ${MAX_TRANSLATION_DERIVED_PATCH_BATCH_V2} patches`,
    );
  }
  assertJsonData(rawPatches, 'translation derived patch batch');
  const patches = rawPatches.map((patch) => validateTranslationDerivedPatchV2(patch));
  const mutableSlice = structuredClone(activeSlice);
  const indicesByJobKey = Array.isArray(mutableSlice.jobs)
    ? buildJobKeyIndex(mutableSlice.jobs)
    : new Map();
  const outcomes = patches.map((patch) => applyValidatedPatch(
    mutableSlice,
    patch,
    indicesByJobKey,
  ));
  return deepFreezeTranslationV2({ outcomes, slice: mutableSlice });
}

export function reduceTranslationDerivedPatchV2(activeSlice, rawPatch) {
  const batch = reduceTranslationDerivedPatchBatchV2(activeSlice, [rawPatch]);
  return Object.freeze({ outcome: batch.outcomes[0], slice: batch.slice });
}
