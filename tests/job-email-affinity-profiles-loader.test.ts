// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AFFINITY_PROFILE_READ_CHUNK,
  loadJobEmailAffinityProfiles,
} from '../functions/src/lib/jobEmailAffinityStore.js';
import {
  JOB_EMAIL_AFFINITY_COLLECTION,
  affinityRankingContext,
  applyAffinityClick,
  emptyAffinityProfile,
} from '../functions/src/lib/jobEmailAffinity.js';
import { pseudonymousUserId, rankEmailJobs } from '../functions/src/lib/jobEmailRanking.js';
import { subscriberFromFirestoreRow } from '../scripts/lib/subscriberFromFirestoreRow.mjs';

const SECRET = 'test-newsletter-secret';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.now());
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

function validProfile(attrs: Record<string, string>) {
  let profile: any = emptyAffinityProfile('pid');
  profile = applyAffinityClick(profile, attrs, daysAgo(3));
  return applyAffinityClick(profile, attrs, daysAgo(2));
}

/**
 * Firestore fake that records every access. It only supports what the loader
 * may use: collection(name).doc(id) and getAll(...refs). Any query method
 * (where/get on a collection) throws, so a join on the click events would fail.
 */
function fakeDb(stored: Record<string, any> = {}, { failCall = -1 } = {}) {
  const getAllCalls: string[][] = [];
  const collections: string[] = [];
  const db: any = {
    collection: (name: string) => {
      collections.push(name);
      return {
        doc: (id: string) => ({ path: `${name}/${id}`, id }),
        where: () => { throw new Error('query not allowed'); },
        get: () => { throw new Error('collection scan not allowed'); },
      };
    },
    getAll: async (...refs: any[]) => {
      const index = getAllCalls.length;
      getAllCalls.push(refs.map((ref) => ref.path));
      if (index === failCall) throw Object.assign(new Error(`boom on ${refs[0].path}`), { code: 'unavailable' });
      return refs.map((ref) => ({
        exists: ref.path in stored,
        data: () => stored[ref.path],
      }));
    },
  };
  return { db, getAllCalls, collections };
}

const docPath = (email: string) => `${JOB_EMAIL_AFFINITY_COLLECTION}/${pseudonymousUserId(email, SECRET)}`;

afterEach(() => vi.restoreAllMocks());

