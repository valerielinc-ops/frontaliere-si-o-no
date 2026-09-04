import {
  lookupTranslationMemoryV2,
  validateTranslationMemoryV2,
} from './content-addressed-translation-memory-v2.mjs';
import {
  assertTranslationExactKeysV2,
  assertTranslationPlainObjectV2,
  canonicalTranslationJsonV2,
  deepFreezeTranslationV2,
  digestTranslationDocumentV2,
  normalizeTranslationVersionV2,
  TRANSLATION_SHA256_PATTERN_V2,
  validateTranslationUnitIdentityV2,
} from './translation-unit-identity-v2.mjs';
import { normalizeTranslationText } from './translation-unit-identity.mjs';

export const TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION = 2;
export const MAX_TRANSLATION_SCHEDULE_UNITS_V2 = 250;
export const MAX_TRANSLATION_SCHEDULE_JOBS_V2 = 250;
export const MAX_TRANSLATION_SCHEDULER_INPUT_JOBS_V2 = 10_000;
export const MAX_TRANSLATION_SCHEDULER_INPUT_UNITS_V2 = 25_000;
export const MAX_TRANSLATION_SCHEDULE_BYTES_V2 = 1024 * 1024;

const CURSOR_KEYS = [
  'activePlanHash',
  'completionAfterKey',
  'cursorHash',
  'fairnessAfterKey',
  'fairnessCredit',
  'generation',
  'schemaVersion',
  'scopeKey',
];
const CURSOR_INPUT_KEYS = ['scopeKey'];
const PLAN_INPUT_KEYS = [
  'activePlan',
  'baselineMainSha',
  'cursor',
  'engineVersion',
  'gateVersion',
  'jobs',
  'limits',
  'scanDigest',
  'scopeKey',
];
const LIMIT_KEYS = ['fairnessDenominator', 'fairnessNumerator', 'maxJobs', 'maxUnits'];
const JOB_KEYS = ['queuedAtMs', 'target', 'units'];
const TARGET_KEYS = ['crawlerKey', 'jobKey', 'slicePath', 'url'];
const UNIT_KEYS = ['identity', 'memory'];
const PLAN_KEYS = [
  'baselineMainSha',
  'cursorAfter',
  'cursorBeforeHash',
  'engineVersion',
  'gateVersion',
  'metrics',
  'planHash',
  'scanDigest',
  'schemaVersion',
  'scopeKey',
  'selectedJobs',
];
const SELECTED_JOB_KEYS = [
  'generationDistance',
  'lane',
  'queuedAtMs',
  'remainingUnits',
  'schedulingKey',
  'targetOccurrenceKey',
  'units',
];
const SELECTED_UNIT_KEYS = [
  'attemptKey',
  'disposition',
  'identityKey',
  'lookupStatus',
  'selectedCandidateId',
];
const PLAN_METRIC_KEYS = [
  'blockedJobs',
  'completionFeasibleJobs',
  'completionPivotMissing',
  'cursorWraps',
  'exactConflicts',
  'exactMisses',
  'exactValidatedHits',
  'fairnessPivotMissing',
  'negativeCacheHits',
  'predictedCompletionJobs',
  'predictedGenerationUnits',
  'predictedQueueJobsOut',
  'predictedQueueUnitsOut',
  'predictedReuseUnits',
  'quarantinedJobs',
  'queueJobsIn',
  'queueUnitsIn',
  'selectedCompletionLaneJobs',
  'selectedFairnessLaneJobs',
  'selectedJobs',
  'selectedUnits',
];
const SETTLE_INPUT_KEYS = ['cursor', 'outcomes', 'plan'];
const JOB_OUTCOME_KEYS = ['schedulingKey', 'units'];
const UNIT_OUTCOME_KEYS = ['attemptKey', 'status'];
const SETTLEMENT_KEYS = [
  'cursor',
  'metrics',
  'outcomes',
  'planHash',
  'schemaVersion',
  'scopeKey',
  'settlementHash',
];
const SETTLEMENT_METRIC_KEYS = [
  'generated',
  'jobsCompleted',
  'outcomeCounts',
  'patchesApplied',
  'patchesQueued',
  'queueJobsIn',
  'queueJobsOut',
  'queueUnitsIn',
  'queueUnitsOut',
  'rejected',
  'validated',
];

