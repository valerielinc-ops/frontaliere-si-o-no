/** Private retry metadata shares the qualification cache's 90-day retention. */
import { createHash } from 'node:crypto';

const DELAYS = [60 * 60_000, 3 * 60 * 60_000, 12 * 60 * 60_000, 3 * 86400_000];
const FAILURE_CAUSES = new Set(['not_configured', 'rate_limited', 'timeout', 'auth', 'network', 'provider_http', 'provider_error']);
const RETRY_STATUSES = new Set(['compatible', 'incompatible', 'clarification_required', 'unverified']);
const RETRY_REASONS = new Set([
  'analysis_deferred', 'analysis_unavailable', 'answer_source_conflict', 'current_education_unverified',
  'evidence_entailment_unverified', 'evidence_incomplete', 'evidence_source_changed', 'incompatibility_not_proven',
  'job_language_evidence_unverified', 'language_clause_unverified', 'language_evidence_conflict', 'match_below_threshold',
  'posting_incomplete', 'posting_unavailable', 'profile_not_ready', 'profile_unavailable', 'requirements_incomplete', 'retry_backoff',
]);
const TERMINAL_STATUSES = new Set(['compatible', 'incompatible', 'clarification_required']);
const NON_RETRYING_REASONS = new Set(['analysis_deferred', 'retry_backoff']);
export const MAX_ELIGIBILITY_RETRIES_PER_RUN = 8;

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

export function eligibilityRetryRef(serviceRef, url) {
  return serviceRef.collection('eligibility').doc(`retry-${createHash('sha256').update(url).digest('hex').slice(0, 32)}`);
}

export async function dueEligibilityRetries(serviceRef, nowMs) {
  const result = await serviceRef.collection('eligibility').where('retryAt', '<=', nowMs).orderBy('retryAt')
    .limit(MAX_ELIGIBILITY_RETRIES_PER_RUN).get();
  return result.docs;
}

export async function recordEligibilityRetry({ db, serviceRef, url, result, context, nowMs }) {
  const ref = eligibilityRetryRef(serviceRef, url);
  const status = allowlisted(result?.status, RETRY_STATUSES);
  const reason = allowlisted(result?.reason, RETRY_REASONS);
  const lastAttemptAt = Number.isFinite(nowMs) ? nowMs : Date.now();
  await db.runTransaction(async transaction => {
    const previous = (await transaction.get(ref)).data();
    const providerFailures = safeProviderFailures(result?.providerFailures);
    const retainedProviderFailures = providerFailures.length ? providerFailures : safeProviderFailures(previous?.providerFailures);
    if (TERMINAL_STATUSES.has(status)) {
      if (previous) transaction.delete(ref);
      return;
    }

    if (NON_RETRYING_REASONS.has(reason)) {
      // First-time deferred work stays at the scan frontier; don't create a queue row that could reorder discovery.
      if (!previous) return;
      transaction.set(ref, {
        jobUrl: previous.jobUrl || url,
        context: previous.context ?? context,
        attempts: Number(previous.attempts) || 0,
        retryAt: Number(previous.retryAt) || lastAttemptAt,
        lastStatus: status,
        lastReason: reason,
        lastAttemptAt,
        ...(retainedProviderFailures.length ? { providerFailures: retainedProviderFailures } : {}),
      });
      return;
    }

    const attempts = previous?.context === context ? (Number(previous.attempts) || 0) + 1 : 1;
    transaction.set(ref, { jobUrl: url, context, attempts,
      retryAt: lastAttemptAt + DELAYS[Math.min(attempts - 1, DELAYS.length - 1)],
      lastStatus: status,
      lastReason: reason,
      lastAttemptAt,
      ...(retainedProviderFailures.length ? { providerFailures: retainedProviderFailures } : {}),
    });
  });
}

export async function eligibilityRetrySummary(serviceRef) {
  const eligibility = serviceRef.collection('eligibility');
  const pending = eligibility.where('retryAt', '>', 0);
  const count = async query => Number((await query.count().get()).data().count) || 0;
  const statuses = [...RETRY_STATUSES];
  const reasons = [...RETRY_REASONS];
  // Only retry rows have these fields; single-field equality counts avoid full reads and composite indexes.
  const [pendingCount, first, statusValues, reasonValues] = await Promise.all([
    count(pending),
    pending.orderBy('retryAt').limit(1).get(),
    Promise.all(statuses.map(async status => [status, await count(eligibility.where('lastStatus', '==', status))])),
    Promise.all(reasons.map(async reason => [reason, await count(eligibility.where('lastReason', '==', reason))])),
  ]);
  const statusCounts = {};
  const reasonCounts = {};
  for (const [status, total] of statusValues) if (total) statusCounts[status] = total;
  for (const [reason, total] of reasonValues) if (total) reasonCounts[reason] = total;
  const knownStatuses = Object.values(statusCounts).reduce((total, countForStatus) => total + countForStatus, 0);
  const knownReasons = Object.values(reasonCounts).reduce((total, countForReason) => total + countForReason, 0);
  const unknownStatuses = Math.max(0, pendingCount - knownStatuses);
  const unknownReasons = Math.max(0, pendingCount - knownReasons);
  if (unknownStatuses) statusCounts.unknown = unknownStatuses;
  if (unknownReasons) reasonCounts.unknown = unknownReasons;
  const retryAt = first.docs[0]?.data()?.retryAt || null;
  return {
    count: pendingCount,
    retryAt,
    statusCounts,
    reasonCounts,
  };
}
