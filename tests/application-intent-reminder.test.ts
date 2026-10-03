import { describe, expect, it } from 'vitest';

import {
  APPLICATION_INTENT_REMINDER_MIN_AGE_MS,
  buildApplicationIntentEntry,
  isApplicationIntentReminderEligible,
  rankSimilarApplicationJobs,
} from '../scripts/lib/applicationIntentReminder.mjs';
import {
  buildApplicationIntentReminderEmailHtml,
  buildApplicationIntentReminderEmailText,
  getApplicationIntentReminderStrings,
} from '../scripts/lib/applicationIntentReminderEmail.mjs';
import {
  claimApplicationIntentReminderDeliveries,
  markApplicationIntentReminderUnknown,
} from '../scripts/send-application-intent-reminders.mjs';
import {
  APPLICATION_INTENT_CONSENT_VERSION,
  buildApplicationIntentRecord,
  normalizeApplicationIntentRequest,
} from '../functions/src/applicationIntentCore.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const DAY = 86400000;
const HOUR = 60 * 60 * 1000;

const sourceJob = {
  id: 'source',
  companyKey: 'source-company',
  slug: 'software-engineer-lugano',
  slugByLocale: { it: 'software-engineer-lugano' },
  title: 'Software Engineer',
  titleByLocale: { it: 'Software Engineer' },
  company: 'Source SA',
  canton: 'TI',
  location: 'Lugano',
  postedDate: '2026-08-10',
  category: 'IT',
  sector: 'Technology',
};

function intentData(overrides: Record<string, unknown> = {}) {
  const occurredAt = NOW - 3 * DAY;
  return {
    jobKey: 'source-company:software-engineer-lugano',
    jobSlug: 'software-engineer-lugano',
    companyKey: 'source-company',
    timestamp: new Date(occurredAt),
    createdAt: new Date(occurredAt),
    expiresAt: new Date(occurredAt + 90 * DAY),
    consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
    consentText: 'Ho cliccato su Candidati.',
    identifier: 'uid-1',
    identifierType: 'firebase_uid',
    application_status: 'redirect_only',
    application_mode: 'external',
    reminder: {
      enabled: true,
      dueAt: new Date(occurredAt + APPLICATION_INTENT_REMINDER_MIN_AGE_MS),
      state: 'pending',
    },
    ...overrides,
  };
}

function snapshot(data: Record<string, unknown>) {
  return { id: 'intent-1', data: () => data };
}

