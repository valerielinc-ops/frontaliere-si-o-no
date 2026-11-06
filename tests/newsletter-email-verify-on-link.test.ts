import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/auth', () => ({ getAuth: vi.fn() }));

const { shouldVerifyEmailOnLinkClick } = await import('../functions/src/newsletterSubscriptionManagement.js');

describe('shouldVerifyEmailOnLinkClick', () => {
  it('verifies a passwordless account the moment its owner opens the signed link', () => {
    expect(shouldVerifyEmailOnLinkClick({ emailVerified: false, providerData: [] })).toBe(true);
    expect(shouldVerifyEmailOnLinkClick({ emailVerified: false, providerData: [{ providerId: 'facebook.com' }] })).toBe(true);
  });

  it('leaves an already verified account untouched', () => {
    expect(shouldVerifyEmailOnLinkClick({ emailVerified: true, providerData: [] })).toBe(false);
  });

  it('never verifies a password account: its password was set without proving the address', () => {
    expect(shouldVerifyEmailOnLinkClick({ emailVerified: false, providerData: [{ providerId: 'password' }] })).toBe(false);
  });
});
