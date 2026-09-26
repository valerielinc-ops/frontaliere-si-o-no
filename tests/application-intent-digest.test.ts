import { describe, expect, it } from 'vitest';
import {
  APPLICATION_INTENT_COLLECTION,
  APPLICATION_INTENT_RETENTION_DAYS,
  applicationIntentUid,
  buildApplicationIntentEntry,
  buildEmailHtml,
  buildEmailText,
  claimSavedJobsDigestDelivery,
  getStrings,
  hasSavedJobsDigestDelivery,
  isApplicationIntentEligible,
  isSavedJobsDigestEligible,
  mergeDigestEntries,
} from '../scripts/send-saved-jobs-digest.mjs';
import {
  APPLICATION_INTENT_CONSENT_VERSION,
  APPLICATION_INTENTS_COLLECTION,
} from '../functions/src/applicationIntentCore.js';

const DAY = 86400000;
const NOW = Date.now();

const liveJob = {
  id: 'job-live',
  companyKey: 'acme-sa',
  slug: 'job-live-slug',
  slugByLocale: {
    it: 'job-live-slug',
    en: 'live-job-slug',
    de: 'live-stelle-slug',
    fr: 'offre-live-slug',
  },
  title: 'Live job',
  company: 'ACME SA',
  canton: 'TI',
  location: 'Lugano',
  category: 'tech',
  url: 'https://jobs.example.test/live',
};

const jobsById = new Map([[liveJob.id, liveJob]]);

function intentSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    data: () => ({
      jobKey: 'acme-sa:job-live-slug',
      jobSlug: 'job-live-slug',
      companyKey: 'acme-sa',
      jobTitle: 'Software Engineer',
      timestamp: new Date(NOW - 2 * DAY),
      createdAt: new Date(NOW - 2 * DAY),
      consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
      consentText: 'Ho cliccato su Candidati e accetto il promemoria.',
      identifier: 'firebase-user-1',
      identifierType: 'firebase_uid',
      application_status: 'redirect_only',
      origin: 'job_board',
      ...overrides,
    }),
  };
}

function savedEntry(id: string, savedAt = NOW - 4 * DAY) {
  return {
    id,
    title: id,
    company: 'ACME SA',
    canton: 'TI',
    category: 'tech',
    savedAt,
    expired: false,
    url: `https://frontaliereticino.ch/job/${id}/`,
  };
}

