import { createHash } from 'node:crypto';

export const SOCIAL_EXPERIMENT_PROTOCOL_VERSION = 'social-copy-angle-matched-block-v3';
export const SOCIAL_EXPERIMENT_FAMILY_ALPHA = 0.05;
export const SOCIAL_EXPERIMENT_POWER = 0.8;
export const SOCIAL_EXPERIMENT_BASELINE_MINIMUM = 25;
export const SOCIAL_EXPERIMENT_MAX_DURATION_DAYS = 365;
export const SOCIAL_EXPERIMENT_MAX_BLOCKS = 10_000;
export const SOCIAL_EXPERIMENT_INCOMPLETE_BLOCK_MAX_AGE_DAYS = 45;
export const SOCIAL_EXPERIMENT_AA_CALIBRATION_VERSION = 'matched-block-aa-calibration-v1';
export const SOCIAL_EXPERIMENT_AA_CALIBRATION_REPETITIONS = 500;
export const SOCIAL_EXPERIMENT_AA_CALIBRATION_PERMUTATIONS = 1_000;
export const SOCIAL_EXPERIMENT_AA_CALIBRATION_MAX_UPPER_BOUND = 0.08;

const PACK_ID_RE = /^[a-f0-9]{16}$/u;
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const HASH_RE = /^[a-f0-9]{64}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_TOLERANCE_HOURS = 6;

