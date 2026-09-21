/**
 * Regression guard for the redflag fixer round-cap identity lookup.
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
const FIXER = join(ROOT, '.github/workflows/pr-redflag-fixer.yml');
const SOURCE = readFileSync(FIXER, 'utf8');

function roundGuardBlock(): string {
  const start = SOURCE.indexOf('- name: Round cap + capability guard + tier');
  const end = SOURCE.indexOf('- name: Configure git identity', start);
  expect(start, 'round-cap guard must exist').toBeGreaterThanOrEqual(0);
  expect(end, 'round-cap guard must end before git setup').toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('pr-redflag-fixer Actions token identity', () => {
  it('does not probe /user with GITHUB_TOKEN before starting Claude', () => {
    const guard = roundGuardBlock();

    expect(guard).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(guard).toContain("trusted_actor='github-actions[bot]'");
    expect(guard).not.toContain(' api user ');
    expect(guard).toContain('select((.user.login // "") == $actor)');
  });
});