describe('saved-jobs digest — application intent source', () => {
  it('uses the producer collection and accepts its versioned proof while rejecting explicit denial', () => {
    expect(APPLICATION_INTENT_COLLECTION).toBe(APPLICATION_INTENTS_COLLECTION);
    const producerRecord = {
      jobKey: 'acme-sa:job-live-slug',
      consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
      consentText: 'Disclosure recorded by the server producer.',
      createdAt: new Date(NOW - DAY),
    };

    expect(isApplicationIntentEligible(producerRecord, NOW)).toBe(true);
    expect(isApplicationIntentEligible({ ...producerRecord, consentGiven: false }, NOW)).toBe(false);
    expect(buildApplicationIntentEntry(
      { id: 'intent-1', data: () => producerRecord },
      jobsById,
      'it',
      NOW,
    )).toMatchObject({ id: 'job-live', applicationIntent: true });
  });

  it('groups only account-backed producer records and scoped user subcollections', () => {
    const rootRecord = {
      id: 'intent-root',
      ref: { parent: { id: APPLICATION_INTENT_COLLECTION, parent: null } },
      data: () => ({ identifier: 'firebase-user-1', identifierType: 'firebase_uid' }),
    };
    const nestedRecord = {
      id: 'intent-nested',
      ref: {
        parent: {
          id: APPLICATION_INTENT_COLLECTION,
          parent: { id: 'firebase-user-2', parent: { id: 'users' } },
        },
      },
      data: () => ({ identifierType: 'firebase_uid', identifier: 'firebase-user-2' }),
    };
    const anonymousRecord = {
      ref: { parent: { id: APPLICATION_INTENT_COLLECTION, parent: null } },
      data: () => ({ identifier: 'opaque-hash', identifierType: 'anonymous_client' }),
    };
    const mismatchedNestedRecord = {
      ...nestedRecord,
      data: () => ({ identifierType: 'firebase_uid', identifier: 'firebase-user-other' }),
    };

    expect(applicationIntentUid(rootRecord)).toBe('firebase-user-1');
    expect(applicationIntentUid(nestedRecord)).toBe('firebase-user-2');
    expect(applicationIntentUid(anonymousRecord)).toBeNull();
    expect(applicationIntentUid(mismatchedNestedRecord)).toBeNull();
  });

  it('accepts only recent, consented, unresolved intents', () => {
    expect(isApplicationIntentEligible(intentSnapshot().data(), NOW)).toBe(true);
    expect(isApplicationIntentEligible(intentSnapshot({ timestamp: new Date(NOW - (APPLICATION_INTENT_RETENTION_DAYS + 1) * DAY) }).data(), NOW)).toBe(false);
    expect(isApplicationIntentEligible(intentSnapshot({ completedAt: new Date(NOW - DAY) }).data(), NOW)).toBe(false);
    expect(isApplicationIntentEligible(intentSnapshot({ consentText: '' }).data(), NOW)).toBe(false);
    expect(isApplicationIntentEligible({
      timestamp: NOW,
      consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
      consentText: 'shown',
      consentGiven: false,
    }, NOW)).toBe(false);
    expect(isApplicationIntentEligible(intentSnapshot({ deletedAt: new Date(NOW - DAY) }).data(), NOW)).toBe(false);
  });

  it('resolves a live job and drops an intent whose job is no longer identifiable', () => {
    expect(buildApplicationIntentEntry(intentSnapshot(), jobsById, 'it', NOW)).toMatchObject({
      id: 'job-live',
      applicationIntent: true,
      expired: false,
      title: 'Live job',
    });
    expect(buildApplicationIntentEntry(
      intentSnapshot({ jobKey: 'acme-sa:gone', jobSlug: 'gone' }),
      jobsById,
      'it',
      NOW,
    )).toBeNull();
  });

  it('unites saved and intent sources into one card and gives intent priority under the cap', () => {
    const intent = buildApplicationIntentEntry(intentSnapshot(), jobsById, 'it', NOW);
    if (!intent) throw new Error('expected the fixture intent to resolve to a live job');
    const merged = mergeDigestEntries(
      [savedEntry('job-live'), ...Array.from({ length: 25 }, (_, index) => savedEntry(`saved-${index}`, NOW - index * DAY))],
      [intent, { ...intent, intentAt: NOW - DAY }],
    );

    expect(merged.applicationIntentEntries).toHaveLength(1);
    expect(merged.applicationIntentEntries[0].id).toBe('job-live');
    expect(merged.savedEntries.some((entry) => entry.id === 'job-live')).toBe(false);
    expect(merged.savedEntries.length + merged.applicationIntentEntries.length).toBe(20);
  });

  it('lets a consented application intent activate this existing digest, but opt-out still wins', () => {
    const subscriber = { status: 'confirmed' };
    expect(isSavedJobsDigestEligible(
      { savedJobsDigest: { optedIn: false, optedOut: false } },
      subscriber,
      { hasApplicationIntent: true },
    )).toBe(true);
    expect(isSavedJobsDigestEligible(
      { savedJobsDigest: { optedIn: false, optedOut: true } },
      subscriber,
      { hasApplicationIntent: true },
    )).toBe(false);
  });
});

