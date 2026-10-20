import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/sync-gsc-orphans.yml', import.meta.url), 'utf8'));

describe('GSC orphan workflow assembly reconciliation', () => {
  it('leaves the single full slug-reconciliation pass to the following step', () => {
    const steps = workflow.jobs['sync-orphans'].steps;
    const assembleIndex = steps.findIndex((step: { name?: string }) => step.name === 'Assemble jobs dataset (needed by reconcile)');
    const reconcileIndex = steps.findIndex((step: { name?: string }) => step.name === 'Reconcile orphan + expired slugs with active jobs');

    expect(assembleIndex).toBeGreaterThanOrEqual(0);
    expect(reconcileIndex).toBeGreaterThan(assembleIndex);
    expect(steps[assembleIndex].env.JOBS_SKIP_RECONCILIATION).toBe('1');
    expect(steps[reconcileIndex].run).toBe('node scripts/reconcile-job-slugs.mjs');
  });
});
