import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = '.github/workflows/crawler-health-monitor.yml';

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('crawler health state publication', () => {
  it('publishes the state through the shared PR path', () => {
    const workflow = read(WORKFLOW);
    const publisher = read('scripts/lib/open-data-refresh-pr.sh');

    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('node scripts/load-rc-env.mjs');
    expect(workflow).toContain('node scripts/ci/mint-app-token.mjs');
    expect(workflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(workflow).toContain('--path data/crawler-health.json');
    expect(workflow).toContain('--branch chore/refresh-crawler-health');
    expect(workflow).toContain(
      "GH_TOKEN: ${{ env.APP_TOKEN_DATA_REFRESH == 'true' && env.APP_TOKEN || env.GITHUB_PAT }}",
    );
    expect(workflow).toContain('## Implementato');
    expect(workflow).toContain('## Non implementato (ancora)');
    expect(workflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).not.toMatch(/git\s+push\b/);
    expect(publisher).toContain('git config user.name "frontaliere-automation[bot]"');
    expect(publisher).toContain(
      'git config user.email "296434481+frontaliere-automation[bot]@users.noreply.github.com"',
    );
    expect(publisher).not.toContain('valerielinc@gmail.com');
  });

  it('keeps state persistence unconditional after the health verdict', () => {
    const workflow = read(WORKFLOW);
    const stateStep = workflow.indexOf('- name: Open PR with updated health state');
    const healthStep = workflow.indexOf('- name: Run health check');

    expect(stateStep).toBeGreaterThan(healthStep);
    expect(workflow.slice(stateStep)).toContain('if: always()');
  });

  it('seeds the health check from an in-flight stable PR before calculating the next run', () => {
    const workflow = read(WORKFLOW);
    const seedStep = workflow.indexOf('- name: Carry forward pending crawler health PR');
    const healthStep = workflow.indexOf('- name: Run health check');
    const seed = workflow.slice(seedStep, healthStep);

    expect(seedStep).toBeGreaterThan(-1);
    expect(seedStep).toBeLessThan(healthStep);
    expect(seed).toContain("branch='chore/refresh-crawler-health'");
    expect(seed).toContain("state_path='data/crawler-health.json'");
    expect(seed).toContain(
      'refs/heads/${branch}:refs/remotes/origin/${branch}',
    );
    expect(seed).toContain(
      'git show "refs/remotes/origin/${branch}:${state_path}" > "${state_path}"',
    );
  });
});