export function socialExperimentBaselinePopulationScope(channel, slot) {
  return channel === 'instagram' && ['article', 'job', 'border'].includes(slot)
    ? 'same-slot-metric-across-objectives'
    : 'same-objective';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMetric(metric, { slot = '' } = {}) {
  if (!isRecord(metric)) throw new Error('metric must be an object');
  const channel = String(metric.channel || '').trim();
  const objective = String(metric.objective || '').trim();
  if (channel === 'instagram') {
    const expected = {
      share: ['shares', 'reach'],
      save: ['saves', 'reach'],
      conversation: ['comments', 'reach'],
      ...(slot === 'reel' ? { follow: ['follows', 'reach'] } : {}),
    }[objective];
    if (!expected || metric.numerator !== expected[0] || metric.denominator !== expected[1]
      || metric.windowHours !== 72 || metric.windowDays !== undefined) {
      throw new Error('Instagram copy experiments require the objective-matched 72-hour media metric');
    }
  } else if (channel === 'linkedin') {
    if (objective !== 'overall' || metric.numerator !== 'follower_gained_from_content'
      || metric.denominator !== 'impression' || metric.windowDays !== 7
      || metric.measurementWindow !== 'first-seven-utc-calendar-days' || metric.windowHours !== undefined) {
      throw new Error('LinkedIn copy experiments require exact post-attributed followers in the first seven UTC days');
    }
  } else {
    throw new Error('social experiment metric is not supported for this channel');
  }
  return {
    channel,
    objective,
    numerator: String(metric.numerator),
    denominator: String(metric.denominator),
    ...(metric.windowHours !== undefined ? { windowHours: metric.windowHours } : {}),
    ...(metric.windowDays !== undefined ? { windowDays: metric.windowDays } : {}),
    ...(metric.measurementWindow ? { measurementWindow: String(metric.measurementWindow) } : {}),
  };
}

// Peter Acklam's inverse-normal approximation; deterministic and accurate enough
// for fixed-sample planning at the supported alpha and power values.
function normalQuantile(probability) {
  if (!(probability > 0 && probability < 1)) throw new RangeError('normal probability must be between zero and one');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function summarizeBaseline(rows, metric) {
  if (!Array.isArray(rows) || rows.length < SOCIAL_EXPERIMENT_BASELINE_MINIMUM) {
    throw new Error(`baseline needs at least ${SOCIAL_EXPERIMENT_BASELINE_MINIMUM} exact post observations`);
  }
  const seenPostIds = new Set();
  const rates = rows.map((row) => {
    if (!isRecord(row) || row.exact !== true) throw new Error('baseline observations must use exact post-to-copy joins');
    const postId = String(row.postId || '').trim();
    if (!postId) throw new Error('baseline observations need exact post ids');
    if (seenPostIds.has(postId)) throw new Error('baseline observations contain duplicate post ids');
    seenPostIds.add(postId);
    const numerator = finite(row.numerator);
    const denominator = finite(row.denominator);
    if (numerator === null || denominator === null || numerator < 0 || denominator <= 0) {
      throw new Error('baseline observations need available non-negative numerator and positive denominator values');
    }
    return numerator / denominator;
  });
  const meanRate = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  if (!Number.isFinite(meanRate) || meanRate <= 0) throw new Error('baseline rate must be positive before a relative-effect test can be registered');
  const variance = rates.reduce((sum, rate) => sum + ((rate - meanRate) ** 2), 0) / (rates.length - 1);
  const standardDeviation = Math.sqrt(variance);
  if (!Number.isFinite(standardDeviation) || standardDeviation <= 0) {
    throw new Error('baseline variation is insufficient to plan a reliable experiment');
  }
  const endTimes = rows.map((row) => Date.parse(String(row.publishedAt || ''))).filter(Number.isFinite);
  if (endTimes.length !== rows.length) throw new Error('baseline observations need valid publication timestamps');
  const observationDays = new Set(endTimes.map((time) => new Date(time).toISOString().slice(0, 10)));
  if (observationDays.size < SOCIAL_EXPERIMENT_BASELINE_MINIMUM
    || Math.max(...endTimes) - Math.min(...endTimes) < 24 * DAY_MS) {
    throw new Error('baseline must span at least 25 distinct days');
  }
  return {
    observations: rates.length,
    meanRate,
    standardDeviation,
    startAt: new Date(Math.min(...endTimes)).toISOString(),
    endAt: new Date(Math.max(...endTimes)).toISOString(),
    metric: `${metric.numerator}/${metric.denominator}`,
  };
}

/** Build an immutable, hashed registration before any experiment exposure. */
export function createMatchedBlockExperimentRegistration({
  experimentId,
  packId,
  treatmentFingerprint,
  channel,
  slot,
  objective,
  arms,
  metric,
  baselineObservations,
  baselineMaxSpanDays = 45,
  relativeMde = 0.25,
  minimumAbsoluteMde = 0.005,
  familyAlpha = SOCIAL_EXPERIMENT_FAMILY_ALPHA,
  parentFamilySize = 1,
  power = SOCIAL_EXPERIMENT_POWER,
  createdAt = new Date(),
} = {}) {
  const normalizedMetric = normalizeMetric({ ...metric, channel, objective }, { slot });
  const selectedChannel = String(channel || '').trim();
  const selectedObjective = String(objective || '').trim();
  const selectedSlot = String(slot || '').trim();
  const selectedExperiment = String(experimentId || '').trim();
  const selectedPack = String(packId || '').trim();
  const selectedTreatmentFingerprint = String(treatmentFingerprint || '').trim();
  const selectedArms = [...new Set((Array.isArray(arms) ? arms : []).map((arm) => String(arm).trim()))].sort();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(selectedExperiment)
    || !PACK_ID_RE.test(selectedPack)
    || !HASH_RE.test(selectedTreatmentFingerprint)
    || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(selectedChannel)
    || !TEMPLATE_ID_RE.test(selectedSlot)
    || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(selectedObjective)
    || selectedArms.length < 2 || selectedArms.length > 12 || selectedArms.some((arm) => !TEMPLATE_ID_RE.test(arm))) {
    throw new Error('invalid social experiment cohort or arm ids');
  }
  if (!Number.isFinite(relativeMde) || relativeMde <= 0 || relativeMde > 2
    || !Number.isFinite(minimumAbsoluteMde) || minimumAbsoluteMde <= 0
    || !Number.isFinite(familyAlpha) || familyAlpha <= 0 || familyAlpha >= 0.2
    || !Number.isSafeInteger(parentFamilySize) || parentFamilySize < 1 || parentFamilySize > 100
    || !Number.isFinite(power) || power < 0.8 || power >= 1) {
    throw new Error('invalid MDE, family alpha, or statistical power');
  }
  const current = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (!Number.isFinite(current.getTime())) throw new Error('createdAt must be a valid timestamp');
  const maximumBaselineSpanDays = selectedSlot === 'reel' ? 120 : 45;
  if (!Number.isSafeInteger(baselineMaxSpanDays) || baselineMaxSpanDays < 25 || baselineMaxSpanDays > maximumBaselineSpanDays) {
    throw new Error('baselineMaxSpanDays exceeds the supported slot-specific window');
  }
  const baseline = summarizeBaseline(baselineObservations, normalizedMetric);
  const baselinePopulationScope = socialExperimentBaselinePopulationScope(selectedChannel, selectedSlot);
  const baselineStart = Date.parse(baseline.startAt);
  const baselineEnd = Date.parse(baseline.endAt);
  if (baselineEnd >= current.getTime() || current.getTime() - baselineEnd > 7 * DAY_MS
    || current.getTime() - baselineStart > baselineMaxSpanDays * DAY_MS) {
    throw new Error('baseline must be recent and fully observed before experiment registration');
  }
  const mde = Math.max(minimumAbsoluteMde, baseline.meanRate * relativeMde);
  const comparisons = (selectedArms.length * (selectedArms.length - 1)) / 2;
  const effectiveFamilyAlpha = familyAlpha / parentFamilySize;
  const alphaPerComparison = effectiveFamilyAlpha / comparisons;
  const zAlpha = normalQuantile(1 - alphaPerComparison / 2);
  const zPower = normalQuantile(power);
  const conservativePairedSd = Math.sqrt(2) * baseline.standardDeviation;
  const plannedBlocks = Math.max(25, Math.ceil((((zAlpha + zPower) * conservativePairedSd) / mde) ** 2));
  if (!Number.isSafeInteger(plannedBlocks) || plannedBlocks < 25 || plannedBlocks > SOCIAL_EXPERIMENT_MAX_BLOCKS) {
    throw new Error('required matched-block sample is not feasible within the protocol limit');
  }
  const baselineSpanDays = Math.max(1, (baselineEnd - baselineStart) / DAY_MS + 1);
  const estimatedPostsPerDay = baseline.observations / baselineSpanDays;
  const measurementDays = normalizedMetric.windowHours
    ? Math.ceil(normalizedMetric.windowHours / 24)
    : normalizedMetric.windowDays;
  const estimatedDurationDays = Math.ceil((plannedBlocks * selectedArms.length) / estimatedPostsPerDay) + measurementDays;
  if (!Number.isSafeInteger(estimatedDurationDays) || estimatedDurationDays > SOCIAL_EXPERIMENT_MAX_DURATION_DAYS) {
    throw new Error('required matched-block sample is not feasible within the observed posting cadence');
  }
  const cohortKey = [selectedExperiment, selectedChannel, selectedSlot, selectedObjective, selectedTreatmentFingerprint].join('|');
  const body = {
    schemaVersion: 2,
    protocolVersion: SOCIAL_EXPERIMENT_PROTOCOL_VERSION,
    baselinePopulationScope,
    registrationId: digest(cohortKey),
    experimentId: selectedExperiment,
    packId: selectedPack,
    treatmentFingerprint: selectedTreatmentFingerprint,
    channel: selectedChannel,
    measurementChannel: selectedChannel === 'linkedin' ? 'linkedin-member' : selectedChannel,
    slot: selectedSlot,
    objective: selectedObjective,
    arms: selectedArms,
    metric: normalizedMetric,
    baseline,
    baselineMaxSpanDays,
    estimatedPostsPerDay,
    estimatedDurationDays,
    maximumDurationDays: SOCIAL_EXPERIMENT_MAX_DURATION_DAYS,
    relativeMde,
    minimumAbsoluteMde,
    absoluteMde: mde,
    familyAlpha: effectiveFamilyAlpha,
    parentFamilySize,
    familySize: comparisons,
    power,
    plannedBlocks,
    createdAt: current.toISOString(),
    startsAt: current.toISOString(),
  };
  return { ...body, registrationHash: digest(stableJson(body)) };
}

export function validateMatchedBlockExperimentRegistration(registration) {
  if (!isRecord(registration) || registration.schemaVersion !== 2
    || registration.protocolVersion !== SOCIAL_EXPERIMENT_PROTOCOL_VERSION
    || registration.baselinePopulationScope !== socialExperimentBaselinePopulationScope(registration.channel, registration.slot)
    || !HASH_RE.test(String(registration.registrationId || ''))
    || !HASH_RE.test(String(registration.registrationHash || ''))
    || !PACK_ID_RE.test(String(registration.packId || ''))
    || !HASH_RE.test(String(registration.treatmentFingerprint || ''))
    || !Array.isArray(registration.arms) || registration.arms.length < 2
    || registration.arms.length > 12
    || registration.arms.some((arm) => !TEMPLATE_ID_RE.test(String(arm || '')))
    || new Set(registration.arms).size !== registration.arms.length
    || !Number.isSafeInteger(registration.plannedBlocks) || registration.plannedBlocks < 25
    || !Number.isSafeInteger(registration.familySize) || registration.familySize < 1
    || !Number.isSafeInteger(registration.baselineMaxSpanDays) || registration.baselineMaxSpanDays < 25
    || registration.baselineMaxSpanDays > (registration.slot === 'reel' ? 120 : 45)
    || !Number.isFinite(registration.estimatedPostsPerDay) || registration.estimatedPostsPerDay <= 0
    || !Number.isSafeInteger(registration.estimatedDurationDays) || registration.estimatedDurationDays < 1
    || registration.estimatedDurationDays > SOCIAL_EXPERIMENT_MAX_DURATION_DAYS
    || registration.maximumDurationDays !== SOCIAL_EXPERIMENT_MAX_DURATION_DAYS
    || !Number.isSafeInteger(registration.parentFamilySize) || registration.parentFamilySize < 1
    || registration.parentFamilySize > 100
    || registration.familyAlpha * registration.parentFamilySize > SOCIAL_EXPERIMENT_FAMILY_ALPHA + 1e-12
    || !Number.isFinite(registration.absoluteMde) || registration.absoluteMde <= 0
    || !Number.isFinite(Date.parse(String(registration.startsAt || '')))) {
    throw new Error('invalid social experiment registration');
  }
  normalizeMetric(
    { ...registration.metric, channel: registration.channel, objective: registration.objective },
    { slot: registration.slot },
  );
  const cohortKey = [registration.experimentId, registration.channel, registration.slot, registration.objective, registration.treatmentFingerprint].join('|');
  if (digest(cohortKey) !== registration.registrationId) throw new Error('social experiment registration cohort id mismatch');
  const { registrationHash, ...body } = registration;
  if (digest(stableJson(body)) !== registrationHash) throw new Error('social experiment registration hash mismatch');
  return registration;
}

function measurementMatches(row, metric) {
  if (metric.windowHours) {
    const age = finite(row.snapshotAgeHours);
    return Number(row.windowHours) === metric.windowHours && age !== null && age >= 0
      && Math.abs(age - metric.windowHours) <= WINDOW_TOLERANCE_HOURS;
  }
  return Number(row.windowDays) === metric.windowDays
    && row.measurementWindow === metric.measurementWindow;
}

function metricRate(row, metric) {
  const metrics = isRecord(row.metrics) ? row.metrics : row;
  const available = new Set(Array.isArray(row.availableMetrics) ? row.availableMetrics : []);
  if (!available.has(metric.numerator) || !available.has(metric.denominator)) return null;
  const numerator = finite(metrics[metric.numerator]);
  const denominator = finite(metrics[metric.denominator]);
  if (numerator === null || denominator === null || numerator < 0 || denominator <= 0) return null;
  return numerator / denominator;
}

function randomizationPValue(differences, seed, samples = 100_000) {
  const observed = Math.abs(differences.reduce((sum, value) => sum + value, 0) / differences.length);
  if (differences.length <= 18) {
    const total = 2 ** differences.length;
    let extreme = 0;
    for (let mask = 0; mask < total; mask += 1) {
      let sum = 0;
      for (let index = 0; index < differences.length; index += 1) {
        sum += (mask & (1 << index)) ? differences[index] : -differences[index];
      }
      if (Math.abs(sum / differences.length) >= observed - 1e-12) extreme += 1;
    }
    return extreme / total;
  }
  let state = Number.parseInt(digest(seed).slice(0, 8), 16) || 0x9e3779b9;
  const nextUnit = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  let extreme = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1) {
      sum += nextUnit() < 0.5 ? -differences[index] : differences[index];
    }
    if (Math.abs(sum / differences.length) >= observed - 1e-12) extreme += 1;
  }
  return (extreme + 1) / (samples + 1);
}

