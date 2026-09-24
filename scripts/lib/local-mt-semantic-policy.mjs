/**
 * Fail-closed policy for the Argos language-repair overwrite arm.
 *
 * The language detector can tell us that an existing title is in the wrong
 * locale.  It cannot tell us that replacing that title preserves its meaning.
 * A semantic comparator therefore supplies a calibrated probability that the
 * candidate is a better swap.  This module owns the decision boundary and the
 * rollback valve; it deliberately does not invent a score when the comparator
 * is absent or malformed.
 *
 * Issue #9674 supplies the versioned source/existing/candidate cases used to
 * calibrate the comparator.  The fixture is intentionally an input to
 * `calibrateSemanticThreshold()` rather than a production dependency: until a
 * real, observable calibration is available, callers can require a ready
 * calibration and the policy remains disabled.
 */

export const LOCAL_MT_SEMANTIC_POLICY_VERSION = 'argos-semantic-policy-v1';

// Conservative defaults.  A calibrated fixture may select a higher cutoff,
// never a lower one.  The 5% rollback ceiling is deliberately below the 12.3%
// regression rate observed by the Argos shadow audit.
export const SEMANTIC_SCORE_CUTOFF = 0.9;
export const SEMANTIC_TARGET_PRECISION = 0.95;
export const SEMANTIC_MAX_REGRESSION_RATE = 0.05;
export const SEMANTIC_MIN_REGRESSION_OBSERVATIONS = 20;
export const SEMANTIC_MIN_CALIBRATION_CASES = 20;
export const SEMANTIC_MIN_IMPROVEMENT = 0.05;

const POSITIVE_LABELS = new Set([
  'accept',
  'acceptable',
  'acceptable-translation',
  'better',
  'improved',
  'preserved',
  'write',
]);
const NEGATIVE_LABELS = new Set([
  'correct-rejection',
  'equal',
  'inversion',
  'loss',
  'reject',
  'rejected',
  'regression',
  'worse',
  'wrong-language',
]);
const UNCLEAR_LABELS = new Set(['doubtful', 'unclear', 'unknown']);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (POSITIVE_LABELS.has(label)) return 'positive';
  if (NEGATIVE_LABELS.has(label)) return 'negative';
  if (UNCLEAR_LABELS.has(label)) return 'unclear';
  return null;
}

function scoreFrom(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['score', 'semanticScore', 'confidence', 'probability']) {
    const score = finiteNumber(value[key]);
    if (score !== null) return score;
  }
  return null;
}

function labelFrom(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['label', 'expectedLabel', 'expectedVerdict', 'verdict']) {
    const label = normalizeLabel(value[key]);
    if (label) return label;
  }
  return null;
}

function calibrationUnavailable(reason, extra = {}) {
  return Object.freeze({
    status: 'unavailable',
    source: 'issue-9674',
    scoreCutoff: null,
    targetPrecision: SEMANTIC_TARGET_PRECISION,
    precision: null,
    recall: null,
    ...extra,
    reason,
  });
}

/**
 * Calibrate the lowest score cutoff that still meets the requested precision.
 *
 * Rows without a finite score or a known label are excluded from the
 * calibration population.  `unclear` is retained as a non-positive outcome:
 * accepting an unclear case is unsafe.  Returning `unavailable` is deliberate
 * when the fixture is missing, too small, or cannot produce a high-precision
 * cutoff; callers must not silently fall back to a permissive threshold.
 *
 * @param {Array<object>|{cases?: Array<object>}} input
 * @param {{targetPrecision?: number, minCases?: number, minAccepted?: number, source?: string}} [options]
 */