const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SLICE_PATH_PATTERN = /^data\/jobs\/by-crawler\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PLAN_HASH_PATTERN = /^translation-schedule:v2:[a-f0-9]{64}$/;
const TARGET_KEY_PATTERN = /^translation-target-occurrence:v2:[a-f0-9]{64}$/;
const SCHEDULING_KEY_PATTERN = /^translation-scheduling:v2:[a-f0-9]{64}$/;
const ATTEMPT_KEY_PATTERN = /^translation-attempt:v2:[a-f0-9]{64}$/;
const IDENTITY_KEY_PATTERN = /^translation-unit:v2:[a-f0-9]{64}$/;
const CANDIDATE_KEY_PATTERN = /^translation-candidate:v2:[a-f0-9]{64}$/;
const COMPLETED_UNIT_STATUSES = new Set(['applied', 'already_valid']);
const OUTCOME_STATUSES = Object.freeze([
  'already_valid',
  'ambiguous_target',
  'applied',
  'conflict',
  'duplicate_attempt',
  'generation_failed',
  'malformed_target',
  'negative_cache',
  'rejected',
  'rejected_candidate',
  'retryable_reject',
  'reused',
  'stale_scan',
  'stale_source',
  'stale_target',
  'target_absent',
  'validated',
]);
// v2 settlements created before the additive executor outcomes must retain
// their exact count object and therefore their content-addressed hash.
const LEGACY_OUTCOME_STATUSES = Object.freeze(OUTCOME_STATUSES.filter((status) => (
  status !== 'duplicate_attempt' && status !== 'retryable_reject'
)));
const OUTCOME_STATUS_SET = new Set(OUTCOME_STATUSES);

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertSafeCount(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be a bounded non-negative integer`);
  }
  return value;
}

function normalizeScopeKey(value) {
  if (typeof value !== 'string' || !SCOPE_PATTERN.test(value)) {
    throw new TypeError('translation scheduler scopeKey is invalid');
  }
  return value;
}

function cursorPayload(input) {
  return {
    schemaVersion: TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION,
    scopeKey: input.scopeKey,
    generation: input.generation,
    completionAfterKey: input.completionAfterKey,
    fairnessAfterKey: input.fairnessAfterKey,
    fairnessCredit: input.fairnessCredit,
    activePlanHash: input.activePlanHash,
  };
}

function createCursor(input) {
  const payload = cursorPayload(input);
  return deepFreezeTranslationV2({
    ...payload,
    cursorHash: digestTranslationDocumentV2(payload),
  });
}

export function createEmptyTranslationSchedulerCursorV2(input) {
  assertTranslationPlainObjectV2(input, 'translation scheduler cursor input');
  assertTranslationExactKeysV2(input, CURSOR_INPUT_KEYS, 'translation scheduler cursor input');
  return createCursor({
    scopeKey: normalizeScopeKey(input.scopeKey),
    generation: 0,
    completionAfterKey: null,
    fairnessAfterKey: null,
    fairnessCredit: 0,
    activePlanHash: null,
  });
}

export function validateTranslationSchedulerCursorV2(cursor) {
  assertTranslationPlainObjectV2(cursor, 'translation scheduler cursor');
  assertTranslationExactKeysV2(cursor, CURSOR_KEYS, 'translation scheduler cursor');
  if (cursor.schemaVersion !== TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION) {
    throw new TypeError('unsupported translation scheduler cursor schema');
  }
  const scopeKey = normalizeScopeKey(cursor.scopeKey);
  const generation = assertSafeCount(cursor.generation, 'translation scheduler cursor generation');
  for (const [label, value] of [
    ['completionAfterKey', cursor.completionAfterKey],
    ['fairnessAfterKey', cursor.fairnessAfterKey],
  ]) {
    if (value !== null && (typeof value !== 'string' || !SCHEDULING_KEY_PATTERN.test(value))) {
      throw new TypeError(`translation scheduler cursor ${label} is invalid`);
    }
  }
  if (!Number.isInteger(cursor.fairnessCredit) || cursor.fairnessCredit < 0 || cursor.fairnessCredit > 4) {
    throw new TypeError('translation scheduler cursor fairnessCredit is invalid');
  }
  if (cursor.activePlanHash !== null
      && (typeof cursor.activePlanHash !== 'string' || !PLAN_HASH_PATTERN.test(cursor.activePlanHash))) {
    throw new TypeError('translation scheduler cursor activePlanHash is invalid');
  }
  const checked = createCursor({
    scopeKey,
    generation,
    completionAfterKey: cursor.completionAfterKey,
    fairnessAfterKey: cursor.fairnessAfterKey,
    fairnessCredit: cursor.fairnessCredit,
    activePlanHash: cursor.activePlanHash,
  });
  if (cursor.cursorHash !== checked.cursorHash) {
    throw new TypeError('translation scheduler cursor hash does not match its content');
  }
  return checked;
}

function assertCanonicalTargetText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
      || value !== value.trim() || normalizeTranslationText(value) !== value
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be canonical bounded text`);
  }
  return value;
}

function normalizeTarget(target) {
  assertTranslationPlainObjectV2(target, 'translation scheduler target');
  assertTranslationExactKeysV2(target, TARGET_KEYS, 'translation scheduler target');
  if (typeof target.crawlerKey !== 'string' || !TOKEN_PATTERN.test(target.crawlerKey)) {
    throw new TypeError('translation scheduler crawlerKey is invalid');
  }
  if (typeof target.slicePath !== 'string' || !SLICE_PATH_PATTERN.test(target.slicePath)) {
    throw new TypeError(
      'translation scheduler slicePath must match data/jobs/by-crawler/<safe filename>.json',
    );
  }
  return deepFreezeTranslationV2({
    crawlerKey: target.crawlerKey,
    slicePath: target.slicePath,
    jobKey: assertCanonicalTargetText(target.jobKey, 'translation scheduler jobKey'),
    url: assertCanonicalTargetText(target.url, 'translation scheduler url'),
  });
}

function targetOccurrenceKey(target) {
  return `translation-target-occurrence:v2:${digestTranslationDocumentV2({
    schemaVersion: TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION,
    target,
  })}`;
}

function normalizeLimits(limits) {
  assertTranslationPlainObjectV2(limits, 'translation scheduler limits');
  assertTranslationExactKeysV2(limits, LIMIT_KEYS, 'translation scheduler limits');
  if (!Number.isInteger(limits.maxJobs) || limits.maxJobs < 1 || limits.maxJobs > MAX_TRANSLATION_SCHEDULE_JOBS_V2
      || !Number.isInteger(limits.maxUnits) || limits.maxUnits < 1
      || limits.maxUnits > MAX_TRANSLATION_SCHEDULE_UNITS_V2
      || limits.fairnessNumerator !== 1 || limits.fairnessDenominator !== 5) {
    throw new TypeError('translation scheduler limits are invalid');
  }
  return { ...limits };
}

