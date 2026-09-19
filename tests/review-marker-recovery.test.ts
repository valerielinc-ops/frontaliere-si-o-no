import { describe, expect, it } from 'vitest';
import { markerCli, parseReviewPages, reviewMarkerDecision } from '../scripts/ci/review-marker-recovery.mjs';
import { reviewInputMarker } from '../scripts/ci/lib/review-input-revision.mjs';

const HEAD = 'a'.repeat(40);
const REVISION = `body:${'b'.repeat(64)}`;
const MARKER = reviewInputMarker(REVISION);

function review(body = `${MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`) {
  return {
    id: 42,
    user: { type: 'Bot', login: 'github-actions[bot]' },
    state: 'COMMENTED',
    commit_id: HEAD,
    body,
    submitted_at: '2026-09-19T10:00:00Z',
  };
}

describe('deterministic review input marker recovery', () => {
  it('accepts one exact marker in a valid paginated API response', () => {
    const pages = [[review()]];
    expect(parseReviewPages(JSON.stringify(pages))).toEqual(pages);
    expect(reviewMarkerDecision({ reviews: pages, headSha: HEAD, reviewRevision: REVISION }))
      .toMatchObject({ ok: true });
  });

  it('ignores an older same-HEAD marker as history when the latest review is current', () => {
    const old = {
      ...review(`${reviewInputMarker(`body:${'c'.repeat(64)}`)}\n## Findings (Important: 1, Nit: 0)`),
      id: 41,
      submitted_at: '2026-09-19T09:00:00Z',
    };
    expect(reviewMarkerDecision({ reviews: [[old, review()]], headSha: HEAD, reviewRevision: REVISION }))
      .toMatchObject({ ok: true });
  });

  it('ignores pending/dismissed historical reviews but requires state on every entry', () => {
    const pending = { ...review(), id: 43, state: 'PENDING', submitted_at: '2026-09-19T11:00:00Z' };
    const dismissed = { ...review(), id: 44, state: 'DISMISSED', submitted_at: '2026-09-19T12:00:00Z' };
    expect(parseReviewPages(JSON.stringify([[pending, dismissed, review()]]))).not.toBeNull();
    expect(reviewMarkerDecision({ reviews: [[pending, dismissed, review()]], headSha: HEAD, reviewRevision: REVISION }))
      .toMatchObject({ ok: true });
    const missingState = { ...review() } as Record<string, unknown>;
    delete missingState.state;
    expect(parseReviewPages(JSON.stringify([[missingState]]))).toBeNull();
    expect(parseReviewPages(JSON.stringify([[{ ...review(), state: 'UNKNOWN' }]]))).toBeNull();
  });

  it.each([
    ['missing', '## Findings (Important: 0, Nit: 0)\n\n## LGTM'],
    ['stale', `${reviewInputMarker(`body:${'c'.repeat(64)}`)}\n## LGTM`],
    ['duplicate', `${MARKER}\n${MARKER}\n## LGTM`],
  ])('fails closed for a %s marker without a model retry', (_label, body) => {
    expect(reviewMarkerDecision({ reviews: [[review(body)]], headSha: HEAD, reviewRevision: REVISION }))
      .toMatchObject({ ok: false });
  });

  it.each([
    ['malformed JSON', '{'],
    ['malformed pages', JSON.stringify([review()])],
    ['malformed entry', JSON.stringify([[null]])],
  ])('rejects %s before the gate', (_label, raw) => {
    const pages = parseReviewPages(raw);
    expect(pages).toBeNull();
    expect(markerCli(
      ['node', 'review-marker-recovery.mjs', 'validate', '--head', HEAD, '--revision', REVISION],
      raw,
    )).toBe(1);
  });
});
