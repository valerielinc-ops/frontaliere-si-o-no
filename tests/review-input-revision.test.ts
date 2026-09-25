import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  reviewHasInputRevision,
  reviewInputMarker,
  reviewInputRevisionFromBody,
  reviewInputRevisionFromPullRequest,
  reviewInputRevisions,
  reviewInputSerialization,
} from '../scripts/ci/lib/review-input-revision.mjs';

const SCRIPT = new URL('../scripts/ci/lib/review-input-revision.mjs', import.meta.url);

describe('trusted review input revision', () => {
  it('hashes the exact body and accepts an explicitly empty GitHub body', () => {
    const body = '## Implementato\n- exact bytes\n';
    const revision = reviewInputRevisionFromBody(body);
    expect(revision).toMatch(/^body:[0-9a-f]{64}$/u);
    expect(reviewInputRevisionFromPullRequest({ body })).toBe(revision);
    expect(reviewInputRevisionFromPullRequest({ body: null })).toBe(reviewInputRevisionFromBody(''));
  });

  it('rejects an unavailable or malformed API body instead of inventing a revision', () => {
    expect(() => reviewInputRevisionFromPullRequest(null)).toThrow(/object/i);
    expect(() => reviewInputRevisionFromPullRequest({})).toThrow(/body field/i);
    expect(() => reviewInputRevisionFromPullRequest({ body: 42 })).toThrow(/string/i);
  });

  it('requires one complete marker and handles serialized newline separators', () => {
    const revision = reviewInputRevisionFromBody('body');
    const marker = reviewInputMarker(revision);
    expect(reviewInputRevisions(`${marker}\n## LGTM`)).toEqual([revision]);
    expect(reviewInputRevisions(`${marker}\\n## LGTM`)).toEqual([revision]);
    expect(reviewHasInputRevision(`${marker}\n## LGTM`, revision)).toBe(true);
    expect(reviewHasInputRevision(`${marker}\n${marker}`, revision)).toBe(false);
    expect(reviewHasInputRevision(`${marker}`, reviewInputRevisionFromBody('other'))).toBe(false);
  });

  it('hash-pr-json is a subprocess boundary for the workflow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frontaliere-review-input-'));
    const file = join(dir, 'pr.json');
    try {
      const body = '## Implementato\n- subprocess\n';
      writeFileSync(file, JSON.stringify({ body }), 'utf8');
      const result = spawnSync(process.execPath, [SCRIPT.pathname, 'hash-pr-json', '--file', file], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(reviewInputRevisionFromBody(body));

      writeFileSync(file, JSON.stringify({ body: 42 }), 'utf8');
      const malformed = spawnSync(process.execPath, [SCRIPT.pathname, 'hash-pr-json', '--file', file], {
        encoding: 'utf8',
      });
      expect(malformed.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Cross-repo agreement, pinned by VALUE and not by re-deriving it.
 *
 * A test that recomputes the digest with the same formula as the code under
 * test cannot see a change of representation: it moves with it. These hex
 * strings were produced by the corpus' own
 * `scripts/ci/review-test-policy.mjs#reviewInputRevisionForBody` on
 * `origin/main` (2026-09-20) — the only producer of REVIEW_INPUT_REVISION
 * markers that exists — and by the `sha256sum "$BODY_FILE"` of its
 * `tests.yml`, which hashes the file `gh api --jq` writes. If the site ever
 * drifts away from that representation again, these fail.
 *
 * They are literals on purpose: the two repositories talk over HTTP and the
 * site must not import corpus code to check this (see the workspace boundary
 * rule). A frozen vector is the verifiable form of that agreement.
 */
describe('review input revision: the digest the corpus actually emits', () => {
  const CORPUS_VECTORS: Array<[string, string]> = [
    ['', 'body:01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b'],
    ['ciao', 'body:6f0378f21a495f5c13247317d158e9d51da45a5bf68fc2f366e450deafdc8302'],
    ['## Implementato\n- x\n', 'body:d4388110714e32cda176f145a80d6241f277352fab24b373097265a3dd14521f'],
    ['riga\r\ncon CRLF', 'body:249086460c8548bbff44a17ad48bf7284d973540682e1ed1a621fe461e50042a'],
  ];

  it.each(CORPUS_VECTORS)('matches the corpus digest for %j', (body, expected) => {
    expect(reviewInputRevisionFromBody(body)).toBe(expected);
  });

  it('hashes the `gh api --jq` serialization, newline included', () => {
    expect(reviewInputSerialization('ciao')).toBe('ciao\n');
    // The old site formula — sha256 of the body WITHOUT the trailing newline —
    // produced a digest that matched no marker ever emitted. Pin the gap so a
    // revert is loud instead of silent.
    const withoutNewline = createHash('sha256').update('ciao', 'utf8').digest('hex');
    expect(reviewInputRevisionFromBody('ciao')).not.toBe(`body:${withoutNewline}`);
  });

  it('a body that already ends in a newline is not confused with one that does not', () => {
    expect(reviewInputRevisionFromBody('x')).not.toBe(reviewInputRevisionFromBody('x\n'));
  });

  it('an explicitly empty GitHub body hashes the empty serialization', () => {
    expect(reviewInputRevisionFromPullRequest({ body: null })).toBe(CORPUS_VECTORS[0][1]);
  });
});
