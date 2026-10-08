import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachApplicationIntentPersonalization,
  loadJobAlertsForSubscribers,
  loadPooledCampaignVariantTotals,
} from '../scripts/lib/newsletter-send-inputs.mjs';

type Snapshot = {
  id: string;
  exists: () => boolean;
  data: () => Record<string, any> | undefined;
  ref?: { path: string };
};

type FixtureOptions = {
  alerts?: Record<string, Record<string, any>[]>;
  privateDocs?: Record<string, Record<string, any>>;
  users?: Record<string, Record<string, any>>;
  alertQueryErrors?: Set<string>;
  collectionGroupError?: Error;
  privateReadError?: Error;
  profileReadError?: Error;
  cacheDocument?: Record<string, any>;
  cacheReadError?: Error;
  cacheWriteError?: Error;
};

function snapshot(pathName: string, data: Record<string, any> | undefined): Snapshot {
  const id = pathName.split('/').pop() || '';
  return {
    id,
    exists: () => data !== undefined,
    data: () => data,
    ref: { path: pathName },
  };
}

function fakeDb(options: FixtureOptions = {}) {
  const alerts = options.alerts || {};
  const privateDocs = options.privateDocs || {};
  const users = options.users || {};
  let cache = options.cacheDocument ? { ...options.cacheDocument } : undefined;
  const calls = {
    collectionGroup: 0,
    alertQueries: [] as string[],
    getAll: [] as string[][],
    cacheGets: 0,
    cacheSets: [] as Array<{ payload: Record<string, any>; options: any }>,
  };

  const makeDocRef = (pathName: string): any => ({
    path: pathName,
    id: pathName.split('/').pop(),
    collection(name: string) {
      return makeCollectionRef(`${pathName}/${name}`);
    },
    async get() {
      if (pathName === 'newsletter_subscribers/_meta_/campaign_ab_winners/weekly_current') {
        calls.cacheGets += 1;
        if (options.cacheReadError) throw options.cacheReadError;
        return snapshot(pathName, cache);
      }
      return snapshot(pathName, undefined);
    },
    async set(payload: Record<string, any>, setOptions: any) {
      if (pathName === 'newsletter_subscribers/_meta_/campaign_ab_winners/weekly_current') {
        calls.cacheSets.push({ payload, options: setOptions });
        if (options.cacheWriteError) throw options.cacheWriteError;
        cache = { ...payload };
      }
    },
  });

  const makeCollectionRef = (pathName: string): any => ({
    path: pathName,
    doc(id: string) {
      return makeDocRef(`${pathName}/${id}`);
    },
    where(field: string, operator: string, value: any) {
      return {
        async get() {
          if (pathName.startsWith('job_alert_subscribers/')) {
            const email = pathName.split('/')[1];
            calls.alertQueries.push(email);
            if (options.alertQueryErrors?.has(email)) throw new Error(`errore ${email}`);
            const rows = (alerts[email] || []).filter((row) => operator !== '==' || row[field] === value);
            return {
              docs: rows.map((row, index) => snapshot(`${pathName}/alert-${index}`, row)),
              size: rows.length,
            };
          }
          return { docs: [], size: 0 };
        },
      };
    },
  });

  const db: any = {
    collection(name: string) {
      return makeCollectionRef(name);
    },
    collectionGroup(name: string) {
      calls.collectionGroup += 1;
      return {
        where(field: string, operator: string, value: any) {
          return {
            async get() {
              if (options.collectionGroupError) throw options.collectionGroupError;
              if (name !== 'alerts') return { docs: [], size: 0 };
              const docs = Object.entries(alerts).flatMap(([email, rows]) => (
                rows
                  .filter((row) => operator !== '==' || row[field] === value)
                  .map((row, index) => snapshot(`job_alert_subscribers/${email}/alerts/alert-${index}`, row))
              ));
              return { docs, size: docs.length };
            },
          };
        },
      };
    },
    async getAll(...refs: any[]) {
      const paths = refs.map((ref) => ref.path);
      calls.getAll.push(paths);
      if (options.privateReadError && paths.some((value) => value.includes('/private/personalization'))) {
        throw options.privateReadError;
      }
      if (options.profileReadError && paths.some((value) => value.startsWith('users/'))) {
        throw options.profileReadError;
      }
      return refs.map((ref) => {
        const privateMatch = /^newsletter_subscribers\/([^/]+)\/private\/personalization$/.exec(ref.path);
        if (privateMatch) return snapshot(ref.path, privateDocs[privateMatch[1]]);
        const userMatch = /^users\/([^/]+)$/.exec(ref.path);
        if (userMatch) return snapshot(ref.path, users[userMatch[1]]);
        return snapshot(ref.path, undefined);
      });
    },
  };

  return { db, calls };
}

