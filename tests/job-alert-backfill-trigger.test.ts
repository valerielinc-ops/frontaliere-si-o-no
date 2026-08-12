import { describe, expect, it } from 'vitest';
import { handleNewsletterSubscriberCreated } from '../functions/src/jobAlertBackfillTrigger.js';
import { getSignalTier, signalTierChanged, resolveSignalTier, MAX_ALERTS_PER_USER } from '../functions/src/jobAlertBackfillCore.js';

// The affirmative, job-alert-scoped consent `shouldSkipSubscriber` requires
// since #5705. Spread by the tests that exercise the mechanics BEYOND the gate
// (cap, idempotence, patch merge); every test that omits it is asserting the
// gate itself.
import { JOB_ALERT_CONSENT } from './helpers/jobAlertConsent';

interface AlertDoc {
  id: string;
  active?: boolean;
}

function fakeDb({
  existingAlerts = [] as AlertDoc[],
  parentExists = false,
}: { existingAlerts?: AlertDoc[]; parentExists?: boolean } = {}) {
  const writes: Array<{ path: string; payload: Record<string, unknown>; merge: boolean }> = [];

  return {
    writes,
    collection: () => ({
      doc: (email: string) => ({
        collection: () => ({
          get: async () => ({
            docs: existingAlerts.map((a) => ({ id: a.id, data: () => a })),
          }),
          doc: (alertId: string) => ({
            set: async (payload: Record<string, unknown>, opts: { merge: boolean }) => {
              writes.push({ path: `job_alert_subscribers/${email}/alerts/${alertId}`, payload, merge: opts.merge });
            },
          }),
        }),
        get: async () => ({ exists: parentExists }),
        set: async (payload: Record<string, unknown>, opts: { merge: boolean }) => {
          writes.push({ path: `job_alert_subscribers/${email}`, payload, merge: opts.merge });
        },
      }),
    }),
  };
}

describe('signalTierChanged — race-condition guard (onDocumentWritten)', () => {
  it('is true on doc creation when the doc already carries job signal', () => {
    expect(signalTierChanged(null, { job_category: 'tech' })).toBe(true);
  });

  it('is false on doc creation when the doc carries no signal at all', () => {
    expect(signalTierChanged(null, {})).toBe(false);
  });

  it('is true when a later merge adds the signal that a bare auth write omitted (the reviewer-flagged race)', () => {
    // saveUserProfileToFirestore creates the doc with only auth fields...
    const bareAuthWrite = { auth_uid: 'uid-1', name: 'Foo' };
    // ...then upsertNewsletterSubscriber merges in the real signal moments later.
    const fullUpsertMerge = { auth_uid: 'uid-1', name: 'Foo', job_category: 'tech' };
    expect(signalTierChanged(bareAuthWrite, fullUpsertMerge)).toBe(true);
  });

  it('is false for an unrelated field update once the tier is already settled (engagement tracking)', () => {
    const before = { job_category: 'tech', opens: 3 };
    const after = { job_category: 'tech', opens: 4 };
    expect(signalTierChanged(before, after)).toBe(false);
  });

  it('is true when tier upgrades from location-fallback to signal', () => {
    const before = { location_interest: 'Lugano' };
    const after = { location_interest: 'Lugano', job_category: 'tech' };
    expect(signalTierChanged(before, after)).toBe(true);
  });
});

describe('getSignalTier', () => {
  it('returns none/location-fallback/signal in priority order', () => {
    expect(getSignalTier({})).toBe('none');
    expect(getSignalTier({ geo_city: 'Lugano' })).toBe('location-fallback');
    expect(getSignalTier({ job_category: 'tech', geo_city: 'Lugano' })).toBe('signal');
  });

  it('treats sector_interest alone as tier 1 signal, not location-fallback', () => {
    // A subscriber who picks a sector from a standalone selector (no job page,
    // no job_category) carries the same explicit intent as job_category and
    // must not fall through to no-signal.
    expect(getSignalTier({ sector_interest: 'health' })).toBe('signal');
  });
});

describe('handleNewsletterSubscriberCreated — meta sentinel', () => {
  it('is a no-op for the _meta_ doc', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated('_meta_', {}, { db: db as any });
    expect(result).toEqual({ created: false, reason: 'meta_sentinel' });
    expect(db.writes).toHaveLength(0);
  });
});

