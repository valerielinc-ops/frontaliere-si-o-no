/**
 * Creation date of a subscriber row.
 *
 * Measured on newsletter_subscribers: 534 rows have no creation stamp at all.
 * The 71 whose first capture falls on or after 2026-09-17 all belong to
 * Firebase accounts created earlier, mostly 12-16 September, when the auth
 * writer stored profile fields without a subscription write. Every later
 * capture found an existing row and stamped nothing, so these signups, among
 * them 171 job-gate social unlocks, dropped out of every report by creation
 * day. The first capture of such a row is its real creation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  addDoc: vi.fn(async () => ({ id: 'event-1' })),
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((db: unknown, name: string) => ({ db, name })),
  doc: vi.fn((...args: unknown[]) => ({ args })),
  getDoc: (...args: unknown[]) => mocks.getDoc(...args),
  setDoc: (...args: unknown[]) => mocks.setDoc(...args),
  addDoc: (...args: unknown[]) => mocks.addDoc(...args),
  increment: vi.fn((value: number) => ({ __increment: value })),
  serverTimestamp: vi.fn(() => '__server_timestamp__'),
  deleteField: vi.fn(() => '__delete_field__'),
}));

import { captureNewsletterSubscriber, isUncapturedSubscriberRow } from '../services/newsletterSubscribers';

type Row = Record<string, any>;
let stored: Row | undefined;

const JOB_GATE_SOCIAL = {
  email: 'reader@example.test',
  source: 'job_gate_google',
  sourceChannel: 'job_gate' as const,
  sourcePage: '/cerca-lavoro-ticino/',
  sourceCta: 'job_board_social_unlock',
  sourceComponent: 'JobBoard',
  registrationTermsAccepted: true,
  registrationMethod: 'authenticated' as const,
};

async function captureAndGetWrite(existing: Row | undefined): Promise<Row> {
  stored = existing ? { ...existing } : undefined;
  await captureNewsletterSubscriber({} as any, JOB_GATE_SOCIAL);
  expect(mocks.setDoc).toHaveBeenCalledTimes(1);
  return mocks.setDoc.mock.calls[0][1] as Row;
}

describe('creation stamp on the first capture', () => {
  beforeEach(() => {
    stored = undefined;
    mocks.getDoc.mockReset();
    mocks.setDoc.mockReset();
    mocks.getDoc.mockImplementation(async () => ({
      exists: () => Boolean(stored),
      data: () => stored,
    }));
    mocks.setDoc.mockImplementation(async (_ref: unknown, data: Row) => {
      stored = { ...(stored || {}), ...data };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('a brand-new row gets created_at and the subscribed_at pair', async () => {
    const write = await captureAndGetWrite(undefined);
    expect(write.created_at).toBe('__server_timestamp__');
    expect(write.subscribed_at).toBe('__server_timestamp__');
    expect(write.subscribedAt).toBe('__server_timestamp__');
  });

  it('a profile-only row (auth fields, no status/channel/stamp) gets created_at on its first capture', async () => {
    const write = await captureAndGetWrite({
      auth_uid: 'uid-1',
      auth_provider: 'google',
      name: 'Reader Test',
      lastLoginAt: 'ts',
      updatedAt: 'ts',
    });
    expect(write.created_at).toBe('__server_timestamp__');
    // The subscribed_at pair is a state field in firestore.rules: never minted
    // on an update.
    expect(write).not.toHaveProperty('subscribed_at');
    expect(write).not.toHaveProperty('subscribedAt');
  });

  it('never overwrites an existing creation stamp', async () => {
    const write = await captureAndGetWrite({
      status: 'confirmed',
      source_channel: 'auth_google',
      created_at: '2026-08-01T00:00:00.000Z',
    });
    expect(write).not.toHaveProperty('created_at');
  });

  it('does not invent a date for a captured legacy row that simply lacks one', async () => {
    const write = await captureAndGetWrite({ status: 'confirmed', source_channel: 'newsletter_form' });
    expect(write).not.toHaveProperty('created_at');
  });

  it('isUncapturedSubscriberRow classifies the row shapes', () => {
    expect(isUncapturedSubscriberRow(undefined)).toBe(false);
    expect(isUncapturedSubscriberRow({ auth_uid: 'u', lastLoginAt: 'ts' })).toBe(true);
    expect(isUncapturedSubscriberRow({ auth_uid: 'u', createdAt: 'ts' })).toBe(false);
    expect(isUncapturedSubscriberRow({ auth_uid: 'u', subscribed_at: 'ts' })).toBe(false);
    // A status is not a capture: the unsubscribe writers, the bounce webhooks
    // and the account-deletion tombstone put one on never-captured rows.
    expect(isUncapturedSubscriberRow({ status: 'unsubscribed', unsubscribed_at: 'ts' })).toBe(true);
    expect(isUncapturedSubscriberRow({ source_channel: 'auth_google' })).toBe(false);
  });

  it('an opt-out on a never-captured row does not hide its first capture from the creation stamp', async () => {
    // Measured 2026-09-25: a profile row from May, unsubscribed from the weekly
    // of 17/09 (status without a channel), first captured from the job gate.
    const unsubscribedProfile = {
      auth_uid: 'uid-1',
      status: 'unsubscribed',
      unsubscribed_at: 'ts-optout',
      source: 'unsubscribe_link',
    };

    // An ordinary login is still a no-op on a recorded opt-out…
    stored = { ...unsubscribedProfile };
    await captureNewsletterSubscriber({} as any, JOB_GATE_SOCIAL);
    expect(mocks.setDoc).not.toHaveBeenCalled();

    // …and the verified owner's explicit gate action is the re-opt-in that
    // registers the row, now with its creation date.
    stored = { ...unsubscribedProfile };
    await captureNewsletterSubscriber({} as any, { ...JOB_GATE_SOCIAL, explicitConsentAction: true });
    const write = mocks.setDoc.mock.calls[0][1] as Row;
    expect(write.created_at).toBe('__server_timestamp__');
    expect(write.status).toBe('subscribed');
    // The subscribed_at pair stays creation-only (a state field in the rules).
    expect(write).not.toHaveProperty('subscribed_at');
    expect(write).not.toHaveProperty('subscribedAt');
    // Re-opt-in rules unchanged: the lift is a newer stamp written BESIDE the
    // opt-out, whose evidence is neither deleted nor rewritten.
    expect(write.resubscribed_at).toBe('__server_timestamp__');
    expect(write).not.toHaveProperty('unsubscribed_at');
    expect(stored?.unsubscribed_at).toBe('ts-optout');
  });
});
