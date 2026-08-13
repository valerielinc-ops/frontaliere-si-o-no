import { describe, it, expect } from 'vitest';
import {
  ADDRESS_SUPPRESSED_STATUSES,
  NEWSLETTER_EXCLUDED_STATUSES,
  JOB_ALERT_EXCLUDED_STATUSES,
  isAddressSuppressed,
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
});

describe('isAddressSuppressed', () => {
  it('matches hard signals regardless of case/whitespace', () => {
    for (const s of ['bounced', 'COMPLAINED', '  suppressed ', 'Bounced']) {
      expect(isAddressSuppressed(s)).toBe(true);
    }
  });

  it('does NOT cross channel-level unsubscribe (a newsletter unsub still gets alerts)', () => {
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
