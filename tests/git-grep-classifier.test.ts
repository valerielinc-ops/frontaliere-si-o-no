/**
 * Unit test for the shared `git grep` exit-code classifier
 * `scripts/ci/lib/git-grep.mjs` (#2010, follow-up of #2002).
 *
 * The two zero-Claude gates (check-cls-ad-slots, check-client-lookbehind) spawn
 * `git grep` via execFileSync, which throws on any non-zero exit. Only exit 1 with
 * NO stdout/stderr is a legitimate no-match (clean → []); every other failure must
 * re-throw so a real error (bad pathspec, missing git, exit 128) fails the CI job
 * loudly instead of silently returning [] — a false-clean GREEN on a funnel
 * invariant. This locks that distinction so neither gate can drift back to the lax
 * `status === 1` check that the reviewer flagged.
 */
import { describe, it, expect } from 'vitest';
import { isGitGrepNoMatch } from '../scripts/ci/lib/git-grep.mjs';

describe('isGitGrepNoMatch — legitimate no-match (→ clean)', () => {
  it('exit 1 with empty stdout and stderr is a clean no-match', () => {
    expect(isGitGrepNoMatch({ status: 1, stdout: '', stderr: '' })).toBe(true);
  });

  it('treats whitespace-only stdout/stderr as empty', () => {
    expect(isGitGrepNoMatch({ status: 1, stdout: '  \n', stderr: '\n' })).toBe(true);
  });

  it('exit 1 with undefined stdout/stderr (Buffer-less) is a clean no-match', () => {
    expect(isGitGrepNoMatch({ status: 1 })).toBe(true);
  });
});

describe('isGitGrepNoMatch — real failure (→ re-throw)', () => {
  it('exit 128 (bad pathspec / not a repo) is NOT a no-match', () => {
    expect(isGitGrepNoMatch({ status: 128, stderr: "fatal: bad pathspec '…'" })).toBe(false);
  });

  it('exit >=2 is NOT a no-match', () => {
    expect(isGitGrepNoMatch({ status: 2, stdout: '', stderr: '' })).toBe(false);
  });

  it('exit 1 WITH stderr is NOT a no-match (usage error on some git builds)', () => {
    expect(isGitGrepNoMatch({ status: 1, stdout: '', stderr: 'warning: something' })).toBe(false);
  });

  it('exit 1 WITH stdout is anomalous, NOT a silent no-match', () => {
    expect(isGitGrepNoMatch({ status: 1, stdout: 'some/file.ts', stderr: '' })).toBe(false);
  });

  it('a non-error value never counts as a no-match', () => {
    expect(isGitGrepNoMatch(null)).toBe(false);
    expect(isGitGrepNoMatch(undefined)).toBe(false);
    expect(isGitGrepNoMatch('boom')).toBe(false);
  });
});