export function calibrateSemanticThreshold(input, options = {}) {
  const cases = Array.isArray(input) ? input : input?.cases;
  if (!Array.isArray(cases)) return calibrationUnavailable('fixture-unavailable');

  const targetPrecision = finiteNumber(options.targetPrecision) ?? SEMANTIC_TARGET_PRECISION;
  const minCases = Number.isSafeInteger(options.minCases) && options.minCases > 0
    ? options.minCases
    : SEMANTIC_MIN_CALIBRATION_CASES;
  const minAccepted = Number.isSafeInteger(options.minAccepted) && options.minAccepted > 0
    ? options.minAccepted
    : 1;
  if (targetPrecision <= 0 || targetPrecision > 1) {
    return calibrationUnavailable('invalid-target-precision', { cases: 0 });
  }

  const rows = cases
    .map((entry) => ({ score: scoreFrom(entry), label: labelFrom(entry) }))
    .filter(({ score, label }) => score !== null && score >= 0 && score <= 1 && label !== null);
  if (rows.length < minCases) {
    return calibrationUnavailable('insufficient-calibration-cases', {
      cases: rows.length,
      requiredCases: minCases,
    });
  }

  const thresholds = [...new Set(rows.map(({ score }) => score))]
    .sort((left, right) => left - right);
  let selected = null;
  for (const cutoff of thresholds) {
    const predicted = rows.filter(({ score }) => score >= cutoff);
    if (predicted.length < minAccepted) continue;
    const truePositives = predicted.filter(({ label }) => label === 'positive').length;
    const precision = truePositives / predicted.length;
    if (precision < targetPrecision) continue;
    const totalPositive = rows.filter(({ label }) => label === 'positive').length;
    const recall = totalPositive > 0 ? truePositives / totalPositive : 0;
    // The first qualifying threshold is the least destructive high-precision
    // cutoff.  The sort is ascending, so it maximizes measured recall.
    selected = {
      cutoff,
      accepted: predicted.length,
      truePositives,
      falsePositives: predicted.length - truePositives,
      precision,
      recall,
      totalPositive,
    };
    break;
  }

  if (!selected) {
    return calibrationUnavailable('no-high-precision-cutoff', {
      cases: rows.length,
      requiredCases: minCases,
      targetPrecision,
    });
  }

  // Never report metrics for the un-clamped threshold when the conservative
  // production floor raises it.  A fixture whose useful evidence all sits
  // below that floor is not calibrated enough to enable the arm.
  const effectiveCutoff = Math.max(SEMANTIC_SCORE_CUTOFF, selected.cutoff);
  const effectivePredicted = rows.filter(({ score }) => score >= effectiveCutoff);
  const effectiveTruePositives = effectivePredicted.filter(({ label }) => label === 'positive').length;
  const effectivePrecision = effectivePredicted.length > 0
    ? effectiveTruePositives / effectivePredicted.length
    : 0;
  if (effectivePredicted.length < minAccepted || effectivePrecision < targetPrecision) {
    return calibrationUnavailable('no-high-precision-cutoff', {
      cases: rows.length,
      requiredCases: minCases,
      targetPrecision,
    });
  }
  const totalPositive = rows.filter(({ label }) => label === 'positive').length;
  selected = {
    cutoff: effectiveCutoff,
    accepted: effectivePredicted.length,
    truePositives: effectiveTruePositives,
    falsePositives: effectivePredicted.length - effectiveTruePositives,
    precision: effectivePrecision,
    recall: totalPositive > 0 ? effectiveTruePositives / totalPositive : 0,
    totalPositive,
  };

  return Object.freeze({
    status: 'ready',
    source: String(options.source || 'issue-9674'),
    scoreCutoff: selected.cutoff,
    targetPrecision,
    cases: rows.length,
    ...selected,
  });
}

// Keep the policy name discoverable to callers that model calibration as a
// policy rather than as a threshold operation.
export const calibrateSemanticPolicy = calibrateSemanticThreshold;

export function semanticPolicyEnabled(value) {
  return String(value || '0') === '1';
}

function readyCalibration(value) {
  return value?.status === 'ready'
    && finiteNumber(value.scoreCutoff) !== null
    && value.scoreCutoff >= 0
    && value.scoreCutoff <= 1;
}

function result({ decision, verdict, reason, score = null, cutoff = null, rollback = false }) {
  return Object.freeze({
    decision,
    verdict,
    shouldWrite: decision === 'write',
    rollback,
    reason,
    score,
    cutoff,
  });
}

/**
 * Evaluate one proposed existing→candidate swap.
 *
 * `score` is the comparator's calibrated probability that the swap is an
 * improvement.  A missing score, comparator error, malformed verdict, or
 * missing required calibration is never treated as approval.
 */