function normalizeQueuedAt(value) {
  if (value === null) return null;
  return assertSafeCount(value, 'translation scheduler queuedAtMs');
}

function schedulingKey(scopeKey, occurrenceKey, units) {
  return `translation-scheduling:v2:${digestTranslationDocumentV2({
    attemptKeys: units.map((unit) => unit.attemptKey),
    scopeKey,
    schemaVersion: TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION,
    targetOccurrenceKey: occurrenceKey,
  })}`;
}

function ageRank(value) {
  return value === null ? Number.MAX_SAFE_INTEGER : value;
}

function completionComparator(left, right) {
  return left.generationDistance - right.generationDistance
    || left.remainingUnits - right.remainingUnits
    || ageRank(left.queuedAtMs) - ageRank(right.queuedAtMs)
    || compareText(left.schedulingKey, right.schedulingKey);
}

function fairnessComparator(left, right) {
  return ageRank(left.queuedAtMs) - ageRank(right.queuedAtMs)
    || compareText(left.schedulingKey, right.schedulingKey);
}

function rotateAfter(values, key) {
  if (key === null) return [...values];
  const index = values.findIndex((value) => value.schedulingKey === key);
  return index < 0 ? [...values] : [...values.slice(index + 1), ...values.slice(0, index + 1)];
}

// Distinguishes an intentional reset (key === null) from a silent one: the pivot
// key was set but its job left the feasible set (completed/removed) before the
// next plan, so rotateAfter() fell back to an unrotated list without a signal.
function isPivotMissing(values, key) {
  return key !== null && !values.some((value) => value.schedulingKey === key);
}

function planPayload(plan) {
  const { planHash: _ignored, ...payload } = plan;
  return payload;
}

function assertMetricDocument(metrics, keys, label) {
  assertTranslationPlainObjectV2(metrics, label);
  assertTranslationExactKeysV2(metrics, keys, label);
  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'outcomeCounts') continue;
    assertSafeCount(value, `${label} ${key}`);
  }
}

function validateSelectedUnit(unit) {
  assertTranslationPlainObjectV2(unit, 'translation schedule selected unit');
  assertTranslationExactKeysV2(unit, SELECTED_UNIT_KEYS, 'translation schedule selected unit');
  if (!ATTEMPT_KEY_PATTERN.test(unit.attemptKey ?? '') || !IDENTITY_KEY_PATTERN.test(unit.identityKey ?? '')
      || !['generate', 'reuse'].includes(unit.disposition)
      || !['missing', 'exact_validated_hit'].includes(unit.lookupStatus)
      || (unit.lookupStatus === 'missing'
        ? unit.disposition !== 'generate' || unit.selectedCandidateId !== null
        : unit.disposition !== 'reuse' || !CANDIDATE_KEY_PATTERN.test(unit.selectedCandidateId ?? ''))) {
    throw new TypeError('translation schedule selected unit is invalid');
  }
  return { ...unit };
}