describe('handleNewsletterSubscriberCreated — skip reasons', () => {
  it('skips a subscriber with no job or location signal', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated('a@b.ch', {}, { db: db as any });
    expect(result).toEqual({ created: false, reason: 'no-signal' });
    expect(db.writes).toHaveLength(0);
  });

  it('skips a suppressed/unsubscribed subscriber even with job signal', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { job_category: 'tech', status: 'unsubscribed' },
      { db: db as any },
    );
    expect(result).toEqual({ created: false, reason: 'suppressed' });
  });
});

describe('handleNewsletterSubscriberCreated — cap enforcement', () => {
  it('skips when the subscriber already has MAX_ALERTS_PER_USER active alerts', async () => {
    // Derived from the constant, not a hand-written list of 3 (#5012): the cap
    // moved to 10 and a fixed-size fixture silently stops testing the cap the
    // moment it no longer reaches it — it would assert 'capped' on a subscriber
    // that is under the limit, or (as here) fail for the wrong reason.
    const db = fakeDb({
      existingAlerts: Array.from({ length: MAX_ALERTS_PER_USER }, (_, i) => ({
        id: `alert-${i + 1}`,
        active: true,
      })),
    });
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { job_category: 'tech', ...JOB_ALERT_CONSENT },
      { db: db as any },
    );
    expect(result).toEqual({ created: false, reason: 'capped' });
    expect(db.writes).toHaveLength(0);
  });

  it('does not count inactive alerts toward the cap', async () => {
    const db = fakeDb({
      existingAlerts: [
        { id: 'alert-1', active: false },
        { id: 'alert-2', active: false },
        { id: 'alert-3', active: false },
      ],
    });
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { job_category: 'tech', ...JOB_ALERT_CONSENT },
      { db: db as any },
    );
    expect(result.created).toBe(true);
  });
});

describe('handleNewsletterSubscriberCreated — creation', () => {
  it('creates an alert for a job-signal subscriber who affirmatively consented to job alerts', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { job_category: 'tech', source_channel: 'job_gate', ...JOB_ALERT_CONSENT },
      { db: db as any },
    );
    expect(result.created).toBe(true);
    expect(result.tier).toBe('newsletter_subscribers:job_gate');
    const alertWrite = db.writes.find((w) => w.path.includes('/alerts/backfill-newsletter'));
    expect(alertWrite).toBeDefined();
    expect(alertWrite?.payload.active).toBe(true);
    expect(alertWrite?.payload.keywords).toEqual([]);
  });

  it('creates a location-fallback alert when there is no job signal but a location one', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { location_interest: 'Lugano', source_channel: 'popup', ...JOB_ALERT_CONSENT },
      { db: db as any },
    );
    expect(result.created).toBe(true);
    expect(result.tier).toBe('newsletter_subscribers:popup:location-fallback');
  });

  it('never reactivates an alert the user already disabled', async () => {
    const db = fakeDb({ existingAlerts: [{ id: 'backfill-newsletter', active: false }] });
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { job_category: 'tech', ...JOB_ALERT_CONSENT },
      { db: db as any },
    );
    expect(result.created).toBe(true);
    const alertWrite = db.writes.find((w) => w.path.includes('/alerts/backfill-newsletter'));
    expect(alertWrite?.payload.active).toBe(false);
  });

  it('does not overwrite created_at on an already-existing parent doc', async () => {
    const db = fakeDb({ parentExists: true });
    await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { job_category: 'tech', ...JOB_ALERT_CONSENT },
      { db: db as any },
    );
    const parentWrite = db.writes.find((w) => w.path === 'job_alert_subscribers/a@b.ch');
    expect(parentWrite?.payload).not.toHaveProperty('created_at');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5705 — the invariant this file exists to protect from here on.
//
// The tests above USED to be the whole story: every one of them passed a
// subscriber with an inferred signal and asserted an alert was created. That is
// the defect, encoded as an expectation — 7.167 alerts against 578 a person
// asked for. They now carry an explicit consent fixture, and the block below
// pins what happens without it, tier by tier, for both trigger entry points.
// ─────────────────────────────────────────────────────────────────────────────
describe('handleNewsletterSubscriberCreated — no alert without affirmative job-alert consent (#5705)', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown> | null]> = [
    ['tier 1 — a job_category filled into a signup form', { job_category: 'tech', source_channel: 'job_gate' }, null],
    ['tier 2 — an IP-geolocated city', { geo_city: 'Lugano', source_channel: 'popup' }, null],
    [
      'tier 3 — browsing behaviour in private/personalization',
      { source_channel: 'popup' },
      { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] },
    ],
    [
      'tier 4 — a canton read out of the signup page URL',
      { source_channel: 'popup', consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/' },
      null,
    ],
  ];

  for (const [label, data, personalization] of cases) {
    it(`writes nothing for ${label}`, async () => {
      const db = fakeDb();
      const result = await handleNewsletterSubscriberCreated('a@b.ch', data, {
        db: db as any,
        personalization: personalization as any,
      });
      expect(result).toEqual({ created: false, reason: 'no-job-alert-consent' });
      expect(db.writes).toHaveLength(0);
    });
  }

  it('writes nothing for the newsletter consent the 6.308 were enrolled under — it never names job ads', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      {
        job_category: 'tech',
        consent_given: true,
        consent_text_displayed: true,
        consent_act: 'typed_email_submit',
        consent_text:
          'Accetto di ricevere la newsletter settimanale con aggiornamenti su cambio CHF/EUR, traffico di frontiera e novità fiscali per frontalieri. Posso disiscrivermi in qualsiasi momento.',
      },
      { db: db as any },
    );
    expect(result).toEqual({ created: false, reason: 'no-job-alert-consent' });
    expect(db.writes).toHaveLength(0);
  });

  it('writes nothing when the notice names job alerts but the act was a sign-in, not a request', async () => {
    // `jobUnlockSocial` in services/consentTexts.ts: the text does name the
    // avvisi di lavoro, and says in so many words that no consent box was
    // offered. An authentication is not an opt-in.
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      {
        job_category: 'tech',
        consent_given: true,
        consent_text_displayed: true,
        consent_act: 'authentication',
        consent_text: 'Accedendo con Google, l’indirizzo email viene iscritto alla newsletter e agli avvisi di lavoro.',
      },
      { db: db as any },
    );
    expect(result).toEqual({ created: false, reason: 'no-job-alert-consent' });
    expect(db.writes).toHaveLength(0);
  });
});

