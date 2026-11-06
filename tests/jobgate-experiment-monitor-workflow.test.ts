import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowPath = join(__dirname, '..', '.github', 'workflows', 'jobgate-experiment-monitor.yml');
const workflow = parse(readFileSync(workflowPath, 'utf8')) as {
  jobs?: { monitor?: { steps?: Array<{ name?: string; run?: string }> } };
};

describe('jobgate experiment monitor dependency install', () => {
  it('retries bounded transient npm registry failures without weakening fail-closed execution', () => {
    const install = workflow.jobs?.monitor?.steps?.find((step) => step.name === 'Install dependencies');
    expect(install?.run).toMatch(/npm ci --ignore-scripts/);
    expect(install?.run).toMatch(/--no-audit --no-fund/);
    expect(install?.run).toMatch(/--fetch-retries=5/);
    expect(install?.run).toMatch(/--fetch-retry-factor=2/);
    expect(install?.run).toMatch(/--fetch-retry-mintimeout=1000/);
    expect(install?.run).toMatch(/--fetch-retry-maxtimeout=30000/);
  });
});
