import { describe, expect, it } from 'vitest';
import {
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
      proposal('accepted', 'accepted'),
      proposal('declined', 'declined'),
      proposal('expired', 'expired'),
      proposal('retracted', 'retracted'),
    ];

    expect(getCandidateVisibleApplicationConciergeProposals(proposals).map(({ status }) => status)).toEqual([
      'proposed',
      'accepted',
      'declined',
      'expired',
    ]);
  });
});
