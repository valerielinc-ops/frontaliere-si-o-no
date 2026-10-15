/**
 * Regression coverage for generation-aware check selection.
 *
 * The old site workflow had an inline `sort_by(.completed_at)` selector. The
 * review now lives in `tests.yml` and stale-pr-rescuer has its own jq mirror;
 * this test keeps the executable JS contract authoritative and checks that the
 * YAML consumer cannot silently fall back to first-page/runner ordering.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  latestCompletedRunSelectionByName,
  latestCompletedRunByName,
  RUN_SELECTION_STATES,
} from '../scripts/ci/lib/vitestCheck.mjs';
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';

const HEAD = 'a'.repeat(40);
const CURRENT_NAME = VITEST_CHECK_NAME;
const LEGACY_NAME = 'vitest execution';

function staleRescuerJqFilter(): string {
  const source = readFileSync('.github/workflows/stale-pr-rescuer.yml', 'utf8');
  const start = source.indexOf('TESTS_STATE=$(printf');
  expect(start).toBeGreaterThanOrEqual(0);
  const jqStart = source.indexOf("jq -rs", start);
  const filterStart = source.indexOf("'", jqStart) + 1;
  const filterEnd = source.indexOf("')", filterStart);
  expect(filterStart).toBeGreaterThan(jqStart);
  expect(filterEnd).toBeGreaterThan(filterStart);
  return source.slice(filterStart, filterEnd);
}

function jqState(pages: unknown[]): { conclusion: string; pending: number } {
  const output = execFileSync('jq', [
    '-rs',
    '--arg', 'n', CURRENT_NAME,
    '--arg', 'legacy', LEGACY_NAME,
    '--arg', 'head', HEAD,
    staleRescuerJqFilter(),
  ], {
    input: pages.map((page) => JSON.stringify(page)).join('\n'),
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function staleRescuerValidationJqFilter(): string {
  const source = readFileSync('.github/workflows/stale-pr-rescuer.yml', 'utf8');
  const jqStart = source.indexOf("jq -s -e --arg head \"$HEAD\"");
  const filterStart = source.indexOf("'", jqStart) + 1;
  const filterEnd = source.indexOf("' >/dev/null", filterStart);
  expect(jqStart).toBeGreaterThanOrEqual(0);
  expect(filterStart).toBeGreaterThan(jqStart);
  expect(filterEnd).toBeGreaterThan(filterStart);
  return source.slice(filterStart, filterEnd);
}

function jqShapeIsValid(pages: unknown[]): boolean {
  const result = spawnSync('jq', [
    '-s', '-e', '--arg', 'head', HEAD, staleRescuerValidationJqFilter(),
  ], {
    input: pages.map((page) => JSON.stringify(page)).join('\n'),
    encoding: 'utf8',
    env: {
      ...process.env,
      CI_CHECK_NAME: CURRENT_NAME,
      LEGACY_CI_CHECK_NAME: LEGACY_NAME,
    },
  });
  return result.status === 0;
}

function run({
  id,
  conclusion = null,
  status = 'completed',
  created_at,
  completed_at = created_at,
  head_sha = HEAD,
  run_attempt,
}: {
  id: number;
  conclusion?: string | null;
  status?: string;
  created_at: string;
  completed_at?: string | null;
  head_sha?: string;
  run_attempt?: number;
}) {
  return {
    id,
    name: VITEST_CHECK_NAME,
    status,
    conclusion,
    head_sha,
    created_at,
    completed_at,
    ...(run_attempt === undefined ? {} : { run_attempt }),
  };
}

describe('generation-aware check selection used by the PR loop', () => {
  it('does not choose the older run merely because it completed later', () => {
    const newer = run({
      id: 200,
      conclusion: 'success',
      created_at: '2026-09-20T10:05:00Z',
      completed_at: '2026-09-20T10:06:00Z',
    });
    const oldRerun = run({
      id: 199,
      conclusion: 'failure',
      created_at: '2026-09-20T10:00:00Z',
      completed_at: '2026-09-20T10:07:00Z',
    });
    expect(latestCompletedRunByName([newer, oldRerun], VITEST_CHECK_NAME)).toBe(newer);
  });

  it('does not carry forward a previous verdict while a newer generation runs', () => {
    const oldSuccess = run({
      id: 300,
      conclusion: 'success',
      created_at: '2026-09-20T11:00:00Z',
      completed_at: '2026-09-20T11:01:00Z',
    });
    const newerPending = run({
      id: 301,
      status: 'in_progress',
      created_at: '2026-09-20T11:05:00Z',
      completed_at: null,
    });
    const selection = latestCompletedRunSelectionByName([oldSuccess, newerPending], VITEST_CHECK_NAME);
    expect(selection.state).toBe(RUN_SELECTION_STATES.PENDING);
    expect(selection.run).toBeNull();
  });

  it('uses run_attempt before check ID for a shared creation timestamp', () => {
    const firstAttempt = run({
      id: 402,
      conclusion: 'failure',
      created_at: '2026-09-20T12:00:00Z',
      completed_at: '2026-09-20T12:02:00Z',
      run_attempt: 1,
    });
    const rerun = run({
      id: 401,
      conclusion: 'success',
      created_at: '2026-09-20T12:00:00Z',
      completed_at: '2026-09-20T12:01:00Z',
      run_attempt: 2,
    });
    expect(latestCompletedRunByName([firstAttempt, rerun], VITEST_CHECK_NAME)).toBe(rerun);
  });

  it('fails closed on mixed SHA or incomplete identity', () => {
    const valid = run({
      id: 500,
      conclusion: 'success',
      created_at: '2026-09-20T13:00:00Z',
    });
    const selection = latestCompletedRunSelectionByName([
      valid,
      { ...valid, id: 501, head_sha: 'b'.repeat(40), conclusion: 'failure' },
    ], VITEST_CHECK_NAME);
    expect(selection.state).toBe(RUN_SELECTION_STATES.AMBIGUOUS);
    expect(latestCompletedRunByName([valid, { ...valid, id: undefined }], VITEST_CHECK_NAME)).toBeNull();
  });

  it('keeps stale-pr-rescuer on the paginated, generation-aware path', () => {
    const source = readFileSync('.github/workflows/stale-pr-rescuer.yml', 'utf8');
    expect(source).toContain('api --paginate "repos/$REPO/commits/$HEAD/check-runs?per_page=100"');
    expect(source).toContain('created_at');
    expect(source).toContain('run_attempt');
    expect(source).toContain('workflow_id');
    expect(source).toContain("LEGACY_CI_CHECK_NAME: 'vitest execution'");
    expect(source).toContain('TESTS_STATE=');
    expect(source).not.toContain('.[].check_runs[]?');
    expect(source).not.toContain('sort_by(.completed_at) | last | .conclusion');
  });

  it('keeps the inline jq mirror behaviorally aligned for empty/skipped/pending/mixed/complete', () => {
    const check = (name: string, id: number, status: string, conclusion: string | null, createdAt: string) => ({
      id,
      name,
      status,
      conclusion,
      head_sha: HEAD,
      created_at: createdAt,
      completed_at: status === 'completed' ? `${createdAt.slice(0, 19)}Z` : null,
    });
    const oldSuccess = check(CURRENT_NAME, 10, 'completed', 'success', '2026-09-20T10:00:00Z');
    const newerPending = check(CURRENT_NAME, 11, 'in_progress', null, '2026-09-20T10:05:00Z');
    const skipped = check(CURRENT_NAME, 12, 'completed', 'skipped', '2026-09-20T10:06:00Z');
    const currentSuccess = check(CURRENT_NAME, 13, 'completed', 'success', '2026-09-20T10:07:00Z');
    const legacyFailure = check(LEGACY_NAME, 14, 'completed', 'failure', '2026-09-20T10:08:00Z');
    const firstAttempt = {
      ...check(CURRENT_NAME, 16, 'completed', 'failure', '2026-09-20T10:09:00Z'),
      run_attempt: 1,
    };
    const rerun = {
      ...check(CURRENT_NAME, 15, 'completed', 'success', '2026-09-20T10:09:00Z'),
      run_attempt: 2,
    };

    expect(jqState([{ check_runs: [] }])).toEqual({ conclusion: 'none', pending: 0 });
    expect(jqState([{ check_runs: [skipped] }])).toEqual({ conclusion: 'none', pending: 0 });
    expect(jqState([{ check_runs: [oldSuccess, newerPending] }])).toEqual({ conclusion: 'none', pending: 1 });
    expect(jqState([{
      check_runs: [currentSuccess, { ...currentSuccess, id: 15, head_sha: 'b'.repeat(40) }],
    }]))
      .toEqual({ conclusion: 'none', pending: 1 });
    expect(jqState([{ check_runs: [currentSuccess, legacyFailure] }])).toEqual({ conclusion: 'success', pending: 0 });
    expect(jqState([{ check_runs: [legacyFailure] }])).toEqual({ conclusion: 'failure', pending: 0 });
    expect(jqState([{ check_runs: [firstAttempt, rerun] }])).toEqual({ conclusion: 'success', pending: 0 });

    expect(latestCompletedRunSelectionByName([oldSuccess, newerPending], CURRENT_NAME).state)
      .toBe(RUN_SELECTION_STATES.PENDING);
    expect(latestCompletedRunSelectionByName([skipped], CURRENT_NAME, { excludeSkipped: true }).state)
      .toBe(RUN_SELECTION_STATES.PENDING);
    expect(latestCompletedRunSelectionByName([currentSuccess], CURRENT_NAME).run?.conclusion)
      .toBe('success');
    expect(latestCompletedRunSelectionByName([legacyFailure], LEGACY_NAME).run?.conclusion)
      .toBe('failure');
  });

  it('fails closed on malformed paginated API pages before any rescue mutation', () => {
    const valid = {
      check_runs: [{
        id: 21,
        name: CURRENT_NAME,
        status: 'completed',
        conclusion: 'success',
        head_sha: HEAD,
        created_at: '2026-09-20T15:00:00Z',
        completed_at: '2026-09-20T15:01:00Z',
      }],
    };
    for (const malformed of [{}, [{}], { check_runs: null }, { check_runs: [null] }]) {
      expect(jqShapeIsValid([malformed]), JSON.stringify(malformed)).toBe(false);
    }
    expect(jqShapeIsValid([valid])).toBe(true);

    const source = readFileSync('.github/workflows/stale-pr-rescuer.yml', 'utf8');
    expect(source).toContain('CHECKS_STATE=unavailable');
    expect(source).toContain('nessun rescue o mutation.');
    expect(source).toContain('if (valid_pages | not) then false');
  });
});
