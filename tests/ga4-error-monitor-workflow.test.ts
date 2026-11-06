import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/ga4-error-monitor.yml'), 'utf8');

describe('GA4 Error Monitor workflow', () => {
  it('runs daily at the existing 07:25 UTC slot', () => {
    expect(workflow).toContain("- cron: '25 7 * * *'");
    expect(workflow).not.toContain("- cron: '25 7 * * 2'");
  });

  it('passes the GA4 window to the issue-producing sync script', () => {
    expect(workflow).toContain('name: Sync GA4 app_error issues to backlog');
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain("WINDOW_DAYS: ${{ inputs.windowDays || '7' }}");
    expect(workflow).toContain('run: node scripts/posthog-error-issue-sync.mjs');
  });
});