function xorshift(seed) {
  let state = Number.parseInt(digest(seed).slice(0, 8), 16) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function normalRandom(nextUnit) {
  const left = Math.max(Number.MIN_VALUE, nextUnit());
  const right = nextUnit();
  return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
}

function wilsonUpperBound(successes, trials) {
  const z = 1.959963984540054;
  const rate = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = rate + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * trials)) / trials);
  return Math.min(1, (center + spread) / denominator);
}

function calibrationFingerprint() {
  return digest(stableJson({
    protocolVersion: SOCIAL_EXPERIMENT_PROTOCOL_VERSION,
    calibrationVersion: SOCIAL_EXPERIMENT_AA_CALIBRATION_VERSION,
    repetitions: SOCIAL_EXPERIMENT_AA_CALIBRATION_REPETITIONS,
    permutations: SOCIAL_EXPERIMENT_AA_CALIBRATION_PERMUTATIONS,
    blocks: 25,
    arms: ['aa-one', 'aa-two', 'aa-three'],
    alpha: SOCIAL_EXPERIMENT_FAMILY_ALPHA,
    maxUpperBound: SOCIAL_EXPERIMENT_AA_CALIBRATION_MAX_UPPER_BOUND,
  }));
}

export function matchedBlockAaCalibrationFingerprint() {
  return calibrationFingerprint();
}