describe('application-intent reminder eligibility and recommendations', () => {
  it('requires the new dueAt cutover and keeps the 48-hour quiet period', () => {
    expect(isApplicationIntentReminderEligible(intentData(), NOW)).toBe(true);
    expect(isApplicationIntentReminderEligible(intentData({ reminder: undefined }), NOW)).toBe(false);
    expect(isApplicationIntentReminderEligible(intentData({
      reminder: { enabled: true, dueAt: new Date(NOW - 3 * DAY + 24 * 60 * 60 * 1000), state: 'pending' },
    }), NOW)).toBe(false);
    expect(isApplicationIntentReminderEligible(intentData({
      reminder: { enabled: true, dueAt: new Date(NOW), state: 'sent' },
    }), NOW)).toBe(false);
  });

  // The fixtures above stamp `timestamp` and `reminder.dueAt` from the same
  // instant. The real producer cannot: dueAt comes from the function clock
  // when the record is built, `timestamp` is serverTimestamp() resolved at the
  // commit that follows the transaction's reads. Exact comparison rejected
  // every production record (reminder runs 2026-09-29..10-01: "sent 0").
  describe('records written by the real producer', () => {
    function committedProducerRecord(builtAt: number, commitLatencyMs: number) {
      const normalized = normalizeApplicationIntentRequest({
        jobKey: 'source-company:software-engineer-lugano',
        jobSlug: 'software-engineer-lugano',
        companyKey: 'source-company',
        jobTitle: 'Software Engineer',
        origin: '/cerca-lavoro-ticino/',
        surface: 'job_board_apply',
        consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
        consentText: 'Ho cliccato su Candidati.',
      });
      if (!normalized.ok) throw new Error(normalized.error);
      const record = buildApplicationIntentRecord({
        req: { headers: {} },
        token: { uid: 'uid-1' },
        input: normalized.input,
        now: builtAt,
      });
      if (!record) throw new Error('producer refused the fixture');
      // What Firestore stores: the server-timestamp sentinels resolve to the
      // commit time, the Dates the producer computed are kept as they are.
      const committedAt = new Date(builtAt + commitLatencyMs);
      return { ...record, timestamp: committedAt, createdAt: committedAt, updatedAt: committedAt };
    }

    it.each([1, 150, 15_000])('is due 48 hours after the click when the commit lands %i ms after the build', (latencyMs) => {
      const builtAt = Date.now() - 3 * DAY;
      const data = committedProducerRecord(builtAt, latencyMs);
      const clickAt = builtAt + latencyMs;
      expect(isApplicationIntentReminderEligible(data, clickAt + APPLICATION_INTENT_REMINDER_MIN_AGE_MS - 1)).toBe(false);
      expect(isApplicationIntentReminderEligible(data, clickAt + APPLICATION_INTENT_REMINDER_MIN_AGE_MS)).toBe(true);
      expect(isApplicationIntentReminderEligible(data, clickAt + 3 * DAY)).toBe(true);
    });

    it('still rejects a schedule shorter than 48 hours and never sends inside the quiet period', () => {
      const clickAt = Date.now() - 3 * DAY;
      const at = (dueOffsetMs: number) => intentData({
        timestamp: new Date(clickAt),
        createdAt: new Date(clickAt),
        expiresAt: new Date(clickAt + 90 * DAY),
        reminder: { enabled: true, dueAt: new Date(clickAt + dueOffsetMs), state: 'pending' },
      });
      expect(isApplicationIntentReminderEligible(at(47 * HOUR), clickAt + 3 * DAY)).toBe(false);
      expect(isApplicationIntentReminderEligible(at(48 * HOUR - 2 * 60 * 1000), clickAt + 3 * DAY)).toBe(false);
      // dueAt already passed, but the click is not 48 hours old yet.
      expect(isApplicationIntentReminderEligible(at(48 * HOUR - 30 * 1000), clickAt + 48 * HOUR - 10 * 1000)).toBe(false);
    });
  });

  it('blocks completion and the email-only opt-out without blocking the signal contract', () => {
    expect(isApplicationIntentReminderEligible(intentData({ completion: { state: 'completed' } }), NOW)).toBe(false);
    expect(isApplicationIntentReminderEligible(intentData({ reminder: { enabled: false, dueAt: new Date(NOW - DAY), state: 'pending' } }), NOW)).toBe(false);
  });

  it('resolves a live source and ranks keyword/location matches with company diversity', () => {
    const entry = buildApplicationIntentEntry(
      snapshot(intentData()),
      new Map([['source', sourceJob]]),
      'it',
      (job) => `https://example.test/${job.slug}`,
      NOW,
    );
    expect(entry).toMatchObject({ id: 'source', intentId: 'intent-1', postedDate: '2026-08-10', sourceJob });

    const candidateJobs = [
      { ...sourceJob, id: 'same-company', companyKey: 'source-company', title: 'Senior Software Engineer', titleByLocale: { it: 'Senior Software Engineer' }, slug: 'senior-software-engineer', slugByLocale: { it: 'senior-software-engineer' }, location: 'Lugano' },
      { ...sourceJob, id: 'good', companyKey: 'other-company', company: 'Other SA', title: 'Software Developer', titleByLocale: { it: 'Software Developer' }, slug: 'software-developer', slugByLocale: { it: 'software-developer' }, location: 'Lugano' },
      { ...sourceJob, id: 'far', companyKey: 'far-company', company: 'Far SA', title: 'Software Developer', titleByLocale: { it: 'Software Developer' }, slug: 'software-developer-far', slugByLocale: { it: 'software-developer-far' }, location: 'Zurich', canton: 'ZH' },
      { ...sourceJob, id: 'unrelated', companyKey: 'unrelated-company', company: 'Unrelated SA', title: 'Chef de cuisine', titleByLocale: { it: 'Chef de cuisine' }, slug: 'chef-cuisine', slugByLocale: { it: 'chef-cuisine' }, category: 'Hospitality', sector: 'Hospitality', location: 'Lugano' },
    ];
    expect(rankSimilarApplicationJobs([sourceJob], candidateJobs, {
      max: 3,
      excludedJobIds: new Set(['source']),
    }).map((job) => job.id)).toEqual(['good', 'far']);
  });
});

