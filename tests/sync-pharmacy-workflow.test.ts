import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { buildSyncArgs } from '../scripts/sync-pharmacy-duties.mjs';

const WORKFLOW = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/sync-pharmacy-duties.yml'),
  'utf8',
);
const BORDER_WORKFLOW = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/sync-pharmacies-border.yml'),
  'utf8',
);

describe('sync-pharmacy-duties workflow', () => {
  it('uses a read-only preview for local calls and reserves staged writes for CI', () => {
    const local = buildSyncArgs([], {});
    expect(local).toHaveLength(2);
    expect(local[1]).toBe('--dry-run');
    expect(buildSyncArgs(['--dry-run'], {})).toEqual(local);
    expect(buildSyncArgs([], { PHARMACY_DUTY_STAGE_DIR: '/tmp/pharmacy-stage' })).toHaveLength(1);
  });

  it('delegates manual and cadence duty triggers to the atomic border writer', () => {
    expect(WORKFLOW).toContain('workflow_dispatch: {}');
    expect(WORKFLOW).toContain("cron: '*/15 * * * *'");
    expect(WORKFLOW).toContain('uses: ./.github/workflows/sync-pharmacies-border.yml');
    expect(WORKFLOW).toContain('permissions:\n      contents: write\n    uses: ./.github/workflows/sync-pharmacies-border.yml');
    expect(WORKFLOW).not.toContain('git push');
    expect(WORKFLOW).not.toContain('node scripts/sync-pharmacy-duties.mjs');
  });

  it('keeps the scheduled cadence as a reusable workflow call without writer steps', () => {
    const parsed = parse(WORKFLOW) as {
      on?: { schedule?: Array<{ cron?: string }> };
      jobs?: { sync?: { uses?: string; steps?: unknown[] } };
    };

    expect(parsed.on?.schedule).toEqual([{ cron: '*/15 * * * *' }]);
    expect(parsed.jobs?.sync?.uses).toBe('./.github/workflows/sync-pharmacies-border.yml');
    expect(parsed.jobs?.sync?.steps).toBeUndefined();
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
