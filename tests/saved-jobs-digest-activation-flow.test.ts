/**
 * The saved-jobs digest from the save that activates it to the click that
 * stops it (owner decision 2026-10-02: "attiva al salvataggio annuncio").
 *
 * Runs the real sender main() and the real unsubscribe handler against one
 * in-memory Firestore, with the provider cascade stubbed. The point is the
 * seam between three deploy units: the browser writes the activation, the
 * script signs the link, the Cloud Function verifies it. Each had its own
 * tests; none of them proved that the link the script mails is one the
 * function accepts, nor that the stop survives the next save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cascade = vi.hoisted(() => ({ calls: [] as Array<Array<Record<string, any>>> }));
/** Firebase Auth as the Admin SDK reports it, per uid; a missing uid throws. */
const authUsers = vi.hoisted(() => new Map<string, { email: string; emailVerified: boolean }>());

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUser: async (uid: string) => {
      const user = authUsers.get(uid);
      if (!user) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
      return { uid, ...user };
    },
  }),
}));

vi.mock('../scripts/lib/email-cascade.mjs', () => ({
  sendEmailCascade: async (items: Array<Record<string, any>>, opts: Record<string, any> = {}) => {
    cascade.calls.push(items);
    const sent = items.map((item) => ({ ...item, messageId: `msg-${cascade.calls.length}`, provider: 'stub' }));
    for (const item of sent) await opts.onSent?.(item, item);
    return { sent, failed: [] };
  },
}));

import {
  __setFirestoreAdminForTest,
  __setJobsForTest,
  assertUnsubscribeSecret,
  ensureSavedJobsDigestAnchor,
  main,
} from '../scripts/send-saved-jobs-digest.mjs';
import { handleSavedJobsDigestUnsubscribe } from '../functions/src/savedJobsDigestUnsubscribe.js';
import { applyResendWebhookEvent } from '../functions/src/newsletterResendWebhookCore.js';
import { hasNewsletterSubscriberRecord } from '../functions/src/jobAlertBackfillCore.js';
import {
  hasSubscriptionBasis,
  isSavedJobsDigestAnchorOnly,
  SAVED_JOBS_DIGEST_ANCHOR_FIELD,
} from '../services/subscriberConsent.mjs';
import {
  SAVED_JOBS_DIGEST_SAVE_ACTIVATION,
  savedJobsDigestChoice,
  shouldActivateSavedJobsDigestOnSave,
} from '../services/savedJobsDigestActivation.mjs';

const SECRET = 'test-newsletter-secret';
const UID = 'uid-1';
const EMAIL = 'uid-1@example.invalid';

function isMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isMap(value) && isMap(out[key])
      ? mergeDeep(out[key] as Record<string, unknown>, value)
      : value;
  }
  return out;
}

/** Path-keyed admin-SDK fake: nested collections, collection groups, serialized transactions. */
function memoryFirestore() {
  const docs = new Map<string, Record<string, any>>();
  const snapshot = (path: string) => ({
    id: path.split('/').pop(),
    exists: docs.has(path),
    data: () => docs.get(path),
  });
  const write = (path: string, data: Record<string, any>, options?: { merge?: boolean }) => {
    docs.set(path, options?.merge ? mergeDeep(docs.get(path) || {}, data) : data);
  };
  const docRef = (path: string): any => {
    const segments = path.split('/');
    return {
      id: segments[segments.length - 1],
      path,
      // The webhook cores open their transaction from the document reference.
      firestore: db,
      parent: {
        id: segments[segments.length - 2],
        parent: segments.length > 2 ? docRef(segments.slice(0, -2).join('/')) : null,
      },
      get: async () => snapshot(path),
      set: async (data: Record<string, any>, options?: { merge?: boolean }) => write(path, data, options),
      collection: (name: string) => collectionRef(`${path}/${name}`),
    };
  };
  let autoId = 0;
  const collectionRef = (path: string) => ({
    doc: (id: string) => docRef(`${path}/${id}`),
    add: async (data: Record<string, any>) => {
      autoId += 1;
      docs.set(`${path}/auto-${autoId}`, data);
      return docRef(`${path}/auto-${autoId}`);
    },
    where: () => ({ get: async () => ({ docs: [] }) }),
  });
  let tail = Promise.resolve();
  const db: any = {
    collection: (name: string) => collectionRef(name),
    collectionGroup: (name: string) => ({
      get: async () => ({
        docs: [...docs.keys()]
          .filter((path) => path.split('/').slice(-2, -1)[0] === name)
          .map((path) => ({ ...snapshot(path), ref: docRef(path) })),
      }),
    }),
    async runTransaction(callback: (transaction: any) => Promise<unknown>) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback({
          get: async (ref: { path: string }) => snapshot(ref.path),
          create: (ref: { path: string }, data: Record<string, any>) => {
            if (docs.has(ref.path)) throw new Error('already_exists');
            docs.set(ref.path, data);
          },
          set: (ref: { path: string }, data: Record<string, any>, options?: { merge?: boolean }) => write(ref.path, data, options),
          delete: (ref: { path: string }) => docs.delete(ref.path),
        });
      } finally {
        release();
      }
    },
  };
  return { db, docs };
}