export function evaluateSemanticCandidate(input, options = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const calibration = options.calibration ?? value.calibration;
  const requireCalibration = options.requireCalibration === true;
  if (value.error || value.ok === false) {
    return result({
      decision: 'keep',
      verdict: 'unclear',
      reason: 'semantic-error',
      rollback: true,
    });
  }
  if (requireCalibration && !readyCalibration(calibration)) {
    return result({
      decision: 'keep',
      verdict: 'unclear',
      reason: 'calibration-unavailable',
      rollback: true,
    });
  }

  const score = scoreFrom(value);
  const cutoff = readyCalibration(calibration)
    ? calibration.scoreCutoff
    : finiteNumber(options.scoreCutoff) ?? SEMANTIC_SCORE_CUTOFF;
  if (score === null || score < 0 || score > 1) {
    return result({
      decision: 'keep',
      verdict: 'unclear',
      reason: 'semantic-score-unavailable',
      cutoff,
      rollback: true,
    });
  }

  const regressionRate = finiteNumber(value.regressionRate ?? value.regressionShare);
  const maxRegressionRate = finiteNumber(options.maxRegressionRate) ?? SEMANTIC_MAX_REGRESSION_RATE;
  if (regressionRate !== null && (regressionRate < 0 || regressionRate > 1)) {
    return result({
      decision: 'keep',
      verdict: 'unclear',
      reason: 'invalid-regression-rate',
      score,
      cutoff,
      rollback: true,
    });
  }
  if (regressionRate !== null && regressionRate > maxRegressionRate) {
    return result({
      decision: 'keep',
      verdict: 'reject',
      reason: 'regression-limit',
      score,
      cutoff,
      rollback: true,
    });
  }

  const label = labelFrom(value);
  if (label === 'negative') {
    return result({
      decision: 'keep',
      verdict: 'reject',
      reason: value.verdict === 'worse' ? 'semantic-worse' : 'semantic-rejected',
      score,
      cutoff,
    });
  }
  if (label === 'unclear') {
    return result({
      decision: 'keep',
      verdict: 'unclear',
      reason: 'semantic-unclear',
      score,
      cutoff,
    });
  }
  if (value.verdict !== undefined && label === null) {
    return result({
      decision: 'keep',
      verdict: 'unclear',
      reason: 'semantic-verdict-unavailable',
      score,
      cutoff,
      rollback: true,
    });
  }

  const improvement = finiteNumber(value.improvement ?? value.delta ?? value.margin);
  const minImprovement = finiteNumber(options.minImprovement) ?? SEMANTIC_MIN_IMPROVEMENT;
  if (improvement !== null && improvement < minImprovement) {
    return result({
      decision: 'keep',
      verdict: 'reject',
      reason: 'improvement-below-margin',
      score,
      cutoff,
    });
  }
  if (score < cutoff) {
    return result({
      decision: 'keep',
      verdict: 'reject',
      reason: 'score-below-cutoff',
      score,
      cutoff,
    });
  }
  return result({
    decision: 'write',
    verdict: 'accept',
    reason: 'score-clears-cutoff',
    score,
    cutoff,
  });
}

export const evaluateSemanticPolicy = evaluateSemanticCandidate;

/**
 * Decide whether a measured run may keep the semantic arm enabled.
 * Comparator errors/unavailable evidence disable immediately.  A regression
 * rate is actionable only after the declared minimum sample, avoiding a
 * rollback from one unlucky case while still tripping on the observed 12.3%.
 */
export function evaluateSemanticRun(input = {}, options = {}) {
  const attempted = nonNegativeInteger(input.attempted);
  const judged = nonNegativeInteger(input.judged);
  const errors = nonNegativeInteger(input.errors);
  const unavailable = nonNegativeInteger(input.unavailable);
  const regressions = nonNegativeInteger(input.regressions);
  const maxRegressionRate = finiteNumber(options.maxRegressionRate) ?? SEMANTIC_MAX_REGRESSION_RATE;
  const minObservations = Number.isSafeInteger(options.minObservations) && options.minObservations > 0
    ? options.minObservations
    : SEMANTIC_MIN_REGRESSION_OBSERVATIONS;
  const explicitRate = finiteNumber(input.regressionRate ?? input.regressionShare);
  const computedRate = judged > 0 ? regressions / judged : null;
  const regressionRate = explicitRate ?? computedRate;
  const noEvidence = attempted > 0 && judged === 0 && unavailable === 0 && errors === 0;
  const rollback = errors > 0
    || unavailable > 0
    || noEvidence
    || (regressionRate !== null
      && (explicitRate !== null || judged >= minObservations)
      && regressionRate > maxRegressionRate);
  const reason = errors > 0
    ? 'semantic-error'
    : unavailable > 0 || noEvidence
      ? 'semantic-evidence-unavailable'
      : regressionRate !== null && regressionRate > maxRegressionRate
        ? 'regression-limit'
        : 'within-policy';
  return Object.freeze({
    enabled: !rollback,
    rollback,
    reason,
    attempted,
    judged,
    errors,
    unavailable,
    regressions,
    regressionRate,
    maxRegressionRate,
    minObservations,
  });
}

/** Create a small stateful observer for one mop-up run. */
export function createSemanticRunGuard(options = {}) {
  const state = {
    attempted: 0,
    judged: 0,
    errors: 0,
    unavailable: 0,
    regressions: 0,
  };
  return {
    observe(candidateResult) {
      state.attempted++;
      const value = candidateResult && typeof candidateResult === 'object' ? candidateResult : {};
      if (value.verdict === 'accept' || value.verdict === 'reject') state.judged++;
      if (value.reason === 'semantic-worse' || value.reason === 'regression-limit') {
        state.regressions++;
      } else if (value.rollback) {
        state.errors++;
      }
      if (value.reason === 'semantic-score-unavailable'
        || value.reason === 'semantic-verdict-unavailable'
        || value.reason === 'calibration-unavailable') {
        state.unavailable++;
      }
      return this.status();
    },
    status() {
      return evaluateSemanticRun(state, options);
    },
  };
}
