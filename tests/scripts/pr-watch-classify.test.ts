/**
 * pr-watch-classify.mjs — the verdict pr-watch-gate.mjs blocks on.
 *
 * The one property every case here protects: a review must be read against
 * the CURRENT head commit, never just "the latest review" — a stale review
 * from before a fix commit must not read as today's verdict. That confusion
 * is exactly how #6318's real 🔴 Important finding sat unnoticed on
 * 2026-08-24 while the session that opened the PR had already moved on.
 */
import { describe, expect, it } from 'vitest';
import { classifyPr, RESOLVED_STATUSES } from '../../scripts/ci/lib/pr-watch-classify.mjs';

const review = (commit_id: string, body: string, login = 'claude[bot]') => ({
  commit_id,
  user: { login },
  body,
});

describe('classifyPr', () => {
  it('merged and closed are terminal regardless of review state', () => {
    expect(classifyPr({ state: 'MERGED', headSha: 'a', reviews: [] }).status).toBe('merged');
    expect(classifyPr({ state: 'CLOSED', headSha: 'a', reviews: [] }).status).toBe('closed');
  });

  it('no review at all on the current head → awaiting-review, not resolved', () => {
    const v = classifyPr({ state: 'OPEN', headSha: 'HEAD2', reviews: [] });
    expect(v.status).toBe('awaiting-review');
  });

  it('LGTM on the CURRENT head resolves the watch', () => {
    const v = classifyPr({
      state: 'OPEN',
      headSha: 'HEAD2',
      reviews: [review('HEAD2', '## LGTM\nall good')],
    });
    expect(v.status).toBe('lgtm');
  });

  it('a non-LGTM review on the current head keeps the watch open', () => {
    const v = classifyPr({
      state: 'OPEN',
      headSha: 'HEAD2',
      reviews: [review('HEAD2', '## Findings\n🔴 Important: ...')],
    });
    expect(v.status).toBe('not-lgtm');
  });

  it('a stale review from a PRIOR commit does not count as today\'s verdict — the exact #6318 bug', () => {
    // The review landed on the commit BEFORE the fix push. The fix has since
    // been pushed (headSha moved on) and no new review has arrived yet.
    const v = classifyPr({
      state: 'OPEN',
      headSha: 'HEAD_AFTER_FIX',
      reviews: [review('HEAD_BEFORE_FIX', '🔴 Important: ...')],
    });
    expect(v.status).toBe('awaiting-review');
  });

  it('an LGTM from a prior commit does not carry forward to a new head either', () => {
    // A push after LGTM (e.g. an unrelated commit) must not be read as still-LGTM.
    const v = classifyPr({
      state: 'OPEN',
      headSha: 'HEAD3',
      reviews: [review('HEAD2', '## LGTM')],
    });
    expect(v.status).toBe('awaiting-review');
  });

  it('ignores a review from someone other than claude[bot]', () => {
    const v = classifyPr({
      state: 'OPEN',
      headSha: 'HEAD2',
      reviews: [review('HEAD2', '## LGTM', 'a-human')],
    });
    expect(v.status).toBe('awaiting-review');
  });

  it('picks the LAST claude[bot] review on the head when there are several', () => {
    const v = classifyPr({
      state: 'OPEN',
      headSha: 'HEAD2',
      reviews: [review('HEAD2', '🔴 Important: first pass'), review('HEAD2', '## LGTM')],
    });
    expect(v.status).toBe('lgtm');
  });

  it('RESOLVED_STATUSES matches exactly the statuses that let the watch drop', () => {
    expect(RESOLVED_STATUSES.has('merged')).toBe(true);
    expect(RESOLVED_STATUSES.has('closed')).toBe(true);
    expect(RESOLVED_STATUSES.has('lgtm')).toBe(true);
    expect(RESOLVED_STATUSES.has('not-lgtm')).toBe(false);
    expect(RESOLVED_STATUSES.has('awaiting-review')).toBe(false);
  });
});
