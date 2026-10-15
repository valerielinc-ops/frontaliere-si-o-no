/**
 * Regression guard for the autonomous PR fixer round-cap identity lookup.
 *
 * Actions' `GITHUB_TOKEN` is an installation token: GitHub accepts it for
 * repository APIs but `GET /user` cannot return a user identity for it. The
 * fixer must keep using that token for its marker comments and pin the known
 * REST actor instead of failing before Claude.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const FIXERS = ['pr-redflag-fixer.yml', 'pr-redcheck-fixer.yml'];

function roundGuardBlock(source: string, fixer: string): string {
  const start = source.indexOf('- name: Round cap + capability guard');
  const end = source.indexOf('- name: Configure git identity', start);
  expect(start, 'round-cap guard must exist').toBeGreaterThanOrEqual(0);
  expect(end, `${fixer}: round-cap guard must end before git setup`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('autonomous PR fixers Actions token identity', () => {
  it('do not probe /user with GITHUB_TOKEN before starting Claude', () => {
    for (const fixer of FIXERS) {
      const source = readFileSync(join(ROOT, '.github/workflows', fixer), 'utf8');
      const guard = roundGuardBlock(source, fixer);

      expect(guard, fixer).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
      expect(guard, fixer).toContain("trusted_actor='github-actions[bot]'");
      expect(guard, fixer).not.toContain(' api user ');
      expect(guard, fixer).toContain('select((.user.login // "") == $actor)');
    }
  });
});
