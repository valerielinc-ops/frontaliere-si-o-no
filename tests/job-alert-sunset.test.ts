import { describe, it, expect } from 'vitest';
import {
  classifyJobAlertSunset,
  JOB_ALERT_SUNSET_MIN_DELIVERED,
  JOB_ALERT_SUNSET_MIN_AGE_DAYS,
  REPROBE_AFTER_INACTIVE_DAYS,
  REPROBE_MAX_ATTEMPTS,
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

  it('reactivates an inactive subscriber who engaged via a real send during their one-time re-probe (production-reachable path, issue #5559)', () => {
    // Unlike a bare { status: 'inactive', open_count: 1 } fixture: no sender
    // ever writes to job_alert_subscribers while inactive (worse than the
    // newsletter case, per the issue — there isn't even an accidental exit),
    // so open_count can only move again after a re-probe re-admits the
    // subscriber to a mailable status and a real send goes out.
    const reengaged = zombie({ status: 'inactive', sunset_reprobed_at: daysAgo(1), sunset_reprobe_count: 1, open_count: 1 });
    expect(classifyJobAlertSunset(reengaged, NOW).action).toBe('reactivate');
  });

  it('leaves an inactive subscriber alone while still unengaged, until the re-probe window elapses', () => {
    const stillDark = zombie({ status: 'inactive', inactive_at: daysAgo(1) });
    expect(classifyJobAlertSunset(stillDark, NOW).action).toBe('none');
  });

  describe('re-probe — the exit `reactivate` alone cannot provide (issue #5559)', () => {
    it('grants a one-time re-probe once an inactive subscriber has been silent long enough', () => {
      const longSilent = zombie({ status: 'inactive', inactive_at: daysAgo(REPROBE_AFTER_INACTIVE_DAYS + 1) });
      expect(classifyJobAlertSunset(longSilent, NOW).action).toBe('reprobe');
    });

    it('does not re-probe before the silence window elapses', () => {
      const notYet = zombie({ status: 'inactive', inactive_at: daysAgo(REPROBE_AFTER_INACTIVE_DAYS - 1) });
      expect(classifyJobAlertSunset(notYet, NOW).action).toBe('none');
    });

    it('never re-probes twice — a second silent round after an exhausted attempt stays inactive for good (no ping-pong)', () => {
      const alreadyTried = zombie({
        status: 'inactive',
        sunset_reprobe_count: REPROBE_MAX_ATTEMPTS,
        sunset_reprobed_at: daysAgo(REPROBE_AFTER_INACTIVE_DAYS + 30),
      });
      expect(classifyJobAlertSunset(alreadyTried, NOW).action).toBe('none');
    });

    it('ignores suppression-decay\'s unrelated reprobe_count field — a subscriber that exhausted THAT mechanism\'s budget must still be eligible here (field-namespace collision, PR #5573 review)', () => {
      const exhaustedElsewhere = zombie({
        status: 'inactive',
        inactive_at: daysAgo(REPROBE_AFTER_INACTIVE_DAYS + 1),
        reprobe_count: 99, // scripts/suppression-decay.mjs's own counter, unrelated mechanism
        reprobed_at: daysAgo(1), // ditto
      });
      expect(classifyJobAlertSunset(exhaustedElsewhere, NOW).action).toBe('reprobe');
    });
  });

  it('treats an empty/missing status as mailable', () => {
    expect(classifyJobAlertSunset(zombie({ status: '' }), NOW).action).toBe('sunset');
    expect(classifyJobAlertSunset(zombie({ status: undefined }), NOW).action).toBe('sunset');
  });
});
