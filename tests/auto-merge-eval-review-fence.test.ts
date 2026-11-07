import { describe, expect, it } from 'vitest';
import {
  isManagedReview,
  siteRequiredCheckVerdict,
} from '../scripts/ci/auto-merge-eval.mjs';
import {
  reviewInputMarker,
  reviewInputRevisionFromBody,
} from '../scripts/ci/lib/review-input-revision.mjs';
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';

const HEAD = 'a'.repeat(40);
const PR_BODY = '## Implementato\n- current body';
const REVIEW_REVISION = reviewInputRevisionFromBody(PR_BODY);
const REVIEW_MARKER = reviewInputMarker(REVIEW_REVISION);
const CLEAN_REVIEW_BODY = `${REVIEW_MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`;

function review(body = CLEAN_REVIEW_BODY, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user: { type: 'Bot', login: 'claude[bot]' },
    state: 'COMMENTED',
    body,
    commit_id: HEAD,
    ...overrides,
  };
}

function siteCheck(conclusion: string, head = HEAD) {
  return {
    id: 101,
    name: VITEST_CHECK_NAME,
    status: 'completed',
    conclusion,
    head_sha: head,
    created_at: '2026-11-07T00:00:00Z',
    completed_at: '2026-11-07T00:01:00Z',
  };
}

describe('auto-merge-eval review/body fence', () => {
  it('requires a managed terminal review on the current HEAD and body revision', () => {
    expect(isManagedReview(review(), { head: HEAD, reviewRevision: REVIEW_REVISION })).toBe(true);

    const oldRevision = reviewInputRevisionFromBody('## Implementato\n- old body');
    expect(isManagedReview(
      review(`${reviewInputMarker(oldRevision)}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`),
      { head: HEAD, reviewRevision: REVIEW_REVISION },
    )).toBe(false);
    expect(isManagedReview(
      review(CLEAN_REVIEW_BODY, { commit_id: 'b'.repeat(40) }),
      { head: HEAD, reviewRevision: REVIEW_REVISION },
    )).toBe(false);
  });

  it('rejects an unmarked or non-terminal review instead of treating its LGTM as proof', () => {
    expect(isManagedReview(
      review(CLEAN_REVIEW_BODY.replace(`${REVIEW_MARKER}\n`, '')),
      { head: HEAD, reviewRevision: REVIEW_REVISION },
    )).toBe(false);
    expect(isManagedReview(
      review(CLEAN_REVIEW_BODY, { state: 'PENDING' }),
      { head: HEAD, reviewRevision: REVIEW_REVISION },
    )).toBe(false);
  });
});

describe('auto-merge-eval site required check adapter', () => {
  it('fails closed when the site check is missing, stale, or not green', () => {
    expect(siteRequiredCheckVerdict([], HEAD)).toMatchObject({ allow: false, conclusion: '' });
    expect(siteRequiredCheckVerdict([siteCheck('success', 'b'.repeat(40))], HEAD))
      .toMatchObject({ allow: false, conclusion: '' });
    expect(siteRequiredCheckVerdict([siteCheck('failure')], HEAD))
      .toMatchObject({ allow: false, conclusion: 'failure' });
  });

  it('uses the site Vitest check; a corpus-only generator-ci entry cannot substitute for it', () => {
    expect(siteRequiredCheckVerdict([
      { ...siteCheck('success'), name: 'generator-ci' },
    ], HEAD)).toMatchObject({ allow: false, conclusion: '' });
    expect(siteRequiredCheckVerdict([siteCheck('success')], HEAD))
      .toMatchObject({ allow: true, conclusion: 'success' });
  });
});
