import { describe, expect, it } from 'vitest';
import { conciergeProposalDisplayStatus, type ApplicationConciergeProposal } from '../services/applicationConciergeService';

const proposal = { status: 'accepted', proposalId: 'proposal_test' } as ApplicationConciergeProposal;
describe('proposal decision and actual application progress', () => {
  it.each([
    ['submitted', 'submitted'], ['candidate_review', 'needs_review'], ['needs_candidate_action', 'needs_answers'],
    ['submitting', 'queued'], ['drafting', 'preparing'], ['regenerating', 'preparing'],
    ['owner_review', 'technical_review'], ['owner_takeover', 'technical_review'], ['withdrawn', 'declined'],
  ])('shows %s as %s', (state, expected) => {
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: state })).toBe(expected);
  });
  it('prefers durable submission evidence and distinguishes sending and scheduled retry', () => {
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: 'candidate_review', childSubmissionStatus: 'submitted' })).toBe('submitted');
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: 'submitting', childSendState: 'sent' })).toBe('submitted');
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: 'submitting', childSendState: 'sending' })).toBe('sending');
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: 'owner_takeover', childRetryScheduled: true })).toBe('retry_scheduled');
    expect(conciergeProposalDisplayStatus({ ...proposal, status: 'declined' })).toBe('declined');
  });
});
