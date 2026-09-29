import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin', () => ({ default: { apps: [] } }));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const {
  FUNCTIONS_ADMIN_REQUIRE, maskEmail, needsRecovery, parseArgs, presentationFromStripe, resolvePresentation,
} = await import('../scripts/recover-assisted-application-orders.mjs');

describe('assisted application recovery script', () => {
  it('is a dry run unless an explicit order is named', () => {
    expect(parseArgs([])).toEqual({ orders: [], apply: false, testTo: '', variant: 'recovery' });
    expect(() => parseArgs(['--apply'])).toThrow('explicit --order');
    expect(() => parseArgs(['--test-to', 'owner@example.com'])).toThrow('explicit --order');
    expect(() => parseArgs(['--order', 'a', '--apply', '--test-to', 'owner@example.com'])).toThrow('exclusive');
    expect(() => parseArgs(['--order', 'a', '--test-to', 'not-an-email'])).toThrow('not an email');
    expect(parseArgs(['--order', 'a', '--order', 'b', '--apply'])).toMatchObject({ orders: ['a', 'b'], apply: true });
  });

  it('selects paid orders whose intro or owner notice was never delivered', () => {
    expect(needsRecovery({ paymentStatus: 'paid' })).toBe(true);
    expect(needsRecovery({ paymentStatus: 'paid', notifications: { customer_intro: { status: 'failed' } } })).toBe(true);
    expect(needsRecovery({ paymentStatus: 'paid', notifications: { customer_intro: { status: 'sent' } } })).toBe(true);
    expect(needsRecovery({
      paymentStatus: 'paid',
      notifications: { customer_intro: { status: 'sent' }, owner_new_order: { status: 'sent' } },
    })).toBe(false);
    expect(needsRecovery({
      paymentStatus: 'paid',
      notifications: { customer_intro: { status: 'ambiguous' }, owner_new_order: { status: 'sent' } },
    })).toBe(false);
    expect(needsRecovery({ paymentStatus: 'pending' })).toBe(false);
  });

  it('masks customer addresses in its output', () => {
    expect(maskEmail('someone@example.com')).toBe('so***@example.com');
    expect(maskEmail('')).toBe('(none)');
  });

  it('initialises the firebase-admin copy that the functions modules use', () => {
    // A second copy (root vs functions/node_modules) left getRemoteConfigValue
    // without an app: the Stripe locale backfill failed silently and a French
    // customer would have received the Italian email.
    const source = readFileSync(resolve(process.cwd(), 'scripts/recover-assisted-application-orders.mjs'), 'utf8');
    expect(source).not.toMatch(/from 'firebase-admin'/);
    const fromFunctions = createRequire(resolve(process.cwd(), 'functions/src/remoteConfigSecrets.js'));
    expect(FUNCTIONS_ADMIN_REQUIRE.resolve('firebase-admin')).toBe(fromFunctions.resolve('firebase-admin'));
  });

  it('never sends for real when the locale and link cannot be established', async () => {
    // Acceptance: no Stripe session and nothing stored at checkout → --apply skips it.
    const bare = { paymentStatus: 'paid' };
    const applied = await resolvePresentation(bare, { apply: true });
    expect(applied).toMatchObject({ presentation: null, skip: true });
    expect(applied.error).toContain('no Stripe checkout session');
    // A dry run / --test-to still previews, flagged by the error.
    expect(await resolvePresentation(bare, { apply: false })).toMatchObject({ skip: false });
    expect((await resolvePresentation(bare, { apply: false })).error).not.toBe('');
  });

  it('reads the locale from a same-site Stripe success_url and rejects any other', async () => {
    const order = { stripeCheckoutSessionId: 'cs_test_1' };
    const stripe = (successUrl: string) => ({
      getKey: async () => 'sk_test_x',
      fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success_url: successUrl }) })),
    });
    const fr = 'https://frontaliereticino.ch/fr/trouver-emploi-bale/job/?assisted_application_order_id=Y';
    await expect(presentationFromStripe(order, stripe(fr))).resolves.toEqual({ locale: 'fr', orderPageUrl: fr });
    await expect(presentationFromStripe(order, stripe('https://evil.example/fr/'))).rejects.toThrow('not a frontaliereticino.ch page');
    await expect(presentationFromStripe(order, { getKey: async () => '' })).rejects.toThrow('STRIPE_SECRET_KEY is empty');
    const failing = { getKey: async () => 'sk_test_x', fetchImpl: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) };
    await expect(presentationFromStripe(order, failing)).rejects.toThrow('HTTP 404');

    const stored = stripe(fr);
    await expect(presentationFromStripe({ ...order, locale: 'de', orderPageUrl: fr }, stored)).resolves.toBeNull();
    expect(stored.fetchImpl).not.toHaveBeenCalled();
  });
});
