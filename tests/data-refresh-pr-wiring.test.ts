import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('protected data refreshes publish through pull requests', () => {
  const refreshes = [
    '.github/workflows/refresh-job-popularity.yml',
    '.github/workflows/refresh-article-trending.yml',
    '.github/workflows/crawler-health-monitor.yml',
    '.github/workflows/build-evidence-and-tune.yml',
    '.github/workflows/discover-404s.yml',
  ];

  it.each(refreshes)('%s uses the shared PR publisher', (workflowPath) => {
    const workflow = read(workflowPath);
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('load-rc-env.mjs');
    expect(workflow).toContain('mint-app-token.mjs');
    expect(workflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(workflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).not.toMatch(/git\s+push\b/);
  });

  it('keeps the shared publisher on the PR path, never main', () => {
    const helper = read('scripts/lib/open-data-refresh-pr.sh');
    expect(helper).toContain('gh pr create');
    expect(helper).toContain('--base main');
    expect(helper).toContain('HEAD:${BRANCH}');
    expect(helper).toContain('--force-with-lease');
    expect(helper).not.toMatch(/HEAD:main/);
  });

  it('passes the evidence PR branch from the build job into quota tuning', () => {
    const workflow = read('.github/workflows/build-evidence-and-tune.yml');
    const branchCheckout = workflow.indexOf('git checkout -B "$DATA_REFRESH_BRANCH" FETCH_HEAD');
    const tune = workflow.indexOf('node scripts/tune-discovery-quota.mjs');
    const publishers = workflow.match(/scripts\/lib\/open-data-refresh-pr\.sh/g) ?? [];
    const branchPublishers = workflow.match(/--branch "\$DATA_REFRESH_BRANCH"/g) ?? [];

    expect(workflow).toContain('git ls-remote --heads origin');
    expect(branchCheckout).toBeGreaterThan(-1);
    expect(tune).toBeGreaterThan(branchCheckout);
    expect(publishers).toHaveLength(2);
    expect(branchPublishers).toHaveLength(2);
    expect(workflow).toContain('DATA_REFRESH_BRANCH: chore/build-evidence-and-tune');
  });

  it('lets the merged 404 PR trigger deployment from main', () => {
    const workflow = read('.github/workflows/discover-404s.yml');
    expect(workflow).toContain('Open PR with discovered 404 data');
    expect(workflow).not.toContain('scripts/lib/trigger-deploy.sh');
    expect(workflow).not.toContain('Trigger deploy if compat changed');
  });
});
