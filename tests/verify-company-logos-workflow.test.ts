import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflowPath = path.resolve('.github/workflows/verify-company-logos-weekly.yml');

describe('Verify Company Logos workflow', () => {
  it('installs the locked dependencies before assembling the dataset', () => {
    const workflow = YAML.parse(fs.readFileSync(workflowPath, 'utf8')) as {
      jobs?: { verify?: { steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, string> }> } };
    };
    const steps = workflow.jobs?.verify?.steps ?? [];
    const setupIndex = steps.findIndex((step) => step.uses === 'actions/setup-node@v5');
    const installIndex = steps.findIndex((step) => step.name === 'Install dependencies');
    const assembleIndex = steps.findIndex((step) => step.name === 'Assemble canonical jobs dataset');
    const verifyIndex = steps.findIndex((step) => step.name === 'Verify company logos');
    const commitIndex = steps.findIndex((step) => step.name === 'Commit + push broken-logos report');
    const setup = steps[setupIndex];
    const install = steps[installIndex];
    const verify = steps[verifyIndex];
    const commit = steps[commitIndex];
    const source = fs.readFileSync(workflowPath, 'utf8');

    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(setup?.with?.cache).toBe('npm');
    expect(installIndex).toBeGreaterThan(setupIndex);
    expect(installIndex).toBeLessThan(assembleIndex);
    expect(install?.run).toBe('npm ci --ignore-scripts --no-audit --no-fund');
    expect(verify?.run).toBe('./node_modules/.bin/tsx scripts/verify-company-logos.mjs');
    expect(commit?.run).toContain('--regenerate-cmd "./node_modules/.bin/tsx scripts/verify-company-logos.mjs; git add data/company-logos-broken.json"');
    expect(source).not.toContain('npx tsx');
  });
});