export function validateTranslationScheduleV2(plan) {
  assertTranslationPlainObjectV2(plan, 'translation schedule');
  assertTranslationExactKeysV2(plan, PLAN_KEYS, 'translation schedule');
  if (plan.schemaVersion !== TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION
      || !COMMIT_PATTERN.test(plan.baselineMainSha ?? '')
      || !DIGEST_PATTERN.test(plan.scanDigest ?? '')
      || !TRANSLATION_SHA256_PATTERN_V2.test(plan.cursorBeforeHash ?? '')
      || !PLAN_HASH_PATTERN.test(plan.planHash ?? '')) {
    throw new TypeError('translation schedule binding is invalid');
  }
  const scopeKey = normalizeScopeKey(plan.scopeKey);
  const engineVersion = normalizeTranslationVersionV2(plan.engineVersion, 'schedule engineVersion');
  const gateVersion = normalizeTranslationVersionV2(plan.gateVersion, 'schedule gateVersion');
  const cursorAfter = validateTranslationSchedulerCursorV2(plan.cursorAfter);
  if (cursorAfter.scopeKey !== scopeKey || cursorAfter.activePlanHash !== null) {
    throw new TypeError('translation schedule cursorAfter is invalid');
  }
  if (!Array.isArray(plan.selectedJobs) || plan.selectedJobs.length > MAX_TRANSLATION_SCHEDULE_JOBS_V2) {
    throw new TypeError('translation schedule selectedJobs are invalid');
  }
  const selectedJobs = plan.selectedJobs.map((job) => {
    assertTranslationPlainObjectV2(job, 'translation schedule selected job');
    assertTranslationExactKeysV2(job, SELECTED_JOB_KEYS, 'translation schedule selected job');
    if (!['completion', 'fairness'].includes(job.lane)
        || !TARGET_KEY_PATTERN.test(job.targetOccurrenceKey ?? '')
        || !SCHEDULING_KEY_PATTERN.test(job.schedulingKey ?? '')
        || (job.queuedAtMs !== null && (!Number.isSafeInteger(job.queuedAtMs) || job.queuedAtMs < 0))
        || !Number.isInteger(job.generationDistance) || job.generationDistance < 0
        || !Number.isInteger(job.remainingUnits) || job.remainingUnits < 1
        || !Array.isArray(job.units) || job.units.length !== job.remainingUnits) {
      throw new TypeError('translation schedule selected job is invalid');
    }
    const units = job.units.map(validateSelectedUnit);
    if (units.filter((unit) => unit.disposition === 'generate').length !== job.generationDistance
        || new Set(units.map((unit) => unit.attemptKey)).size !== units.length
        || schedulingKey(scopeKey, job.targetOccurrenceKey, units) !== job.schedulingKey) {
      throw new TypeError('translation schedule selected job unit counts are invalid');
    }
    return { ...job, units };
  });
  if (new Set(selectedJobs.map((job) => job.schedulingKey)).size !== selectedJobs.length) {
    throw new TypeError('translation schedule selectedJobs contain duplicates');
  }
  assertMetricDocument(plan.metrics, PLAN_METRIC_KEYS, 'translation schedule metrics');
  const selectedUnits = selectedJobs.reduce((sum, job) => sum + job.units.length, 0);
  const predictedGenerationUnits = selectedJobs.flatMap((job) => job.units)
    .filter((unit) => unit.disposition === 'generate').length;
  const predictedReuseUnits = selectedJobs.flatMap((job) => job.units)
    .filter((unit) => unit.disposition === 'reuse').length;
  if (selectedUnits > MAX_TRANSLATION_SCHEDULE_UNITS_V2
      || plan.metrics.queueJobsIn > MAX_TRANSLATION_SCHEDULER_INPUT_JOBS_V2
      || plan.metrics.queueUnitsIn > MAX_TRANSLATION_SCHEDULER_INPUT_UNITS_V2
      || plan.metrics.cursorWraps > 2
      || plan.metrics.completionPivotMissing > 1
      || plan.metrics.fairnessPivotMissing > 1
      || plan.metrics.completionFeasibleJobs + plan.metrics.blockedJobs !== plan.metrics.queueJobsIn
      || plan.metrics.quarantinedJobs !== plan.metrics.blockedJobs
      || selectedJobs.length > plan.metrics.completionFeasibleJobs
      || plan.metrics.exactValidatedHits + plan.metrics.exactMisses
        + plan.metrics.negativeCacheHits + plan.metrics.exactConflicts !== plan.metrics.queueUnitsIn
      || plan.metrics.selectedJobs !== selectedJobs.length
      || plan.metrics.selectedUnits !== selectedUnits
      || plan.metrics.predictedCompletionJobs !== selectedJobs.length
      || plan.metrics.predictedGenerationUnits !== predictedGenerationUnits
      || plan.metrics.predictedReuseUnits !== predictedReuseUnits
      || plan.metrics.predictedGenerationUnits + plan.metrics.predictedReuseUnits !== selectedUnits
      || plan.metrics.predictedQueueJobsOut !== plan.metrics.queueJobsIn - selectedJobs.length
      || plan.metrics.predictedQueueUnitsOut !== plan.metrics.queueUnitsIn - selectedUnits
      || plan.metrics.selectedCompletionLaneJobs
        !== selectedJobs.filter((job) => job.lane === 'completion').length
      || plan.metrics.selectedFairnessLaneJobs
        !== selectedJobs.filter((job) => job.lane === 'fairness').length) {
    throw new TypeError('translation schedule metrics do not match its selection');
  }
  const checked = deepFreezeTranslationV2({
    schemaVersion: plan.schemaVersion,
    scopeKey,
    baselineMainSha: plan.baselineMainSha,
    scanDigest: plan.scanDigest,
    engineVersion,
    gateVersion,
    cursorBeforeHash: plan.cursorBeforeHash,
    cursorAfter,
    selectedJobs,
    metrics: { ...plan.metrics },
    planHash: plan.planHash,
  });
  const expectedHash = `translation-schedule:v2:${digestTranslationDocumentV2(planPayload(checked))}`;
  if (plan.planHash !== expectedHash
      || Buffer.byteLength(canonicalTranslationJsonV2(checked)) > MAX_TRANSLATION_SCHEDULE_BYTES_V2) {
    throw new TypeError('translation schedule hash or byte bound is invalid');
  }
  return checked;
}

function assertReservedCursorPlanBinding(cursor, plan) {
  if (cursor.activePlanHash !== plan.planHash || cursor.scopeKey !== plan.scopeKey
      || plan.cursorAfter.generation !== cursor.generation + 1) {
    throw new TypeError('translation scheduler active plan binding is invalid');
  }
  const cursorBefore = createCursor({
    scopeKey: cursor.scopeKey,
    generation: cursor.generation,
    completionAfterKey: cursor.completionAfterKey,
    fairnessAfterKey: cursor.fairnessAfterKey,
    fairnessCredit: cursor.fairnessCredit,
    activePlanHash: null,
  });
  if (cursorBefore.cursorHash !== plan.cursorBeforeHash) {
    throw new TypeError('translation scheduler active plan cursor binding is invalid');
  }
  let fairnessCredit = cursor.fairnessCredit;
  let completionAfterKey = cursor.completionAfterKey;
  let fairnessAfterKey = cursor.fairnessAfterKey;
  for (const job of plan.selectedJobs) {
    const fairnessDue = fairnessCredit === 4;
    // A due fairness turn is allowed to fall back to completion (its bundle didn't fit
    // the residual capacity), but a non-due turn must never claim the fairness lane.
    if (job.lane === 'fairness' && !fairnessDue) {
      throw new TypeError('translation scheduler active plan lane sequence is invalid');
    }
    if (job.lane === 'fairness') {
      fairnessAfterKey = job.schedulingKey;
      fairnessCredit = 0;
    } else {
      completionAfterKey = job.schedulingKey;
      if (!fairnessDue) fairnessCredit += 1;
    }
  }
  if (plan.cursorAfter.completionAfterKey !== completionAfterKey
      || plan.cursorAfter.fairnessAfterKey !== fairnessAfterKey
      || plan.cursorAfter.fairnessCredit !== fairnessCredit) {
    throw new TypeError('translation scheduler active plan cursor transition is invalid');
  }
}

