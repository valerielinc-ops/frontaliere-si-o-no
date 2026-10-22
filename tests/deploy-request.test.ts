import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const requestPath = resolve('.github/workflows/deploy-request.yml');
const deployPath = resolve('.github/workflows/deploy.yml');

describe('deploy-request.yml — solo riconcilia la pubblicazione', () => {
  const request = readFileSync(requestPath, 'utf8');
  const workflow = YAML.parse(request) as any;

  it('non contiene più alcun lancio di deploy.yml', () => {
    expect(request).not.toContain('request-latest-deploy.mjs');
    expect(request).not.toMatch(/gh workflow run\s+deploy\.yml/);
    expect(request).not.toMatch(/actions\/workflows\/deploy\.yml\/dispatches/);
    expect(request).toContain('request-latest-publish.mjs');
  });

  it('resta una rete di sicurezza per publish, con trigger brevi e bounded', () => {
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining([
      'workflow_dispatch',
      'schedule',
      'workflow_run',
    ]));
    expect(request).toContain("cron: '*/10 * * * *'");
    expect(request).toContain('group: deploy-request-dispatcher');
    expect(request).toContain('APP_TOKEN_ACTIONS');
    expect(request).toContain('APP_TOKEN_DEPLOYMENTS_READ');
    expect(request).toContain('APP_TOKEN_STATUSES_READ');
    expect(request).toContain('GH_TOKEN="$APP_TOKEN" node scripts/ci/request-latest-publish.mjs');
  });
});

describe('deploy.yml — la build si riattiva da sola', () => {
  const deploy = readFileSync(deployPath, 'utf8');
  const workflow = YAML.parse(deploy) as any;

  it('usa schedule solo come resolver leggero e mantiene il lock build', () => {
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(['schedule', 'workflow_dispatch']));
    expect(deploy).toContain("cron: '*/10 * * * *'");
    expect(deploy).toMatch(/group:.*pages-build-run/);
    expect(deploy).toContain('cancel-in-progress: false');
    expect(workflow.jobs['schedule-reconcile'].if).toContain("github.event_name == 'schedule'");
  });

  it('riavvia deploy.yml dal job finale con GITHUB_TOKEN e actions:write', () => {
    const rearm = workflow.jobs.rearm;
    expect(rearm.if).toContain('always()');
    expect(rearm.needs).toContain('build-locale');
    expect(rearm.permissions).toMatchObject({ actions: 'write' });
    expect(deploy).toContain('gh workflow run deploy-publish.yml');
    expect(deploy).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(deploy).not.toContain('gh workflow run deploy.yml');
    expect(deploy).not.toContain('mint-app-token.mjs');
  });
});