/** What services/savedJobsService.ts writes in its transaction when a listing is saved. */
function saveListing(docs: Map<string, Record<string, any>>, jobId: string) {
  docs.set(`users/${UID}/savedJobs/${jobId}`, {
    slug: `${jobId}-slug`, title: `Job ${jobId}`, company: 'ACME SA', canton: 'TI', category: 'IT', savedAt: Date.now(),
  });
  const profile = docs.get(`users/${UID}`) || {};
  if (!shouldActivateSavedJobsDigestOnSave(profile.savedJobsDigest)) return;
  docs.set(`users/${UID}`, mergeDeep(profile, {
    savedJobsDigest: { optedIn: true, optedInAt: new Date(), activationSource: SAVED_JOBS_DIGEST_SAVE_ACTIVATION },
  }));
}

async function runDigest(db: unknown) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
  try {
    __setFirestoreAdminForTest(db);
    await main();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

const listing = {
  id: 'job-1',
  companyKey: 'acme',
  slug: 'software-engineer-lugano',
  slugByLocale: { it: 'software-engineer-lugano' },
  title: 'Software Engineer',
  company: 'ACME SA',
  canton: 'TI',
  location: 'Lugano',
  category: 'IT',
};

describe('saved-jobs digest — activated by a save, stopped by its own link', () => {
  const previousSecret = process.env.NEWSLETTER_SECRET;

  beforeEach(() => {
    cascade.calls.length = 0;
    process.env.NEWSLETTER_SECRET = SECRET;
    __setJobsForTest([listing]);
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.NEWSLETTER_SECRET;
    else process.env.NEWSLETTER_SECRET = previousSecret;
  });

  function seededFirestore() {
    const store = memoryFirestore();
    // ensureUserProfileDoc: email + locale, no digest field ("never decided").
    store.docs.set(`users/${UID}`, { email: EMAIL, locale: 'it' });
    // A sign-in is the registration act (services/authService.ts): the saver
    // already has the central record the digest requires.
    store.docs.set(`newsletter_subscribers/${EMAIL}`, {
      email: EMAIL, status: 'confirmed', registration_terms_accepted: true, auth_uid: UID,
    });
    return store;
  }

  it('a saved-job document alone is not an activation (no backfill)', async () => {
    const { db, docs } = seededFirestore();
    docs.set(`users/${UID}/savedJobs/job-1`, { title: 'Job job-1', company: 'ACME SA', savedAt: 1 });
    const output = await runDigest(db);
    expect(output).toContain('sent 0, skipped 1');
    expect(cascade.calls).toHaveLength(0);
  });

  it('mails the saver with a one-click link the unsubscribe function accepts, and a later save does not undo it', async () => {
    const { db, docs } = seededFirestore();
    saveListing(docs, 'job-1');
    expect(savedJobsDigestChoice(docs.get(`users/${UID}`)?.savedJobsDigest)).toBe('on');

    expect(await runDigest(db)).toContain('sent 1, skipped 0');
    expect(cascade.calls).toHaveLength(1);
    const { payload } = cascade.calls[0][0];
    expect(payload.to).toEqual([EMAIL]);

    // The same signed link in the header, the HTML part and the text part.
    const header = String(payload.headers['List-Unsubscribe']);
    expect(payload.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const unsubUrl = header.replace(/^<|>$/g, '');
    const url = new URL(unsubUrl);
    expect(url.origin).toBe('https://frontaliereticino.ch');
    expect(url.pathname).toBe('/disiscrivi-promemoria-salvati/');
    expect(payload.html).toContain(`href="${unsubUrl}"`);
    expect(payload.text).toContain(unsubUrl);

    // The click (or the provider's one-click POST) reaches the function.
    const result = await handleSavedJobsDigestUnsubscribe({
      uid: url.searchParams.get('uid'),
      email: url.searchParams.get('email'),
      token: url.searchParams.get('token'),
      secret: SECRET,
      forensics: null,
      db,
    });
    expect(result.status).toBe(200);
    expect(docs.get(`users/${UID}`)?.savedJobsDigest).toMatchObject({ optedIn: false, optedOut: true });
    // Scoped to this channel: the newsletter record is untouched.
    expect(docs.get(`newsletter_subscribers/${EMAIL}`)).toMatchObject({ status: 'confirmed' });

    // Saving another listing afterwards does not turn the digest back on:
    // no write at all, the stop keeps its provenance.
    const stopped = docs.get(`users/${UID}`)?.savedJobsDigest;
    saveListing(docs, 'job-2');
    expect(docs.get(`users/${UID}`)?.savedJobsDigest).toBe(stopped);
    expect(savedJobsDigestChoice(stopped)).toBe('off');

    // Next week's run: no campaign claim in the way, the stop alone blocks it.
    for (const path of [...docs.keys()]) {
      if (path.includes('/campaign_deliveries/')) docs.delete(path);
    }
    expect(await runDigest(db)).toContain('sent 0, skipped 1');
    expect(cascade.calls).toHaveLength(1);
  });

  it('a forged link does not unsubscribe', async () => {
    const { db, docs } = seededFirestore();
    saveListing(docs, 'job-1');
    const result = await handleSavedJobsDigestUnsubscribe({
      uid: UID, email: EMAIL, token: '00'.repeat(32), secret: SECRET, forensics: null, db,
    });
    expect(result.status).toBe(403);
    expect(savedJobsDigestChoice(docs.get(`users/${UID}`)?.savedJobsDigest)).toBe('on');
  });

  it('refuses to send without the secret that signs the link', async () => {
    delete process.env.NEWSLETTER_SECRET;
    const { db, docs } = seededFirestore();
    saveListing(docs, 'job-1');
    __setFirestoreAdminForTest(db);
    await expect(main()).rejects.toThrow(/NEWSLETTER_SECRET/);
    expect(cascade.calls).toHaveLength(0);
    expect(() => assertUnsubscribeSecret(true, {})).not.toThrow();
  });
});

/**
 * Owner decision of 2026-10-03, "includili al salvataggio": about 3% of the
 * accounts created in early September have no `newsletter_subscribers` row, so
 * the activation written at save time reached nobody. The sender now creates
 * the digest's own record for them — and that record must give them the
 * digest and nothing else, keep catching the provider's bounce/complaint, and
 * never become a subscription.
 */
describe('saved-jobs digest — an account without a central row', () => {
  const previousSecret = process.env.NEWSLETTER_SECRET;
  const ROW = `newsletter_subscribers/${EMAIL}`;

  beforeEach(() => {
    cascade.calls.length = 0;
    process.env.NEWSLETTER_SECRET = SECRET;
    __setJobsForTest([listing]);
    authUsers.clear();
    authUsers.set(UID, { email: EMAIL, emailVerified: true });
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.NEWSLETTER_SECRET;
    else process.env.NEWSLETTER_SECRET = previousSecret;
  });

  /** ensureUserProfileDoc wrote the profile; the sign-in's registration write never landed. */
  function profileOnlyFirestore() {
    const store = memoryFirestore();
    store.docs.set(`users/${UID}`, { email: EMAIL, locale: 'it' });
    return store;
  }

  /** What the provider webhook delivers for an event on this digest. */
  function providerEvent(db: unknown, type: string) {
    return applyResendWebhookEvent({
      type,
      data: {
        email_id: `msg-${type}`,
        to: [EMAIL],
        created_at: new Date().toISOString(),
        tags: [{ name: 'type', value: 'saved-jobs-digest' }],
      },
    }, { db });
  }

  function nextWeek(docs: Map<string, Record<string, any>>) {
    for (const path of [...docs.keys()]) {
      if (path.includes('/campaign_deliveries/')) docs.delete(path);
    }
  }

  it('the first save is enough: the digest goes out, and the only row created is the digest record', async () => {
    const { db, docs } = profileOnlyFirestore();
    saveListing(docs, 'job-1');

    expect(await runDigest(db)).toContain('sent 1, skipped 0');
    expect(cascade.calls).toHaveLength(1);
    expect(cascade.calls[0][0].payload.to).toEqual([EMAIL]);

    const row = docs.get(ROW);
    expect(row).toEqual({
      email: EMAIL,
      auth_uid: UID,
      [SAVED_JOBS_DIGEST_ANCHOR_FIELD]: { created_at: expect.any(Date), activation_source: SAVED_JOBS_DIGEST_SAVE_ACTIVATION },
    });
    // Not a subscription: every newsletter-population gate refuses it, and no
    // other channel's collection was touched.
    expect(isSavedJobsDigestAnchorOnly(row)).toBe(true);
    expect(hasSubscriptionBasis(row)).toBe(false);
    expect(hasNewsletterSubscriberRecord(row)).toBe(false);
    expect([...docs.keys()].filter((path) => path.startsWith('job_alert_subscribers/'))).toEqual([]);

    // The one-click link works for this account too: it is keyed by uid.
    const unsubUrl = new URL(String(cascade.calls[0][0].payload.headers['List-Unsubscribe']).replace(/^<|>$/g, ''));
    const result = await handleSavedJobsDigestUnsubscribe({
      uid: unsubUrl.searchParams.get('uid'),
      email: unsubUrl.searchParams.get('email'),
      token: unsubUrl.searchParams.get('token'),
      secret: SECRET,
      forensics: null,
      db,
    });
    expect(result.status).toBe(200);
    expect(savedJobsDigestChoice(docs.get(`users/${UID}`)?.savedJobsDigest)).toBe('off');
    expect(docs.get(ROW)).toBe(row);

    nextWeek(docs);
    expect(await runDigest(db)).toContain('sent 0, skipped 1');
    expect(cascade.calls).toHaveLength(1);
  });

  it('a complaint about the digest lands on that record and stops the next one', async () => {
    const { db, docs } = profileOnlyFirestore();
    saveListing(docs, 'job-1');
    expect(await runDigest(db)).toContain('sent 1, skipped 0');

    // Without the record the webhook would answer UNKNOWN_RECIPIENT and the
    // complaint would be lost — the reason the digest requires a row at all.
    expect(await providerEvent(db, 'email.complained')).toMatchObject({ handled: true });
    expect(docs.get(ROW)).toMatchObject({ status: 'complained' });
    expect(hasSubscriptionBasis(docs.get(ROW))).toBe(false);

    nextWeek(docs);
    expect(await runDigest(db)).toContain('sent 0, skipped 1');
    expect(cascade.calls).toHaveLength(1);
  });

  it('a machine recovery does not turn the record into a subscription; the digest resumes', async () => {
    const { db, docs } = profileOnlyFirestore();
    saveListing(docs, 'job-1');
    expect(await runDigest(db)).toContain('sent 1, skipped 0');

    expect(await providerEvent(db, 'email.suppressed')).toMatchObject({ handled: true });
    nextWeek(docs);
    expect(await runDigest(db)).toContain('sent 0, skipped 1');

    // A late delivery disproves the provider suppression (subscriberReactivation.js):
    // the row gets `status: 'active'`, `isActive: true`. That is the address
    // coming back, not the person asking for the newsletter.
    expect(await providerEvent(db, 'email.delivered')).toMatchObject({ handled: true });
    const recovered = docs.get(ROW);
    expect(recovered).toMatchObject({ status: 'active', isActive: true });
    expect(hasSubscriptionBasis(recovered)).toBe(false);
    expect(hasNewsletterSubscriberRecord(recovered)).toBe(false);

    nextWeek(docs);
    expect(await runDigest(db)).toContain('sent 1, skipped 0');
    expect(cascade.calls).toHaveLength(2);
  });

  it('an explicit stop is final: no digest and no record', async () => {
    const { db, docs } = profileOnlyFirestore();
    docs.set(`users/${UID}`, { email: EMAIL, locale: 'it', savedJobsDigest: { optedIn: false, optedOut: true } });
    saveListing(docs, 'job-1');

    expect(await runDigest(db)).toContain('sent 0, skipped 1');
    expect(docs.has(ROW)).toBe(false);
  });

  it('a save from before the activation (never decided) creates nothing', async () => {
    const { db, docs } = profileOnlyFirestore();
    docs.set(`users/${UID}/savedJobs/job-1`, { title: 'Job job-1', company: 'ACME SA', savedAt: 1 });

    expect(await runDigest(db)).toContain('sent 0, skipped 1');
    expect(docs.has(ROW)).toBe(false);
  });

  it('an address Auth does not mark verified is excluded, and gets no record', async () => {
    authUsers.set(UID, { email: EMAIL, emailVerified: false });
    const { db, docs } = profileOnlyFirestore();
    saveListing(docs, 'job-1');

    expect(await runDigest(db)).toContain('sent 0, skipped 1');
    expect(cascade.calls).toHaveLength(0);
    expect(docs.has(ROW)).toBe(false);
  });

  it('a profile address that is not the Auth address is excluded', async () => {
    // users/{uid} is owner-writable: its `email` is a claim, Auth is the record.
    authUsers.set(UID, { email: 'someone-else@example.invalid', emailVerified: true });
    const { db, docs } = profileOnlyFirestore();
    saveListing(docs, 'job-1');

    expect(await runDigest(db)).toContain('sent 0, skipped 1');
    expect([...docs.keys()].filter((path) => path.startsWith('newsletter_subscribers/'))).toEqual([]);
  });

  it('an Auth lookup failure skips the account instead of failing the run', async () => {
    authUsers.clear();
    const { db, docs } = profileOnlyFirestore();
    saveListing(docs, 'job-1');

    expect(await runDigest(db)).toContain('sent 0, skipped 1');
    expect(docs.has(ROW)).toBe(false);
  });

  it('never overwrites a row that appeared meanwhile, and reads that row instead', async () => {
    const { db, docs } = profileOnlyFirestore();
    const stopped = { email: EMAIL, status: 'unsubscribed', isActive: false };
    docs.set(ROW, stopped);
    const row = await ensureSavedJobsDigestAnchor(db, { uid: UID, email: EMAIL, activationSource: 'saved_job' });
    expect(row).toBe(stopped);
    expect(docs.get(ROW)).toBe(stopped);
  });

  it('an account that has its central row is unchanged: no Auth lookup, no record', async () => {
    authUsers.clear();
    const { db, docs } = profileOnlyFirestore();
    const central = { email: EMAIL, status: 'confirmed', registration_terms_accepted: true, auth_uid: UID };
    docs.set(ROW, central);
    saveListing(docs, 'job-1');

    expect(await runDigest(db)).toContain('sent 1, skipped 0');
    expect(docs.get(ROW)).toBe(central);
  });
});
