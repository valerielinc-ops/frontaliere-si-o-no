import { describe, expect, it } from 'vitest';

import {
 APPLICATION_INTENT_ACCOUNT_TOMBSTONES_COLLECTION,
 buildApplicationIntentAccountTombstone,
 canRegisterApplicationIntent,
 canSendApplicationIntentReminder,
 canSendApplicationIntentReminderForAccount,
 canUseApplicationIntentForRanking,
 canWriteApplicationIntentForAccount,
 isApplicationIntentAccountDeleted,
 resolveApplicationIntentIdentity,
} from '../functions/src/applicationIntentPrivacy.js';

function createTombstoneDb() {
 const store = new Map<string, Record<string, unknown>>();
 const db = {
  collection(name: string) {
   return {
    doc(id: string) {
     const path = `${name}/${id}`;
     return {
      async get() {
       const data = store.get(path);
       return { exists: Boolean(data), data: () => data };
      },
      async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
       store.set(path, options?.merge ? { ...(store.get(path) || {}), ...data } : { ...data });
      },
     };
    },
   };
  },
 };
 return { db, store };
}

describe('application-intent privacy gates', () => {
 it('uses only the separate opt-out and leaves saved-jobs preferences independent', () => {
  const profile = {
   applicationIntent: { optedOut: false },
   savedJobsDigest: { optedIn: true, optedOut: false },
  };
  expect(canRegisterApplicationIntent({ profile, userId: 'uid-1' })).toBe(true);
  expect(canRegisterApplicationIntent({
   profile: { ...profile, applicationIntent: { optedOut: true } },
   userId: 'uid-1',
  })).toBe(false);
 });

 it('rejects anonymous identities instead of linking by email', () => {
  expect(resolveApplicationIntentIdentity({ email: 'reader@example.com' })).toBeNull();
  expect(canRegisterApplicationIntent({
   profile: { applicationIntent: { optedOut: false } },
   userId: undefined,
  })).toBe(false);
 });

 it('blocks reminder and ranking use after opt-out, tombstone or retention expiry', () => {
  const now = Date.now();
  const intent = {
   userId: 'uid-1',
   occurred_at: new Date(now - 25 * 86400000).toISOString(),
  };
  expect(canSendApplicationIntentReminder({
   profile: { applicationIntent: { optedOut: false } },
   intent,
   userId: 'uid-1',
   now,
  })).toBe(true);
  expect(canUseApplicationIntentForRanking({
   profile: { applicationIntent: { optedOut: true } },
   intent,
   userId: 'uid-1',
   now,
  })).toBe(false);
  expect(canSendApplicationIntentReminder({
   profile: { applicationIntent: { optedOut: false } },
   intent: { ...intent, status: 'account_deleted' },
   userId: 'uid-1',
   now,
  })).toBe(false);
  expect(canUseApplicationIntentForRanking({
   profile: { applicationIntent: { optedOut: false } },
   intent: { ...intent, occurred_at: new Date(now - 400 * 86400000).toISOString() },
   userId: 'uid-1',
   now,
  })).toBe(false);
 });

 it('rejects every conflicting account identity field, including accountUid', () => {
  const now = Date.now();
  const retainedIntent = {
   userId: 'uid-1',
   accountUid: 'uid-2',
   occurred_at: new Date(now - 1000).toISOString(),
  };
  expect(canUseApplicationIntentForRanking({
   profile: { applicationIntent: { optedOut: false } },
   intent: retainedIntent,
   userId: 'uid-1',
   now,
  })).toBe(false);
 });

 it('keeps the deletion boundary durable and rejects late writes', async () => {
  const { db, store } = createTombstoneDb();
  const stamp = new Date().toISOString();
  const tombstone = buildApplicationIntentAccountTombstone('uid-1', stamp);
  expect(tombstone).toMatchObject({ status: 'account_deleted', userId: 'uid-1' });
  await db.collection(APPLICATION_INTENT_ACCOUNT_TOMBSTONES_COLLECTION).doc('uid-1').set(tombstone!);

  expect(await isApplicationIntentAccountDeleted(db as never, 'uid-1')).toBe(true);
  expect(await canWriteApplicationIntentForAccount(db as never, {
   uid: 'uid-1',
   profile: { applicationIntent: { optedOut: false } },
  })).toBe(false);
  expect(await canSendApplicationIntentReminderForAccount(db as never, {
   userId: 'uid-1',
   profile: { applicationIntent: { optedOut: false } },
   intent: { userId: 'uid-1', occurred_at: new Date(Date.now() - 6 * 86400000).toISOString() },
  })).toBe(false);
  expect(store.get(`${APPLICATION_INTENT_ACCOUNT_TOMBSTONES_COLLECTION}/uid-1`)).toMatchObject({
   account_deleted_at: stamp,
  });
 });
});

describe('application-intent preference center contract', () => {
 it('does not default the preference during login or load', async () => {
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(
   new URL('../components/preferences/SubscriptionPreferencesController.tsx', import.meta.url),
   'utf8',
  ));
  expect(source).toContain('authLoadApplicationIntentOptOut');
  expect(source).toContain('authSetApplicationIntentOptOut');
  expect(source).toContain('applicationIntent.optedOut');
  expect(source).toContain('if (!cancelled) {\n   setApplicationIntentOptedOut(optedOut);');
  expect(source).not.toMatch(/authLoadApplicationIntentOptOut\([^)]*\)[\s\S]{0,200}setDoc/);
 });
});
