/** Private retry metadata shares the qualification cache's 90-day retention. */
import { createHash } from 'node:crypto';

const DELAYS = [60 * 60_000, 3 * 60 * 60_000, 12 * 60 * 60_000, 3 * 86400_000];
const DEFERRED_RETRY_DELAY_MS = 15 * 60_000;
const FAILURE_CAUSES = new Set(['not_configured', 'rate_limited', 'timeout', 'auth', 'network', 'provider_http', 'provider_error']);
const RETRY_STATUSES = new Set(['compatible', 'incompatible', 'clarification_required', 'unverified']);
const RETRY_REASONS = new Set([
  'analysis_deferred', 'analysis_unavailable', 'answer_source_conflict', 'current_education_unverified',
  'eligibility_metadata_incomplete', 'evidence_entailment_unverified', 'evidence_incomplete', 'evidence_source_changed',
  'hard_requirement_uncovered', 'incompatibility_not_proven', 'job_language_evidence_unverified',
  'language_clause_unverified', 'language_evidence_conflict', 'language_requirement_uncovered', 'match_below_threshold',
  'match_response_incomplete', 'posting_incomplete', 'posting_unavailable', 'profile_incomplete', 'profile_not_ready',
  'profile_unavailable', 'provider_invalid_json', 'provider_unavailable', 'requirements_incomplete',
  'requirements_missing', 'requirements_over_limit', 'requirements_response_invalid', 'retry_backoff',
]);
const TERMINAL_STATUSES = new Set(['compatible', 'incompatible', 'clarification_required']);
export const MAX_ELIGIBILITY_RETRIES_PER_RUN = 8;
export const MAX_ELIGIBILITY_RETRY_ATTEMPTS = DELAYS.length + 1;
export const MAX_ELIGIBILITY_DEFERRALS = 8;
export const MAX_ELIGIBILITY_RETRY_ROWS = 500;

function allowlisted(value, values) {
  return typeof value === 'string' && values.has(value) ? value : 'unknown';
}

function safeProviderFailures(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(failure => {
    const provider = String(failure?.provider || '').trim().slice(0, 64);
    const cause = String(failure?.cause || 'provider_error');
    const status = Number.isInteger(failure?.status) && failure.status >= 400 && failure.status <= 599 ? failure.status : null;
    return provider && FAILURE_CAUSES.has(cause) ? { provider, cause, status } : null;
  }).filter(Boolean);
}

