import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOW = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/sync-pharmacy-duties.yml'),
  'utf8',
);

describe('sync-pharmacy-duties workflow', () => {
  it('uses the shared rebase-retry path for concurrent main writers', () => {
    expect(WORKFLOW).toContain('bash scripts/lib/git-push-with-retry.sh');
    expect(WORKFLOW).toContain('--regenerate-cmd');
    expect(WORKFLOW).toContain('node scripts/sync-pharmacy-duties.mjs');
    expect(WORKFLOW).toContain('git add data/pharmacy-duties-ticino.json data/pharmacy-duties-ticino-status.json');
    expect(WORKFLOW).not.toContain('git push origin HEAD:main');
  });

  it('loads the ruleset-bypass credentials before invoking the helper', () => {
    const credentials = WORKFLOW.indexOf('node scripts/load-rc-env.mjs');
    const pushHelper = WORKFLOW.indexOf('bash scripts/lib/git-push-with-retry.sh');
    expect(credentials).toBeGreaterThan(-1);
    expect(pushHelper).toBeGreaterThan(credentials);
  });
});
