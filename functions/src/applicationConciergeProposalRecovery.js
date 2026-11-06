/** Durable, bounded recovery for legacy proposals retracted on uncertain evidence. */

export const LEGACY_UNVERIFIED_RETRACTION_REASON = 'decisive_requirements_unverified';
export const MAX_LEGACY_PROPOSAL_RECOVERIES_PER_RUN = 8;

const RECOVERY_BACKOFF_MS = [60 * 60_000, 3 * 60 * 60_000, 12 * 60 * 60_000, 3 * 24 * 60 * 60_000];
const DEFERRED_REASONS = new Set(['analysis_deferred', 'retry_backoff']);

export function isLegacyUnverifiedRetraction(proposal = {}) {
  return proposal.status === 'retracted'
    && proposal.eligibilityStatus === 'unverified'
    && proposal.retractionReason === LEGACY_UNVERIFIED_RETRACTION_REASON
    && !proposal.childApplicationId
    && !proposal.acceptedAt
    && !proposal.withdrawnAt
    && !['terminal', 'recovered'].includes(proposal.legacyRecoveryStatus);
}

/** Rotate through durable proposal rows so a repeatedly failing prefix cannot starve later rows. */
export function selectLegacyProposalRecovery(proposals, {
  cursor = '',
  context = '',
  nowMs = Date.now(),
  limit = MAX_LEGACY_PROPOSAL_RECOVERIES_PER_RUN,
} = {}) {
  const queued = proposals
    .filter(({ data }) => isLegacyUnverifiedRetraction(data))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const due = queued.filter(({ data }) => {
    if (data.legacyRecoveryContext !== context) return true;
    const retryAt = Number(data.legacyRecoveryNextAt) || 0;
    return retryAt <= nowMs;
  });
  const cursorIndex = due.findIndex(({ id }) => id === cursor);
  const rotated = cursorIndex < 0
    ? due
    : [...due.slice(cursorIndex + 1), ...due.slice(0, cursorIndex + 1)];
  const selected = rotated.slice(0, Math.max(0, Math.floor(limit)));
  return {
    queued,
    selected,
    nextCursor: selected.at(-1)?.id || cursor,
  };
}

export function legacyProposalRecoveryRetryFields(previous = {}, { context = '', nowMs = Date.now(), reason = '' } = {}) {
  const sameContext = previous.legacyRecoveryContext === context;
  const attempts = sameContext ? Number(previous.legacyRecoveryAttempts) || 0 : 0;
  const nextAttempts = DEFERRED_REASONS.has(reason) ? attempts : attempts + 1;
  const delay = DEFERRED_REASONS.has(reason)
    ? RECOVERY_BACKOFF_MS[0]
    : RECOVERY_BACKOFF_MS[Math.min(nextAttempts - 1, RECOVERY_BACKOFF_MS.length - 1)];
  return {
    legacyRecoveryStatus: 'pending',
    legacyRecoveryContext: context,
    legacyRecoveryAttempts: nextAttempts,
    legacyRecoveryLastAttemptAt: nowMs,
    legacyRecoveryNextAt: nowMs + delay,
    legacyRecoveryLastReason: String(reason || 'eligibility_unverified').slice(0, 80),
  };
}

export function legacyProposalRecoveryTerminalFields({ context = '', nowMs = Date.now(), reason = '' } = {}) {
  return {
    legacyRecoveryStatus: 'terminal',
    legacyRecoveryContext: context,
    legacyRecoveryResolvedAt: nowMs,
    legacyRecoveryNextAt: null,
    legacyRecoveryLastReason: String(reason || 'not_recoverable').slice(0, 80),
  };
}

/** Summarize persisted queue rows plus this run's transactional outcomes for lifecycle scheduling. */
export function summarizeLegacyProposalRecovery(proposals, outcomes = new Map(), {
  context = '',
  nowMs = Date.now(),
  retryFloorMs = 60 * 60_000,
} = {}) {
  const pending = [];
  for (const row of proposals) {
    const outcome = outcomes.get(row.id) || {};
    const data = { ...row.data, ...outcome };
    if (isLegacyUnverifiedRetraction(data)) pending.push(data);
  }
  if (!pending.length) return { count: 0, retryAt: null };

  const nextTimes = pending.map(data => {
    const retryAt = Number(data.legacyRecoveryNextAt) || 0;
    if (data.legacyRecoveryContext !== context || retryAt <= nowMs) return nowMs + retryFloorMs;
    return retryAt;
  });
  return { count: pending.length, retryAt: Math.min(...nextTimes) };
}
