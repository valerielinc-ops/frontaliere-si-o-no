import { describe, expect, it } from 'vitest';
import {
  APPLICATION_INTENT_RETENTION_DAYS,
  buildApplicationIntentEntry,
  buildEmailText,
  getStrings,
  hasSavedJobsDigestDelivery,
  isApplicationIntentEligible,
  isSavedJobsDigestEligible,
  mergeDigestEntries,
} from '../scripts/send-saved-jobs-digest.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-09-26T12:00:00.000Z');

const liveJob = {
  id: 'job-live',
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
      jobId: 'job-live',
      timestamp: new Date(NOW - 2 * DAY),
      consentVersion: 'application-intent-v1',
      consentText: 'Ho cliccato su Candidati e accetto il promemoria.',
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
  it('accepts only recent, consented, unresolved intents', () => {
    expect(isApplicationIntentEligible(intentSnapshot().data(), NOW)).toBe(true);
    expect(isApplicationIntentEligible(intentSnapshot({ timestamp: new Date(NOW - (APPLICATION_INTENT_RETENTION_DAYS + 1) * DAY) }).data(), NOW)).toBe(false);
    expect(isApplicationIntentEligible(intentSnapshot({ completedAt: new Date(NOW - DAY) }).data(), NOW)).toBe(false);
    expect(isApplicationIntentEligible(intentSnapshot({ consentText: '' }).data(), NOW)).toBe(false);
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
      intentSnapshot({ jobId: 'job-gone' }),
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
});
