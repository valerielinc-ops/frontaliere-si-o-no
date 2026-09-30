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

  it('publishes changed corpus registries through the shared strict CDN path', () => {
    const commitIndex = steps.findIndex((step) => step.name === 'Commit if changed');
    const acquireIndex = steps.findIndex((step) => step.name === 'Acquire article chunk section locks for synced corpus');
    const publishIndex = steps.findIndex((step) => step.name === 'Publish client article chunks for synced corpus');
    const releaseIndex = steps.findIndex((step) => step.name === 'Release article chunk section locks for synced corpus');
    const publish = stepNamed('Publish client article chunks for synced corpus');
    const release = stepNamed('Release article chunk section locks for synced corpus');

    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(acquireIndex).toBeGreaterThan(commitIndex);
    expect(publishIndex).toBeGreaterThan(acquireIndex);
    expect(releaseIndex).toBeGreaterThan(publishIndex);
    expect(publish.if).toContain("steps.commit.outputs.article-content-changed == 'true'");
    expect(publish.if).toContain("steps.check_synced_chunk_source.outputs.current == 'true'");
    expect(publish.run).toContain('scripts/publish-article-chunks.mjs --strict --no-ticker');
    expect(publish['continue-on-error']).toBeUndefined();
    expect(release.if).toContain('always()');
    expect(release.run).toContain('scripts/lib/r2-section-lock.mjs release --section frontaliere,svizzera');

    const commitRun = stepNamed('Commit if changed').run ?? '';
    expect(commitRun).toContain('article-content-changed=true');
    expect(commitRun).toContain('article-content-changed=false');
    expect(commitRun.indexOf('article-content-changed=false')).toBeLessThan(commitRun.indexOf('git commit'));
  });

  it('shares the source freshness and lock checks with the existing chunk publishers', () => {
    const source = stepNamed('Check synced article chunk source is current').run ?? '';
    const before = stepNamed('Verify synced article chunk lock before publication').run ?? '';
    const after = stepNamed('Verify synced article chunk lock after publication').run ?? '';
    expect(source).toContain('git fetch --no-tags --depth=1 origin main');
    expect(source).toContain('scripts/lib/article-chunk-publish-freshness.mjs');
    expect(source).toContain('git checkout --detach --force origin/main');
    expect(before).toContain('LOCK_RENEW_FAILURE_FILE');
    expect(before).toContain('kill -0');
    expect(after).toContain('LOCK_RENEW_FAILURE_FILE');
    expect(after).toContain('kill -0');
  });
});