function mapEntries(map: Map<string, Record<string, any>[]>, emails: string[]) {
  return emails.map((email) => {
    const normalized = email.trim().toLowerCase();
    return [normalized, map.get(normalized) || []];
  });
}

afterEach(() => vi.restoreAllMocks());

describe('loadJobAlertsForSubscribers', () => {
  const alerts = {
    'uno@example.com': [{ email: 'UNO@EXAMPLE.COM', active: true, keywords: ['uno'] }],
    'due@example.com': [{ email: 'due@example.com', active: true, keywords: ['due'] }],
    'tre@example.com': [{ email: 'tre@example.com', active: true, keywords: ['tre'] }],
    'altro@example.com': [{ email: 'altro@example.com', active: true, keywords: ['altro'] }],
  };

  it('returns the same requested Map in both modes and applies the threshold', async () => {
    const requested = [' UNO@example.com ', 'due@example.com', 'tre@example.com'];
    const perSubscriber = fakeDb({ alerts });
    const grouped = fakeDb({ alerts });

    const perResult = await loadJobAlertsForSubscribers(perSubscriber.db, requested, {
      perSubscriberMax: 3,
      concurrency: 2,
    });
    const groupResult = await loadJobAlertsForSubscribers(grouped.db, requested, {
      perSubscriberMax: 2,
    });

    expect(mapEntries(perResult.alertsByEmail, requested)).toEqual(mapEntries(groupResult.alertsByEmail, requested));
    expect(perSubscriber.calls.collectionGroup).toBe(0);
    expect(perSubscriber.calls.alertQueries).toHaveLength(3);
    expect(perResult.stats).toMatchObject({ recipients: 3, subscriber_queries: 3, collection_group_queries: 0 });
    expect(grouped.calls.collectionGroup).toBe(1);
    expect(grouped.calls.alertQueries).toHaveLength(0);
    expect(groupResult.stats).toMatchObject({ recipients: 3, subscriber_queries: 0, collection_group_queries: 1 });
    expect(Object.values(perResult.stats).every((value) => Number.isInteger(value))).toBe(true);
  });

  it('keeps only alerts owned by the subscriber in both modes', async () => {
    const requested = ['uno@example.com', 'due@example.com'];
    const fixture = {
      alerts: {
        'uno@example.com': [
          { email: ' UNO@EXAMPLE.COM ', active: true, keywords: ['valido'] },
          { active: true, keywords: ['senza-email'] },
          { email: 'altro@example.com', active: true, keywords: ['altro'] },
        ],
        'due@example.com': [],
      },
    };

    const perSubscriber = await loadJobAlertsForSubscribers(fakeDb(fixture).db, requested, {
      perSubscriberMax: 2,
    });
    const collectionGroup = await loadJobAlertsForSubscribers(fakeDb(fixture).db, requested, {
      perSubscriberMax: 1,
    });

    expect(perSubscriber.alertsByEmail).toEqual(collectionGroup.alertsByEmail);
    expect(perSubscriber.alertsByEmail.get('uno@example.com')).toEqual([
      { email: ' UNO@EXAMPLE.COM ', active: true, keywords: ['valido'] },
    ]);
    expect(perSubscriber.stats.alerts).toBe(1);
    expect(perSubscriber.stats.subscribers_with_alerts).toBe(1);
    expect(collectionGroup.stats.alerts).toBe(1);
    expect(collectionGroup.stats.subscribers_with_alerts).toBe(1);
  });

  it('counts a failed subscriber query once and never logs its address', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => warnings.push(args.join(' ')));
    const result = await loadJobAlertsForSubscribers(fakeDb({
      alerts,
      alertQueryErrors: new Set(['due@example.com']),
    }).db, ['uno@example.com', 'due@example.com', 'tre@example.com']);

    expect(result.alertsByEmail.has('uno@example.com')).toBe(true);
    expect(result.alertsByEmail.has('due@example.com')).toBe(false);
    expect(result.stats.failed_subscriber_queries).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('@');
  });

  it('keeps the collection-group failure behavior and returns an empty Map', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => warnings.push(args.join(' ')));
    const result = await loadJobAlertsForSubscribers(fakeDb({
      alerts,
      collectionGroupError: new Error('indice mancante'),
    }).db, ['uno@example.com', 'due@example.com'], { perSubscriberMax: 1 });

    expect(result.alertsByEmail).toEqual(new Map());
    expect(result.stats).toMatchObject({ collection_group_queries: 1, failed_collection_group_queries: 1 });
    expect(warnings).toHaveLength(1);
  });
});