function evaluateJobs({ jobs, scopeKey, engineVersion, gateVersion }) {
  if (!Array.isArray(jobs) || jobs.length > MAX_TRANSLATION_SCHEDULER_INPUT_JOBS_V2) {
    throw new TypeError('translation scheduler jobs must be a bounded array');
  }
  let queueUnitsIn = 0;
  const counters = {
    exactValidatedHits: 0,
    exactMisses: 0,
    negativeCacheHits: 0,
    exactConflicts: 0,
  };
  const evaluated = jobs.map((job) => {
    assertTranslationPlainObjectV2(job, 'translation scheduler job');
    assertTranslationExactKeysV2(job, JOB_KEYS, 'translation scheduler job');
    const target = normalizeTarget(job.target);
    const occurrenceKey = targetOccurrenceKey(target);
    const queuedAtMs = normalizeQueuedAt(job.queuedAtMs);
    if (!Array.isArray(job.units) || job.units.length < 1
        || job.units.length > MAX_TRANSLATION_SCHEDULE_UNITS_V2) {
      throw new TypeError('translation scheduler job units are invalid');
    }
    queueUnitsIn += job.units.length;
    if (queueUnitsIn > MAX_TRANSLATION_SCHEDULER_INPUT_UNITS_V2) {
      throw new TypeError('translation scheduler input unit bound is exceeded');
    }
    const units = job.units.map((unit) => {
      assertTranslationPlainObjectV2(unit, 'translation scheduler unit');
      assertTranslationExactKeysV2(unit, UNIT_KEYS, 'translation scheduler unit');
      const identity = validateTranslationUnitIdentityV2(unit.identity);
      const memory = validateTranslationMemoryV2(unit.memory);
      const lookup = lookupTranslationMemoryV2(memory, { identity, engineVersion, gateVersion });
      if (lookup.status === 'exact_validated_hit') counters.exactValidatedHits += 1;
      else if (lookup.status === 'missing') counters.exactMisses += 1;
      else if (lookup.status === 'negative_cache') counters.negativeCacheHits += 1;
      else if (lookup.status === 'conflicting_candidates') counters.exactConflicts += 1;
      return {
        identityKey: identity.key,
        attemptKey: lookup.attemptKey,
        lookupStatus: lookup.status,
        disposition: lookup.status === 'exact_validated_hit' ? 'reuse'
          : lookup.status === 'missing' ? 'generate' : 'quarantine',
        selectedCandidateId: lookup.status === 'exact_validated_hit'
          ? lookup.applicableCandidates[0].candidateId
          : null,
      };
    }).sort((left, right) => compareText(left.attemptKey, right.attemptKey));
    if (new Set(units.map((unit) => unit.attemptKey)).size !== units.length) {
      throw new TypeError('translation scheduler job contains duplicate attempts');
    }
    const key = schedulingKey(scopeKey, occurrenceKey, units);
    return {
      targetOccurrenceKey: occurrenceKey,
      schedulingKey: key,
      queuedAtMs,
      remainingUnits: units.length,
      generationDistance: units.filter((unit) => unit.disposition === 'generate').length,
      feasible: units.every((unit) => unit.disposition !== 'quarantine'),
      units,
    };
  });
  if (new Set(evaluated.map((job) => job.targetOccurrenceKey)).size !== evaluated.length
      || new Set(evaluated.map((job) => job.schedulingKey)).size !== evaluated.length) {
    throw new TypeError('translation scheduler jobs contain duplicate targets');
  }
  return { evaluated, counters, queueUnitsIn };
}