describe('saved-jobs digest — localized application reminder copy', () => {
  it.each([
    ['it', 'Hai già completato queste candidature?'],
    ['en', 'Have you completed these applications?'],
    ['de', 'Haben Sie diese Bewerbungen schon abgeschlossen?'],
    ['fr', 'Avez-vous terminé ces candidatures ?'],
  ])('%s asks about completion without claiming it', (locale, expectedQuestion) => {
    const strings = getStrings(locale);
    const text = buildEmailText({
      locale,
      s: strings,
      savedEntries: [],
      applicationIntentEntries: [{
        id: 'job-live',
        title: 'Live job',
        company: 'ACME SA',
        url: 'https://frontaliereticino.ch/job-live/',
      }],
      recommendations: [],
      manageUrl: 'https://frontaliereticino.ch/profilo/',
      unsubUrl: 'https://frontaliereticino.ch/disiscrivi-promemoria-salvati/',
    });
    expect(text).toContain(expectedQuestion);
    expect(text).toContain(strings.applicationIntentNotice);
  });

  it('keeps the completion question visible when saved jobs and intents share one digest', () => {
    const strings = getStrings('it');
    const html = buildEmailHtml({
      locale: 'it',
      s: strings,
      savedEntries: [savedEntry('saved-1')],
      applicationIntentEntries: [{
        id: 'job-live',
        title: 'Live job',
        company: 'ACME SA',
        url: 'https://frontaliereticino.ch/job-live/',
      }],
      recommendations: [],
      manageUrl: 'https://frontaliereticino.ch/profilo/',
      unsubUrl: 'https://frontaliereticino.ch/disiscrivi-promemoria-salvati/',
      email: 'person@example.test',
    });
    expect(html).toContain(strings.applicationSectionTitle);
    expect(html).toContain(strings.applicationIntentNotice);
  });
});

describe('saved-jobs digest — campaign ledger idempotency', () => {
  function fakeDb(exists: boolean, data: Record<string, unknown> = {}) {
    const snapshot = { exists, data: () => data };
    const deliveryRef = { get: async () => snapshot };
    const deliveries = { doc: () => deliveryRef };
    const user = { collection: () => deliveries };
    return { collection: () => ({ doc: () => user }) };
  }

  it('recognizes an accepted delivery for the same uid/campaign', async () => {
    expect(await hasSavedJobsDigestDelivery(
      fakeDb(true, { campaign_id: 'saved-jobs-digest-2026-09-26', sent_at: new Date(NOW) }),
      { uid: 'uid-1', email: 'person@example.test', campaignId: 'saved-jobs-digest-2026-09-26' },
    )).toBe(true);
    expect(await hasSavedJobsDigestDelivery(
      fakeDb(false),
      { uid: 'uid-1', email: 'person@example.test', campaignId: 'saved-jobs-digest-2026-09-26' },
    )).toBe(false);
  });

  it('allows only one concurrent claim for the same uid, email, and campaign', async () => {
    const docs = new Map<string, Record<string, unknown>>();
    let transactionTail = Promise.resolve();
    const deliveryId = 'saved-jobs-digest-today__person@example.test';
    const deliveryRef = { id: deliveryId, path: `users/uid-1/campaign_deliveries/${deliveryId}` };
    const deliveries = { doc: () => deliveryRef };
    const user = { collection: () => deliveries };
    const db = {
      collection: () => ({ doc: () => user }),
      async runTransaction(callback: (transaction: any) => Promise<unknown>) {
        const previous = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await callback({
            get: async (ref: { path: string }) => ({
              exists: docs.has(ref.path),
              data: () => docs.get(ref.path),
            }),
            create: (ref: { path: string }, data: Record<string, unknown>) => {
              if (docs.has(ref.path)) throw new Error('document already exists');
              docs.set(ref.path, data);
            },
            delete: (ref: { path: string }) => docs.delete(ref.path),
          });
        } finally {
          release();
        }
      },
    };
    const input = {
      uid: 'uid-1',
      email: 'person@example.test',
      campaignId: 'saved-jobs-digest-today',
    };

    const claims = await Promise.all([
      claimSavedJobsDigestDelivery(db, input),
      claimSavedJobsDigestDelivery(db, input),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => !claim)).toHaveLength(1);
    expect([...docs.values()]).toMatchObject([{ status: 'sending', campaign_id: input.campaignId }]);
  });
});
