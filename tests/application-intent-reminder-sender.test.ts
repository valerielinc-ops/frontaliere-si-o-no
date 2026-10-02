/**
 * The one-shot "Candidati" reminder, end to end inside main(): a record built
 * by the real producer, an in-memory Firestore, a stubbed provider cascade.
 *
 * Why at this level: the eligibility helper and the delivery ledger each had
 * their own unit tests, all green, while every production run ended
 * "sent 0" (2026-09-29..10-01). The pieces were tested with fixtures the
 * producer can never write, and nothing ran them together.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cascade = vi.hoisted(() => ({ calls: [] as Array<Array<Record<string, any>>> }));

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUser: async (uid: string) => ({
      uid,
      email: `${uid}@example.invalid`,
      emailVerified: uid !== 'uid-unverified',
    }),
    verifyIdToken: async () => null,
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
  APPLICATION_INTENT_CONSENT_VERSION,
  buildApplicationIntentRecord,
  normalizeApplicationIntentRequest,
} from '../functions/src/applicationIntentCore.js';
import { buildApplicationIntentJobKey } from '../services/applicationIntentRanking.mjs';
import {
  __setFirestoreAdminForTest,
  __setJobsForTest,
  main,
} from '../scripts/send-application-intent-reminders.mjs';

const DAY = 86400000;
const LEDGER = 'application_intent_reminder_deliveries';

function job(n: number) {
  return {
    id: `job-${n}`,
    companyKey: `company-${n}`,
    slug: `software-engineer-${n}`,
    slugByLocale: { it: `software-engineer-${n}` },
    title: `Software Engineer ${n}`,
    titleByLocale: { it: `Software Engineer ${n}` },
    company: `Company ${n} SA`,
    canton: 'TI',
    location: 'Lugano',
    category: 'IT',
  };
}

/** What Firestore holds after the producer's transaction commits. */
function producerRecord(uid: string, listing: ReturnType<typeof job>, clickedDaysAgo: number) {
  const normalized = normalizeApplicationIntentRequest({
    jobKey: buildApplicationIntentJobKey(listing),
    jobSlug: listing.slug,
    companyKey: listing.companyKey,
    jobTitle: listing.title,
    origin: '/cerca-lavoro-ticino/',
    surface: 'job_board_apply',
    consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
    consentText: 'Ho cliccato su Candidati.',
  });
  if (!normalized.ok) throw new Error(normalized.error);
  const builtAt = Date.now() - clickedDaysAgo * DAY;
  const record = buildApplicationIntentRecord({
    req: { headers: {} },
    token: { uid },
    input: normalized.input,
    now: builtAt,
  });
  if (!record) throw new Error('producer refused the fixture');
  const { intentId, ...stored } = record;
  // serverTimestamp() resolves at commit, after the transaction's reads.
  const committedAt = new Date(builtAt + 150);
  return { intentId, data: { ...stored, timestamp: committedAt, createdAt: committedAt, updatedAt: committedAt } };
}

function memoryDb() {
  const docs = new Map<string, Record<string, any>>();
  const snapshot = (path: string) => ({
    id: path.split('/').pop(),
    exists: docs.has(path),
    data: () => docs.get(path),
  });
  const ref = (path: string) => ({
    id: path.split('/').pop(),
    path,
    get: async () => snapshot(path),
    set: async (data: Record<string, any>, options?: { merge?: boolean }) => {
      docs.set(path, options?.merge ? { ...(docs.get(path) || {}), ...data } : data);
    },
  });
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ref(`${name}/${id}`),
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
    collectionGroup: (name: string) => ({
      get: async () => ({
        docs: [...docs.keys()]
          .filter((path) => path.startsWith(`${name}/`))
          .map((path) => ({
            ...snapshot(path),
            ref: { ...ref(path), parent: { id: name, parent: null } },
          })),
      }),
    }),
    async runTransaction(callback: (transaction: any) => Promise<unknown>) {
      return callback({
        get: async (target: { path: string }) => snapshot(target.path),
        create: (target: { path: string }, data: Record<string, any>) => {
          if (docs.has(target.path)) throw new Error('already_exists');
          docs.set(target.path, data);
        },
        set: (target: { path: string }, data: Record<string, any>, options?: { merge?: boolean }) => {
          docs.set(target.path, options?.merge ? { ...(docs.get(target.path) || {}), ...data } : data);
        },
        delete: (target: { path: string }) => docs.delete(target.path),
      });
    },
  };
  return { db, docs };
}

async function runSender(db: unknown) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  try {
    __setFirestoreAdminForTest(db);
    await main();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

describe('application-intent reminder sender — main()', () => {
  beforeEach(() => {
    cascade.calls.length = 0;
  });

  it('reminds a producer-written click once, and only once, after 48 hours', async () => {
    const listing = job(1);
    __setJobsForTest([listing]);
    const { db, docs } = memoryDb();
    const intent = producerRecord('uid-1', listing, 3);
    docs.set(`application_intents/${intent.intentId}`, intent.data);

    const first = await runSender(db);
    expect(first).toContain('sent 1, skipped 0');
    expect(cascade.calls).toHaveLength(1);
    expect(cascade.calls[0][0].payload.to).toEqual(['uid-1@example.invalid']);
    expect(docs.get(`${LEDGER}/${intent.intentId}`)).toMatchObject({ state: 'sent', uid: 'uid-1' });

    const second = await runSender(db);
    expect(second).toContain('sent 0, skipped 1');
    expect(second).toContain('already_delivered=1');
    expect(cascade.calls).toHaveLength(1);
  });

  it('does not remind a click younger than 48 hours', async () => {
    const listing = job(1);
    __setJobsForTest([listing]);
    const { db, docs } = memoryDb();
    const intent = producerRecord('uid-1', listing, 1);
    docs.set(`application_intents/${intent.intentId}`, intent.data);

    const output = await runSender(db);
    expect(output).toContain('sent 0, skipped 1');
    expect(output).toContain('intent_not_due_or_closed=1');
    expect(cascade.calls).toHaveLength(0);
  });

  it('reminds a sixth click when the five older ones were already reminded', async () => {
    const listings = [1, 2, 3, 4, 5, 6].map(job);
    __setJobsForTest(listings);
    const { db, docs } = memoryDb();
    const intents = listings.map((listing, index) => producerRecord('uid-1', listing, 10 - index));
    for (const intent of intents) docs.set(`application_intents/${intent.intentId}`, intent.data);
    for (const intent of intents.slice(0, 5)) {
      docs.set(`${LEDGER}/${intent.intentId}`, { uid: 'uid-1', intent_id: intent.intentId, state: 'sent' });
    }

    const output = await runSender(db);
    expect(output).toContain('sent 1, skipped 0');
    expect(cascade.calls).toHaveLength(1);
    expect(cascade.calls[0][0].payload.tags).toContainEqual({ name: 'intent_count', value: '1' });
    expect(docs.get(`${LEDGER}/${intents[5].intentId}`)).toMatchObject({ state: 'sent' });
  });

  it('says why an account was skipped', async () => {
    const listing = job(1);
    __setJobsForTest([listing]);
    const { db, docs } = memoryDb();
    const intent = producerRecord('uid-unverified', listing, 3);
    docs.set(`application_intents/${intent.intentId}`, intent.data);

    const output = await runSender(db);
    expect(output).toContain('sent 0, skipped 1');
    expect(output).toContain('Skip reasons: no_verified_email=1');
    expect(cascade.calls).toHaveLength(0);
  });
});
