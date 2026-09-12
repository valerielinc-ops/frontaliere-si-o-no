import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__server_timestamp__',
    increment: (value: number) => ({ __increment: value }),
  },
}));

vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: vi.fn(),
}));

import {
  decidePetitionSign,
  handlePetitionSign,
  isPetitionNewsletterEligible,
  PETITION_ID,
} from '../functions/src/petitionSign.js';

const TOKEN = {
  uid: 'auth-user-1',
  email: 'worker@example.com',
  email_verified: true,
};

const SUBSCRIBER = {
  email: 'worker@example.com',
  status: 'confirmed',
  isActive: true,
  consent_given: true,
  consent_act: 'authentication',
  consent_text_displayed: true,
  confirmed_at: '2026-09-12T05:00:00.000Z',
};

function makeDb() {
  const store: Record<string, Record<string, unknown>> = {
    'newsletter_subscribers/worker@example.com': SUBSCRIBER,
  };
  const writes: Array<{ kind: string; path: string; data: Record<string, unknown> }> = [];

  const doc = (collection: string, id: string) => {
    const path = `${collection}/${id}`;
    return {
      path,
      get: async () => ({
        exists: Boolean(store[path]),
        data: () => store[path],
      }),
    };
  };

  return {
    store,
    writes,
    collection: (name: string) => ({ doc: (id: string) => doc(name, id) }),
    runTransaction: async (callback: (transaction: any) => Promise<unknown>) => callback({
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      create: (ref: { path: string }, data: Record<string, unknown>) => {
        writes.push({ kind: 'create', path: ref.path, data });
        store[ref.path] = data;
      },
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        writes.push({ kind: 'set', path: ref.path, data });
        store[ref.path] = { ...(store[ref.path] || {}), ...data };
      },
    }),
  };
}

describe('Stabio-Gaggiolo petition newsletter gate', () => {
  it('requires active, consent-backed newsletter proof', () => {
    expect(isPetitionNewsletterEligible(SUBSCRIBER)).toBe(true);
    expect(isPetitionNewsletterEligible({ ...SUBSCRIBER, status: 'pending' })).toBe(false);
    expect(isPetitionNewsletterEligible({ ...SUBSCRIBER, isActive: false })).toBe(false);
    expect(isPetitionNewsletterEligible({ ...SUBSCRIBER, consent_given: false })).toBe(false);
    expect(isPetitionNewsletterEligible({ ...SUBSCRIBER, confirmed_at: undefined })).toBe(false);
    expect(isPetitionNewsletterEligible({ ...SUBSCRIBER, status: 'unsubscribed' })).toBe(false);
  });

  it('accepts only a verified account whose newsletter record belongs to its email', () => {
    expect(decidePetitionSign({
      method: 'POST', token: { ...TOKEN, email: 'WORKER@example.com' }, petitionId: PETITION_ID, subscriber: SUBSCRIBER,
    })).toEqual({ ok: true, email: 'worker@example.com' });
    expect(decidePetitionSign({
      method: 'POST', token: { ...TOKEN, email_verified: false }, petitionId: PETITION_ID, subscriber: SUBSCRIBER,
    }).error).toBe('verified_account_required');
    expect(decidePetitionSign({
      method: 'POST', token: TOKEN, petitionId: 'other-petition', subscriber: SUBSCRIBER,
    }).error).toBe('invalid_petition');
    expect(decidePetitionSign({
      method: 'POST', token: TOKEN, petitionId: PETITION_ID, subscriber: { ...SUBSCRIBER, email: 'other@example.com' },
    }).error).toBe('account_email_mismatch');
  });

  it('writes one uid-keyed signature and makes retries idempotent', async () => {
    const db = makeDb();
    const first = await handlePetitionSign({
      method: 'POST', token: TOKEN, petitionId: PETITION_ID, locale: 'it',
      sourcePath: '/petizione-dosso-stabio/', db: db as never,
    });

    expect(first).toEqual({ status: 200, body: { success: true, signed: true } });
    expect(db.store['petition_signatures/auth-user-1']).toMatchObject({
      petitionId: PETITION_ID,
      uid: 'auth-user-1',
      locale: 'it',
      sourcePath: '/petizione-dosso-stabio/',
    });
    expect(db.store['petition_meta/stabio-dosso'].signatureCount).toEqual({ __increment: 1 });

    const writeCount = db.writes.length;
    const retry = await handlePetitionSign({
      method: 'POST', token: TOKEN, petitionId: PETITION_ID, locale: 'it', db: db as never,
    });
    expect(retry).toEqual({ status: 200, body: { success: true, signed: true, alreadySigned: true } });
    expect(db.writes).toHaveLength(writeCount);
  });

  it('rejects malformed requests before touching Firestore', async () => {
    const db = {
      collection: () => { throw new Error('Firestore should not be reached'); },
    };
    await expect(handlePetitionSign({
      method: 'GET', token: null, petitionId: PETITION_ID, locale: 'it', db: db as never,
    })).resolves.toEqual({ status: 405, body: { success: false, error: 'method_not_allowed' } });
    await expect(handlePetitionSign({
      method: 'POST', token: null, petitionId: PETITION_ID, locale: 'it', db: db as never,
    })).resolves.toEqual({ status: 401, body: { success: false, error: 'verified_account_required' } });
  });
});
