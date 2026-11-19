import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const workflow = YAML.parse(
  readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8'),
) as any;
const prepSteps = workflow.jobs.prep.steps as Array<any>;

function stepIndex(name: string): number {
  return prepSteps.findIndex((step) => step.name === name);
}

describe('deploy hardened jobs source sync', () => {
  it('scatters and commits only crawler slices before packing the prepared snapshot', () => {
    const loadCredentials = stepIndex('Load secrets from Remote Config');
    const cleanup = stepIndex('Housekeeping (cross-crawler dedup + locale hardening)');
    const credential = stepIndex('Require source-slice push credential');
    const scatter = stepIndex('Scatter hardened jobs back to crawler slices');
    const commit = stepIndex('Commit hardened jobs to crawler slices');
    const pack = stepIndex('Pack prepared snapshot (generated data + thumbnails)');

    expect(loadCredentials).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(loadCredentials);
    expect(credential).toBeGreaterThan(cleanup);
    expect(scatter).toBeGreaterThan(credential);
    expect(commit).toBeGreaterThan(scatter);
    expect(pack).toBeGreaterThan(commit);

    expect(prepSteps[credential].run).toContain('GITHUB_PAT');
    expect(prepSteps[credential].run).toContain('APP_TOKEN');
    expect(prepSteps[scatter].run).toContain('data/jobs.json');
    expect(prepSteps[scatter].run).toContain('node scripts/scatter-jobs-to-slices.mjs');
    expect(prepSteps[commit].run).toContain('git-commit-data.sh --slice-only');
    expect(prepSteps[commit].run).not.toContain('data/jobs.json');
    expect(prepSteps[commit]['continue-on-error']).not.toBe(true);
    expect(workflow.permissions.contents).toBe('read');
  });
});
