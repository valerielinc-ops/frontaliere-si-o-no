import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  claimStatusFromOutcome,
  latestPrFixClaims,
  parsePrFixClaim,
  prFixClaimDecision,
  prFixClaimDedupeKey,
  prFixClaimKey,
} from '../scripts/ci/pr-fixer-claim.mjs';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

function claim(overrides: Record<string, unknown> = {}) {
  const context = {
    workflow: 'redflag',
    prNumber: '8362',
    headSha: HEAD,
    eventKey: 'review:42',
    verdictKey: 'findings:' + 'c'.repeat(64),
  };
  const key = prFixClaimKey(context);
  const dedupeKey = prFixClaimDedupeKey(context);
  return {
    version: 1,
    token: 'claim-token',
    ...context,
    key,
    dedupeKey,
    state: 'active',
    issuedAt: 100,
    expiresAt: 3_700,
    runId: '77',
    ...overrides,
  };
}

function comment(event: Record<string, unknown>, id = 1) {
  return {
    id,
    created_at: '1970-01-01T00:02:00Z',
    user: { login: 'github-actions[bot]' },
    body: `<!-- PR_FIX_CLAIM: ${JSON.stringify(event)} -->`,
  };
}

describe('persisted PR fixer claims (#8362, #8363)', () => {
  it('keys the exact PR + HEAD + event/verdict, while deduping retries of one verdict', () => {
    const base = {
      workflow: 'redflag',
      prNumber: '8362',
      headSha: HEAD,
      verdictKey: 'findings:' + 'c'.repeat(64),
    };
    const first = prFixClaimKey({ ...base, eventKey: 'review:42' });
    const retry = prFixClaimKey({ ...base, eventKey: 'review:43' });
    const otherHead = prFixClaimKey({ ...base, headSha: NEXT_HEAD, eventKey: 'review:42' });

    expect(first).not.toBe('');
    expect(retry).not.toBe(first);
    expect(prFixClaimDedupeKey({ ...base, eventKey: 'review:42' }))
      .toBe(prFixClaimDedupeKey({ ...base, eventKey: 'review:43' }));
    expect(otherHead).not.toBe(first);
    expect(prFixClaimKey({ ...base, verdictKey: '' })).toBe('');
  });

  it('rejects a forged or malformed persisted marker', () => {
    expect(parsePrFixClaim('<!-- PR_FIX_CLAIM: {"version":1} -->')).toBeNull();
    expect(parsePrFixClaim('ordinary PR comment')).toBeNull();
    expect(parsePrFixClaim(`<!-- PR_FIX_CLAIM: ${JSON.stringify(claim())} -->`))
      .toMatchObject({ workflow: 'redflag', prNumber: '8362', headSha: HEAD });
  });

  it('blocks active duplicates, skips terminal duplicates, and re-arms only transient retries', () => {
    const active = claim();
    const key = String(active.key);
    const dedupeKey = String(active.dedupeKey);

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [active],
      nowSec: 200,
      activeRunStates: { '77': { status: 'in_progress', conclusion: null } },
    })).toMatchObject({ allowed: false, reason: 'same-pr-head-claim-active' });

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [claim({ state: 'completed' })],
      nowSec: 200,
    })).toMatchObject({ allowed: false, reason: 'same-pr-head-terminal-claim' });

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [claim({ state: 'failed-transient' })],
      nowSec: 200,
    })).toMatchObject({ allowed: true, reason: 'same-pr-head-claim-retryable' });

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [active],
      nowSec: 200,
      activeRunStates: { '77': { status: 'completed', conclusion: 'cancelled' } },
    })).toMatchObject({ allowed: true, reason: 'same-pr-head-claim-retryable' });

    expect(prFixClaimDecision({
      key,
      dedupeKey,
      claims: [active],
      nowSec: 200,
      activeRunStates: { '77': { status: 'completed', conclusion: 'success' } },
    })).toMatchObject({ allowed: false, reason: 'same-pr-head-claim-active' });
  });

  it('keeps the latest state per token and does not mix a new HEAD or verdict', () => {
    const first = claim();
    const finalized = claim({ state: 'completed' });
    const newHead = claim({
      token: 'new-head-token',
      headSha: NEXT_HEAD,
      eventKey: 'review:44',
      verdictKey: 'findings:' + 'd'.repeat(64),
      key: prFixClaimKey({
        workflow: 'redflag', prNumber: '8362', headSha: NEXT_HEAD,
        eventKey: 'review:44', verdictKey: 'findings:' + 'd'.repeat(64),
      }),
      dedupeKey: prFixClaimDedupeKey({
        workflow: 'redflag', prNumber: '8362', headSha: NEXT_HEAD,
        eventKey: 'review:44', verdictKey: 'findings:' + 'd'.repeat(64),
      }),
    });
    const comments = [comment(first, 10), comment(finalized, 11), comment(newHead, 12)];
    const claims = latestPrFixClaims(comments);

    expect(claims).toHaveLength(2);
    expect(claims.find((item) => item.headSha === HEAD)?.state).toBe('completed');
    expect(claims.find((item) => item.headSha === NEXT_HEAD)?.state).toBe('active');
  });

  it('classifies a transient action failure without weakening the round cap', () => {
    expect(claimStatusFromOutcome({ proceed: false })).toBe('released');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'cancelled' }))
      .toBe('failed-transient');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: '' }))
      .toBe('failed-transient');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'skipped' }))
      .toBe('failed-transient');
    expect(claimStatusFromOutcome({
      proceed: true,
      claudeOutcome: 'failure',
      executionText: '{"is_error":true,"api_error_status":429}',
    })).toBe('failed-transient');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'failure' }))
      .toBe('failed-terminal');
    expect(claimStatusFromOutcome({ proceed: true, claudeOutcome: 'success' }))
      .toBe('completed');
  });
});

describe('workflow wiring for the two site PR fixer consumers', () => {
  const redflag = readFileSync(new URL('../.github/workflows/pr-redflag-fixer.yml', import.meta.url), 'utf8');
  const redcheck = readFileSync(new URL('../.github/workflows/pr-redcheck-fixer.yml', import.meta.url), 'utf8');

  it('persists a redflag claim before the bounded fixer and finalizes it', () => {
    expect(redflag).toContain('scripts/ci/pr-fixer-claim.mjs --claim');
    expect(redflag).toContain('CLAIM_KIND: redflag');
    expect(redflag).toContain('EVENT_KEY: review:');
    expect(redflag).toContain('REVIEW_BODY:');
    expect(redflag).toContain('claim_error');
    expect(redflag).toContain('MAX_ROUNDS=2');
    expect(redflag).toContain('CLAIM_ACTION: finalize');
  });

  it('persists a redcheck claim on the current failed check set', () => {
    expect(redcheck).toContain('head_sha: ${{ steps.pre.outputs.head_sha }}');
    expect(redcheck).toContain('failed_check_key: ${{ steps.pre.outputs.failed_check_key }}');
    expect(redcheck).toContain('scripts/ci/pr-fixer-claim.mjs --claim');
    expect(redcheck).toContain('CLAIM_KIND: redcheck');
    expect(redcheck).toContain('CHECK_FAILURE_KEY:');
    expect(redcheck).toContain('claim_error');
    expect(redcheck).toContain('MAX_ROUNDS=2');
    expect(redcheck).toContain('CLAIM_ACTION: finalize');
  });
});