describe('attachApplicationIntentPersonalization', () => {
  const applicationIntent = { intents: [{ jobKey: 'job-uno' }] };
  const subscribers = [
    { email: 'uno@example.com', userId: 'uid-uno' },
    { email: 'marcatore@example.com', userId: 'uid-marcato' },
    { email: 'senza-uid@example.com' },
    { email: 'optout@example.com', userId: 'uid-optout' },
    { email: 'senza-profilo@example.com', userId: 'uid-missing' },
  ];
  const privateDocs = {
    'uno@example.com': { applicationIntentAuthUid: 'uid-uno', applicationIntent },
    'marcatore@example.com': { applicationIntentAuthUid: 'uid-diverso', applicationIntent },
    'optout@example.com': { applicationIntentAuthUid: 'uid-optout', applicationIntent },
    'senza-profilo@example.com': { applicationIntentAuthUid: 'uid-missing', applicationIntent },
  };
  const users = {
    'uid-uno': { applicationIntent: { optedOut: false } },
    'uid-optout': { applicationIntent: { optedOut: true } },
  };

  it('reads only userId subscribers, ignores a wrong marker, opts out and missing profiles', async () => {
    const { db, calls } = fakeDb({ privateDocs, users });
    const result = await attachApplicationIntentPersonalization(db, subscribers.map((subscriber) => ({ ...subscriber })), { chunkSize: 2 });
    const privatePaths = calls.getAll[0];
    const profilePaths = calls.getAll[2];

    expect(privatePaths).toEqual([
      'newsletter_subscribers/uno@example.com/private/personalization',
      'newsletter_subscribers/marcatore@example.com/private/personalization',
    ]);
    expect(calls.getAll[1]).toEqual(['newsletter_subscribers/optout@example.com/private/personalization', 'newsletter_subscribers/senza-profilo@example.com/private/personalization']);
    expect(profilePaths).toEqual(['users/uid-uno', 'users/uid-optout']);
    expect(result.subscribers.map((subscriber) => subscriber.applicationIntent || null)).toEqual([
      applicationIntent,
      null,
      null,
      null,
      null,
    ]);
    expect(result.stats).toMatchObject({ subscribers: 5, with_user_id: 4, private_reads: 4, private_found: 3, profile_reads: 3, profiles_found: 2, opted_out: 1, failed_batches: 0 });
  });

  it('matches the old collection-group join on the same fixture', async () => {
    const input = subscribers.map((subscriber) => ({ ...subscriber }));
    const { db } = fakeDb({ privateDocs, users });
    const result = await attachApplicationIntentPersonalization(db, input);

    // Equivalent of the removed collection-group scan: marker ownership first,
    // then the current account preference and the fail-closed missing profile.
    const expected = input.map((subscriber) => {
      const privateData = privateDocs[subscriber.email];
      const uid = String(subscriber.userId || '').trim();
      const account = privateData?.applicationIntentAuthUid === uid ? users[uid] : undefined;
      return privateData?.applicationIntent
        && account
        && account.applicationIntent?.optedOut !== true
        ? privateData.applicationIntent
        : null;
    });
    expect(result.subscribers.map((subscriber) => subscriber.applicationIntent || null)).toEqual(expected);
  });

  it('on any read error removes applicationIntent for everyone and warns without addresses', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => warnings.push(args.join(' ')));
    const input = subscribers.map((subscriber) => ({ ...subscriber, applicationIntent }));
    const result = await attachApplicationIntentPersonalization(fakeDb({
      privateDocs,
      users,
      privateReadError: new Error('lettura privata fallita'),
    }).db, input);

    expect(result.subscribers.every((subscriber) => !subscriber.applicationIntent)).toBe(true);
    expect(result.stats.failed_batches).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('@');
  });
});

