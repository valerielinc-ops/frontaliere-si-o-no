/**
 * prComments.mjs — modulo condiviso hasCommentMarker/commentOnce, estratto da
 * pr-collision-detector.mjs e pr-autorebase.mjs (residuo #5095, issue #5100).
 */
import { describe, it, expect, vi } from 'vitest';
import { hasCommentMarker, commentOnce } from '../scripts/ci/lib/prComments.mjs';

const MARKER = '<!-- TEST_MARKER -->';

function fakeGh(commentsBody) {
  return vi.fn((args) => {
    if (args[0] === 'api') return commentsBody;
    return ''; // gh pr comment ...
  });
}

describe('hasCommentMarker', () => {
  it('marker presente tra i commenti → true', () => {
    const gh = fakeGh(`altro commento\n${MARKER}\nresto`);
    expect(hasCommentMarker(gh, 'o/r', 42, MARKER)).toBe(true);
  });

  it('marker assente → false', () => {
    const gh = fakeGh('nessun marker qui');
    expect(hasCommentMarker(gh, 'o/r', 42, MARKER)).toBe(false);
  });

  it('fetch API vuoto/fallito (gh ritorna null) → false, nessun crash', () => {
    const gh = vi.fn(() => null);
    expect(hasCommentMarker(gh, 'o/r', 42, MARKER)).toBe(false);
  });
});

describe('commentOnce', () => {
  it('marker già presente → NON posta un nuovo commento', () => {
    const gh = fakeGh(MARKER);
    commentOnce(gh, 'o/r', 42, MARKER, 'body');
    expect(gh).not.toHaveBeenCalledWith(
      expect.arrayContaining(['pr', 'comment']),
      expect.anything(),
    );
  });

  it('marker assente → posta il commento con marker + body', () => {
    const gh = fakeGh('');
    commentOnce(gh, 'o/r', 42, MARKER, 'ciao');
    const postCall = gh.mock.calls.find((c) => c[0][0] === 'pr');
    expect(postCall).toBeTruthy();
    expect(postCall[0]).toEqual(['pr', 'comment', '42', '--repo', 'o/r', '--body', `${MARKER}\nciao`]);
  });

  it('dry-run + marker assente → NON posta, solo log (nessuna chiamata "pr comment")', () => {
    const gh = fakeGh('');
    commentOnce(gh, 'o/r', 42, MARKER, 'ciao', { dry: true });
    const postCall = gh.mock.calls.find((c) => c[0][0] === 'pr');
    expect(postCall).toBeUndefined();
  });

  it('dry-run + marker già presente → il check gira comunque (dedup rispettata anche in dry)', () => {
    const gh = fakeGh(MARKER);
    commentOnce(gh, 'o/r', 42, MARKER, 'ciao', { dry: true });
    expect(gh).toHaveBeenCalledTimes(1); // solo la fetch dei commenti, niente altro
  });
});