/** Simulate the frozen winner rule under a three-arm, zero-effect A/A design. */
export function calibrateMatchedBlockExperimentProtocol() {
  const arms = ['aa-one', 'aa-two', 'aa-three'];
  const familySize = (arms.length * (arms.length - 1)) / 2;
  const critical = normalQuantile(1 - SOCIAL_EXPERIMENT_FAMILY_ALPHA / (2 * familySize));
  let falseWinners = 0;
  for (let repetition = 0; repetition < SOCIAL_EXPERIMENT_AA_CALIBRATION_REPETITIONS; repetition += 1) {
    const nextUnit = xorshift(`${SOCIAL_EXPERIMENT_AA_CALIBRATION_VERSION}:${repetition}`);
    const outcomes = new Map(arms.map((arm) => [arm, []]));
    for (let block = 0; block < 25; block += 1) {
      const blockEffect = normalRandom(nextUnit) * 0.02;
      for (const arm of arms) outcomes.get(arm).push(0.1 + blockEffect + normalRandom(nextUnit) * 0.02);
    }
    const comparisons = [];
    for (let leftIndex = 0; leftIndex < arms.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < arms.length; rightIndex += 1) {
        const left = arms[leftIndex];
        const right = arms[rightIndex];
        const differences = outcomes.get(left).map((value, index) => value - outcomes.get(right)[index]);
        const meanDifference = differences.reduce((sum, value) => sum + value, 0) / differences.length;
        const variance = differences.reduce((sum, value) => sum + ((value - meanDifference) ** 2), 0) / (differences.length - 1);
        const lowerBound = meanDifference - critical * Math.sqrt(variance / differences.length);
        const pValue = randomizationPValue(
          differences,
          `${SOCIAL_EXPERIMENT_AA_CALIBRATION_VERSION}:${repetition}:${left}:${right}`,
          SOCIAL_EXPERIMENT_AA_CALIBRATION_PERMUTATIONS,
        );
        comparisons.push({ left, right, meanDifference, lowerBound, pValue });
      }
    }
    holmAdjust(comparisons);
    const winner = arms.some((candidate) => arms.filter((arm) => arm !== candidate).every((opponent) => {
      const comparison = comparisons.find((item) => item.left === candidate && item.right === opponent)
        || comparisons.find((item) => item.left === opponent && item.right === candidate);
      if (!comparison) return false;
      const direction = comparison.left === candidate ? 1 : -1;
      return comparison.adjustedPValue <= SOCIAL_EXPERIMENT_FAMILY_ALPHA
        && direction * comparison.meanDifference > 0
        && direction * comparison.lowerBound > 0;
    }));
    if (winner) falseWinners += 1;
  }
  const falseWinnerRate = falseWinners / SOCIAL_EXPERIMENT_AA_CALIBRATION_REPETITIONS;
  const upperBound = wilsonUpperBound(falseWinners, SOCIAL_EXPERIMENT_AA_CALIBRATION_REPETITIONS);
  const certificate = {
    schemaVersion: 1,
    protocolVersion: SOCIAL_EXPERIMENT_PROTOCOL_VERSION,
    calibrationVersion: SOCIAL_EXPERIMENT_AA_CALIBRATION_VERSION,
    fingerprint: calibrationFingerprint(),
    repetitions: SOCIAL_EXPERIMENT_AA_CALIBRATION_REPETITIONS,
    blocksPerSimulation: 25,
    armsPerSimulation: arms.length,
    falseWinners,
    falseWinnerRate,
    wilsonUpperBound: upperBound,
    maximumAcceptedUpperBound: SOCIAL_EXPERIMENT_AA_CALIBRATION_MAX_UPPER_BOUND,
    status: upperBound <= SOCIAL_EXPERIMENT_AA_CALIBRATION_MAX_UPPER_BOUND ? 'passed' : 'failed',
  };
  return { ...certificate, certificateHash: digest(stableJson(certificate)) };
}