export function planTranslationScheduleV2(input) {
  assertTranslationPlainObjectV2(input, 'translation scheduler plan input');
  assertTranslationExactKeysV2(input, PLAN_INPUT_KEYS, 'translation scheduler plan input');
  const cursor = validateTranslationSchedulerCursorV2(input.cursor);
  const scopeKey = normalizeScopeKey(input.scopeKey);
  if (cursor.scopeKey !== scopeKey) throw new TypeError('translation scheduler cursor scope mismatch');
  if (cursor.activePlanHash !== null) {
    const activePlan = validateTranslationScheduleV2(input.activePlan);
    assertReservedCursorPlanBinding(cursor, activePlan);
    return deepFreezeTranslationV2({ cursor, plan: activePlan });
  }
  if (input.activePlan !== null) throw new TypeError('translation scheduler activePlan must be null');
  if (!COMMIT_PATTERN.test(input.baselineMainSha ?? '') || !DIGEST_PATTERN.test(input.scanDigest ?? '')) {
    throw new TypeError('translation scheduler scan binding is invalid');
  }
  const engineVersion = normalizeTranslationVersionV2(input.engineVersion, 'scheduler engineVersion');
  const gateVersion = normalizeTranslationVersionV2(input.gateVersion, 'scheduler gateVersion');
  const limits = normalizeLimits(input.limits);
  const { evaluated, counters, queueUnitsIn } = evaluateJobs({
    jobs: input.jobs,
    scopeKey,
    engineVersion,
    gateVersion,
  });
  const feasible = evaluated.filter((job) => job.feasible);
  const oversized = feasible.find((job) => job.remainingUnits > limits.maxUnits);
  if (oversized) {
    throw new TypeError(
      `translation scheduler feasible job ${oversized.schedulingKey} exceeds maxUnits`,
    );
  }
  const completionSorted = [...feasible].sort(completionComparator);
  const fairnessSorted = [...feasible].sort(fairnessComparator);
  const completion = rotateAfter(completionSorted, cursor.completionAfterKey);
  const fairness = rotateAfter(fairnessSorted, cursor.fairnessAfterKey);
  const selectedJobs = [];
  const selectedKeys = new Set();
  let selectedUnits = 0;
  let fairnessCredit = cursor.fairnessCredit;
  let completionAfterKey = cursor.completionAfterKey;
  let fairnessAfterKey = cursor.fairnessAfterKey;
  while (selectedJobs.length < limits.maxJobs) {
    const fairnessDue = fairnessCredit === limits.fairnessDenominator - limits.fairnessNumerator;
    let lane = fairnessDue ? 'fairness' : 'completion';
    let candidate = lane === 'fairness'
      ? fairness.find((job) => !selectedKeys.has(job.schedulingKey))
      : completion.find((job) => !selectedKeys.has(job.schedulingKey)
        && selectedUnits + job.remainingUnits <= limits.maxUnits);
    if (lane === 'fairness' && (!candidate || selectedUnits + candidate.remainingUnits > limits.maxUnits)) {
      // Fairness lane has no candidate that fits the residual capacity this turn:
      // fall back to completion instead of halting the whole selection.
      lane = 'completion';
      candidate = completion.find((job) => !selectedKeys.has(job.schedulingKey)
        && selectedUnits + job.remainingUnits <= limits.maxUnits);
    }
    if (!candidate) break;
    selectedKeys.add(candidate.schedulingKey);
    selectedUnits += candidate.remainingUnits;
    selectedJobs.push({
      targetOccurrenceKey: candidate.targetOccurrenceKey,
      schedulingKey: candidate.schedulingKey,
      queuedAtMs: candidate.queuedAtMs,
      remainingUnits: candidate.remainingUnits,
      generationDistance: candidate.generationDistance,
      lane,
      units: candidate.units.map((unit) => ({
        identityKey: unit.identityKey,
        attemptKey: unit.attemptKey,
        lookupStatus: unit.lookupStatus,
        disposition: unit.disposition,
        selectedCandidateId: unit.selectedCandidateId,
      })),
    });
    if (lane === 'fairness') {
      fairnessAfterKey = candidate.schedulingKey;
      fairnessCredit = 0;
    } else {
      completionAfterKey = candidate.schedulingKey;
      // A due fairness turn that fell back to completion (above) stays due:
      // preserve the credit so the very next iteration retries fairness
      // instead of pushing the owed turn further away.
      if (!fairnessDue) fairnessCredit += 1;
    }
  }
  const cursorAfter = createCursor({
    scopeKey,
    generation: cursor.generation + 1,
    completionAfterKey,
    fairnessAfterKey,
    fairnessCredit,
    activePlanHash: null,
  });
  const metrics = {
    queueJobsIn: evaluated.length,
    queueUnitsIn,
    completionFeasibleJobs: feasible.length,
    blockedJobs: evaluated.length - feasible.length,
    quarantinedJobs: evaluated.length - feasible.length,
    completionPivotMissing: isPivotMissing(completionSorted, cursor.completionAfterKey) ? 1 : 0,
    fairnessPivotMissing: isPivotMissing(fairnessSorted, cursor.fairnessAfterKey) ? 1 : 0,
    cursorWraps: [
      [completionSorted, cursor.completionAfterKey, 'completion'],
      [fairnessSorted, cursor.fairnessAfterKey, 'fairness'],
    ].filter(([sorted, pivot, lane]) => {
      const pivotIndex = sorted.findIndex((job) => job.schedulingKey === pivot);
      return pivotIndex >= 0 && selectedJobs.some((job) => job.lane === lane
        && sorted.findIndex((candidate) => candidate.schedulingKey === job.schedulingKey) <= pivotIndex);
    }).length,
    exactValidatedHits: counters.exactValidatedHits,
    exactMisses: counters.exactMisses,
    negativeCacheHits: counters.negativeCacheHits,
    exactConflicts: counters.exactConflicts,
    selectedJobs: selectedJobs.length,
    selectedUnits,
    selectedCompletionLaneJobs: selectedJobs.filter((job) => job.lane === 'completion').length,
    selectedFairnessLaneJobs: selectedJobs.filter((job) => job.lane === 'fairness').length,
    predictedCompletionJobs: selectedJobs.length,
    predictedGenerationUnits: selectedJobs.flatMap((job) => job.units)
      .filter((unit) => unit.disposition === 'generate').length,
    predictedReuseUnits: selectedJobs.flatMap((job) => job.units)
      .filter((unit) => unit.disposition === 'reuse').length,
    predictedQueueJobsOut: evaluated.length - selectedJobs.length,
    predictedQueueUnitsOut: queueUnitsIn - selectedUnits,
  };
  const payload = {
    schemaVersion: TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION,
    scopeKey,
    baselineMainSha: input.baselineMainSha,
    scanDigest: input.scanDigest,
    engineVersion,
    gateVersion,
    cursorBeforeHash: cursor.cursorHash,
    cursorAfter,
    selectedJobs,
    metrics,
  };
  const plan = validateTranslationScheduleV2({
    ...payload,
    planHash: `translation-schedule:v2:${digestTranslationDocumentV2(payload)}`,
  });
  const reservedCursor = createCursor({
    ...cursor,
    activePlanHash: plan.planHash,
  });
  return deepFreezeTranslationV2({ cursor: reservedCursor, plan });
}