function safeFingerprint(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

export function eligibilityRetryRef(serviceRef, url) {
  return serviceRef.collection('eligibility').doc(`retry-${createHash('sha256').update(url).digest('hex').slice(0, 32)}`);
}

/** Reads a fixed-size window of active and exhausted retries; raw CV or posting caches are never scanned. */
export async function eligibilityRetryRows(serviceRef) {
  const eligibility = serviceRef.collection('eligibility');
  const [active, exhausted] = await Promise.all([
    eligibility.where('retryAt', '>', 0).orderBy('retryAt').limit(MAX_ELIGIBILITY_RETRY_ROWS).get(),
    eligibility.where('retryState', '==', 'exhausted').limit(MAX_ELIGIBILITY_RETRY_ROWS).get(),
  ]);
  const rows = new Map();
  for (const doc of [...(active.docs || []), ...(exhausted.docs || [])]) rows.set(doc.id, doc);
  return [...rows.values()];
}

export async function dueEligibilityRetries(serviceRef, nowMs) {
  const result = await serviceRef.collection('eligibility').where('retryAt', '>', 0).where('retryAt', '<=', nowMs).orderBy('retryAt')
    .limit(MAX_ELIGIBILITY_RETRIES_PER_RUN).get();
  return result.docs;
}

export async function recordEligibilityRetry({ db, serviceRef, url, result, context, jobContext = context, nowMs }) {
  const ref = eligibilityRetryRef(serviceRef, url);
  const status = allowlisted(result?.status, RETRY_STATUSES);
  const reason = allowlisted(result?.reason, RETRY_REASONS);
  const lastAttemptAt = Number.isFinite(nowMs) ? nowMs : Date.now();
  const fingerprint = safeFingerprint(result?.fingerprint);
  await db.runTransaction(async transaction => {
    const previousSnapshot = await transaction.get(ref);
    const previous = previousSnapshot.data();
    const sameJobContext = previous?.jobContext === jobContext;
    const sameContext = previous?.context === context && sameJobContext;
    const providerFailures = safeProviderFailures(result?.providerFailures);
    const retainedProviderFailures = providerFailures.length
      ? providerFailures
      : sameContext ? safeProviderFailures(previous?.providerFailures) : [];
    const retainedFingerprint = fingerprint || (sameContext ? safeFingerprint(previous?.fingerprint) : null);

    if (TERMINAL_STATUSES.has(status)) {
      if (!previous) return;
      const firstAttemptAt = sameJobContext ? Number(previous.firstAttemptAt) || 0 : 0;
      if (firstAttemptAt > 0) {
        const recoveryDurationMs = Math.max(0, lastAttemptAt - firstAttemptAt);
        const serviceSnapshot = await transaction.get(serviceRef);
        const service = serviceSnapshot.data() || {};
        const count = Math.max(0, Math.floor(Number(service.matchingEligibilityRecoveryCount) || 0));
        const durationTotal = Math.max(0, Number(service.matchingEligibilityRecoveryDurationMsTotal) || 0);
        transaction.set(serviceRef, {
          matchingEligibilityRecoveryCount: count + 1,
          matchingEligibilityRecoveryDurationMsTotal: durationTotal + recoveryDurationMs,
          matchingEligibilityLastRecoveryMs: recoveryDurationMs,
          matchingEligibilityLastRecoveryStatus: status,
          matchingEligibilityLastRecoveryAt: new Date(lastAttemptAt),
        }, { merge: true });
      }
      transaction.delete(ref);
      return;
    }

    // A duplicate worker delivery cannot revive an exhausted row with the same
    // source context. New candidate/job inputs produce a different context and
    // start a fresh, bounded recovery episode.
    if (sameContext && previous?.retryState === 'exhausted') return;

    if (reason === 'retry_backoff') return;
    if (reason === 'analysis_deferred') {
      const deferrals = sameContext ? Math.max(0, Number(previous?.deferrals) || 0) + 1 : 1;
      const attempts = sameContext ? Math.max(0, Number(previous?.attempts) || 0) : 0;
      const exhausted = deferrals >= MAX_ELIGIBILITY_DEFERRALS;
      const firstAttemptAt = sameContext && Number(previous?.firstAttemptAt) > 0
        ? Number(previous.firstAttemptAt)
        : lastAttemptAt;
      const deferredDelay = Math.min(DEFERRED_RETRY_DELAY_MS * (2 ** (deferrals - 1)), 3 * 86400_000);
      transaction.set(ref, {
        jobUrl: previous?.jobUrl || url,
        context,
        jobContext,
        attempts,
        deferrals,
        retryAt: exhausted ? 0 : lastAttemptAt + deferredDelay,
        retryState: exhausted ? 'exhausted' : 'deferred',
        lastStatus: sameContext ? previous.lastStatus || status : 'unverified',
        lastReason: sameContext ? previous.lastReason || reason : reason,
        ...(sameContext && Number(previous.lastAttemptAt) > 0 ? { lastAttemptAt: Number(previous.lastAttemptAt) } : {}),
        lastDeferredAt: lastAttemptAt,
        firstAttemptAt,
        retryExhaustedAt: exhausted ? lastAttemptAt : null,
        ...(retainedFingerprint ? { fingerprint: retainedFingerprint } : {}),
        ...(retainedProviderFailures.length ? { providerFailures: retainedProviderFailures } : {}),
      });
      return;
    }

    const attempts = sameContext ? (Number(previous?.attempts) || 0) + 1 : 1;
    const exhausted = attempts >= MAX_ELIGIBILITY_RETRY_ATTEMPTS;
    const firstAttemptAt = sameContext && Number(previous?.firstAttemptAt) > 0
      ? Number(previous.firstAttemptAt)
      : lastAttemptAt;
    transaction.set(ref, {
      jobUrl: url,
      context,
      jobContext,
      attempts,
      deferrals: 0,
      retryAt: exhausted ? 0 : lastAttemptAt + DELAYS[Math.min(attempts - 1, DELAYS.length - 1)],
      retryState: exhausted ? 'exhausted' : 'scheduled',
      firstAttemptAt,
      lastStatus: status,
      lastReason: reason,
      lastAttemptAt,
      lastDeferredAt: null,
      retryExhaustedAt: exhausted ? lastAttemptAt : null,
      ...(retainedFingerprint ? { fingerprint: retainedFingerprint } : {}),
      ...(retainedProviderFailures.length ? { providerFailures: retainedProviderFailures } : {}),
    });
  });
}

export async function eligibilityRetrySummary(serviceRef) {
  const eligibility = serviceRef.collection('eligibility');
  const active = eligibility.where('retryAt', '>', 0);
  const exhausted = eligibility.where('retryState', '==', 'exhausted');
  const count = async query => Number((await query.count().get()).data().count) || 0;
  const statuses = [...RETRY_STATUSES];
  const reasons = [...RETRY_REASONS];
  // Single-field equality counts avoid composite indexes and never read cached CV/posting payloads.
  const [retryCount, exhaustedCount, first, statusValues, reasonValues, serviceSnapshot] = await Promise.all([
    count(active),
    count(exhausted),
    active.orderBy('retryAt').limit(1).get(),
    Promise.all(statuses.map(async status => [status, await count(eligibility.where('lastStatus', '==', status))])),
    Promise.all(reasons.map(async reason => [reason, await count(eligibility.where('lastReason', '==', reason))])),
    serviceRef.get(),
  ]);
  const statusCounts = {};
  const reasonCounts = {};
  for (const [status, total] of statusValues) if (total) statusCounts[status] = total;
  for (const [reason, total] of reasonValues) if (total) reasonCounts[reason] = total;
  const totalCount = retryCount + exhaustedCount;
  const knownStatuses = Object.values(statusCounts).reduce((total, countForStatus) => total + countForStatus, 0);
  const knownReasons = Object.values(reasonCounts).reduce((total, countForReason) => total + countForReason, 0);
  const unknownStatuses = Math.max(0, totalCount - knownStatuses);
  const unknownReasons = Math.max(0, totalCount - knownReasons);
  if (unknownStatuses) statusCounts.unknown = unknownStatuses;
  if (unknownReasons) reasonCounts.unknown = unknownReasons;
  const retryAt = first.docs[0]?.data()?.retryAt || null;
  const service = serviceSnapshot.data() || {};
  const recoveryCount = Math.max(0, Math.floor(Number(service.matchingEligibilityRecoveryCount) || 0));
  const recoveryDurationMsTotal = Math.max(0, Number(service.matchingEligibilityRecoveryDurationMsTotal) || 0);
  return {
    count: totalCount,
    retryCount,
    exhaustedCount,
    retryAt,
    statusCounts,
    reasonCounts,
    recovery: {
      count: recoveryCount,
      averageDurationMs: recoveryCount ? Math.round(recoveryDurationMsTotal / recoveryCount) : null,
      lastDurationMs: Number.isFinite(Number(service.matchingEligibilityLastRecoveryMs)) ? Number(service.matchingEligibilityLastRecoveryMs) : null,
      lastStatus: service.matchingEligibilityLastRecoveryStatus || null,
      lastAt: service.matchingEligibilityLastRecoveryAt || null,
    },
  };
}
