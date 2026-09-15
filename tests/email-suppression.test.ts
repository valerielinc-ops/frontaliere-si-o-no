import { describe, it, expect } from 'vitest';
import {
  ADDRESS_SUPPRESSED_STATUSES,
  NEWSLETTER_EXCLUDED_STATUSES,
  JOB_ALERT_EXCLUDED_STATUSES,
  CROSS_CHANNEL_STOP_STATUSES,
  GLOBAL_EMAIL_OPT_OUT_FIELDS,
  isAddressSuppressed,
  isGlobalEmailOptOut,
  isCrossChannelStop,
  isNewsletterExcluded,
  isJobAlertExcluded,
} from '../services/emailSuppression.mjs';

describe('emailSuppression sets', () => {
  it('address-level set is the hard, cross-channel signals only', () => {
    expect([...ADDRESS_SUPPRESSED_STATUSES].sort()).toEqual(['bounced', 'complained', 'suppressed']);
  });

  it('newsletter set adds the channel-level soft states (unsubscribe + inactive sunset + expired opt-in)', () => {
    // `expired` (#5692): three confirmation requests, one per day, unanswered.
    // Channel-level like `inactive` — our own state, not a human instruction
    // and not an address signal — so it is here and NOT in the job-alert or
    // cross-channel sets, both of which are asserted unchanged around this.
    expect([...NEWSLETTER_EXCLUDED_STATUSES].sort()).toEqual(['bounced', 'complained', 'expired', 'inactive', 'suppressed', 'unsubscribed']);
  });

  it('job-alert set adds only that channel\'s own inactive sunset (no unsubscribed — that is per-alert active:false)', () => {
    expect([...JOB_ALERT_EXCLUDED_STATUSES].sort()).toEqual(['bounced', 'complained', 'inactive', 'suppressed']);
  });

  it('cross-channel set contains the explicit unsubscribe and hard address statuses', () => {
    expect([...CROSS_CHANNEL_STOP_STATUSES].sort()).toEqual(['bounced', 'complained', 'suppressed', 'unsubscribed']);
    expect(GLOBAL_EMAIL_OPT_OUT_FIELDS).toEqual([
      'all_email_opted_out',
      'all_emails_opted_out',
      'global_email_opt_out',
      'global_email_opted_out',
    ]);
  });
});

describe('isAddressSuppressed', () => {
  it('matches hard signals regardless of case/whitespace', () => {
    for (const s of ['bounced', 'COMPLAINED', '  suppressed ', 'Bounced']) {
      expect(isAddressSuppressed(s)).toBe(true);
    }
  });

  it('keeps unsubscribe distinct from hard address suppression', () => {
    expect(isAddressSuppressed('unsubscribed')).toBe(false);
  });

  it('is false for active/confirmed/pending/empty', () => {
    for (const s of ['active', 'confirmed', 'pending', '', null, undefined]) {
      expect(isAddressSuppressed(s as string)).toBe(false);
    }
  });

  it('ignores the event-type name "complaint" (only the status "complained" suppresses)', () => {
    // Guards against the historical drift where senders checked 'complaint'.
    expect(isAddressSuppressed('complaint')).toBe(false);
    expect(isAddressSuppressed('complained')).toBe(true);
  });
});

describe('isNewsletterExcluded', () => {
  it('excludes address signals plus channel-level soft states (unsubscribed, inactive)', () => {
    for (const s of ['bounced', 'complained', 'suppressed', 'unsubscribed', 'inactive']) {
      expect(isNewsletterExcluded(s)).toBe(true);
    }
  });

  it('does NOT treat the soft newsletter state "inactive" as an address-level signal', () => {
    // inactive must never cross to job alerts — it is newsletter-channel only.
    expect(isAddressSuppressed('inactive')).toBe(false);
  });

  it('keeps active recipients', () => {
    expect(isNewsletterExcluded('active')).toBe(false);
  });
});

describe('isJobAlertExcluded (#2852 item 1)', () => {
  it('excludes address signals plus this channel\'s own inactive sunset', () => {
    for (const s of ['bounced', 'complained', 'suppressed', 'inactive']) {
      expect(isJobAlertExcluded(s)).toBe(true);
    }
  });

  it('does NOT exclude "unsubscribed" — job alerts have no such channel status (that is per-alert active:false)', () => {
    expect(isJobAlertExcluded('unsubscribed')).toBe(false);
  });

  it('keeps active recipients', () => {
    expect(isJobAlertExcluded('active')).toBe(false);
    expect(isJobAlertExcluded('')).toBe(false);
  });
});

describe('global email opt-out', () => {
  it('requires an explicit true value and supports raw/projection shapes', () => {
    expect(isGlobalEmailOptOut({ all_email_opted_out: true })).toBe(true);
    expect(isGlobalEmailOptOut({ global_email_opted_out: 'true' })).toBe(true);
    expect(isGlobalEmailOptOut({ doc: { global_email_opt_out: 1 } })).toBe(true);
    expect(isGlobalEmailOptOut({ all_email_opted_out: false })).toBe(false);
    expect(isGlobalEmailOptOut({ status: 'unsubscribed' })).toBe(false);
  });

  it('cross-channel stop honors newsletter unsubscribe and legacy global fields', () => {
    expect(isCrossChannelStop({ status: 'unsubscribed', unsubscribedAt: '2026-01-01T00:00:00.000Z' })).toBe(true);
    expect(isCrossChannelStop({ status: 'unsubscribed', all_email_opted_out: true })).toBe(true);
    expect(isCrossChannelStop({ status: 'complained' })).toBe(true);
  });
});