function validateOutcomes(outcomes, plan, allowedStatuses = OUTCOME_STATUS_SET) {
  if (!Array.isArray(outcomes) || outcomes.length !== plan.selectedJobs.length) {
    throw new TypeError('translation scheduler outcomes do not cover selected jobs');
  }
  const expected = new Map(plan.selectedJobs.map((job) => [job.schedulingKey, job]));
  const normalized = outcomes.map((jobOutcome) => {
    assertTranslationPlainObjectV2(jobOutcome, 'translation scheduler job outcome');
    assertTranslationExactKeysV2(jobOutcome, JOB_OUTCOME_KEYS, 'translation scheduler job outcome');
    const selected = expected.get(jobOutcome.schedulingKey);
    if (!selected || !Array.isArray(jobOutcome.units) || jobOutcome.units.length !== selected.units.length) {
      throw new TypeError('translation scheduler job outcome binding is invalid');
    }
    const expectedAttempts = new Set(selected.units.map((unit) => unit.attemptKey));
    const units = jobOutcome.units.map((unit) => {
      assertTranslationPlainObjectV2(unit, 'translation scheduler unit outcome');
      assertTranslationExactKeysV2(unit, UNIT_OUTCOME_KEYS, 'translation scheduler unit outcome');
      if (!expectedAttempts.has(unit.attemptKey) || !allowedStatuses.has(unit.status)) {
        throw new TypeError('translation scheduler unit outcome is invalid');
      }
      return { attemptKey: unit.attemptKey, status: unit.status };
    }).sort((left, right) => compareText(left.attemptKey, right.attemptKey));
    if (new Set(units.map((unit) => unit.attemptKey)).size !== units.length) {
      throw new TypeError('translation scheduler unit outcomes contain duplicates');
    }
    return { schedulingKey: jobOutcome.schedulingKey, units };
  }).sort((left, right) => compareText(left.schedulingKey, right.schedulingKey));
  if (new Set(normalized.map((outcome) => outcome.schedulingKey)).size !== normalized.length) {
    throw new TypeError('translation scheduler job outcomes contain duplicates');
  }
  return normalized;
}

function outcomeStatusShape(outcomeCounts) {
  assertTranslationPlainObjectV2(outcomeCounts, 'translation scheduler settlement outcomeCounts');
  const ownKeys = Object.keys(outcomeCounts);
  const matches = (statuses) => ownKeys.length === statuses.length
    && statuses.every((status) => Object.hasOwn(outcomeCounts, status));
  if (matches(OUTCOME_STATUSES)) {
    assertTranslationExactKeysV2(outcomeCounts, OUTCOME_STATUSES, 'translation scheduler settlement outcomeCounts');
    return OUTCOME_STATUSES;
  }
  if (matches(LEGACY_OUTCOME_STATUSES)) {
    assertTranslationExactKeysV2(outcomeCounts, LEGACY_OUTCOME_STATUSES, 'translation scheduler settlement outcomeCounts');
    return LEGACY_OUTCOME_STATUSES;
  }
  throw new TypeError('translation scheduler settlement outcomeCounts schema is invalid');
}

export function settleTranslationScheduleV2(input) {
  assertTranslationPlainObjectV2(input, 'translation scheduler settlement input');
  assertTranslationExactKeysV2(input, SETTLE_INPUT_KEYS, 'translation scheduler settlement input');
  const cursor = validateTranslationSchedulerCursorV2(input.cursor);
  const plan = validateTranslationScheduleV2(input.plan);
  assertReservedCursorPlanBinding(cursor, plan);
  const outcomes = validateOutcomes(input.outcomes, plan);
  const outcomeCounts = Object.fromEntries(OUTCOME_STATUSES.map((status) => [status, 0]));
  let completedUnits = 0;
  let jobsCompleted = 0;
  for (const outcome of outcomes) {
    let completed = true;
    for (const unit of outcome.units) {
      outcomeCounts[unit.status] += 1;
      if (COMPLETED_UNIT_STATUSES.has(unit.status)) completedUnits += 1;
      else completed = false;
    }
    if (completed) jobsCompleted += 1;
  }
  const metrics = {
    generated: outcomeCounts.validated + outcomeCounts.rejected,
    jobsCompleted,
    patchesApplied: outcomeCounts.applied + outcomeCounts.already_valid,
    patchesQueued: outcomeCounts.validated + outcomeCounts.reused,
    queueJobsIn: plan.metrics.queueJobsIn,
    queueJobsOut: plan.metrics.queueJobsIn - jobsCompleted,
    queueUnitsIn: plan.metrics.queueUnitsIn,
    queueUnitsOut: plan.metrics.queueUnitsIn - completedUnits,
    rejected: outcomeCounts.rejected,
    validated: outcomeCounts.validated,
    outcomeCounts,
  };
  assertMetricDocument(metrics, SETTLEMENT_METRIC_KEYS, 'translation scheduler settlement metrics');
  assertTranslationPlainObjectV2(outcomeCounts, 'translation scheduler settlement outcomeCounts');
  assertTranslationExactKeysV2(outcomeCounts, OUTCOME_STATUSES, 'translation scheduler settlement outcomeCounts');
  for (const [status, count] of Object.entries(outcomeCounts)) {
    assertSafeCount(count, `translation scheduler settlement ${status}`);
  }
  const payload = {
    schemaVersion: TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION,
    scopeKey: plan.scopeKey,
    planHash: plan.planHash,
    cursor: plan.cursorAfter,
    outcomes,
    metrics,
  };
  return deepFreezeTranslationV2({
    ...payload,
    settlementHash: digestTranslationDocumentV2(payload),
  });
}

