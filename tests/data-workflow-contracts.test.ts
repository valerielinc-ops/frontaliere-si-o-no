import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEGACY_CRAWLER_RESIDUE_PATHS } from '../scripts/cleanup-legacy-crawler-residues.mjs';

const cleanupWorkflow = readFileSync(
  new URL('../.github/workflows/cleanup-stale-jobs.yml', import.meta.url),
  'utf8',
);
const reconcileWorkflow = readFileSync(
  new URL('../.github/workflows/reconcile-expired-route-duplicates.yml', import.meta.url),
  'utf8',
);

describe('scheduled data workflow contracts (#8500, #8485)', () => {
  it('#9142 checkpoints the legacy Coop purge before the bounded cleanup can time out', () => {
    const purge = cleanupWorkflow.indexOf('- name: Remove legacy crawler scratch archives');
    const checkpoint = cleanupWorkflow.indexOf('- name: Commit legacy crawler residue cleanup');
    const sliceCleanup = cleanupWorkflow.indexOf('- name: Cleanup each per-crawler slice');
    expect(purge).toBeGreaterThanOrEqual(0);
    expect(checkpoint).toBeGreaterThan(purge);
    expect(sliceCleanup).toBeGreaterThan(checkpoint);
    expect(cleanupWorkflow.slice(checkpoint, sliceCleanup)).toContain(
      'git-commit-data.sh --extra-only',
    );
    expect(cleanupWorkflow.slice(checkpoint, sliceCleanup)).toContain(
      'data/jobs/expired/by-crawler/coop-ticino-locale-cache.json',
    );
  });

  it('#9142 publishes every path the legacy residue purge may delete', () => {
    // --extra-only names its complete ownership surface: a residue the purge
    // deletes but the checkpoint does not name is removed on the runner and
    // never reaches main (the active-side Coop sentinel stayed after #11295).
    const checkpoint = cleanupWorkflow.slice(
      cleanupWorkflow.indexOf('- name: Commit legacy crawler residue cleanup'),
      cleanupWorkflow.indexOf('- name: Cleanup each per-crawler slice'),
    );
    const commitLine = checkpoint.split('\n').find((line) => line.includes('git-commit-data.sh --extra-only')) ?? '';
    const namedPaths = commitLine.split(/\s+/).filter((token) => token.startsWith('data/'));
    expect(LEGACY_CRAWLER_RESIDUE_PATHS.length).toBeGreaterThan(0);
    expect([...namedPaths].sort()).toEqual([...LEGACY_CRAWLER_RESIDUE_PATHS].sort());
  });

  it('#8500 delegates URL validation and fails closed per slice', () => {
    const cleanupStep = cleanupWorkflow.slice(
      cleanupWorkflow.indexOf('- name: Cleanup each per-crawler slice'),
      cleanupWorkflow.indexOf('- name: Commit Phase 1'),
    );
    expect(cleanupStep).toContain("JOBS_SKIP_URL_VALIDATION: '1'");
    expect(cleanupStep).toContain('bash scripts/cleanup-stale-job-slices.sh');
    expect(cleanupStep).not.toContain('cleanup-jobs.mjs || true');
    expect(cleanupStep).not.toContain('JOBS_HOUSEKEEPING_TIMEOUT_MS');
    expect(cleanupStep).not.toContain('JOBS_HOUSEKEEPING_CONCURRENCY');
    expect(cleanupWorkflow).toContain('benchmark-cleanup-slices:');
    expect(cleanupWorkflow).toContain("github.event.inputs.benchmark_only == 'true'");
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
