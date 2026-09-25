import { describe, expect, it } from 'vitest';
import { classifyOrphan, headReview } from '../scripts/ci/orphan-pr-custodian.mjs';
import { isTerminalReviewState } from '../scripts/ci/lib/pr-review-admission.mjs';

// Issue #9791: il custode filtrava `review.state` per ESCLUSIONE (solo
// PENDING e DISMISSED fuori), quindi uno stato vuoto o sconosciuto contava
// come review gestita. Qui ogni stato che non e' un verdetto inviato e non
// ritirato deve restare fuori: allowlist fail-closed.

const HEAD = 'a'.repeat(40);
const NOW_S = Date.parse('2026-09-19T17:40:00Z') / 1000;
const IMPORTANT = '## Findings\nscripts/x.mjs:L1: 🔴 Important: rompe il contratto.';

const VALID_STATES = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'];
const INVALID_STATES: unknown[] = ['PENDING', 'DISMISSED', '', '   ', undefined, null, 'SUPERSEDED', 'REVIEW_WITHDRAWN', 42];

function review(state: unknown, body = IMPORTANT) {
  return {
    id: 10,
    state,
    commit_id: HEAD,
    body,
    user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
  };
}

function pr() {
  return {
    number: 1591,
    draft: false,
    headRef: 'audit-stale-claim-marker',
    headSha: HEAD,
    updatedAt: '2026-09-19T11:09:00Z',
    headCommittedAt: '2026-09-19T11:09:00Z',
    authorType: 'User',
    labels: [] as string[],
  };
}

describe('orphan-pr-custodian — stati della review in allowlist (#9791)', () => {
  it.each(VALID_STATES)('%s e\' un verdetto gestito sulla HEAD', (state) => {
    expect(headReview([review(state)], HEAD)?.id).toBe(10);
  });

  it.each(INVALID_STATES.map((state) => [JSON.stringify(state) ?? String(state), state]))(
    'stato %s non e\' una review gestita (fail-closed)',
    (_label, state) => {
      expect(headReview([review(state)], HEAD)).toBeNull();
    },
  );

  it('uno stato sconosciuto piu\' recente non sostituisce il verdetto valido precedente', () => {
    const valid = { ...review('COMMENTED', '## LGTM'), id: 10 };
    const unknown = { ...review('SUPERSEDED'), id: 11 };
    expect(headReview([valid, unknown], HEAD)?.id).toBe(10);
  });

  it('una PR la cui sola review ha uno stato sconosciuto non viene adottata', () => {
    const base = { pr: pr(), checkRuns: [], comments: [], nowS: NOW_S };
    expect(classifyOrphan({ ...base, reviews: [review('COMMENTED')] }).action).toBe('adopt');
    const decision = classifyOrphan({ ...base, reviews: [review('SUPERSEDED')] });
    expect(decision.action).not.toBe('adopt');
  });
});

describe('pr-review-admission — isTerminalReviewState', () => {
  it.each(VALID_STATES)('%s e\' terminale', (state) => {
    expect(isTerminalReviewState(state)).toBe(true);
    expect(isTerminalReviewState(` ${state.toLowerCase()} `)).toBe(true);
  });

  it.each(INVALID_STATES.map((state) => [JSON.stringify(state) ?? String(state), state]))(
    'stato %s non e\' terminale',
    (_label, state) => {
      expect(isTerminalReviewState(state)).toBe(false);
    },
  );
});
