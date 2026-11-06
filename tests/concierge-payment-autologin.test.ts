import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  createCustomToken: vi.fn(async (uid: string) => `token-${uid}`),
  getUser: vi.fn(async (uid: string) => ({ uid })),
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => mocks }));
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({ ensureAdminApp: vi.fn(), getAdminDb: vi.fn() }));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getNewsletterSecrets: vi.fn(), getAutologinPolicyConfig: vi.fn(), bridgeEmailCascadeCredentialsToEnv: vi.fn(),
}));
import { handleSubscriptionManagement } from '../functions/src/newsletterSubscriptionManagement.js';
import { mintAutologinCode, resolveAutologinPolicy } from '../functions/src/lib/autologinCode.js';
import { buildApplicationConciergePaymentReminderEmail } from '../functions/src/applicationConciergePaymentReminders.js';
const email = 'candidate@example.test';
const secret = 'concierge-autologin-test-secret';
const autologinCode = mintAutologinCode(email, { secret, scheme: 'v1' });

describe('concierge payment email authentication', () => {
  it.each(['it', 'en', 'de', 'fr'])('keeps signed owner login and attribution in %s email', (locale) => {
    const message = buildApplicationConciergePaymentReminderEmail({
      day: 3, locale, serviceId: 'service-test', unsubscribeUrl: 'https://example.test/unsubscribe/',
      autologin: { email, autologinCode },
    });
    const link = message.text.split('\n').find((line: string) => line.includes('application_concierge_service_id='))!.split(': ').slice(1).join(': ');
    const url = new URL(link);
    expect(url.searchParams.get('application_concierge_service_id')).toBe('service-test');
    expect(url.searchParams.get('ac')).toBe(autologinCode);
    expect(url.searchParams.get('ne')).toBe(email);
    expect(url.searchParams.get('utm_source')).toBe('email');
    expect(url.searchParams.get('utm_medium')).toBe('payment_reminder');
    expect(url.searchParams.get('utm_campaign')).toBe('application_concierge');
  });

  it.each([true, false])('only restores the signed recipient checkout owner: match=%s', async (match) => {
    mocks.createCustomToken.mockClear();
    const service = { userId: 'anonymous-checkout-owner', customerEmail: match ? email : 'other@example.test' };
    const db = { collection: (collection: string) => ({ doc: () => ({
      get: async () => ({ exists: collection === 'application_concierge_services', data: () => service }),
    }) }) };
    const result = await handleSubscriptionManagement({
      action: 'exchange_auth_code', email, token: autologinCode, secret, locale: 'it',
      autologinPolicy: resolveAutologinPolicy({ NEWSLETTER_AC_SCHEME: 'v1' }),
      applicationConciergeServiceId: 'service-test', db,
    });
    expect(result.status).toBe(match ? 200 : 403);
    if (match) expect(mocks.createCustomToken).toHaveBeenCalledWith('anonymous-checkout-owner');
    else expect(mocks.createCustomToken).not.toHaveBeenCalled();
  });
  it.each([
    { email: 'different-owner@example.test' },
    { phoneNumber: '+41000000000', providerData: [{ providerId: 'phone' }] },
    { disabled: true },
  ])('refuses owner account impersonation despite signed billing email: %j', async (owner) => {
    mocks.createCustomToken.mockClear();
    mocks.getUser.mockResolvedValueOnce({ uid: 'registered-owner', ...owner } as any);
    const db = { collection: (name: string) => ({ doc: () => ({ get: async () => ({
      exists: name === 'application_concierge_services',
      data: () => ({ userId: 'registered-owner', customerEmail: email }),
    }) }) }) };
    const result = await handleSubscriptionManagement({ action: 'exchange_auth_code', email,
      token: autologinCode, secret, locale: 'it', applicationConciergeServiceId: 'service-test',
      autologinPolicy: resolveAutologinPolicy({ NEWSLETTER_AC_SCHEME: 'v1' }), db });
    expect(result.status).toBe(403);
    expect(mocks.createCustomToken).not.toHaveBeenCalled();
  });

});
