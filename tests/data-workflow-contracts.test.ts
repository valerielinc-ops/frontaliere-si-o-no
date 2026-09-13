import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cleanupWorkflow = readFileSync(
  new URL('../.github/workflows/cleanup-stale-jobs.yml', import.meta.url),
  'utf8',
);
const reconcileWorkflow = readFileSync(
  new URL('../.github/workflows/reconcile-expired-route-duplicates.yml', import.meta.url),
  'utf8',
);

describe('scheduled data workflow contracts (#8500, #8485)', () => {
  it('#8500 delegates URL validation and fails closed per slice', () => {
    const cleanupStep = cleanupWorkflow.slice(
      cleanupWorkflow.indexOf('- name: Cleanup each per-crawler slice'),
      cleanupWorkflow.indexOf('- name: Commit Phase 1'),
    );
    expect(cleanupStep).toContain("JOBS_SKIP_URL_VALIDATION: '1'");
    expect(cleanupStep).toContain('set -euo pipefail');
    expect(cleanupStep).toContain('JOBS_SLICE_FILE="$slice" node scripts/cleanup-jobs.mjs');
    expect(cleanupStep).not.toContain('cleanup-jobs.mjs || true');
    expect(cleanupStep).not.toContain('JOBS_HOUSEKEEPING_TIMEOUT_MS');
    expect(cleanupStep).not.toContain('JOBS_HOUSEKEEPING_CONCURRENCY');
  });

  it('#8485 uses the relevant fail-closed contracts instead of an unrelated full suite', () => {
    const gateStart = reconcileWorkflow.indexOf('- name: Test gate (reconciler and commit contract)');
    const commitStart = reconcileWorkflow.indexOf('- name: Commit and push changed slices');
    const gate = reconcileWorkflow.slice(gateStart, commitStart);
    expect(gateStart).toBeGreaterThanOrEqual(0);
    expect(commitStart).toBeGreaterThan(gateStart);
    expect(gate).toContain('set -euo pipefail');
    expect(gate).toContain('tests/reconcile-crawler-company-ownership.test.ts');
    expect(gate).toContain('tests/expired-at-parsable.test.ts');
    expect(gate).toContain('tests/git-commit-data-slice-scoping.test.ts');
    expect(gate).not.toContain('npm test');
    expect(reconcileWorkflow).toContain('git-commit-data.sh --slice-only');
    expect(reconcileWorkflow).toContain("SKIP_AI_TRANSLATION: '1'");
  });
});