describe('resolveSignalTier — tier-3 personalization fallback', () => {
  it('falls through to none when flat fields and personalization are both empty', () => {
    expect(resolveSignalTier({}, null)).toEqual({ tier: 'none', patch: null });
  });

  it('does not consult personalization when a flat-field tier already resolves', () => {
    const result = resolveSignalTier(
      { job_category: 'tech' },
      { viewedJobs: [{ location: 'Lugano', category: 'Finanza' }] },
    );
    expect(result.tier).toBe('signal');
    expect(result.patch).toBeNull();
  });

  it('derives personalization-fallback from viewed-job browsing data', () => {
    const result = resolveSignalTier(
      {},
      { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia', company: 'Tether' }] },
    );
    expect(result.tier).toBe('personalization-fallback');
    expect(result.patch).toMatchObject({ location_interest: 'Mendrisio', job_category: 'IT / Tecnologia' });
  });

  it('stays none when personalization has nothing usable (empty viewedJobs/filterUsage)', () => {
    expect(resolveSignalTier({}, { viewedJobs: [], filterUsage: {} })).toEqual({ tier: 'none', patch: null });
  });

  it('derives personalization-fallback from a company-only signal, not just job_category/location_interest/geo_city/job_search_query (#3378)', () => {
    // Regression: a subscriber who only has a viewed-job COMPANY (no
    // location/category derivable, no search history) produces a patch whose
    // ONLY field is `job_company` — a real, non-blank field `derivePersonalizationPatch`
    // guarantees is present (its own `Object.keys(patch).length > 0` contract).
    // A prior version of this gate named only 4 of the 6 `PERSONALIZATION_FIELDS`
    // (missing `job_company`/`sector_interest`), so this exact patch was silently
    // discarded and the subscriber wrongly fell through toward 'none'/tier-4
    // instead of using the real derived signal.
    const result = resolveSignalTier({}, { viewedJobs: [{ company: 'Acme SA' }] });
    expect(result.tier).toBe('personalization-fallback');
    expect(result.patch).toEqual({ job_company: 'Acme SA' });
  });
});

describe('handleNewsletterSubscriberCreated — tier-3 personalization fallback', () => {
  it('skips when flat fields are empty and no personalization dep is passed (no drift for the flat-field trigger)', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { source_channel: 'popup' },
      { db: db as any },
    );
    expect(result.created).toBe(false);
    expect(result.reason).toBe('no-signal');
  });

  it('creates a personalization-fallback alert and merges the derived patch onto the parent doc', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { source_channel: 'popup', ...JOB_ALERT_CONSENT },
      {
        db: db as any,
        personalization: { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia', company: 'Tether' }] },
      },
    );
    expect(result.created).toBe(true);
    expect(result.tier).toBe('newsletter_subscribers:popup:personalization-fallback');
    const parentWrite = db.writes.find((w) => w.path === 'job_alert_subscribers/a@b.ch');
    expect(parentWrite?.payload).toMatchObject({ location_interest: 'Mendrisio', job_category: 'IT / Tecnologia' });
  });

  it('does not derive personalization-fallback when browsing data has nothing usable', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { source_channel: 'popup' },
      { db: db as any, personalization: { viewedJobs: [], filterUsage: {} } },
    );
    expect(result.created).toBe(false);
    expect(result.reason).toBe('no-signal');
  });

  it('derives personalization-fallback from a bare search query with no viewed jobs', () => {
    const result = resolveSignalTier({}, { searches: [{ query: 'infermiera', ts: 1 }] });
    expect(result.tier).toBe('personalization-fallback');
    expect(result.patch).toEqual({ job_search_query: 'infermiera' });
  });
});

