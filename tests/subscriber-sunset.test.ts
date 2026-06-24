import { describe, it, expect } from 'vitest';
import {
  classifySunset,
  SUNSET_MIN_SENDS,
  SUNSET_MIN_AGE_DAYS,
  WINBACK_GRACE_DAYS,
} from '../scripts/lib/subscriberSunset.mjs';

const NOW = 1_700_000_000_000; // fixed reference; all fixtures are relative to it
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY;

// A conclamated zombie: long on the list, many sends, zero open/click.
function zombie(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    send_count: SUNSET_MIN_SENDS + 5,
    open_count: 0,
    click_count: 0,
    created_at: daysAgo(SUNSET_MIN_AGE_DAYS + 30),
    ...overrides,
  };
}

describe('classifySunset', () => {
  it('flags a never-engaged long-term subscriber for win-back first', () => {
    expect(classifySunset(zombie(), NOW).action).toBe('winback');
  });

  it('does not touch subscribers below the send threshold', () => {
    expect(classifySunset(zombie({ send_count: SUNSET_MIN_SENDS - 1 }), NOW).action).toBe('none');
  });

  it('does not touch subscribers younger than the age window', () => {
    expect(classifySunset(zombie({ created_at: daysAgo(SUNSET_MIN_AGE_DAYS - 1) }), NOW).action).toBe('none');
  });

  it('spares anyone who has ever opened OR clicked', () => {
    expect(classifySunset(zombie({ open_count: 1 }), NOW).action).toBe('none');
    expect(classifySunset(zombie({ click_count: 1 }), NOW).action).toBe('none');
  });

  it('honors the camelCase field spellings too', () => {
    const camel = { status: 'active', sendCount: 20, openCount: 0, clickCount: 0, createdAt: daysAgo(200) };
    expect(classifySunset(camel, NOW).action).toBe('winback');
  });

  it('waits out the grace window after a win-back before sunsetting', () => {
    const withinGrace = zombie({ winback_sent_at: daysAgo(WINBACK_GRACE_DAYS - 1) });
    expect(classifySunset(withinGrace, NOW).action).toBe('none');

    const graceExpired = zombie({ winback_sent_at: daysAgo(WINBACK_GRACE_DAYS + 1) });
    expect(classifySunset(graceExpired, NOW).action).toBe('sunset');
  });

  it('reactivates an inactive subscriber who has since engaged', () => {
    expect(classifySunset({ status: 'inactive', open_count: 1 }, NOW).action).toBe('reactivate');
  });

  it('leaves a still-silent inactive subscriber alone (no churn, no re-mail)', () => {
    expect(classifySunset({ status: 'inactive', open_count: 0, click_count: 0 }, NOW).action).toBe('none');
  });

  it('never touches unsubscribed / bounced / complained / suppressed', () => {
    for (const status of ['unsubscribed', 'bounced', 'complained', 'suppressed']) {
      expect(classifySunset(zombie({ status }), NOW).action).toBe('none');
    }
  });

  it('treats a missing status as mailable', () => {
    const noStatus = zombie();
    delete (noStatus as Record<string, unknown>).status;
    expect(classifySunset(noStatus, NOW).action).toBe('winback');
  });

  it('handles Firestore Timestamp-shaped dates ({ _seconds })', () => {
    const ts = { _seconds: Math.floor(daysAgo(200) / 1000) };
    expect(classifySunset(zombie({ created_at: ts }), NOW).action).toBe('winback');
  });
});