describe('loadJobEmailAffinityProfiles', () => {
  it('reads one document per person, in getAll batches of at most 300', async () => {
    const emails = Array.from({ length: 650 }, (_, index) => `persona${index}@example.com`);
    const { db, getAllCalls } = fakeDb();
    const { profiles, stats } = await loadJobEmailAffinityProfiles(db, emails.map((email) => ({ email })), { secret: SECRET });
    expect(AFFINITY_PROFILE_READ_CHUNK).toBe(300);
    expect(getAllCalls.map((refs) => refs.length)).toEqual([300, 300, 50]);
    expect(new Set(getAllCalls.flat()).size).toBe(650);
    expect(profiles.size).toBe(650);
    expect(stats).toMatchObject({ recipients: 650, read: 650, found: 0, failed: 0 });
  });

  it('reads a person once even with several alerts or a different casing', async () => {
    const { db, getAllCalls } = fakeDb();
    await loadJobEmailAffinityProfiles(db, [
      { email: 'Persona@Example.com' },
      { email: 'persona@example.com' },
      { email: ' persona@example.com ' },
      { email: 'altra@example.com' },
    ], { secret: SECRET });
    expect(getAllCalls.flat()).toEqual([docPath('persona@example.com'), docPath('altra@example.com')]);
  });

  it('computes the id as HMAC(email, NEWSLETTER_SECRET), never the unsalted user_id of the click events', async () => {
    const email = 'persona@example.com';
    const profile = validProfile({ category: 'Informatica' });
    const { db, getAllCalls, collections } = fakeDb({ [docPath(email)]: profile });
    const { profiles } = await loadJobEmailAffinityProfiles(db, [{ email }], { secret: SECRET });
    // Cloud Functions compute the click events' user_id without the secret.
    const unsaltedEventUserId = pseudonymousUserId(email, '');
    expect(getAllCalls.flat()).toEqual([`${JOB_EMAIL_AFFINITY_COLLECTION}/${pseudonymousUserId(email, SECRET)}`]);
    expect(getAllCalls.flat().join()).not.toContain(unsaltedEventUserId);
    expect(new Set(collections)).toEqual(new Set([JOB_EMAIL_AFFINITY_COLLECTION]));
    expect(profiles.get(email)).toBe(profile);
  });

  it('does not read the profile of a person who opposed it: null, standard order', async () => {
    const email = 'contraria@example.com';
    const { db, getAllCalls } = fakeDb({ [docPath(email)]: validProfile({ category: 'Informatica' }) });
    const { profiles, stats } = await loadJobEmailAffinityProfiles(db, [{ email, optOut: true }], { secret: SECRET });
    expect(getAllCalls).toEqual([]);
    expect(profiles.get(email)).toBeNull();
    expect(stats).toMatchObject({ recipients: 1, opted_out: 1, read: 0 });

    const pool = [
      { slug: 'edilizia', category: 'Edilizia', relevanceScore: 10 },
      { slug: 'informatica', category: 'Informatica', relevanceScore: 8 },
    ];
    const context = affinityRankingContext(profiles.get(email) ?? null, NOW);
    expect(context.affinityProfile).toBe(false);
    const config = { enabled: true, rollout: 1, affinityWeight: 1 };
    expect(rankEmailJobs(pool, { variant: 'affinity', affinityScorer: context.affinityScorer, config }).map((job) => job.slug))
      .toEqual(rankEmailJobs(pool, { variant: 'control', config }).map((job) => job.slug));
  });

  it('the newsletter projection carries the opposition flag of the subscriber document', () => {
    expect(subscriberFromFirestoreRow({ email: 'a@example.com', ranking_personalization_opt_out: true }).rankingPersonalizationOptOut).toBe(true);
    expect(subscriberFromFirestoreRow({ email: 'a@example.com' }).rankingPersonalizationOptOut).toBe(false);
    expect(subscriberFromFirestoreRow({ email: 'a@example.com', ranking_personalization_opt_out: 'yes' }).rankingPersonalizationOptOut).toBe(false);
  });

  it('without the secret it reads nothing and everybody gets the standard order', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, getAllCalls } = fakeDb();
    const { profiles, stats } = await loadJobEmailAffinityProfiles(db, [{ email: 'a@example.com' }], { secret: '' });
    expect(getAllCalls).toEqual([]);
    expect(profiles.get('a@example.com')).toBeNull();
    expect(stats.skipped_reason).toBe('missing_secret');
    expect(warn).toHaveBeenCalled();
  });

  it('without Firestore (preview) it reads nothing and does not throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { profiles, stats } = await loadJobEmailAffinityProfiles(null, [{ email: 'a@example.com' }], { secret: SECRET });
    expect(profiles.get('a@example.com')).toBeNull();
    expect(stats.skipped_reason).toBe('no_firestore');
  });

  it('a failed batch degrades to "no profile" for that batch only, with a log free of addresses and pseudonyms', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const first = 'uno@example.com';
    const second = 'due@example.com';
    const stored = {
      [docPath(first)]: validProfile({ canton: 'TI' }),
      [docPath(second)]: validProfile({ canton: 'GE' }),
    };
    const { db } = fakeDb(stored, { failCall: 0 });
    const { profiles, stats } = await loadJobEmailAffinityProfiles(db, [{ email: first }, { email: second }], { secret: SECRET, chunkSize: 1 });
    expect(profiles.get(first)).toBeNull();
    expect(profiles.get(second)).toBe(stored[docPath(second)]);
    expect(stats).toMatchObject({ read: 1, found: 1, failed: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('@');
    expect(lines[0]).not.toContain(pseudonymousUserId(first, SECRET));
  });
});
