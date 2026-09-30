import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('protected data refreshes publish through pull requests', () => {
  const refreshes = [
    '.github/workflows/refresh-job-popularity.yml',
    '.github/workflows/refresh-article-trending.yml',
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
});
