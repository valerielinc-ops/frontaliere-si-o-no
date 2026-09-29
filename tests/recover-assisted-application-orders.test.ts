import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin', () => ({ default: { apps: [] } }));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { FUNCTIONS_ADMIN_REQUIRE, maskEmail, needsRecovery, parseArgs } = await import('../scripts/recover-assisted-application-orders.mjs');

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
});
