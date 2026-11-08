import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GA4_PROMOTION_EVENT_NAMES,
  GA4_PROMOTION_ISSUE_NUMBER,
  sanitizePromotionReport,
  validateAppliedPlan,
  validateReadPlan,
} from '../scripts/ci/promote-ga4-key-events.mjs';

const baseResult = (planOverrides: Record<string, Record<string, unknown>> = {}) => ({
  propertyId: 'properties/524485296',
  lookbackDays: 28,
  plan: [
    {
      eventName: 'newsletter_subscribe',
      action: 'create',
      counting: 'ONCE_PER_EVENT',
      eventCount: 3,
      ...planOverrides.newsletter_subscribe,
    },
    {
      eventName: 'login',
      action: 'create',
      counting: 'ONCE_PER_SESSION',
      eventCount: 2,
      ...planOverrides.login,
    },
    {
      eventName: 'job_apply_handoff',
      action: 'exists',
      counting: 'ONCE_PER_EVENT',
      eventCount: 12,
      ...planOverrides.job_apply_handoff,
    },
  ],
});

describe('trusted GA4 newsletter/login promotion', () => {
  it('requires both target events to be observed and rejects unrelated creates', () => {
    expect(() => validateReadPlan(baseResult({
      job_apply_handoff: { action: 'create' },
    }))).toThrow(/unexpected events/u);

    const safeRead = baseResult({
      job_apply_handoff: { action: 'exists' },
    });
    expect(validateReadPlan(safeRead)).toBe(true);
  });

  it('does not authorize an unobserved target or a counting mismatch', () => {
    expect(() => validateReadPlan(baseResult({ login: { eventCount: 0 } }))).toThrow(/no settled observations/u);
    expect(() => validateReadPlan(baseResult({ login: { action: 'counting_mismatch' } }))).toThrow(/not safe/u);
  });

  it('accepts only created/existing targets after apply', () => {
    const applied = baseResult({
      newsletter_subscribe: { action: 'created' },
      login: { action: 'exists' },
    });
    expect(validateAppliedPlan(applied)).toBe(true);
    expect(() => validateAppliedPlan(baseResult({
      newsletter_subscribe: { action: 'created' },
      login: { action: 'created' },
      job_apply_handoff: { action: 'created' },
    }))).toThrow(/unexpected events/u);
  });

  it('writes only sanitized plan fields for the model-visible evidence', () => {
    const read = baseResult({
      newsletter_subscribe: { action: 'exists', reason: 'private detail', resource: 'secret-shaped-id' },
      login: { action: 'exists', reason: 'private detail', resource: 'secret-shaped-id' },
      job_apply_handoff: { action: 'exists', reason: 'private detail', resource: 'secret-shaped-id' },
    });
    const report = sanitizePromotionReport({ issueNumber: GA4_PROMOTION_ISSUE_NUMBER, read, applied: read });
    expect(report.targetEventNames).toEqual([...GA4_PROMOTION_EVENT_NAMES]);
    expect(JSON.stringify(report)).not.toContain('private detail');
    expect(JSON.stringify(report)).not.toContain('secret-shaped-id');
    expect(report.status).toBe('promoted');
  });

  it('keeps the credentialed operation out of the Codex action', () => {
    const workflow = readFileSync('.github/workflows/ga4-key-events-promotion.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('FIREBASE_SERVICE_ACCOUNT_JSON: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}');
    expect(workflow).toContain('node scripts/ci/promote-ga4-key-events.mjs');
    expect(workflow).not.toContain('claude-codex-fallback');
  });
});
