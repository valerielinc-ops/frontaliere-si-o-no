import { describe, expect, it } from 'vitest';
import {
  conciergeProposalDisplayStatus,
  getCandidateVisibleApplicationConciergeProposals,
  type ApplicationConciergeProposal,
} from '../services/applicationConciergeService';

function proposal(proposalId: string, status: string): ApplicationConciergeProposal {
  return {
    proposalId,
    jobId: `job-${proposalId}`,
    jobUrl: `https://jobs.example.test/${proposalId}`,
    companyId: `company-${proposalId}`,
    companyName: 'Example AG',
    jobTitle: 'Application Manager',
    status,
  };
}

describe('candidate-visible application concierge proposals', () => {
  it('hides retracted proposals while keeping the remaining status history', () => {
    const proposals = [
      proposal('proposed', 'proposed'),
      { ...proposal('needs-verification', 'proposed'), eligibilityStatus: 'needs_verification' },
      proposal('accepted', 'accepted'),
      proposal('declined', 'declined'),
      proposal('expired', 'expired'),
      proposal('retracted', 'retracted'),
    ];

    expect(getCandidateVisibleApplicationConciergeProposals(proposals).map(({ status }) => status)).toEqual([
      'proposed',
      'proposed',
      'accepted',
      'declined',
      'expired',
    ]);
    const needsVerification = getCandidateVisibleApplicationConciergeProposals(proposals).find(({ proposalId }) => proposalId === 'needs-verification');
    expect(needsVerification).toBeDefined();
    expect(conciergeProposalDisplayStatus(needsVerification!)).toBe('needs_verification');
  });
});
