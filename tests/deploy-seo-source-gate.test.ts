import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/deploy.yml');

function workflowSteps(job: Record<string, any>): Array<Record<string, any>> {
  return Array.isArray(job?.steps) ? job.steps : [];
}

describe('deploy SEO source preflight', () => {
  it('gates the locale matrix once, before expensive shared prep', () => {
    const workflow = YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8')) as {
      jobs?: Record<string, Record<string, any>>;
    };
    const prep = workflow.jobs?.prep;
    const buildLocale = workflow.jobs?.['build-locale'];

    expect(prep).toBeDefined();
    expect(buildLocale).toBeDefined();
    expect(prep?.needs).toBe('matrix-setup');
    expect(buildLocale?.needs).toEqual(expect.arrayContaining(['prep']));

    const prepGateSteps = workflowSteps(prep!).filter((step) => step.name === 'Run SEO source tests once per build');
    expect(prepGateSteps).toHaveLength(1);
    expect(prepGateSteps[0].run).toBe('npm run gate:seo-source');
    expect(prepGateSteps[0]['timeout-minutes']).toBe(25);
    expect(prepGateSteps[0].env).toMatchObject({
      BUILD_LOCALE: '',
      VITEST_SKIP_LIVE_DATA: 'true',
    });

    const prepGateIndex = workflowSteps(prep!).indexOf(prepGateSteps[0]);
    const assembleIndex = workflowSteps(prep!).findIndex((step) => step.name === 'Assemble jobs dataset from per-crawler slices');
    expect(prepGateIndex).toBeGreaterThanOrEqual(0);
    expect(assembleIndex).toBeGreaterThan(prepGateIndex);

    expect(workflowSteps(buildLocale!).some((step) => step.run === 'npm run gate:seo-source')).toBe(false);
  });
});
