import { describe, expect, it } from 'vitest';
import { conciergeProposalDisplayStatus, type ApplicationConciergeProposal } from '../services/applicationConciergeService';

const proposal = { status: 'accepted', proposalId: 'proposal_test' } as ApplicationConciergeProposal;
describe('proposal decision and actual application progress', () => {
  it.each([
    ['submitted', 'submitted'], ['candidate_review', 'needs_review'], ['needs_candidate_action', 'needs_answers'],
    ['submitting', 'queued'], ['drafting', 'preparing'], ['regenerating', 'preparing'],
    ['owner_review', 'technical_review'], ['owner_takeover', 'technical_review'], ['withdrawn', 'withdrawn'],
  ])('shows %s as %s', (state, expected) => {
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: state })).toBe(expected);
  });
  it('distinguishes an unsent persisted withdrawal from a declined proposal', () => {
    expect(conciergeProposalDisplayStatus({ ...proposal, status: 'declined', withdrawnAt: new Date().toISOString() })).toBe('withdrawn');
    expect(conciergeProposalDisplayStatus({ ...proposal, status: 'declined' })).toBe('declined');
  });
  it('shows a stale proposed match as needing re-verification while leaving it a proposal', () => {
    expect(conciergeProposalDisplayStatus({ ...proposal, status: 'proposed', eligibilityStatus: 'needs_verification' })).toBe('needs_verification');
  });
  it('keeps confirmed sending and employer replies visible when withdrawal evidence conflicts', () => {
    const withdrawn = { ...proposal, status: 'declined', childApplicationId: 'child-test', withdrawnAt: new Date().toISOString(), childApplicationState: 'withdrawn' };
    expect(conciergeProposalDisplayStatus({ ...withdrawn, childSendState: 'sent' })).toBe('submitted');
    expect(conciergeProposalDisplayStatus({ ...withdrawn, childSubmissionStatus: 'submitted' })).toBe('submitted');
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: 'withdrawn', childSubmissionStatus: 'submitted' })).toBe('submitted');
    expect(conciergeProposalDisplayStatus({ ...withdrawn, childEmployerResponse: { category: 'interview_invite', receivedAt: Date.now(), needsReply: true } })).toBe('employer_interview_invite');
    expect(conciergeProposalDisplayStatus({ ...withdrawn, childApplicationId: null, childSendState: 'sent' })).toBe('submitted');
    expect(conciergeProposalDisplayStatus({ ...withdrawn, childApplicationId: null, childEmployerResponse: { category: 'interview_invite', receivedAt: Date.now(), needsReply: true } })).toBe('employer_interview_invite');
    expect(conciergeProposalDisplayStatus({ ...proposal, status: 'declined', childEmployerResponse: { category: 'interview_invite', receivedAt: Date.now(), needsReply: true } })).toBe('declined');
  });
  it('prefers durable submission evidence and distinguishes sending and scheduled retry', () => {
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: 'candidate_review', childSubmissionStatus: 'submitted' })).toBe('submitted');
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: 'submitting', childSendState: 'sent' })).toBe('submitted');
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: 'submitting', childSendState: 'sending' })).toBe('sending');
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: 'owner_takeover', childRetryScheduled: true })).toBe('retry_scheduled');
    expect(conciergeProposalDisplayStatus({ ...proposal, status: 'declined' })).toBe('declined');
  });
});