export function validateMatchedBlockAaCalibration(certificate) {
  if (!isRecord(certificate)
    || certificate.schemaVersion !== 1
    || certificate.protocolVersion !== SOCIAL_EXPERIMENT_PROTOCOL_VERSION
    || certificate.calibrationVersion !== SOCIAL_EXPERIMENT_AA_CALIBRATION_VERSION
    || certificate.fingerprint !== calibrationFingerprint()
    || certificate.repetitions !== SOCIAL_EXPERIMENT_AA_CALIBRATION_REPETITIONS
    || certificate.status !== 'passed'
    || !Number.isSafeInteger(certificate.falseWinners) || certificate.falseWinners < 0
    || !Number.isFinite(certificate.falseWinnerRate) || certificate.falseWinnerRate < 0 || certificate.falseWinnerRate > 1
    || !Number.isFinite(certificate.wilsonUpperBound)
    || certificate.wilsonUpperBound > SOCIAL_EXPERIMENT_AA_CALIBRATION_MAX_UPPER_BOUND) {
    return false;
  }
  const { certificateHash, ...body } = certificate;
  return digest(stableJson(body)) === certificateHash;
}

function holmAdjust(comparisons) {
  const sorted = [...comparisons].sort((left, right) => left.pValue - right.pValue);
  let previous = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const adjusted = Math.min(1, (sorted.length - index) * sorted[index].pValue);
    previous = Math.max(previous, adjusted);
    sorted[index].adjustedPValue = previous;
  }
  return comparisons;
}

