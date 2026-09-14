import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOW = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/sync-pharmacy-duties.yml'),
  'utf8',
);
const BORDER_WORKFLOW = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/sync-pharmacies-border.yml'),
  'utf8',
);

describe('sync-pharmacy-duties workflow', () => {
  it('delegates the manual duty trigger to the atomic border writer', () => {
    expect(WORKFLOW).toContain('workflow_dispatch: {}');
    expect(WORKFLOW).toContain('uses: ./.github/workflows/sync-pharmacies-border.yml');
    expect(WORKFLOW).not.toContain('schedule:');
    expect(WORKFLOW).not.toContain('git push');
    expect(WORKFLOW).not.toContain('node scripts/sync-pharmacy-duties.mjs');
  });

  it('keeps retry and ruleset-bypass auth in the called writer', () => {
    const credentials = BORDER_WORKFLOW.indexOf('node scripts/load-rc-env.mjs');
    const pushHelper = BORDER_WORKFLOW.indexOf('bash scripts/lib/git-push-with-retry.sh');
    expect(credentials).toBeGreaterThan(-1);
    expect(pushHelper).toBeGreaterThan(credentials);
    expect(BORDER_WORKFLOW).toContain('--regenerate-cmd');
    expect(BORDER_WORKFLOW).toContain('node scripts/sync-pharmacy-duties.mjs');
    expect(BORDER_WORKFLOW).toContain('git add data/pharmacies-ticino-complete.json data/pharmacies-italy-border.json data/pharmacy-duties-ticino.json data/pharmacy-duties-ticino-status.json');
  });
});