describe('resolveSignalTier — tier-4 URL fallback', () => {
  it('derives a canton from an Italian job-board consent URL', () => {
    const result = resolveSignalTier({ consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/' }, null);
    expect(result).toEqual({ tier: 'url-fallback', patch: { location_interest: 'ti' } });
  });

  it('derives a canton from a French locale-prefixed source_page path', () => {
    const result = resolveSignalTier({ source_page: '/fr/trouver-emploi-valais/some-job/' }, null);
    expect(result).toEqual({ tier: 'url-fallback', patch: { location_interest: 'vs' } });
  });

  it('falls back to source_page when consent_source_url resolves nothing', () => {
    const result = resolveSignalTier(
      { consent_source_url: 'https://frontaliereticino.ch/', source_page: '/cerca-lavoro-ticino/some-job/' },
      null,
    );
    expect(result).toEqual({ tier: 'url-fallback', patch: { location_interest: 'ti' } });
  });

  it('prefers tier-3 personalization over tier-4 URL when both are available', () => {
    const result = resolveSignalTier(
      { consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/' },
      { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] },
    );
    expect(result.tier).toBe('personalization-fallback');
  });

  it('stays none for the Switzerland-wide aggregator URL', () => {
    const result = resolveSignalTier({ consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-svizzera/' }, null);
    expect(result).toEqual({ tier: 'none', patch: null });
  });

  it('stays none for an ambiguous half-canton group URL', () => {
    const result = resolveSignalTier({ consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-basilea/' }, null);
    expect(result).toEqual({ tier: 'none', patch: null });
  });

  it('stays none when the URL is not a job-board page', () => {
    const result = resolveSignalTier({ consent_source_url: 'https://frontaliereticino.ch/blog/some-article/' }, null);
    expect(result).toEqual({ tier: 'none', patch: null });
  });
});

describe('signalTierChanged — tier-4 URL awareness', () => {
  it('is true on doc creation when the doc only carries a job-board consent URL', () => {
    const after = { consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/' };
    expect(signalTierChanged(null, after)).toBe(true);
  });

  it('is false when a non-job-board URL is added (no eligibility flip)', () => {
    const before = {};
    const after = { consent_source_url: 'https://frontaliereticino.ch/blog/some-article/' };
    expect(signalTierChanged(before, after)).toBe(false);
  });

  it('is false for an unrelated field update once the URL tier is already settled', () => {
    const before = { consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/', opens: 3 };
    const after = { consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/', opens: 4 };
    expect(signalTierChanged(before, after)).toBe(false);
  });

  it('is true when tier upgrades from url-fallback to signal', () => {
    const before = { consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/' };
    const after = { ...before, job_category: 'tech' };
    expect(signalTierChanged(before, after)).toBe(true);
  });
});

describe('handleNewsletterSubscriberCreated — tier-4 URL fallback', () => {
  it('creates a url-fallback alert from a job-board consent URL with no other signal', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      {
        source_channel: 'popup',
        consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/',
        ...JOB_ALERT_CONSENT,
      },
      { db: db as any },
    );
    expect(result.created).toBe(true);
    expect(result.tier).toBe('newsletter_subscribers:popup:url-fallback');
    const parentWrite = db.writes.find((w) => w.path === 'job_alert_subscribers/a@b.ch');
    expect(parentWrite?.payload).toMatchObject({ location_interest: 'ti' });
  });

  it('does not derive url-fallback from a non-job-board URL', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { source_channel: 'popup', consent_source_url: 'https://frontaliereticino.ch/blog/some-article/' },
      { db: db as any },
    );
    expect(result.created).toBe(false);
    expect(result.reason).toBe('no-signal');
  });
});