describe('loadPooledCampaignVariantTotals', () => {
  const firstCells = { mailjet: { concreto: { sends: 10, opens: 4 } } };
  const secondCells = { mailjet: { curioso: { sends: 7, opens: 3 } }, mailgun: { concreto: { sends: 2, opens: 1 } } };

  it('calculates on a miss, writes only with persist, then skips the loader on a hit', async () => {
    const cacheDb = fakeDb();
    const loadTotals = vi.fn(async (_db: unknown, id: string) => ({ cells: id.endsWith('one') ? firstCells : secondCells }));
    const miss = await loadPooledCampaignVariantTotals(cacheDb.db, 'weekly_current', ['weekly_one', 'weekly_two'], { loadCampaignVariantTotals: loadTotals });
    expect(miss.source).toBe('calculation');
    expect(loadTotals).toHaveBeenCalledTimes(2);
    expect(cacheDb.calls.cacheSets).toHaveLength(0);

    const persisted = fakeDb();
    const persistedLoader = vi.fn(loadTotals);
    const persistedMiss = await loadPooledCampaignVariantTotals(persisted.db, 'weekly_current', ['weekly_one', 'weekly_two'], {
      loadCampaignVariantTotals: persistedLoader,
      persist: true,
    });
    expect(persistedMiss.pooledCells).toEqual(miss.pooledCells);
    expect(persisted.calls.cacheSets).toHaveLength(1);
    expect(persisted.calls.cacheSets[0].options).toBeUndefined();
    expect(persisted.calls.cacheSets[0].payload).toMatchObject({
      campaign_id: 'weekly_current',
      lookback_ids: ['weekly_one', 'weekly_two'],
      version: 1,
    });

    const hitLoader = vi.fn();
    const hit = await loadPooledCampaignVariantTotals(persisted.db, 'weekly_current', ['weekly_one', 'weekly_two'], {
      loadCampaignVariantTotals: hitLoader,
    });
    expect(hit.source).toBe('cache');
    expect(hit.pooledCells).toEqual(miss.pooledCells);
    expect(hit.stats.cache_hits).toBe(1);
    expect(hitLoader).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'lookback diverso', cache: { campaign_id: 'weekly_current', lookback_ids: ['weekly_old'], pooled_cells: firstCells, version: 1 } },
    { label: 'version diversa', cache: { campaign_id: 'weekly_current', lookback_ids: ['weekly_one', 'weekly_two'], pooled_cells: firstCells, version: 2 } },
  ])('$label ricalcola', async ({ cache }) => {
    const db = fakeDb({ cacheDocument: cache });
    const loadTotals = vi.fn(async () => ({ cells: secondCells }));
    const result = await loadPooledCampaignVariantTotals(db.db, 'weekly_current', ['weekly_one', 'weekly_two'], { loadCampaignVariantTotals: loadTotals });
    expect(result.source).toBe('calculation');
    expect(loadTotals).toHaveBeenCalledTimes(2);
  });

  it('treats a cache read error as a miss and does not throw on a write error', async () => {
    const loader = vi.fn(async () => ({ cells: firstCells }));
    const readError = await loadPooledCampaignVariantTotals(fakeDb({ cacheReadError: new Error('cache non disponibile') }).db, 'weekly_current', ['weekly_one'], { loadCampaignVariantTotals: loader });
    expect(readError.source).toBe('calculation');
    expect(loader).toHaveBeenCalledTimes(1);

    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => warnings.push(args.join(' ')));
    await expect(loadPooledCampaignVariantTotals(fakeDb({ cacheWriteError: new Error('scrittura negata') }).db, 'weekly_current', ['weekly_one'], {
      loadCampaignVariantTotals: loader,
      persist: true,
    })).resolves.toMatchObject({ source: 'calculation' });
    expect(warnings).toHaveLength(1);
  });
});

describe('guardia dei sorgenti newsletter', () => {
  it('keeps both collection-group input reads out of send-newsletter.mjs', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../scripts/send-newsletter.mjs'), 'utf8');
    expect(source).not.toMatch(/collectionGroup\(\s*['"]private['"]/);
    expect(source).not.toMatch(/collectionGroup\(\s*['"]alerts['"]/);
    expect(source).not.toContain('fetchAllJobAlerts');
  });
});
