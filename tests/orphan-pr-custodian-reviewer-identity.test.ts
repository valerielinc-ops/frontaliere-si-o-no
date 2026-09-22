import { describe, expect, it } from 'vitest';
import { classifyOrphan } from '../scripts/ci/orphan-pr-custodian.mjs';

const HEAD = 'a'.repeat(40);
const NOW_S = Date.parse('2026-09-19T17:40:00Z') / 1000;
const IMPORTANT = '## Findings\nscripts/x.mjs:L1: 🔴 Important: rompe il contratto.';

function pr() {
  return {
    number: 1591,
    draft: false,
    headRef: 'audit-stale-claim-marker',
    headSha: HEAD,
    updatedAt: '2026-09-19T11:09:00Z',
    headCommittedAt: '2026-09-19T11:09:00Z',
    authorType: 'User',
    labels: [],
  };
}

function review(user: Record<string, string>) {
  return {
    id: 10,
    state: 'COMMENTED',
    commit_id: HEAD,
    body: IMPORTANT,
    user,
  };
}

describe('orphan-pr-custodian — reviewer identity', () => {
  it('riconosce il reviewer allowlistato anche con i metadati REST variabili', () => {
    for (const user of [
      { type: 'User', login: 'frontaliere-automation[bot]' },
      { login: 'frontaliere-automation[bot]' },
    ]) {
      const decision = classifyOrphan({
        pr: pr(),
        checkRuns: [],
        reviews: [review(user)],
        comments: [],
        nowS: NOW_S,
      });
      expect(decision.action).toBe('adopt');
    }
  });
});
