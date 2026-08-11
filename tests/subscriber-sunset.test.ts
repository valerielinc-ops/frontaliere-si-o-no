import { describe, it, expect } from 'vitest';
import {
  classifySunset,
  SUNSET_MIN_SENDS,
  SUNSET_MIN_AGE_DAYS,
  WINBACK_GRACE_DAYS,
  REPROBE_AFTER_INACTIVE_DAYS,
  REPROBE_MAX_ATTEMPTS,
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

  it('spares a subscriber who resubscribed AFTER the win-back (explicit stay), even with grace expired', () => {
    const responded = zombie({
      winback_sent_at: daysAgo(WINBACK_GRACE_DAYS + 5),
      resubscribed_at: daysAgo(1), // clicked "yes, keep me" — but click not ESP-tracked
    });
    expect(classifySunset(responded, NOW).action).toBe('none');
  });

  it('still sunsets when the only resubscribe predates the win-back (stale signal)', () => {
    const stale = zombie({
      winback_sent_at: daysAgo(WINBACK_GRACE_DAYS + 1),
      resubscribed_at: daysAgo(WINBACK_GRACE_DAYS + 30),
    });
    expect(classifySunset(stale, NOW).action).toBe('sunset');
  });

  it('never sunsets when the signup date is unknown (conservative age floor)', () => {
    const noDate = zombie();
    delete (noDate as Record<string, unknown>).created_at;
    expect(classifySunset(noDate, NOW).action).toBe('none');
  });

  it('reactivates an inactive subscriber who engaged via a real send during their one-time re-probe (production-reachable path, issue #5559)', () => {
    // Unlike a bare { status: 'inactive', open_count: 1 } fixture (impossible in
    // production: sends stop the instant status flips to 'inactive', so nothing
    // can ever increment open_count again without a re-probe first re-admitting
    // the subscriber to a mailable status and triggering a real send) — this
    // engagement is evidence the system itself was able to produce.
    const doc = { status: 'inactive', sunset_reprobed_at: daysAgo(1), sunset_reprobe_count: 1, open_count: 1 };
    expect(classifySunset(doc, NOW).action).toBe('reactivate');
  });

  it('leaves a still-silent inactive subscriber alone until the re-probe window elapses (no churn, no re-mail)', () => {
    const freshlyInactive = { status: 'inactive', open_count: 0, click_count: 0, inactive_at: daysAgo(1) };
    expect(classifySunset(freshlyInactive, NOW).action).toBe('none');
  });

  describe('re-probe — the exit `reactivate` alone cannot provide (issue #5559)', () => {
    it('grants a one-time re-probe once a plain inactive subscriber has been silent long enough', () => {
      const longSilent = { status: 'inactive', open_count: 0, click_count: 0, inactive_at: daysAgo(REPROBE_AFTER_INACTIVE_DAYS + 1) };
      expect(classifySunset(longSilent, NOW).action).toBe('reprobe');
    });

    it('does not re-probe before the silence window elapses', () => {
      const notYet = { status: 'inactive', open_count: 0, click_count: 0, inactive_at: daysAgo(REPROBE_AFTER_INACTIVE_DAYS - 1) };
      expect(classifySunset(notYet, NOW).action).toBe('none');
    });

    it('never re-probes twice — a second silent round after an exhausted attempt stays inactive for good (no ping-pong)', () => {
      const alreadyTried = {
        status: 'inactive',
        open_count: 0,
        click_count: 0,
        sunset_reprobe_count: REPROBE_MAX_ATTEMPTS,
        sunset_reprobed_at: daysAgo(REPROBE_AFTER_INACTIVE_DAYS + 30),
      };
      expect(classifySunset(alreadyTried, NOW).action).toBe('none');
    });

    it('ignores suppression-decay\'s unrelated reprobe_count field — a subscriber that exhausted THAT mechanism\'s budget must still be eligible here (field-namespace collision, PR #5573 review)', () => {
      const exhaustedElsewhere = {
        status: 'inactive',
        open_count: 0,
        click_count: 0,
        inactive_at: daysAgo(REPROBE_AFTER_INACTIVE_DAYS + 1),
        reprobe_count: 99, // scripts/suppression-decay.mjs's own counter, unrelated mechanism
        reprobed_at: daysAgo(1), // ditto
      };
      expect(classifySunset(exhaustedElsewhere, NOW).action).toBe('reprobe');
    });

    it('also grants a re-probe to a dormant_winback-sunset doc with no fresh-engagement proof (the tighter-sealed branch)', () => {
      const doc = {
        status: 'inactive',
        sunset_source: 'dormant_winback',
        inactive_at: daysAgo(REPROBE_AFTER_INACTIVE_DAYS + 1),
        open_count: 4, // historical engagement predating the sunset — still no exit without re-probe
      };
      expect(classifySunset(doc, NOW).action).toBe('reprobe');
    });
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

  describe('dormant win-back sunset marker (review PR #4338, bug C)', () => {
    it('does NOT reactivate a dormant_winback-sunset doc on lifetime engagement alone (no ping-pong)', () => {
      const doc = {
        status: 'inactive',
        sunset_source: 'dormant_winback',
        inactive_at: daysAgo(5),
        open_count: 3, // historical engagement predating the sunset — must not resurrect it
        click_count: 1,
      };
      expect(classifySunset(doc, NOW).action).toBe('none');
    });

    it('reactivates a dormant_winback-sunset doc on FRESH engagement strictly after the sunset timestamp', () => {
      const doc = {
        status: 'inactive',
        sunset_source: 'dormant_winback',
        inactive_at: daysAgo(5),
        open_count: 4,
        last_open_at: daysAgo(1), // after inactive_at
      };
      expect(classifySunset(doc, NOW).action).toBe('reactivate');
    });

    it('does NOT reactivate a dormant_winback-sunset doc when engagement predates (or ties) the sunset timestamp', () => {
      const doc = {
        status: 'inactive',
        sunset_source: 'dormant_winback',
        inactive_at: daysAgo(5),
        open_count: 4,
        last_open_at: daysAgo(5), // not strictly after
      };
      expect(classifySunset(doc, NOW).action).toBe('none');
    });

    it('never reactivates a dormant_winback-sunset doc when the recency data needed to prove fresh engagement is missing', () => {
      const doc = {
        status: 'inactive',
        sunset_source: 'dormant_winback',
        inactive_at: daysAgo(5),
        open_count: 4, // engaged, but no last_open_at/last_click_at to prove it's fresh
      };
      expect(classifySunset(doc, NOW).action).toBe('none');
    });

    it('still reactivates a plain (non dormant_winback) inactive subscriber on lifetime engagement, unaffected', () => {
      expect(classifySunset({ status: 'inactive', open_count: 1 }, NOW).action).toBe('reactivate');
    });
  });
});
