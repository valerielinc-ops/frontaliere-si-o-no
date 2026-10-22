import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflowPath = resolve('.github/workflows/deploy-stalled-watchdog.yml');
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source) as any;

describe('deploy-stalled-watchdog.yml', () => {
  it('covers schedule gaps, terminal deploy runs, and main pushes', () => {
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining([
      'schedule',
      'push',
      'workflow_run',
      'workflow_dispatch',
    ]));
    expect(source).toContain("cron: '3,13,23,33,43,53 * * * *'");
    expect(workflow.on.workflow_run.workflows).toContain('Deploy to GitHub Pages');
    expect(workflow.on.workflow_run.types).toContain('completed');
  });

  it('is a read/dispatch resolver, never a second build or publisher', () => {
    expect(workflow.concurrency).toEqual({
      group: 'deploy-rearm-dispatch',
      'cancel-in-progress': false,
    });
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'write', statuses: 'read' });
    expect(source).toContain('scripts/ci/rearm-deploy-build.mjs');
    expect(source).toContain("REARM_SKIP_LOCALE_RECOVERY: '1'");
    expect(source).not.toContain('npm ci');
    expect(source).not.toContain('vite build');
    expect(source).not.toContain('deploy-publish.yml');
  });
});
