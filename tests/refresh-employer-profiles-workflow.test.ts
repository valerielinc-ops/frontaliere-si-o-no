import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = YAML.parse(
  fs.readFileSync(
    path.resolve(__dirname, '..', '.github/workflows/refresh-employer-profiles.yml'),
    'utf8',
  ),
);

describe('refresh-employer-profiles assembly memory contract', () => {
  const steps = workflow.jobs.refresh.steps;

  it('keeps the full corpus assembly on the proven 8 GiB heap', () => {
    const assemble = steps.find(
      (step: { name?: string }) => step.name === 'Assemble active-job corpus',
    );

    expect(assemble?.run).toBe('node scripts/assemble-jobs-dataset.mjs');
    expect(assemble?.env?.NODE_OPTIONS).toBe('--max-old-space-size=8192');
  });

  it('keeps rebase regeneration on the same heap contract', () => {
    const commit = steps.find(
      (step: { name?: string }) => step.name === 'Commit and push employer-profiles snapshot',
    );

    expect(commit?.run).toContain(
      'NODE_OPTIONS=--max-old-space-size=8192 node scripts/assemble-jobs-dataset.mjs',
    );
  });
});
