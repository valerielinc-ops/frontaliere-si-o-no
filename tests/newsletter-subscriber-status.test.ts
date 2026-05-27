import { describe, expect, it } from 'vitest';
import { inferNewsletterSubscriptionState } from '@/services/newsletterSubscribers';

describe('inferNewsletterSubscriptionState', () => {
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

  it('keeps authenticated sources confirmed/active', () => {
    expect(
      inferNewsletterSubscriptionState({
        email: 'user@example.com',
        source: 'signup',
      }, undefined),
    ).toEqual({
      status: 'confirmed',
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
});
