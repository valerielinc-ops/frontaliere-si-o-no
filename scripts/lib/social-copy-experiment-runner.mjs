import { createHash } from 'node:crypto';

import {
  SOCIAL_EXPERIMENT_AA_CALIBRATION_VERSION,
  SOCIAL_EXPERIMENT_FAMILY_ALPHA,
  calibrateMatchedBlockExperimentProtocol,
  createMatchedBlockExperimentRegistration,
  evaluateMatchedBlockExperiment,
  matchedBlockAaCalibrationFingerprint,
  validateMatchedBlockAaCalibration,
  validateMatchedBlockExperimentRegistration,
  socialExperimentBaselinePopulationScope,
} from './social-experiment-protocol.mjs';
import {
  socialCopyExperimentRegistrationId,
  socialCopyExperimentTreatmentFingerprint,
} from './social-copy-pack.mjs';
import {
  SOCIAL_AUDIENCE_MAX_AGE_HOURS,
  SOCIAL_AUDIENCE_MINIMUM_DAYS,
  SOCIAL_GROWTH_BASELINE_DAYS,
} from './social-growth-scorecard.mjs';

export const SOCIAL_COPY_EXPERIMENT_REGISTRATION_COLLECTION = 'social_copy_experiment_registrations';
export const SOCIAL_COPY_EXPERIMENT_EVALUATION_COLLECTION = 'social_copy_experiment_evaluations';
export const SOCIAL_COPY_EXPERIMENT_CALIBRATION_COLLECTION = 'social_copy_experiment_calibrations';
export const SOCIAL_COPY_EXPERIMENT_ASSIGNMENT_COLLECTION = 'social_copy_assignment_records';
export const SOCIAL_COPY_EXPERIMENT_PARAM = 'SOCIAL_COPY_EXPERIMENT_CONFIG';
export const SOCIAL_COPY_EXPERIMENT_ID = 'social-copy-angle-matched-v3';
export const SOCIAL_COPY_EXPERIMENT_SCHEMA_VERSION = 4;
export const SOCIAL_COPY_EXPERIMENT_PROTOCOL_VERSION = 'social-copy-angle-matched-block-v3';
export const SOCIAL_COPY_EXPERIMENT_SOURCE_MAX_AGE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const OBJECTIVE_METRICS = Object.freeze({
  share: { numerator: 'shares', denominator: 'reach', windowHours: 72 },
  save: { numerator: 'saves', denominator: 'reach', windowHours: 72 },
  conversation: { numerator: 'comments', denominator: 'reach', windowHours: 72 },
  follow: { numerator: 'follows', denominator: 'reach', windowHours: 72 },
  overall: {
    numerator: 'follower_gained_from_content',
    denominator: 'impression',
    windowDays: 7,
    measurementWindow: 'first-seven-utc-calendar-days',
  },
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function postIdHash(channel, postId) {
  return digest(`${channel}\u0000${postId}`);
}

function copyOf(row) {
  return isRecord(row?.copy) ? row.copy : row;
}

function metricValue(row, name) {
  const metrics = isRecord(row?.metrics) ? row.metrics : row;
  const available = new Set(Array.isArray(row?.availableMetrics) ? row.availableMetrics : []);
  if (!available.has(name)) return null;
  const value = Number(metrics?.[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function metricWindowMatches(row, metric) {
  if (metric.windowHours) {
    const age = Number(row?.snapshotAgeHours);
    return Number(row?.windowHours) === metric.windowHours
      && Number.isFinite(age) && age >= 0 && Math.abs(age - metric.windowHours) <= 6;
  }
  return Number(row?.windowDays) === metric.windowDays
    && row?.measurementWindow === metric.measurementWindow;
}

function expectedMaturityAt(registration, assignment) {
  const publishedAt = Date.parse(String(assignment?.publishedAt || ''));
  if (!Number.isFinite(publishedAt)) return null;
  if (registration.metric.windowHours) return publishedAt + (registration.metric.windowHours + 6) * HOUR_MS;
  const date = new Date(publishedAt);
  const utcStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return utcStart + registration.metric.windowDays * DAY_MS;
}

function statusOf(source) {
  return typeof source === 'string' ? source : String(source?.status || '');
}

function sourceTimestamp(source, channel) {
  const fields = channel === 'instagram' ? [source?.latestSnapshotAt] : [source?.lastSuccessAt, source?.latestSnapshotAt];
  const values = fields
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

/** Summarize a qualified account-level audience trend; this is a promotion safety signal, not causal attribution. */
export function summarizeSocialAudienceSafety(audienceSnapshots, channel, asOf = new Date()) {
  const current = asOf instanceof Date ? asOf : new Date(asOf);
  if (!Number.isFinite(current.getTime())) throw new TypeError('asOf must be a valid timestamp');
  const metric = channel === 'telegram' ? 'members'
    : channel === 'youtube-shorts' ? 'subscribers' : 'followers';
  const cutoff = current.getTime() - SOCIAL_GROWTH_BASELINE_DAYS * DAY_MS;
  const rowsByDay = new Map();
  for (const row of Array.isArray(audienceSnapshots) ? audienceSnapshots : []) {
    if (!isRecord(row) || row.channel !== channel || row.metric !== metric || row.status !== 'available'
      || !Number.isSafeInteger(row.value) || row.value < 0) continue;
    const at = Date.parse(String(row.snapshotAt || ''));
    if (!Number.isFinite(at) || at < cutoff || at > current.getTime()) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    const previous = rowsByDay.get(day);
    if (!previous || at > previous.at) rowsByDay.set(day, { at, value: row.value });
  }
  const rows = [...rowsByDay.values()].sort((left, right) => left.at - right.at);
  const latest = rows.at(-1) || null;
  const coverageDays = rows.length;
  const spanDays = rows.length > 1 ? Math.floor((rows.at(-1).at - rows[0].at) / DAY_MS) : 0;
  const ageHours = latest ? (current.getTime() - latest.at) / (60 * 60 * 1000) : null;
  if (!latest || coverageDays < SOCIAL_AUDIENCE_MINIMUM_DAYS || spanDays < SOCIAL_AUDIENCE_MINIMUM_DAYS
    || ageHours > SOCIAL_AUDIENCE_MAX_AGE_HOURS) {
    return { status: 'unqualified', metric, observations: coverageDays, spanDays, netChange: null };
  }
  const netChange = latest.value - rows[0].value;
  return {
    status: netChange < 0 ? 'declining' : 'non-declining',
    metric,
    observations: coverageDays,
    spanDays,
    netChange,
  };
}

export function socialExperimentPlatformPolicyClear(
  registration,
  insights,
  asOf = new Date(),
  { linkedinPostAnalyticsStorageApproved = false } = {},
) {
  const sourceKey = registration.measurementChannel === 'linkedin-member'
    ? 'linkedinMember'
    : registration.slot === 'reel' ? 'instagramPostInsights' : 'instagram';
  const source = insights?.sources?.[sourceKey];
  if (registration.measurementChannel === 'linkedin-member'
    && (linkedinPostAnalyticsStorageApproved !== true || source?.postAnalyticsStorageApproved !== true)) return false;
  const status = statusOf(source).toLowerCase();
  const current = asOf instanceof Date ? asOf.getTime() : Date.parse(String(asOf));
  const observedAt = sourceTimestamp(source, sourceKey === 'instagram' ? 'instagram' : 'linkedin-member');
  const blocked = /(policy|permission|unauthori[sz]ed|scope|rate.?limit|api.?error|credentials.?missing|not-collected|unavailable|review-required)/u.test(status);
  return !blocked && ['available', 'partial', 'snapshots-added', 'backlog-pending', 'no-new-eligible-posts'].includes(status)
    && Number.isFinite(current) && observedAt !== null && observedAt <= current
    && current - observedAt <= SOCIAL_COPY_EXPERIMENT_SOURCE_MAX_AGE_DAYS * DAY_MS;
}

/** Only API-backed posts with exact native post IDs enter the experiment family. */
export function listSocialCopyExperimentCohorts(pack) {
  const cohorts = [];
  const channels = isRecord(pack?.channels) ? pack.channels : {};
  for (const slot of ['article', 'job', 'reel']) {
    const instagramTemplates = Array.isArray(channels.instagram?.[slot]) ? channels.instagram[slot] : [];
    const objectives = [...new Set(instagramTemplates
      .map((template) => String(template?.objective || '')))]
      .filter((objective) => ['share', 'save', 'conversation', 'follow'].includes(objective))
      .sort();
    for (const objective of objectives) {
      const arms = [...new Set(instagramTemplates
        .filter((template) => template?.objective === objective)
        .map((template) => String(template?.angleId || '')))].sort();
      const treatmentFingerprint = socialCopyExperimentTreatmentFingerprint(pack, { channel: 'instagram', slot, objective });
      if (arms.length >= 2 && arms.every((arm) => /^[a-z0-9][a-z0-9-]{0,31}$/u.test(arm))
        && /^[a-f0-9]{64}$/u.test(treatmentFingerprint)) cohorts.push({
        experimentId: SOCIAL_COPY_EXPERIMENT_ID,
        packId: String(pack.packId || ''),
        channel: 'instagram',
        measurementChannel: 'instagram',
        slot,
        objective,
        arms,
        treatmentFingerprint,
        baselinePopulationScope: socialExperimentBaselinePopulationScope('instagram', slot),
        baselineMaxSpanDays: slot === 'reel' ? 120 : 45,
        metric: OBJECTIVE_METRICS[objective],
      });
    }

    const linkedinTemplates = Array.isArray(channels.linkedin?.[slot]) ? channels.linkedin[slot] : [];
    const linkedinArms = [...new Set(linkedinTemplates.map((template) => String(template?.angleId || '')))].sort();
    const linkedinFingerprint = socialCopyExperimentTreatmentFingerprint(pack, { channel: 'linkedin', slot, objective: 'overall' });
    if (linkedinArms.length >= 2 && linkedinArms.every((arm) => /^[a-z0-9][a-z0-9-]{0,31}$/u.test(arm))
      && /^[a-f0-9]{64}$/u.test(linkedinFingerprint)) cohorts.push({
      experimentId: SOCIAL_COPY_EXPERIMENT_ID,
      packId: String(pack.packId || ''),
      channel: 'linkedin',
      measurementChannel: 'linkedin-member',
      slot,
      objective: 'overall',
      arms: linkedinArms,
      treatmentFingerprint: linkedinFingerprint,
      baselinePopulationScope: socialExperimentBaselinePopulationScope('linkedin', slot),
      baselineMaxSpanDays: 45,
      metric: OBJECTIVE_METRICS.overall,
    });
  }
  return cohorts;
}

function baselineRows(posts, cohort, asOf) {
  const current = asOf.getTime();
  return (Array.isArray(posts) ? posts : []).flatMap((row) => {
    if (!isRecord(row) || row.channel !== cohort.measurementChannel) return [];
    const copy = copyOf(row);
    if (String(copy.copyMode || '') !== 'codex'
      || String(copy.copySlot || '') !== cohort.slot
      || String(copy.copyPackId || '') === ''
      || String(copy.copyTemplateId || '') === ''
      || String(row.copyAttributionStatus || '') !== 'exact') return [];
    const objective = String(copy.copyObjective || (cohort.channel === 'linkedin' ? 'overall' : ''));
    const allowedBaselineObjectives = cohort.baselinePopulationScope === 'same-slot-metric-across-objectives'
      ? ['share', 'save', 'conversation']
      : [cohort.objective];
    if (!allowedBaselineObjectives.includes(objective) || !metricWindowMatches(row, cohort.metric)) return [];
    const published = Date.parse(String(row.publishedAt || ''));
    const snapshot = Date.parse(String(row.snapshotAt || ''));
    const numerator = metricValue(row, cohort.metric.numerator);
    const denominator = metricValue(row, cohort.metric.denominator);
    if (!Number.isFinite(published) || published >= current || current - published > cohort.baselineMaxSpanDays * DAY_MS
      || !Number.isFinite(snapshot) || snapshot > current
      || !String(row.postId || '').trim() || numerator === null || denominator === null || denominator <= 0) return [];
    return [{
      exact: true,
      postId: String(row.postId),
      numerator,
      denominator,
      publishedAt: row.publishedAt,
    }];
  });
}

function expectedBaselineError(error) {
  return /baseline needs|baseline observations|baseline must span|baseline must be recent|baseline rate must be positive|baseline variation is insufficient|required matched-block sample/u.test(String(error?.message || error));
}

async function getRegistration(db, registrationId) {
  const snapshot = await db.collection(SOCIAL_COPY_EXPERIMENT_REGISTRATION_COLLECTION).doc(registrationId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function freezeRegistration(db, candidate) {
  const reference = db.collection(SOCIAL_COPY_EXPERIMENT_REGISTRATION_COLLECTION).doc(candidate.registrationId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists) {
      const stored = snapshot.data();
      validateMatchedBlockExperimentRegistration(stored);
      if (stored.registrationId !== candidate.registrationId
        || stored.experimentId !== candidate.experimentId
        || stored.treatmentFingerprint !== candidate.treatmentFingerprint
        || stored.channel !== candidate.channel
        || stored.slot !== candidate.slot
        || stored.objective !== candidate.objective
        || JSON.stringify(stored.arms) !== JSON.stringify(candidate.arms)) {
        throw new Error('stored social experiment registration does not match its cohort key');
      }
      return stored;
    }
    transaction.set(reference, candidate);
    return candidate;
  });
}

async function listAssignments(db, registrationHash) {
  const query = db.collection(SOCIAL_COPY_EXPERIMENT_ASSIGNMENT_COLLECTION)
    .where('registrationHash', '==', registrationHash);
  const snapshot = await query.get();
  return (Array.isArray(snapshot.docs) ? snapshot.docs : []).map((document) => ({
    id: String(document.id || ''),
    ...document.data(),
  }));
}

async function reconcileAcceptedAssignments(db, registration, assignments, posts, asOf) {
  const occupiedPostHashes = new Set(assignments
    .filter((assignment) => assignment?.status === 'published')
    .map((assignment) => String(assignment.postIdHash || ''))
    .filter(Boolean));
  for (const assignment of assignments.filter((item) => item?.status === 'active' && item.id)) {
    const rows = (Array.isArray(posts) ? posts : []).filter((row) => {
      const copy = copyOf(row);
      return row?.channel === registration.measurementChannel
        && String(row.copyAttributionStatus || '') === 'exact'
        && String(copy.copyAssignmentMode || '') === 'firebase-balanced'
        && String(copy.copyExperimentId || '') === registration.experimentId
        && String(copy.copyRegistrationHash || '') === registration.registrationHash
        && /^[a-f0-9]{16}$/u.test(String(copy.copyPackId || ''))
        && String(copy.copySlot || '') === registration.slot
        && String(copy.copyObjective || (registration.objective === 'overall' ? 'overall' : '')) === registration.objective
        && String(copy.copyAngleId || '') === String(assignment.armId || assignment.templateId || '')
        && String(copy.copyBlockId || '') === String(assignment.blockId || '')
        && copy.copyBlockCycle === assignment.blockCycle
        && metricWindowMatches(row, registration.metric)
        && Number.isFinite(Date.parse(String(row.snapshotAt || '')))
        && Date.parse(String(row.snapshotAt || '')) <= asOf.getTime()
        && Number.isFinite(Date.parse(String(row.publishedAt || '')));
    });
    if (rows.length !== 1) continue;
    const row = rows[0];
    const deliveredAt = Date.parse(String(row.publishedAt));
    const hash = postIdHash(registration.channel, row.postId);
    if (!String(row.postId || '').trim() || occupiedPostHashes.has(hash)
      || deliveredAt > asOf.getTime() || deliveredAt < Date.parse(registration.startsAt)) continue;
    const reference = db.collection(SOCIAL_COPY_EXPERIMENT_ASSIGNMENT_COLLECTION).doc(assignment.id);
    const reconciled = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists || snapshot.data()?.status !== 'active') return false;
      const current = snapshot.data();
      const attempts = Object.fromEntries(Object.entries(current?.attempts || {})
        .map(([key, status]) => [key, status === 'active' ? 'published' : status]));
      transaction.set(reference, {
        attempts,
        status: 'published',
        postIdHash: hash,
        publishedAt: new Date(deliveredAt).toISOString(),
        markedPublishedAt: asOf,
        reconciledFromExactNativePost: true,
      }, { merge: true });
      return true;
    });
    if (!reconciled) continue;
    assignment.status = 'published';
    assignment.postIdHash = hash;
    assignment.publishedAt = new Date(deliveredAt).toISOString();
    occupiedPostHashes.add(hash);
  }
  return assignments;
}

function buildEvaluationInputs(registration, assignments, posts, asOf) {
  const current = asOf.getTime();
  const publishedAssignmentHashes = new Map();
  let invalidPublishedAssignmentCount = 0;
  for (const assignment of assignments) {
    if (assignment?.status !== 'published') continue;
    const publishedAt = Date.parse(String(assignment.publishedAt || ''));
    if (!/^[a-f0-9]{64}$/u.test(String(assignment.postIdHash || ''))
      || !Number.isFinite(publishedAt) || publishedAt > current) {
      invalidPublishedAssignmentCount += 1;
      continue;
    }
    publishedAssignmentHashes.set(assignment.postIdHash, (publishedAssignmentHashes.get(assignment.postIdHash) || 0) + 1);
  }
  const duplicatePublishedAssignmentCount = [...publishedAssignmentHashes.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const matureAssignments = assignments.filter((assignment) => {
    const maturityAt = expectedMaturityAt(registration, assignment);
    return assignment?.status === 'published'
      && String(assignment?.registrationHash || '') === registration.registrationHash
      && /^[a-f0-9]{16}$/u.test(String(assignment?.packId || registration.packId))
      && String(assignment?.channel || registration.channel) === registration.channel
      && maturityAt !== null && maturityAt <= current
      && Date.parse(String(assignment.publishedAt)) >= Date.parse(registration.startsAt);
  });
  const expectedHashes = new Set(matureAssignments.map((assignment) => assignment.postIdHash));
  const matchingPosts = (Array.isArray(posts) ? posts : []).filter((row) => {
    const copy = copyOf(row);
    if (String(copy.copyRegistrationHash || '') !== registration.registrationHash
      || String(copy.copyExperimentId || '') !== registration.experimentId
      || !/^[a-f0-9]{16}$/u.test(String(copy.copyPackId || ''))) return false;
    return true;
  });
  const joinedPosts = [];
  let unmatchedExposureCount = 0;
  const postIdCounts = new Map();
  let availableOutcomeCount = 0;
  for (const row of matchingPosts) {
    if (!metricWindowMatches(row, registration.metric)) continue;
    const postId = String(row.postId || '').trim();
    const postHash = postId ? postIdHash(registration.channel, postId) : '';
    if (postId) postIdCounts.set(postId, (postIdCounts.get(postId) || 0) + 1);
    if (!postId || !expectedHashes.has(postHash)) {
      unmatchedExposureCount += 1;
      continue;
    }
    joinedPosts.push(row);
    if (metricWindowMatches(row, registration.metric)
      && metricValue(row, registration.metric.numerator) !== null
      && metricValue(row, registration.metric.denominator) !== null
      && metricValue(row, registration.metric.denominator) > 0
      && String(row.copyAttributionStatus || '') === 'exact') availableOutcomeCount += 1;
  }
  const duplicatePostIds = [...postIdCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const coverage = matureAssignments.length === 0 ? 1 : Math.min(1, availableOutcomeCount / matureAssignments.length);
  const reservationLeaks = assignments.filter((assignment) => {
    if (assignment?.status === 'released') return false;
    if (assignment?.status === 'published') return false;
    return true;
  }).length + unmatchedExposureCount + invalidPublishedAssignmentCount + duplicatePublishedAssignmentCount;
  return {
    observations: joinedPosts,
    guardrails: {
      platformPolicyClear: true,
      reservationLeaks,
      duplicatePostIds,
      metricCoverage: coverage,
      syntheticAaCalibration: 'passed',
    },
    matureAssignmentCount: matureAssignments.length,
    exactOutcomeCount: availableOutcomeCount,
    unmatchedExposureCount,
  };
}

async function loadOrCreateCalibration(db, asOf) {
  const fingerprint = matchedBlockAaCalibrationFingerprint();
  const reference = db.collection(SOCIAL_COPY_EXPERIMENT_CALIBRATION_COLLECTION).doc(fingerprint);
  const snapshot = await reference.get();
  if (snapshot.exists) {
    const existing = snapshot.data();
    if (validateMatchedBlockAaCalibration(existing?.certificate)) return existing.certificate;
    throw new Error('stored matched-block A/A calibration certificate is invalid');
  }
  const generated = calibrateMatchedBlockExperimentProtocol();
  if (generated.status !== 'passed') return generated;
  return db.runTransaction(async (transaction) => {
    const current = await transaction.get(reference);
    if (current.exists) {
      const stored = current.data();
      if (!validateMatchedBlockAaCalibration(stored?.certificate)) {
        throw new Error('stored matched-block A/A calibration certificate is invalid');
      }
      return stored.certificate;
    }
    transaction.set(reference, { certificate: generated, createdAt: asOf.toISOString() });
    return generated;
  });
}

function currentSocialCopyConfig({ packId = '', registrations = {}, registrationDeadlines = {}, winners = {} } = {}) {
  return {
    schemaVersion: SOCIAL_COPY_EXPERIMENT_SCHEMA_VERSION,
    experimentId: SOCIAL_COPY_EXPERIMENT_ID,
    protocolVersion: SOCIAL_COPY_EXPERIMENT_PROTOCOL_VERSION,
    enabled: Object.keys(registrations).length > 0,
    packId,
    registrations,
    registrationDeadlines,
    winners,
  };
}

/** Freeze registrations, evaluate the exact fixed sample, and reconcile the current RC winner map. */
export async function runSocialCopyExperimentProtocol({
  db,
  pack,
  insights,
  asOf = new Date(),
  linkedinPostAnalyticsStorageApproved = false,
  setRemoteConfig = async () => ({ ok: true, changed: false }),
  logger = () => {},
} = {}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('Firestore Admin handle is required for social experiment reconciliation');
  }
  const current = asOf instanceof Date ? asOf : new Date(asOf);
  if (!Number.isFinite(current.getTime())) throw new TypeError('asOf must be a valid timestamp');
  if (!isRecord(pack) || !/^[a-f0-9]{16}$/u.test(String(pack.packId || ''))) {
    const config = currentSocialCopyConfig();
    const update = await setRemoteConfig(config);
    if (!update?.ok) throw new Error('Remote Config social-copy disable failed: ' + (update?.detail || 'unknown error'));
    return { status: 'pack-unavailable', config, update, registrations: [], evaluations: [] };
  }
  if (!isRecord(insights) || !Array.isArray(insights.posts)) {
    throw new TypeError('private social insight document is required');
  }

  const calibration = await loadOrCreateCalibration(db, current);
  const cohortCandidates = listSocialCopyExperimentCohorts(pack);
  const exposedRegistrationCount = Math.max(1, cohortCandidates.length);
  const registrations = [];
  const notReady = [];
  for (const cohort of cohortCandidates) {
    const registrationId = socialCopyExperimentRegistrationId(cohort);
    let frozen = await getRegistration(db, registrationId);
    if (frozen) {
      validateMatchedBlockExperimentRegistration(frozen);
    } else {
      if (calibration.status !== 'passed' || !socialExperimentPlatformPolicyClear(cohort, insights, current, {
        linkedinPostAnalyticsStorageApproved,
      })) {
        notReady.push({ registrationId, reason: 'calibration-or-platform-evidence-unavailable' });
        continue;
      }
      try {
        const candidate = createMatchedBlockExperimentRegistration({
          ...cohort,
          baselineObservations: baselineRows(insights.posts, cohort, current),
          familyAlpha: SOCIAL_EXPERIMENT_FAMILY_ALPHA,
          parentFamilySize: exposedRegistrationCount,
          createdAt: current,
        });
        if (candidate.registrationId !== registrationId) throw new Error('social experiment registration id mismatch');
        frozen = await freezeRegistration(db, candidate);
      } catch (error) {
        if (!expectedBaselineError(error)) throw error;
        notReady.push({ registrationId, reason: 'historical-baseline-unqualified' });
        continue;
      }
    }
    registrations.push(frozen);
  }

  const registrationMap = {};
  const registrationDeadlines = {};
  const winners = {};
  const evaluations = [];
  for (const registration of registrations) {
    const policyClear = socialExperimentPlatformPolicyClear(registration, insights, current, {
      linkedinPostAnalyticsStorageApproved,
    });
    const assignments = await listAssignments(db, registration.registrationHash);
    await reconcileAcceptedAssignments(db, registration, assignments, insights.posts, current);
    const evaluationInputs = buildEvaluationInputs(registration, assignments, insights.posts, current);
    evaluationInputs.guardrails.platformPolicyClear = policyClear && calibration.status === 'passed';
    evaluationInputs.guardrails.syntheticAaCalibration = calibration.status;
    let result = evaluateMatchedBlockExperiment({
      registration,
      observations: evaluationInputs.observations,
      asOf: current,
      guardrails: evaluationInputs.guardrails,
    });
    const audienceSafety = summarizeSocialAudienceSafety(
      insights.audienceSnapshots,
      registration.measurementChannel,
      current,
    );
    if (result.status === 'winner' && audienceSafety.status !== 'non-declining') {
      result = {
        ...result,
        status: 'hold',
        reason: audienceSafety.status === 'declining'
          ? 'qualified account-level audience declined over 30 days; engagement winner held'
          : 'account-level audience safety is unqualified; engagement winner held',
      };
    }
    const evaluation = {
      schemaVersion: 1,
      registrationId: registration.registrationId,
      registrationHash: registration.registrationHash,
      packId: registration.packId,
      channel: registration.channel,
      slot: registration.slot,
      objective: registration.objective,
      baselinePopulationScope: registration.baselinePopulationScope,
      status: result.status,
      reason: result.reason,
      completeBlocks: result.completeBlocks || 0,
      plannedBlocks: registration.plannedBlocks,
      matureAssignments: evaluationInputs.matureAssignmentCount,
      exactOutcomes: evaluationInputs.exactOutcomeCount,
      metricCoverage: evaluationInputs.guardrails.metricCoverage,
      reservationLeaks: evaluationInputs.guardrails.reservationLeaks,
      duplicatePostIds: evaluationInputs.guardrails.duplicatePostIds,
      policyClear,
      calibration: calibration.status,
      audienceSafety,
      ...(result.status === 'winner' ? { winnerAngleId: result.winnerAngleId } : {}),
      evaluatedAt: current.toISOString(),
      ...(Array.isArray(result.comparisons) ? {
        comparisons: result.comparisons.map((comparison) => ({
          left: comparison.left,
          right: comparison.right,
          meanDifference: comparison.meanDifference,
          lowerBound: comparison.lowerBound,
          pValue: comparison.pValue,
          adjustedPValue: comparison.adjustedPValue,
        })),
      } : {}),
    };
    await db.collection(SOCIAL_COPY_EXPERIMENT_EVALUATION_COLLECTION)
      .doc(registration.registrationId).set(evaluation);
    evaluations.push(evaluation);
    const deadlineAt = Date.parse(registration.startsAt)
      + registration.maximumDurationDays * DAY_MS;
    const collectingWithinDeadline = result.status === 'collecting'
      && current.getTime() <= deadlineAt;
    const qualifiedWinner = result.status === 'winner'
      && registration.arms.includes(result.winnerAngleId);
    if (policyClear && calibration.status === 'passed'
      && (collectingWithinDeadline || qualifiedWinner)) {
      registrationMap[registration.registrationId] = registration.registrationHash;
      registrationDeadlines[registration.registrationId] = new Date(deadlineAt).toISOString();
      if (qualifiedWinner) {
        winners[registration.registrationId] = {
          registrationHash: registration.registrationHash,
          angleId: result.winnerAngleId,
          decidedAt: current.toISOString(),
        };
      }
    }
  }

  const config = currentSocialCopyConfig({
    packId: pack.packId,
    registrations: registrationMap,
    registrationDeadlines,
    winners,
  });
  const update = await setRemoteConfig(config);
  if (!update?.ok) throw new Error('Remote Config social-copy reconciliation failed: ' + (update?.detail || 'unknown error'));
  logger({
    status: registrations.length ? 'reconciled' : 'waiting-for-evidence',
    packId: pack.packId,
    candidates: cohortCandidates.length,
    registrations: Object.keys(registrationMap).length,
    winners: Object.keys(winners).length,
    notReady: notReady.length,
    evaluationStatuses: evaluations.map((item) => item.status),
    remoteConfigChanged: Boolean(update.changed),
  });
  return { status: registrations.length ? 'reconciled' : 'waiting-for-evidence', config, update, registrations, notReady, evaluations, calibration };
}

export function buildSocialCopyExperimentConfig({ packId = '', registrations = {}, registrationDeadlines = {}, winners = {} } = {}) {
  return currentSocialCopyConfig({ packId, registrations, registrationDeadlines, winners });
}

export function socialCopyExperimentPostIdHash(channel, postId) {
  return postIdHash(channel, postId);
}
