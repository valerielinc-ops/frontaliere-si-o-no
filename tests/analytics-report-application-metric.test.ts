import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../scripts/analytics-report.mjs'), 'utf8');

describe('analytics-report qualified application metric', () => {
  it('queries distinct GA4 sessions for both funnel events', () => {
    expect(source).toContain("JOB_QUALIFIED_SESSION_EVENT = 'job_qualified_session'");
    expect(source).toContain("JOB_APPLY_HANDOFF_EVENT = 'job_apply_handoff'");
    expect(source).toContain("metrics: [{ name: 'sessions' }]");
    expect(source).toContain("matchType: 'EXACT'");
  });

  it('keeps the redirect metric separate from submitted applications', () => {
    expect(source).toContain("name: 'valid_apply_access_per_1000_qualified_sessions'");
    expect(source).toContain("status: 'handoff_not_submitted_application'");
    expect(source).toContain('job_apply_handoff records an external redirect only; no submission is inferred');
  });
});
