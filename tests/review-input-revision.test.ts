import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  reviewHasInputRevision,
  reviewInputMarker,
  reviewInputRevisionFromBody,
  reviewInputRevisionFromPullRequest,
  reviewInputRevisions,
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
