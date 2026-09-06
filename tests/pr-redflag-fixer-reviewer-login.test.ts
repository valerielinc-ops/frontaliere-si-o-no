/**
 * The 🔴-fixer job-level `if:` is the only thing that can start the preflight.
 * A filter that requires `login` to start with `claude` skips every review
 * posted by `frontaliere-automation[bot]` — the same bot `tests.yml` already
 * treats as the review oracle. Observed: PRs #7610 and #7609, check-run
 * skipped, zero fixer comments, 🔴 left on HEAD.
 *
 * Reads the shipped workflow. Does not reimplement the GitHub `if:` evaluator.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const ROOT = process.cwd();
const FIXER = join(ROOT, '.github/workflows/pr-redflag-fixer.yml');
const TESTS = join(ROOT, '.github/workflows/tests.yml');

function preflightIf(): string {
  const doc: any = YAML.parse(readFileSync(FIXER, 'utf8'));
  const expr = doc?.jobs?.preflight?.if;
  expect(typeof expr, 'jobs.preflight.if must be a string in the shipped workflow').toBe('string');
  return String(expr).replace(/\s+/g, ' ').trim();
}

describe('pr-redflag-fixer job-level reviewer filter matches tests.yml bot set', () => {
  it('a frontaliere-automation[bot] review with 🔴 would pass the job-level trigger', () => {
    const expr = preflightIf();
    expect(expr).toContain("github.event.review.user.type == 'Bot'");
    expect(expr).toContain("contains(github.event.review.body, '🔴')");
    expect(
      expr,
      'job-level if: must accept the App bot that actually posts reviews on this repo',
    ).toContain("github.event.review.user.login == 'frontaliere-automation[bot]'");
    expect(expr).toMatch(
      /startsWith\(github\.event\.review\.user\.login, 'claude'\) \|\| github\.event\.review\.user\.login == 'frontaliere-automation\[bot\]'/,
    );
  });

  it('no longer requires login to start with claude as the only reviewer match', () => {
    const expr = preflightIf();
    expect(expr).not.toMatch(
      /startsWith\(github\.event\.review\.user\.login, 'claude'\) && contains\(github\.event\.review\.body/,
    );
  });

  it('stays in the same reviewer set tests.yml already uses for LGTM', () => {
    const testsYml = readFileSync(TESTS, 'utf8');
    expect(testsYml).toMatch(/frontaliere-automation\\?\[bot\\?\]/);
    expect(preflightIf()).toContain('frontaliere-automation[bot]');
  });
});
