import { describe, expect, it } from 'vitest';
import {
  inferNewsletterSubscriptionState,
  isAccountDeletedSubscriber,
  NEWSLETTER_STATUS_KIND,
  type NewsletterSubscriberStatus,
} from '@/services/newsletterSubscribers';

describe('inferNewsletterSubscriptionState', () => {
  it('keeps the status-kind map total for every persisted status', () => {
    const statuses: NewsletterSubscriberStatus[] = [
      'pending',
      'confirmed',
      'subscribed',
      'unsubscribed',
      'bounced',
      'complained',
      'suppressed',
      'expired',
    ];

    expect(Object.keys(NEWSLETTER_STATUS_KIND).sort()).toEqual([...statuses].sort());
    expect(NEWSLETTER_STATUS_KIND.subscribed).toBe('subscription');
  });

  it('defaults manual email sources to pending/inactive', () => {
    expect(
      inferNewsletterSubscriptionState({
        email: 'user@example.com',
        source: 'popup',
      }, undefined),
    ).toEqual({
      status: 'pending',
      isActive: false,
    });
  });

  it('does not infer confirmation from an authenticated-looking source', () => {
    expect(
      inferNewsletterSubscriptionState({
        email: 'user@example.com',
        source: 'signup',
      }, undefined),
    ).toEqual({
      status: 'pending',
      isActive: false,
    });
  });

  it('does not promote a subscribed reactivation from active flags alone', () => {
    expect(
      inferNewsletterSubscriptionState(
        { email: 'user@example.com', source: 'signup', isActive: true },
        { status: 'subscribed', isActive: true, active: true },
      ),
    ).toEqual({
      status: 'subscribed',
      isActive: true,
    });
  });

  it('treats an explicit subscribed status as active, not confirmed', () => {
    expect(
      inferNewsletterSubscriptionState(
        { email: 'user@example.com', status: 'subscribed' },
        undefined,
      ),
    ).toEqual({
      status: 'subscribed',
      isActive: true,
    });
  });

  it('preserves an already confirmed subscriber', () => {
    expect(
      inferNewsletterSubscriptionState({
        email: 'user@example.com',
        source: 'popup',
      }, { status: 'confirmed', isActive: true }),
    ).toEqual({
      status: 'confirmed',
      isActive: true,
    });
  });

 it('gives an account-deletion tombstone precedence over stale subscription fields', () => {
  const tombstone = {
   status: 'subscribed',
   isActive: true,
   active: true,
   account_deleted_at: '2026-09-01T12:00:00.000Z',
  };

  expect(inferNewsletterSubscriptionState({
   email: 'user@example.com',
   source: 'popup',
  }, tombstone)).toEqual({
   status: 'pending',
   isActive: false,
  });
  expect(inferNewsletterSubscriptionState({
   email: 'user@example.com',
   source: 'signup',
  }, tombstone)).toEqual({
   status: 'pending',
   isActive: false,
  });
 });

  it('uses one canonical tombstone predicate for both persisted marker spellings', () => {
    expect(isAccountDeletedSubscriber({
      status: 'subscribed',
      isActive: true,
      account_deleted_at: '2026-09-01T12:00:00.000Z',
    })).toBe(true);
    expect(isAccountDeletedSubscriber({
      status: 'account_deleted',
      isActive: true,
    })).toBe(true);
    expect(isAccountDeletedSubscriber({
      status: 'subscribed',
      isActive: true,
    })).toBe(false);
  });
});
