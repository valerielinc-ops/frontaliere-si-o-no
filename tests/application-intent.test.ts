import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__server_timestamp__',
  },
}));

const verifyIdToken = vi.fn();
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken }),
}));

vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: vi.fn(),
}));

import {
  APPLICATION_INTENT_CONSENT_VERSION,
  APPLICATION_INTENT_STATUS,
  APPLICATION_INTENTS_COLLECTION,
  buildApplicationIntentId,
  handleRecordApplicationIntent,
  normalizeApplicationIntentRequest,
} from '../functions/src/applicationIntentCore.js';

type StoredDoc = Record<string, unknown>;

function makeDb() {
  const store: Record<string, StoredDoc> = {};
  const writes: Array<{ kind: string; path: string; data: StoredDoc }> = [];

  function doc(collection: string, id: string) {
    const path = `${collection}/${id}`;
    return { path, id };
  }

  const db = {
    collection(collection: string) {
      return { doc: (id: string) => doc(collection, id) };
    },
    async runTransaction(callback: (transaction: any) => Promise<unknown>) {
      return callback({
        get: async (ref: { path: string }) => ({
          exists: Boolean(store[ref.path]),
          data: () => store[ref.path],
        }),
        create: (ref: { path: string }, data: StoredDoc) => {
          writes.push({ kind: 'create', path: ref.path, data });
          store[ref.path] = data;
        },
        set: (ref: { path: string }, data: StoredDoc, options?: { merge?: boolean }) => {
          writes.push({ kind: 'set', path: ref.path, data });
          store[ref.path] = options?.merge ? { ...(store[ref.path] || {}), ...data } : data;
        },
      });
    },
  };

  return { db, store, writes };
}

function request(body: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    'user-agent': 'ApplicationIntentTest/1.0',
    'cf-connecting-ip': '203.0.113.42',
  };
  return {
    method: 'POST',
    body,
    headers,
    get: (name: string) => headers[name.toLowerCase()],
    ...overrides,
  };
}

const BASE_BODY = {
  jobKey: 'acme-sa:software-engineer-lugano',
  jobSlug: 'software-engineer-lugano',
  companyKey: 'acme-sa',
  jobTitle: 'Software Engineer',
  origin: '/it/cerca-lavoro-ticino/software-engineer-lugano/',
  surface: 'job_board_apply',
  consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
  consentText: 'Selezionando «Candidati» acconsenti a registrare il tuo interesse.',
  clientIdentifier: 'visitor-0123456789abcdef',
};

describe('application intent contract', () => {
  it('derives one deterministic id from actor identity and stable job key', () => {
    const first = buildApplicationIntentId({ identityKey: 'uid:user-1', jobKey: BASE_BODY.jobKey });
    const retry = buildApplicationIntentId({ identityKey: 'uid:user-1', jobKey: BASE_BODY.jobKey });
    const otherJob = buildApplicationIntentId({ identityKey: 'uid:user-1', jobKey: 'acme-sa:other-job' });

    expect(first).toMatch(/^ai_[a-f0-9]{48}$/);
    expect(retry).toBe(first);
    expect(otherJob).not.toBe(first);
  });

  it('rejects missing/oversized consent inputs before touching Firestore', () => {
    expect(normalizeApplicationIntentRequest({
      ...BASE_BODY,
      consentText: 'x'.repeat(1001),
    })).toEqual({ ok: false, error: 'invalid_application_intent' });
    expect(normalizeApplicationIntentRequest({
      ...BASE_BODY,
      jobKey: 'x'.repeat(241),
    })).toEqual({ ok: false, error: 'invalid_application_intent' });
    expect(normalizeApplicationIntentRequest({
      ...BASE_BODY,
      consentVersion: 'old-version',
    })).toEqual({ ok: false, error: 'invalid_consent_version' });
  });

  it('writes required proof once, keeps redirect_only semantics, and caps retries', async () => {
    const database = makeDb();
    const token = { uid: 'firebase-user-1', email_verified: true };
    const first = await handleRecordApplicationIntent({
      req: request({ ...BASE_BODY, application_completed: true }),
      token,
      db: database.db as never,
    });

    expect(first).toMatchObject({ status: 200, body: {
      ok: true,
      recorded: true,
      duplicate: false,
      application_status: APPLICATION_INTENT_STATUS,
    } });
    const paths = Object.keys(database.store);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(new RegExp(`^${APPLICATION_INTENTS_COLLECTION}/ai_`));
    const stored = database.store[paths[0]];
    expect(stored).toMatchObject({
      jobKey: BASE_BODY.jobKey,
      consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
      consentText: BASE_BODY.consentText,
      identifier: token.uid,
      identifierType: 'firebase_uid',
      application_status: 'redirect_only',
      retryCount: 0,
      ipAnonymized: '203.0.113.0',
      userAgent: 'ApplicationIntentTest/1.0',
    });
    expect(stored.application_completed).toBeUndefined();
    expect(stored.timestamp).toBe('__server_timestamp__');

    let retry = null;
    for (let i = 0; i < 20; i += 1) {
      retry = await handleRecordApplicationIntent({
        req: request(BASE_BODY),
        token,
        db: database.db as never,
      });
    }
    expect(retry).toMatchObject({ status: 200, body: {
      ok: true,
      recorded: false,
      duplicate: true,
    } });
    expect(database.store[paths[0]].retryCount).toBe(8);
    expect(Object.keys(database.store)).toHaveLength(1);
    expect(database.writes.filter((write) => write.kind === 'create')).toHaveLength(1);
  });

  it('uses the opaque anonymous identifier when no account token is available', async () => {
    const database = makeDb();
    const result = await handleRecordApplicationIntent({
      req: request(BASE_BODY),
      db: database.db as never,
    });
    expect(result.status).toBe(200);
    const stored = Object.values(database.store)[0];
    expect(stored.identifierType).toBe('anonymous_client');
    expect(stored.identifier).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.ipAnonymized).not.toBe('203.0.113.42');
  });

  it('denies direct client access to the server-owned collection', () => {
    const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8');
    const start = rules.indexOf('match /application_intents/{intentId}');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = rules.slice(start, rules.indexOf('\n    }', start) + 6);
    expect(block).toContain('allow read, write: if false;');
  });
});
