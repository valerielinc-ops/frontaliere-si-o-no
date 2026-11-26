import fs from 'node:fs';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = YAML.parse(
  fs.readFileSync('.github/workflows/persist-job-stats.yml', 'utf8'),
) as {
  jobs: {
    'persist-stats': {
      steps: Array<{ name?: string; env?: Record<string, string>; run?: string }>;
    };
  };

const steps = workflow.jobs['persist-stats'].steps;

describe('persist-job-stats assembly memory contract', () => {
  it('gives the full assembly the proven 8 GiB heap', () => {
    const assemble = steps.find((step) => step.name === 'Assemble jobs dataset (with stats)');

    expect(assemble?.env?.NODE_OPTIONS).toBe('--max-old-space-size=8192');
  });

  it('keeps retry regeneration on the same heap contract', () => {
    const commit = steps.find((step) => step.name === 'Commit and push stats history');

    expect(commit?.env?.NODE_OPTIONS).toBe('--max-old-space-size=8192');
    expect(commit?.run).toContain('node scripts/assemble-jobs-dataset.mjs --stats');
  });
});
