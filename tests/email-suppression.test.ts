import { describe, it, expect } from 'vitest';
import {
  ADDRESS_SUPPRESSED_STATUSES,
  NEWSLETTER_EXCLUDED_STATUSES,
  isAddressSuppressed,
  isNewsletterExcluded,
} from '../services/emailSuppression.mjs';

describe('emailSuppression sets', () => {
  it('address-level set is the hard, cross-channel signals only', () => {
    expect([...ADDRESS_SUPPRESSED_STATUSES].sort()).toEqual(['bounced', 'complained', 'suppressed']);
  });

  it('newsletter set adds the channel-level unsubscribe', () => {
    expect([...NEWSLETTER_EXCLUDED_STATUSES].sort()).toEqual(['bounced', 'complained', 'suppressed', 'unsubscribed']);
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
  it('excludes address signals plus unsubscribed', () => {
    for (const s of ['bounced', 'complained', 'suppressed', 'unsubscribed']) {
      expect(isNewsletterExcluded(s)).toBe(true);
    }
  });

  it('keeps active recipients', () => {
    expect(isNewsletterExcluded('active')).toBe(false);
  });
});
