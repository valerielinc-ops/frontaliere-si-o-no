const CANDIDATE_ACTION_STATES = new Set([
  'candidate_review',
  'needs_candidate_action',
  'candidate_handoff',
]);

export function candidateStatusForAssistedApplication(order) {
  const submissionStatus = typeof order?.submissionStatus === 'string' ? order.submissionStatus.trim().slice(0, 80) : '';
  const automationState = typeof order?.automationState === 'string' ? order.automationState.trim().slice(0, 80) : '';

  if (order?.paymentStatus === 'refunded' || submissionStatus === 'refunded') return 'refunded';
  if (submissionStatus === 'submitted' || automationState === 'submitted') return 'submitted';
  if (submissionStatus === 'withdrawn' || automationState === 'withdrawn') return 'withdrawn';
  if (CANDIDATE_ACTION_STATES.has(automationState)) return 'needs_candidate';
  if (submissionStatus === 'blocked' || ['failed', 'owner_takeover'].includes(automationState)) return 'under_review';
  const cvStorageKey = typeof order?.cvStorageKey === 'string' ? order.cvStorageKey.trim().slice(0, 300) : '';
  if (submissionStatus === 'awaiting_upload' && !cvStorageKey) return 'awaiting_materials';
  return 'in_progress';
}
