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
import {
  buildBlockReason,
  classifyPr,
  PR_WATCH_WAIT_FOR,
  RESOLVED_STATUSES,
  subscribeCommand,
} from '../../scripts/ci/lib/pr-watch-classify.mjs';

const review = (commit_id: string, body: string, login = 'frontaliere-automation[bot]') => ({
  commit_id,
  user: { login, type: 'Bot' },
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

  it('ignores a review from someone other than the reviewer bot', () => {
    const v = classifyPr({
      state: 'OPEN',
      headSha: 'HEAD2',
      reviews: [review('HEAD2', '## LGTM', 'a-human')],
    });
    expect(v.status).toBe('awaiting-review');
  });

  it('picks the LAST reviewer-bot review on the head when there are several', () => {
    const v = classifyPr({
      state: 'OPEN',
      headSha: 'HEAD2',
      reviews: [review('HEAD2', '🔴 Important: first pass'), review('HEAD2', '## LGTM')],
    });
    expect(v.status).toBe('lgtm');
  });

  // 2026-09-19: il filtro `login === 'claude[bot]'` rendeva il gate cieco alle
  // review reali (sito: frontaliere-automation[bot]; corpus: github-actions[bot]
  // col marker Codex). 5 PR con un 🔴 senza risposta per 4-7 ore.
  it('sees the site reviewer frontaliere-automation[bot] — a 🔴 is not-lgtm, not awaiting-review', () => {
    const v = classifyPr({
      state: 'OPEN',
      headSha: 'H',
      reviews: [review('H', '## Findings (Important: 1)\n🔴 Important: bug', 'frontaliere-automation[bot]')],
    });
    expect(v.status).toBe('not-lgtm');
  });

  it('sees the corpus reviewer github-actions[bot] only with the Codex marker', () => {
    const lgtm = '<!-- CODEX_FALLBACK_REVIEW -->\n## LGTM\n';
    expect(classifyPr({ state: 'OPEN', headSha: 'H', reviews: [review('H', lgtm, 'github-actions[bot]')] }).status).toBe('lgtm');
    expect(
      classifyPr({ state: 'OPEN', headSha: 'H', reviews: [review('H', '## LGTM\n', 'github-actions[bot]')] }).status,
    ).toBe('awaiting-review');
  });

  it('still accepts claude[bot] (legacy reviewer identity)', () => {
    expect(classifyPr({ state: 'OPEN', headSha: 'H', reviews: [review('H', '## LGTM\n', 'claude[bot]')] }).status).toBe('lgtm');
  });

  it('an LGTM heading next to a 🔴 Important is not an approval', () => {
    const v = classifyPr({ state: 'OPEN', headSha: 'H', reviews: [review('H', '## LGTM\n🔴 Important: still broken')] });
    expect(v.status).toBe('not-lgtm');
  });

  it('a DISMISSED review is not a verdict', () => {
    const r = { ...review('H', '🔴 Important: x'), state: 'DISMISSED' };
    expect(classifyPr({ state: 'OPEN', headSha: 'H', reviews: [r] }).status).toBe('awaiting-review');
  });

  it('the block reason points to the event subscription, never to polling gh pr view', () => {
    const ref = { owner: 'o', repo: 'r', number: 7 };
    const reason = buildBlockReason([{ ref, verdict: { status: 'not-lgtm', detail: 'd' } }]);
    expect(reason).not.toMatch(/gh pr view <|ricontrolla con `gh pr view/);
    expect(reason).toContain(subscribeCommand(ref));
    expect(reason).toMatch(/NON e' LGTM/);
  });

  it('the subscription waits for the review events, not only merged/failed', () => {
    for (const state of ['merged', 'failed', 'commented', 'needs_review']) {
      expect(PR_WATCH_WAIT_FOR).toContain(state);
    }
    expect(subscribeCommand({ owner: 'o', repo: 'r', number: 7 })).toContain(`--wait-for ${PR_WATCH_WAIT_FOR.join(',')}`);
  });

  it('RESOLVED_STATUSES matches exactly the statuses that let the watch drop', () => {
    expect(RESOLVED_STATUSES.has('merged')).toBe(true);
    expect(RESOLVED_STATUSES.has('closed')).toBe(true);
    expect(RESOLVED_STATUSES.has('lgtm')).toBe(true);
    expect(RESOLVED_STATUSES.has('not-lgtm')).toBe(false);
    expect(RESOLVED_STATUSES.has('awaiting-review')).toBe(false);
  });
});