describe('application-intent reminder email', () => {
  const entry = {
    id: 'source',
    title: 'Software Engineer',
    company: 'Source SA',
    location: 'Lugano',
    url: 'https://example.test/source',
    companyKey: 'abb-svizzera-sede-ticino',
    postedDate: '2026-08-10',
    sector: 'Sanità',
    category: 'healthcare',
    salaryMin: 80000,
    salaryMax: 100000,
    currency: 'CHF',
    baseSalary: { value: { unitText: 'YEAR' } },
    contract: 'full-time',
  };

  it('uses a factual subject that counts clicks instead of completed applications', () => {
    const strings = getApplicationIntentReminderStrings('it');
    expect(strings.subject(1)).toBe('Hai cliccato «Candidati» su un annuncio');
    expect(strings.subject(5)).toBe('Hai cliccato «Candidati» su 5 annunci');
  });

  it('uses application-specific copy and does not claim completion', () => {
    const text = buildApplicationIntentReminderEmailText({
      locale: 'it',
      applicationIntentEntries: [entry],
      recommendations: [],
      manageUrl: 'https://example.test/profile',
      unsubUrl: 'https://example.test/unsubscribe',
    });
    expect(text).toContain('Il click non prova');
    expect(text).toContain('https://example.test/unsubscribe');
    expect(text).not.toContain('Hai completato la candidatura');
  });

  it.each(['it', 'en', 'de', 'fr'])('renders a complete localized shell (%s)', (locale) => {
    const html = buildApplicationIntentReminderEmailHtml({
      locale,
      applicationIntentEntries: [entry],
      recommendations: [
        { ...entry, id: 'recommended', title: 'Another Engineer', url: 'https://example.test/recommended' },
      ],
      manageUrl: 'https://example.test/profile',
      unsubUrl: 'https://example.test/unsubscribe',
      email: 'reader@example.test',
    });
    expect(html).toContain('Frontaliere Ticino');
    expect(html).toContain('https://example.test/unsubscribe');
    expect(html).toContain('Another Engineer');
  });

  it('uses the shared job card fields for the source listing', () => {
    const html = buildApplicationIntentReminderEmailHtml({
      locale: 'it',
      applicationIntentEntries: [entry],
      recommendations: [],
      manageUrl: 'https://example.test/profile',
      unsubUrl: 'https://example.test/unsubscribe',
      email: 'reader@example.test',
    });
    expect(html).toMatch(/<img src="https:\/\/cdn\.frontaliereticino\.ch\/images\/brands\/abb-svizzera-sede-ticino\.png"/);
    expect(html).toContain('CHF 80K–100K/anno');
    expect(html).toContain('Tempo pieno');
    expect(html).toContain('Lugano');
    expect(html).toContain('Pubblicato il');
    expect(html).toContain('Sanità');
    expect(html).toContain('Da verificare');
  });
});

describe('application-intent reminder delivery ledger', () => {
  function fakeDb() {
    const documents = new Map<string, Record<string, unknown>>();
    let transactionTail = Promise.resolve();
    const db = {
      collection(name: string) {
        return {
          doc(id: string) {
            const path = `${name}/${id}`;
            return {
              id,
              path,
              set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
                documents.set(path, options?.merge ? { ...(documents.get(path) || {}), ...data } : data);
              },
            };
          },
        };
      },
      async runTransaction(callback: (transaction: any) => Promise<unknown>) {
        const previous = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await callback({
            get: async (ref: { path: string }) => ({
              exists: documents.has(ref.path),
              data: () => documents.get(ref.path),
            }),
            create: (ref: { path: string }, data: Record<string, unknown>) => {
              if (documents.has(ref.path)) throw new Error('already_exists');
              documents.set(ref.path, data);
            },
            set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
              documents.set(ref.path, options?.merge ? { ...(documents.get(ref.path) || {}), ...data } : data);
            },
            delete: (ref: { path: string }) => documents.delete(ref.path),
          });
        } finally {
          release();
        }
      },
    };
    return { db, documents };
  }

  it('allows only one concurrent sender to claim each intent', async () => {
    const { db, documents } = fakeDb();
    const args = {
      uid: 'uid-1',
      intentIds: ['intent-a', 'intent-b'],
      campaignId: 'application-intent-reminder-2026-09-27',
      now: new Date(NOW),
    };
    const [first, second] = await Promise.all([
      claimApplicationIntentReminderDeliveries(db as never, args),
      claimApplicationIntentReminderDeliveries(db as never, args),
    ]);
    expect(first).toEqual(['intent-a', 'intent-b']);
    expect(second).toEqual([]);
    expect(documents.size).toBe(2);
  });

  it('never reclaims an old sending or unknown outcome automatically', async () => {
    const { db, documents } = fakeDb();
    documents.set('application_intent_reminder_deliveries/old-sending', {
      state: 'sending',
      claimed_at: new Date(NOW - 24 * 60 * 60 * 1000),
    });
    documents.set('application_intent_reminder_deliveries/unknown', {
      state: 'unknown',
    });

    await expect(claimApplicationIntentReminderDeliveries(db as never, {
      uid: 'uid-1',
      intentIds: ['old-sending', 'unknown'],
      campaignId: 'application-intent-reminder-2026-09-27',
      now: new Date(NOW),
    })).resolves.toEqual([]);

    await markApplicationIntentReminderUnknown(db as never, {
      intentIds: ['old-sending'],
      campaignId: 'application-intent-reminder-2026-09-27',
      error: new Error('provider timeout'),
      at: new Date(NOW),
    });
    expect(documents.get('application_intent_reminder_deliveries/old-sending')).toMatchObject({
      state: 'unknown',
      last_error: 'provider timeout',
    });
  });
});
