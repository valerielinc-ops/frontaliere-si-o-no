import { describe, expect, it } from 'vitest';
import {
  conciergeProposalDisplayCategory,
  conciergeProposalDisplayStatus,
  getCandidateVisibleApplicationConciergeProposals,
  getCandidateVisibleConciergeClarificationTasks,
  groupApplicationConciergeProposals,
  type ApplicationConciergeProposal,
} from '../services/applicationConciergeService';

const proposal = { status: 'accepted', proposalId: 'proposal_test' } as ApplicationConciergeProposal;
describe('proposal decision and actual application progress', () => {
  it.each([
    ['submitted', 'submitted'], ['candidate_review', 'needs_review'], ['needs_candidate_action', 'needs_answers'],
    ['submitting', 'queued'], ['drafting', 'preparing'], ['regenerating', 'preparing'],
    ['owner_review', 'technical_review'], ['owner_takeover', 'technical_review'], ['withdrawn', 'withdrawn'],
    ['failed', 'failed'], ['future_state', 'unknown'],
  ])('shows %s as %s', (state, expected) => {
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationState: state })).toBe(expected);
  });
  it('distinguishes an unsent persisted withdrawal from a declined proposal', () => {
    expect(conciergeProposalDisplayStatus({ ...proposal, status: 'declined', withdrawnAt: new Date().toISOString() })).toBe('withdrawn');
    expect(conciergeProposalDisplayStatus({ ...proposal, status: 'declined' })).toBe('declined');
  });
  it('shows a stale row as under verification, not as an acceptable proposal', () => {
    const stale = { ...proposal, status: 'proposed', eligibilityStatus: 'needs_verification' } as ApplicationConciergeProposal;
    expect(conciergeProposalDisplayStatus(stale)).toBe('needs_verification');
    expect(conciergeProposalDisplayCategory(stale)).toBe('needs_verification');
  });
  it('shows a required answer as a clarification step, separate from verified proposals', () => {
    const needsClarification = { ...proposal, status: 'proposed', eligibilityStatus: 'clarification_required' } as ApplicationConciergeProposal;
    expect(conciergeProposalDisplayStatus(needsClarification)).toBe('needs_clarification');
    expect(conciergeProposalDisplayCategory(needsClarification)).toBe('needs_clarification');
    expect(conciergeProposalDisplayStatus({ ...needsClarification, status: 'preproposal_check' })).toBe('needs_clarification');
  });
  it('fails closed when a proposed row has no current eligibility result', () => {
    const unverified = { ...proposal, status: 'proposed', eligibilityStatus: 'unverified' } as ApplicationConciergeProposal;
    expect(conciergeProposalDisplayStatus(unverified)).toBe('needs_verification');
    expect(conciergeProposalDisplayCategory(unverified)).toBe('needs_verification');
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
  it('keeps an accepted proposal with a child application but no known state unconfirmed', () => {
    expect(conciergeProposalDisplayStatus({ ...proposal, childApplicationId: 'child-test' })).toBe('unknown');
    expect(conciergeProposalDisplayStatus({ ...proposal, status: 'future_decision' })).toBe('unknown');
  });
  it('shows a confirmed submission before a conflicting failure state', () => {
    expect(conciergeProposalDisplayStatus({
      ...proposal,
      childApplicationId: 'child-test',
      childApplicationState: 'failed',
      childSubmissionStatus: 'submitted',
    })).toBe('submitted');
    expect(conciergeProposalDisplayCategory({
      ...proposal,
      childApplicationId: 'child-test',
      childApplicationState: 'failed',
      childSubmissionStatus: 'submitted',
    })).toBe('submitted');
  });
  it('shows an explicit failed submission as failed rather than accepted or unknown', () => {
    expect(conciergeProposalDisplayStatus({
      ...proposal,
      childApplicationId: 'child-test',
      childSubmissionStatus: 'failed',
    })).toBe('failed');
  });
  it('keeps preliminary checks outside proposal groups without losing decision history', () => {
    const proposals = [
      { ...proposal, proposalId: 'proposed', status: 'proposed', eligibilityStatus: 'compatible' },
      { ...proposal, proposalId: 'needs-clarification', status: 'proposed', eligibilityStatus: 'clarification_required',
        clarificationQuestions: [{ id: 'detail', question: 'Please confirm this detail.', required: true }] },
      { ...proposal, proposalId: 'needs-verification', status: 'proposed', eligibilityStatus: 'needs_verification' },
      { ...proposal, proposalId: 'needs-information', childApplicationId: 'child-1', childApplicationState: 'candidate_review' },
      { ...proposal, proposalId: 'accepted', childApplicationId: null },
      { ...proposal, proposalId: 'queued', childApplicationId: 'child-2', childApplicationState: 'submitting' },
      { ...proposal, proposalId: 'submitted', childApplicationId: 'child-3', childSubmissionStatus: 'submitted' },
      { ...proposal, proposalId: 'failed', childApplicationId: 'child-4', childApplicationState: 'failed' },
      { ...proposal, proposalId: 'unknown', childApplicationId: 'child-5', childApplicationState: 'future_state' },
      { ...proposal, proposalId: 'declined', status: 'declined' },
      { ...proposal, proposalId: 'retracted', status: 'retracted' },
    ] as ApplicationConciergeProposal[];

    expect(groupApplicationConciergeProposals(proposals).map(({ category }) => category)).toEqual([
      'needs_information',
      'proposed',
      'accepted',
      'queued',
      'submitted',
      'failed',
      'unknown',
      'declined',
      'retracted',
    ]);
    const visibleProposalIds = getCandidateVisibleApplicationConciergeProposals(proposals).map(({ proposalId }) => proposalId);
    expect(visibleProposalIds).not.toContain('needs-clarification');
    expect(visibleProposalIds).not.toContain('needs-verification');
    expect(getCandidateVisibleConciergeClarificationTasks(proposals).map(({ proposalId }) => proposalId))
      .toEqual(['needs-clarification']);
    expect(conciergeProposalDisplayCategory(proposals.find(({ proposalId }) => proposalId === 'submitted')!)).toBe('submitted');
  });
});