export function serializeTranslationScheduleV2(plan) {
  return `${canonicalTranslationJsonV2(validateTranslationScheduleV2(plan))}\n`;
}

export function validateTranslationSettlementV2(settlement, planInput) {
  const plan = validateTranslationScheduleV2(planInput);
  assertTranslationPlainObjectV2(settlement, 'translation scheduler settlement');
  assertTranslationExactKeysV2(settlement, SETTLEMENT_KEYS, 'translation scheduler settlement');
  if (settlement.schemaVersion !== TRANSLATION_COMPLETION_SCHEDULER_V2_SCHEMA_VERSION
      || !PLAN_HASH_PATTERN.test(settlement.planHash ?? '')
      || !TRANSLATION_SHA256_PATTERN_V2.test(settlement.settlementHash ?? '')) {
    throw new TypeError('translation scheduler settlement binding is invalid');
  }
  const scopeKey = normalizeScopeKey(settlement.scopeKey);
  const cursor = validateTranslationSchedulerCursorV2(settlement.cursor);
  if (settlement.planHash !== plan.planHash || scopeKey !== plan.scopeKey
      || cursor.cursorHash !== plan.cursorAfter.cursorHash || cursor.activePlanHash !== null) {
    throw new TypeError('translation scheduler settlement does not match its plan');
  }
  assertMetricDocument(
    settlement.metrics,
    SETTLEMENT_METRIC_KEYS,
    'translation scheduler settlement metrics',
  );
  const outcomeStatuses = outcomeStatusShape(settlement.metrics.outcomeCounts);
  const outcomeStatusSet = new Set(outcomeStatuses);
  const outcomes = validateOutcomes(settlement.outcomes, plan, outcomeStatusSet);
  const settledUnits = outcomes.reduce((sum, outcome) => sum + outcome.units.length, 0);
  const expectedCounts = Object.fromEntries(outcomeStatuses.map((status) => [status, 0]));
  let jobsCompleted = 0;
  let unitsCompleted = 0;
  for (const outcome of outcomes) {
    if (outcome.units.every((unit) => COMPLETED_UNIT_STATUSES.has(unit.status))) jobsCompleted += 1;
    for (const unit of outcome.units) {
      expectedCounts[unit.status] += 1;
      if (COMPLETED_UNIT_STATUSES.has(unit.status)) unitsCompleted += 1;
    }
  }
  for (const status of outcomeStatuses) {
    assertSafeCount(
      settlement.metrics.outcomeCounts[status],
      `translation scheduler settlement ${status}`,
    );
  }
  if (settlement.metrics.queueJobsIn !== plan.metrics.queueJobsIn
      || settlement.metrics.queueUnitsIn !== plan.metrics.queueUnitsIn) {
    throw new TypeError('translation scheduler settlement metrics do not match its plan');
  }
  if (settlement.metrics.jobsCompleted !== jobsCompleted
      || settlement.metrics.generated !== expectedCounts.validated + expectedCounts.rejected
      || settlement.metrics.patchesApplied !== expectedCounts.applied + expectedCounts.already_valid
      || settlement.metrics.patchesQueued !== expectedCounts.validated + expectedCounts.reused
      || settlement.metrics.queueJobsIn < outcomes.length
      || settlement.metrics.queueUnitsIn < settledUnits
      || settlement.metrics.queueJobsOut !== settlement.metrics.queueJobsIn - jobsCompleted
      || settlement.metrics.queueUnitsOut !== settlement.metrics.queueUnitsIn - unitsCompleted
      || settlement.metrics.rejected !== expectedCounts.rejected
      || settlement.metrics.validated !== expectedCounts.validated
      || canonicalTranslationJsonV2(settlement.metrics.outcomeCounts)
        !== canonicalTranslationJsonV2(expectedCounts)) {
    throw new TypeError('translation scheduler settlement metrics do not match its outcomes');
  }
  const payload = {
    schemaVersion: settlement.schemaVersion,
    scopeKey,
    planHash: settlement.planHash,
    cursor,
    outcomes,
    metrics: {
      generated: settlement.metrics.generated,
      jobsCompleted: settlement.metrics.jobsCompleted,
      patchesApplied: settlement.metrics.patchesApplied,
      patchesQueued: settlement.metrics.patchesQueued,
      queueJobsIn: settlement.metrics.queueJobsIn,
      queueJobsOut: settlement.metrics.queueJobsOut,
      queueUnitsIn: settlement.metrics.queueUnitsIn,
      queueUnitsOut: settlement.metrics.queueUnitsOut,
      rejected: settlement.metrics.rejected,
      validated: settlement.metrics.validated,
      outcomeCounts: expectedCounts,
    },
  };
  if (settlement.settlementHash !== digestTranslationDocumentV2(payload)) {
    throw new TypeError('translation scheduler settlement hash is invalid');
  }
  return deepFreezeTranslationV2({ ...payload, settlementHash: settlement.settlementHash });
}

export function serializeTranslationSettlementV2(settlement, plan) {
  return `${canonicalTranslationJsonV2(validateTranslationSettlementV2(settlement, plan))}\n`;
}
