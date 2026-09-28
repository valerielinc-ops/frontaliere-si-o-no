import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  name?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: unknown;
};

const WORKFLOW_PATH = path.resolve(
  __dirname,
  '..',
  '.github/workflows/sync-articles-sitemaps.yml',
);
const workflow = parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
  jobs: { sync: { steps: WorkflowStep[] } };
};
const steps = workflow.jobs.sync.steps;

function stepNamed(name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

describe('article corpus sync parser gate', () => {
  it('blocks the direct commit when changed article modules do not parse', () => {
    const validationIndex = steps.findIndex(
      (step) => step.name === 'Validate changed article modules before commit',
    );
    const commitIndex = steps.findIndex((step) => step.name === 'Commit if changed');
    const validation = stepNamed('Validate changed article modules before commit');

    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(validationIndex);
    expect(validation.if).toContain("steps.gate.outputs.skipped != 'true'");
    expect(validation.run).toContain('packages/articles/content');
    expect(validation.run).toContain('npm test -- tests/generated-content-parses.test.ts');
    expect(validation['continue-on-error']).toBeUndefined();
    expect(spawnSync('bash', ['-n', '-c', validation.run], { encoding: 'utf8' }).status).toBe(0);
  });

  it('revalidates corpus content regenerated during a push-conflict retry', () => {
    const command = stepNamed('Commit if changed').run?.match(
      /--regenerate-cmd "([^"]+)"/,
    )?.[1];

    expect(command).toBeDefined();
    expect(command).toContain('node scripts/pull-articles-corpus.mjs');
    expect(command).toContain('node scripts/pull-articles-api.mjs');
    expect(command).toContain('npm test -- tests/generated-content-parses.test.ts');
    expect(command).toContain('git add --');
    expect(command!.indexOf('npm test -- tests/generated-content-parses.test.ts')).toBeLessThan(
      command!.indexOf('git add --'),
    );
    expect(spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' }).status).toBe(0);
  });
});
