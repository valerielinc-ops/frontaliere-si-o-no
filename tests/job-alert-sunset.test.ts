import { describe, it, expect } from 'vitest';
import {
  classifyJobAlertSunset,
  JOB_ALERT_SUNSET_MIN_DELIVERED,
  JOB_ALERT_SUNSET_MIN_AGE_DAYS,
} from '../scripts/lib/jobAlertSunset.mjs';

const NOW = 1_700_000_000_000; // fixed reference; all fixtures are relative to it
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY;

// A conclamated zombie: long on the list, many deliveries, zero open/click.
function zombie(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    delivered_count: JOB_ALERT_SUNSET_MIN_DELIVERED + 5,
    open_count: 0,
    click_count: 0,
    createdAt: daysAgo(JOB_ALERT_SUNSET_MIN_AGE_DAYS + 30),
    ...overrides,
  };
}

describe('classifyJobAlertSunset', () => {
  it('sunsets a never-engaged long-term job-alert subscriber directly (no win-back stage)', () => {
    expect(classifyJobAlertSunset(zombie(), NOW).action).toBe('sunset');
  });

  it('does not touch subscribers below the delivered-count threshold', () => {
    expect(classifyJobAlertSunset(zombie({ delivered_count: JOB_ALERT_SUNSET_MIN_DELIVERED - 1 }), NOW).action).toBe('none');
  });

  it('does not touch subscribers younger than the age window', () => {
    expect(classifyJobAlertSunset(zombie({ createdAt: daysAgo(JOB_ALERT_SUNSET_MIN_AGE_DAYS - 1) }), NOW).action).toBe('none');
  });

  it('does not touch a subscriber with no age anchor at all (conservative default)', () => {
    expect(classifyJobAlertSunset(zombie({ createdAt: undefined }), NOW).action).toBe('none');
  });

  it('spares anyone who has ever opened OR clicked', () => {
    expect(classifyJobAlertSunset(zombie({ open_count: 1 }), NOW).action).toBe('none');
    expect(classifyJobAlertSunset(zombie({ click_count: 1 }), NOW).action).toBe('none');
  });

  it('honors the camelCase field spellings too', () => {
    const camel = {
      status: 'active',
      deliveredCount: JOB_ALERT_SUNSET_MIN_DELIVERED + 1,
      openCount: 0,
      clickCount: 0,
      createdAt: daysAgo(JOB_ALERT_SUNSET_MIN_AGE_DAYS + 1),
    };
    expect(classifyJobAlertSunset(camel, NOW).action).toBe('sunset');
  });

  it('never touches hard cross-channel signals (bounced/complained/suppressed)', () => {
    for (const status of ['bounced', 'complained', 'suppressed']) {
      expect(classifyJobAlertSunset(zombie({ status }), NOW).action).toBe('none');
    }
  });

  it('reactivates an inactive subscriber who has since engaged', () => {
    const reengaged = zombie({ status: 'inactive', open_count: 1 });
    expect(classifyJobAlertSunset(reengaged, NOW).action).toBe('reactivate');
  });

  it('leaves an inactive subscriber alone while still unengaged', () => {
    const stillDark = zombie({ status: 'inactive' });
    expect(classifyJobAlertSunset(stillDark, NOW).action).toBe('none');
  });

  it('treats an empty/missing status as mailable', () => {
    expect(classifyJobAlertSunset(zombie({ status: '' }), NOW).action).toBe('sunset');
    expect(classifyJobAlertSunset(zombie({ status: undefined }), NOW).action).toBe('sunset');
  });
});
