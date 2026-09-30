import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('protected data refreshes publish through pull requests', () => {
  const refreshes = [
    {
      workflowPath: '.github/workflows/refresh-job-popularity.yml',
      outputPaths: ['data/job-popularity.json', 'data/job-popularity.meta.json'],
    },
    {
      workflowPath: '.github/workflows/refresh-article-trending.yml',
      outputPaths: ['public/article-trending.json'],
    },
    {
      workflowPath: '.github/workflows/cron-dispatch-canary.yml',
      outputPaths: ['data/cron-dispatch-history.jsonl'],
    },
    {
      workflowPath: '.github/workflows/update-weather.yml',
      outputPaths: ['data/weather-snapshot.json'],
    },
    {
      workflowPath: '.github/workflows/sync-pharmacy-duties-italy.yml',
      outputPaths: ['data/pharmacy-duties-italy.json', 'data/pharmacy-duties-italy-status.json'],
    },
  ];

  it.each(refreshes)('$workflowPath uses the shared PR publisher', ({ workflowPath, outputPaths }) => {
    const workflow = read(workflowPath);
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('load-rc-env.mjs');
    expect(workflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(workflow).toContain('## Implementato');
    expect(workflow).toContain('## Non implementato (ancora)');
    for (const outputPath of outputPaths) expect(workflow).toContain(`--path ${outputPath}`);
    expect(workflow).toMatch(/GH_TOKEN:\s*\$\{\{\s*env\.(?:APP_TOKEN|GITHUB_PAT)/);
    expect(workflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).not.toMatch(/git\s+push\b/);
  });

  it.each([
    '.github/workflows/refresh-job-popularity.yml',
    '.github/workflows/refresh-article-trending.yml',
  ])('%s mints the app identity used to trigger the PR checks', (workflowPath) => {
    expect(read(workflowPath)).toContain('mint-app-token.mjs');
  });

  it('gives append-only canary samples separate PR branches', () => {
    const workflow = read('.github/workflows/cron-dispatch-canary.yml');
    expect(workflow).toContain('chore/cron-dispatch-canary/${GITHUB_RUN_ID}');
  });

  it('keeps the shared publisher on the PR path, never main', () => {
    const helper = read('scripts/lib/open-data-refresh-pr.sh');
    expect(helper).toContain('gh pr create');
    expect(helper).toContain('--base main');
    expect(helper).toContain('HEAD:${BRANCH}');
    expect(helper).toContain('--force-with-lease');
    expect(helper).not.toMatch(/HEAD:main/);
  });
});
