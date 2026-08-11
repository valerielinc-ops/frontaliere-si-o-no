/**
 * prComments.mjs — modulo condiviso hasCommentMarker/commentOnce, estratto da
 * pr-collision-detector.mjs e pr-autorebase.mjs (residuo #5095, issue #5100).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  hasCommentMarker,
  commentOnce,
  findCommentIdByMarker,
  upsertStickyComment,
} from '../scripts/ci/lib/prComments.mjs';

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

/**
 * `upsertStickyComment` (#5552): serve a un chiamante che rigira PIÙ volte sulla
 * stessa PR e deve lasciare UN solo commento sempre aggiornato — dove
 * `commentOnce` lascerebbe invece la prima misura a invecchiare per sempre.
 */
describe('findCommentIdByMarker', () => {
  it('ritorna l’id emesso da jq', () => {
    const gh = vi.fn(() => '918273\n');
    expect(findCommentIdByMarker(gh, 'o/r', 42, MARKER)).toBe('918273');
    // Il match dev'essere delegato a jq sul body intero, non a un parser di
    // righe lato JS: i body sono multi-riga.
    expect(gh.mock.calls[0][0]).toContain('--jq');
    expect(gh.mock.calls[0][0].join(' ')).toContain(`contains("${MARKER}")`);
  });

  it('nessun match → null', () => {
    expect(findCommentIdByMarker(vi.fn(() => ''), 'o/r', 42, MARKER)).toBeNull();
  });

  it('fetch fallita (null) o output non numerico → null, nessun crash', () => {
    expect(findCommentIdByMarker(vi.fn(() => null), 'o/r', 42, MARKER)).toBeNull();
    expect(findCommentIdByMarker(vi.fn(() => 'gh: not found'), 'o/r', 42, MARKER)).toBeNull();
  });

  it('più commenti col marker → prende il primo (stabile fra i giri)', () => {
    expect(findCommentIdByMarker(vi.fn(() => '111\n222\n'), 'o/r', 42, MARKER)).toBe('111');
  });
});

describe('upsertStickyComment', () => {
  const body = `${MARKER}\nmisura aggiornata`;

  it('commento assente → ne CREA uno con il body così com’è (marker incluso)', () => {
    const gh = vi.fn(() => '');
    upsertStickyComment(gh, 'o/r', 42, MARKER, body);
    const post = gh.mock.calls.find((c) => c[0][0] === 'pr');
    expect(post[0]).toEqual(['pr', 'comment', '42', '--repo', 'o/r', '--body', body]);
    // A differenza di commentOnce NON antepone il marker: lo fa già il body.
    expect(post[0][6].startsWith(`${MARKER}\n${MARKER}`)).toBe(false);
  });

  it('commento presente → lo AGGIORNA in place, senza crearne un secondo', () => {
    const gh = vi.fn((args) => (args[0] === 'api' && args[1] !== '--method' ? '55\n' : ''));
    upsertStickyComment(gh, 'o/r', 42, MARKER, body);
    const patch = gh.mock.calls.find((c) => c[0].includes('--method'));
    expect(patch).toBeTruthy();
    expect(patch[0]).toEqual([
      'api', '--method', 'PATCH', 'repos/o/r/issues/comments/55', '-f', `body=${body}`,
    ]);
    // L'invariante che rende l'osservatore silenzioso: N giri, 1 commento.
    expect(gh.mock.calls.some((c) => c[0][0] === 'pr')).toBe(false);
  });

  it('dry-run → nessuna scrittura, né create né update', () => {
    const gh = vi.fn(() => '55\n');
    upsertStickyComment(gh, 'o/r', 42, MARKER, body, { dry: true });
    expect(gh.mock.calls.some((c) => c[0].includes('--method') || c[0][0] === 'pr')).toBe(false);
  });
});
