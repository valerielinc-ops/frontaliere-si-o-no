import { resolveJobDiffKey } from './job-match-key.mjs';
import {
  assertTranslationPlainObjectV2,
  deepFreezeTranslationV2,
} from './translation-unit-identity-v2.mjs';
import { normalizeTranslationText } from './translation-unit-identity.mjs';
import {
  createJobTranslationUnitIdentityV2,
  validateTranslationDerivedPatchV2,
} from './translation-derived-patch-v2.mjs';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function comparableTranslationText(value) {
  return normalizeTranslationText(value).trim().replace(/\s+/gu, ' ');
}

function result(slice, outcome) {
  return deepFreezeTranslationV2({ outcome, slice: structuredClone(slice) });
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

export function reduceTranslationDerivedPatchV2(activeSlice, rawPatch) {
  assertTranslationPlainObjectV2(activeSlice, 'active crawler slice');
  const patch = validateTranslationDerivedPatchV2(rawPatch);
  if (
    !Object.hasOwn(activeSlice, 'crawlerKey')
    || !Object.hasOwn(activeSlice, 'jobs')
    || !Array.isArray(activeSlice.jobs)
    || typeof activeSlice.crawlerKey !== 'string'
  ) {
    return result(activeSlice, 'malformed_target');
  }
  if (activeSlice.crawlerKey !== patch.target.crawlerKey) {
    return result(activeSlice, 'target_absent');
  }

  const matches = [];
  for (let index = 0; index < activeSlice.jobs.length; index += 1) {
    const job = activeSlice.jobs[index];
    if (resolveJobDiffKey(job) === patch.target.jobKey) matches.push(index);
  }
  if (matches.length === 0) return result(activeSlice, 'target_absent');
  if (matches.length !== 1) return result(activeSlice, 'ambiguous_target');

  const job = activeSlice.jobs[matches[0]];
  if (!isPlainObject(job)) return result(activeSlice, 'malformed_target');
  if (typeof job.url !== 'string') return result(activeSlice, 'malformed_target');
  if (job.url !== patch.target.url) return result(activeSlice, 'stale_target');

  const { fieldPath, targetLocale } = patch.destination;
  if (typeof job[fieldPath] !== 'string') return result(activeSlice, 'malformed_target');
  let currentIdentity;
  try {
    currentIdentity = createJobTranslationUnitIdentityV2(job, { fieldPath, targetLocale });
  } catch {
    return result(activeSlice, 'malformed_target');
  }
  if (!sameIdentity(currentIdentity, patch.identity)) {
    return result(activeSlice, 'stale_source');
  }
  if (patch.candidate.status !== 'validated' || patch.candidate.applicability !== 'applicable') {
    return result(activeSlice, 'rejected_candidate');
  }

  const comparableSource = comparableTranslationText(job[fieldPath]);
  const comparableOutput = comparableTranslationText(patch.candidate.outputText);
  if (comparableOutput.length === 0 || comparableOutput === comparableSource) {
    return result(activeSlice, 'rejected_candidate');
  }

  const localeMapField = `${fieldPath}ByLocale`;
  const localeMap = job[localeMapField];
  if (localeMap !== undefined && !isPlainObject(localeMap)) {
    return result(activeSlice, 'malformed_target');
  }
  const hasTarget = localeMap !== undefined && Object.hasOwn(localeMap, targetLocale);
  const currentTarget = hasTarget ? localeMap[targetLocale] : undefined;
  if (currentTarget !== undefined && typeof currentTarget !== 'string') {
    return result(activeSlice, 'malformed_target');
  }
  if (
    typeof currentTarget === 'string'
    && comparableTranslationText(currentTarget).length > 0
    && comparableTranslationText(currentTarget) !== comparableSource
  ) {
    return result(activeSlice, 'already_valid');
  }

  const nextSlice = structuredClone(activeSlice);
  const nextJob = nextSlice.jobs[matches[0]];
  const nextMap = nextJob[localeMapField] === undefined ? {} : nextJob[localeMapField];
  nextMap[targetLocale] = patch.candidate.outputText;
  nextJob[localeMapField] = nextMap;
  return deepFreezeTranslationV2({ outcome: 'applied', slice: nextSlice });
}