function validateGuardrails(guardrails) {
  if (!isRecord(guardrails)
    || guardrails.platformPolicyClear !== true
    || guardrails.reservationLeaks !== 0
    || guardrails.duplicatePostIds !== 0
    || !Number.isFinite(guardrails.metricCoverage) || guardrails.metricCoverage < 0.95
    || guardrails.syntheticAaCalibration !== 'passed') {
    return { ok: false, reason: 'experiment guardrails are missing or unhealthy' };
  }
  return { ok: true };
}

/** Evaluate only the first preregistered number of exact, complete matched blocks. */
export function evaluateMatchedBlockExperiment({ registration, observations, asOf = new Date(), guardrails } = {}) {
  const frozen = validateMatchedBlockExperimentRegistration(registration);
  const current = asOf instanceof Date ? asOf : new Date(asOf);
  if (!Number.isFinite(current.getTime())) throw new Error('asOf must be a valid timestamp');
  const safety = validateGuardrails(guardrails);
  if (!safety.ok) return { status: 'hold', reason: safety.reason, completeBlocks: 0 };
  if (!Array.isArray(observations)) return { status: 'hold', reason: 'observations are unavailable', completeBlocks: 0 };
  const deadlineAt = Date.parse(frozen.startsAt) + frozen.maximumDurationDays * DAY_MS;
  const metricWindowMs = frozen.metric.windowHours
    ? frozen.metric.windowHours * 60 * 60 * 1000
    : frozen.metric.windowDays * DAY_MS;

  const assignments = new Map();
  const seenPostIds = new Set();
  for (const row of observations) {
    if (!isRecord(row)) continue;
    const copy = isRecord(row.copy) ? row.copy : row;
    if (String(row.channel || '') !== frozen.measurementChannel
      || !PACK_ID_RE.test(String(copy.copyPackId || ''))
      || String(copy.copySlot || '') !== frozen.slot
      || String(copy.copyObjective || (frozen.objective === 'overall' ? 'overall' : '')) !== frozen.objective
      || String(copy.copyExperimentId || '') !== frozen.experimentId) continue;
    const publishedAt = Date.parse(String(row.publishedAt || ''));
    if (!Number.isFinite(publishedAt) || publishedAt < Date.parse(frozen.startsAt)
      || publishedAt + metricWindowMs > deadlineAt
      || !measurementMatches(row, frozen.metric)) continue;
    if (String(copy.copyRegistrationHash || '') !== frozen.registrationHash
      || String(row.copyAttributionStatus || '') !== 'exact'
      || copy.copyAssignmentMode !== 'firebase-balanced') {
      return { status: 'data-integrity-failed', reason: 'registered exposure lacks exact assignment or post attribution', completeBlocks: 0 };
    }
    const postId = String(row.postId || '').trim();
    if (!postId || seenPostIds.has(postId)) return { status: 'data-integrity-failed', reason: 'duplicate or missing exact post id', completeBlocks: 0 };
    seenPostIds.add(postId);
    const snapshotAt = Date.parse(String(row.snapshotAt || ''));
    if (!Number.isFinite(snapshotAt) || snapshotAt > current.getTime()) continue;
    const angleId = String(copy.copyAngleId || '').trim();
    const blockId = String(copy.copyBlockId || '').trim();
    const blockCycle = copy.copyBlockCycle;
    if (!frozen.arms.includes(angleId) || !HASH_RE.test(blockId)
      || !Number.isSafeInteger(blockCycle) || blockCycle < 0) {
      return { status: 'data-integrity-failed', reason: 'assignment is missing a registered arm or block id', completeBlocks: 0 };
    }
    const rate = metricRate(row, frozen.metric);
    const key = `${blockId}:${blockCycle}`;
    const block = assignments.get(key) || { blockId, blockCycle, arms: new Map(), publishedAt: [] };
    if (block.arms.has(angleId)) return { status: 'data-integrity-failed', reason: 'matched block contains duplicate arm assignment', completeBlocks: 0 };
    block.arms.set(angleId, rate);
    block.publishedAt.push(publishedAt);
    assignments.set(key, block);
  }

  const complete = [];
  const incomplete = [];
  for (const block of assignments.values()) {
    if (frozen.arms.every((arm) => block.arms.has(arm) && block.arms.get(arm) !== null)) {
      complete.push(block);
    } else {
      const oldest = Math.min(...block.publishedAt);
      if (current.getTime() - oldest > SOCIAL_EXPERIMENT_INCOMPLETE_BLOCK_MAX_AGE_DAYS * DAY_MS) {
        return { status: 'data-integrity-failed', reason: 'matched block expired with missing arm outcomes', completeBlocks: complete.length };
      }
      incomplete.push(block);
    }
  }
  complete.sort((left, right) => Math.min(...left.publishedAt) - Math.min(...right.publishedAt));
  if (complete.length < frozen.plannedBlocks) {
    if (current.getTime() > deadlineAt) {
      return {
        status: 'expired',
        reason: 'maximum experiment duration elapsed before the fixed sample completed',
        completeBlocks: complete.length,
        incompleteBlocks: incomplete.length,
        plannedBlocks: frozen.plannedBlocks,
      };
    }
    return {
      status: 'collecting',
      reason: incomplete.length ? 'one or more matched blocks are still incomplete' : 'fixed sample has not been reached',
      completeBlocks: complete.length,
      incompleteBlocks: incomplete.length,
      plannedBlocks: frozen.plannedBlocks,
    };
  }
  const sample = complete.slice(0, frozen.plannedBlocks);
  const fixedSampleEnd = Math.max(...sample.flatMap((block) => block.publishedAt));
  const olderIncomplete = incomplete.filter((block) => Math.min(...block.publishedAt) <= fixedSampleEnd);
  if (olderIncomplete.length) {
    return { status: 'data-integrity-failed', reason: 'fixed sample is preceded by incomplete matched blocks', completeBlocks: sample.length };
  }
  const comparisons = [];
  for (let leftIndex = 0; leftIndex < frozen.arms.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < frozen.arms.length; rightIndex += 1) {
      const left = frozen.arms[leftIndex];
      const right = frozen.arms[rightIndex];
      const differences = sample.map((block) => block.arms.get(left) - block.arms.get(right));
      const meanDifference = differences.reduce((sum, value) => sum + value, 0) / differences.length;
      const variance = differences.reduce((sum, value) => sum + ((value - meanDifference) ** 2), 0) / Math.max(1, differences.length - 1);
      const standardError = Math.sqrt(variance / differences.length);
      const critical = normalQuantile(1 - frozen.familyAlpha / (2 * frozen.familySize));
      const lowerBound = meanDifference - critical * standardError;
      const pValue = randomizationPValue(differences, `${frozen.registrationHash}:${left}:${right}`);
      comparisons.push({ left, right, meanDifference, lowerBound, pValue });
    }
  }
  holmAdjust(comparisons);
  const winners = frozen.arms.filter((candidate) => frozen.arms
    .filter((arm) => arm !== candidate)
    .every((opponent) => {
      const comparison = comparisons.find((item) => item.left === candidate && item.right === opponent)
        || comparisons.find((item) => item.left === opponent && item.right === candidate);
      if (!comparison) return false;
      const direction = comparison.left === candidate ? 1 : -1;
      return comparison.adjustedPValue <= frozen.familyAlpha
        && direction * comparison.meanDifference > frozen.absoluteMde
        && direction * comparison.lowerBound > frozen.absoluteMde;
    }));
  return {
    status: winners.length === 1 ? 'winner' : 'hold',
    reason: winners.length === 1 ? 'fixed-sample family-wise criteria passed' : 'no arm cleared every preregistered comparison',
    winnerAngleId: winners.length === 1 ? winners[0] : null,
    completeBlocks: sample.length,
    plannedBlocks: frozen.plannedBlocks,
    familyAlpha: frozen.familyAlpha,
    familySize: frozen.familySize,
    absoluteMde: frozen.absoluteMde,
    comparisons,
    evaluatedAt: current.toISOString(),
  };
}
