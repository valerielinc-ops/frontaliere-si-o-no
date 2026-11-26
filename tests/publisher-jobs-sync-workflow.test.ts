import fs from 'node:fs';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = YAML.parse(
  fs.readFileSync('.github/workflows/publisher-jobs-sync.yml', 'utf8'),
);

describe('publisher-jobs-sync assembly memory contract', () => {
  it('keeps the full validation assembly on the proven 8 GiB heap', () => {
    const steps = workflow.jobs['publisher-jobs-sync'].steps;
    const validate = steps.find(
      (step: { name?: string }) => step.name === 'Validate — dataset assembles with the new slice',
    );

    expect(validate?.run).toBe('node scripts/assemble-jobs-dataset.mjs --stats');
    expect(validate?.env?.NODE_OPTIONS).toBe('--max-old-space-size=8192');
  });
});
