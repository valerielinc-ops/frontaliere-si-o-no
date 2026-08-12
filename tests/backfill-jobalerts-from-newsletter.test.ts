import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALERT_ID,
  buildAlertPayload,
  consentNamesJobAlerts,
  getSignalTier,
  hasAffirmativeJobAlertConsent,
  MAX_ALERTS_PER_USER,
  normalizeEmail,
  resolveSignalTier,
  shouldSkipSubscriber,
} from '../scripts/backfill-jobalerts-from-newsletter.mjs';
import { MAX_ALERTS_PER_USER as CLIENT_MAX_ALERTS_PER_USER } from '../services/jobAlertService';
import { CONSENT_TEXTS } from '@/services/consentTexts';
import { JOB_ALERT_CONSENT, withJobAlertConsent as withConsent } from './helpers/jobAlertConsent';

const readRepoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf-8');

describe('backfill-jobalerts-from-newsletter — getSignalTier stays URL-blind', () => {
  // main()'s lazy `private/personalization` fetch is gated on
  // `getSignalTier(data) === 'none'`, NOT on `shouldSkipSubscriber`/
  // `resolveSignalTier` — those also resolve the URL-derived tier 4 from
  // the same flat data, and tier 4 finding a canton must never skip the
  // read: a subscriber landing on a job-board page may ALSO have richer
  // tier-3 browsing data (job_category/sector, not just canton), which
  // resolveSignalTier is supposed to prefer over tier 4 — but only gets
  // the chance to if the caller actually fetches personalization first.
  it('is "none" for a subscriber whose only signal is a job-board consent URL', () => {
    expect(getSignalTier({ consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/' })).toBe(
      'none',
    );
  });
});

describe('backfill-jobalerts-from-newsletter — shouldSkipSubscriber', () => {
  it('is eligible when job_category is present AND job alerts were consented to', () => {
    expect(shouldSkipSubscriber('a@b.ch', withConsent({ job_category: 'tech' }))).toBeNull();
  });

  it('is eligible when only job_location is present', () => {
    expect(shouldSkipSubscriber('a@b.ch', withConsent({ job_location: 'Lugano' }))).toBeNull();
  });

  it('is eligible via tier 1 (not location-fallback) when only sector_interest is present, no job context', () => {
    expect(getSignalTier({ sector_interest: 'health' })).toBe('signal');
    expect(shouldSkipSubscriber('a@b.ch', withConsent({ sector_interest: 'health' }))).toBeNull();
  });

  it('skips an invalid/missing email', () => {
    expect(shouldSkipSubscriber('', withConsent({ job_category: 'tech' }))).toBe('invalid-email');
    expect(shouldSkipSubscriber('not-an-email', withConsent({ job_category: 'tech' }))).toBe('invalid-email');
  });

  it('skips a bounced/complained/suppressed/unsubscribed subscriber', () => {
    expect(shouldSkipSubscriber('a@b.ch', withConsent({ job_category: 'tech', status: 'bounced' }))).toBe('suppressed');
    expect(shouldSkipSubscriber('a@b.ch', withConsent({ job_category: 'tech', status: 'unsubscribed' }))).toBe(
      'suppressed',
    );
  });

  it('skips a subscriber with neither job_category nor job_location', () => {
    expect(shouldSkipSubscriber('a@b.ch', withConsent({ job_slug: 'some-job-abc123' }))).toBe('no-signal');
    expect(shouldSkipSubscriber('a@b.ch', withConsent({}))).toBe('no-signal');
  });

  it('is eligible via the location-fallback tier when only location_interest is present', () => {
    expect(shouldSkipSubscriber('a@b.ch', withConsent({ location_interest: 'Lugano' }))).toBeNull();
  });

  it('is eligible via the location-fallback tier when only geo_city is present', () => {
    expect(shouldSkipSubscriber('a@b.ch', withConsent({ geo_city: 'Bellinzona' }))).toBeNull();
  });

  it('stays no-signal when no personalization arg is passed, even with a viewedJobs-worthy history (flat-field callers unaffected)', () => {
    expect(shouldSkipSubscriber('a@b.ch', withConsent({}))).toBe('no-signal');
  });

  it('is eligible via the personalization-fallback tier when browsing data has real signal', () => {
    expect(
      shouldSkipSubscriber(
        'a@b.ch',
        withConsent({}),
        { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] },
      ),
    ).toBeNull();
  });

  it('stays no-signal when personalization has nothing usable either', () => {
    expect(shouldSkipSubscriber('a@b.ch', withConsent({}), { viewedJobs: [], filterUsage: {} })).toBe('no-signal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5705 — the consent gate. Every assertion in the block above used to be
// written WITHOUT `withConsent`, and every "is eligible" one passed: a signal
// tier alone opened the alert channel. That is the defect the issue measures
// (7.167 inferred alerts, 578 real ones, 71 created on the day it was filed),
// codified as an expectation. The tier assertions are kept — the tiers still
// classify — and what changed is that they no longer authorise a write.
// ─────────────────────────────────────────────────────────────────────────────
describe('backfill-jobalerts-from-newsletter — consent gate (#5705)', () => {
  it('refuses every signal tier when no job-alert consent is on record', () => {
    const tiers: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined]> = [
      ['tier 1 job_category', { job_category: 'tech' }, undefined],
      ['tier 1 sector_interest', { sector_interest: 'health' }, undefined],
      ['tier 2 geo_city', { geo_city: 'Bellinzona' }, undefined],
      ['tier 3 browsing', {}, { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] }],
      [
        'tier 4 signup URL',
        { consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/' },
        undefined,
      ],
    ];
    for (const [label, data, personalization] of tiers) {
      expect(shouldSkipSubscriber('a@b.ch', data, personalization), label).toBe('no-job-alert-consent');
    }
  });

  it('is fail-closed on a missing, empty or malformed consent record', () => {
    for (const data of [
      null,
      undefined,
      {},
      { consent_given: 'true' },
      { consent_given: true },
      { ...JOB_ALERT_CONSENT, consent_given: false },
      { ...JOB_ALERT_CONSENT, consent_text: '' },
      { ...JOB_ALERT_CONSENT, consent_text: null },
      { ...JOB_ALERT_CONSENT, consent_text: 42 },
      { ...JOB_ALERT_CONSENT, consent_text_displayed: null },
      { ...JOB_ALERT_CONSENT, consent_act: '' },
    ]) {
      expect(hasAffirmativeJobAlertConsent(data as never), JSON.stringify(data)).toBe(false);
    }
  });

  it('rejects the four things that are inferences of interest, not requests', () => {
    // Stated as the reason the guard exists: a form field, a geolocated city,
    // browsing behaviour and a page URL are things a person did on a site, not
    // an act by which they asked for a daily email.
    expect(hasAffirmativeJobAlertConsent({ job_category: 'tech' })).toBe(false);
    expect(hasAffirmativeJobAlertConsent({ geo_city: 'Lugano' })).toBe(false);
    expect(hasAffirmativeJobAlertConsent({ location_interest: 'ti' })).toBe(false);
    expect(
      hasAffirmativeJobAlertConsent({
        consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/',
      }),
    ).toBe(false);
  });

  it('accepts only an act the person performed, never an authentication or a link fetch', () => {
    expect(hasAffirmativeJobAlertConsent({ ...JOB_ALERT_CONSENT, consent_act: 'authentication' })).toBe(false);
    // A click is evidence of a fetch: anti-phishing scanners opened 25 links in
    // 7 seconds on one send of this very domain (services/consentTexts.ts).
    expect(hasAffirmativeJobAlertConsent({ ...JOB_ALERT_CONSENT, consent_act: 'email_link_click' })).toBe(false);
    expect(hasAffirmativeJobAlertConsent(JOB_ALERT_CONSENT)).toBe(true);
  });

  it('refuses a notice that was recorded but never shown', () => {
    expect(hasAffirmativeJobAlertConsent({ ...JOB_ALERT_CONSENT, consent_text_displayed: false })).toBe(false);
  });
});

describe('consentNamesJobAlerts — scope of the notice, in the four locales', () => {
  it('recognises the job-alert channel however it is written', () => {
    for (const text of [
      'chiedo di ricevere gli avvisi di lavoro',
      'Avviso di lavoro quotidiano',
      'I want to receive Job Alerts',
      'Job-Alerts per E-Mail',
      'Stellenbenachrichtigungen per E-Mail',
      'Job-Benachrichtigungen',
      'je demande à recevoir les alertes emploi',
      'alertes d’emploi quotidiennes',
    ]) {
      expect(consentNamesJobAlerts(text), text).toBe(true);
    }
  });

  it('does NOT accept a notice that merely mentions job ads as content', () => {
    // "annunci/offerte di lavoro" name what a page shows, not a mailing. The
    // gate formulas that unlock a listing say exactly that, and unlocking a
    // listing is not asking to be mailed daily.
    for (const text of [
      'Inserendo la mia email per sbloccare gli annunci di lavoro',
      'per vedere le offerte di lavoro in Ticino',
      'to unlock the job ads',
      'pour débloquer les offres d’emploi',
      'Accetto di ricevere la newsletter settimanale con aggiornamenti su cambio CHF/EUR, traffico di frontiera e novità fiscali per frontalieri.',
    ]) {
      expect(consentNamesJobAlerts(text), text).toBe(false);
    }
  });

  it('is fail-closed on anything that is not a non-empty string', () => {
    for (const raw of [null, undefined, '', '   ', 42, {}, []]) {
      expect(consentNamesJobAlerts(raw as never), String(raw)).toBe(false);
    }
  });
});

// The register lives in `services/consentTexts.ts`, which `functions/` cannot
// import (no bundler, TypeScript). The two therefore agree by convention only —
// exactly the kind of contract that has no import shape and so is invisible to
// every guard that follows imports. This checks it directly.
describe('the consent register and the gate agree (#5705)', () => {
  it('no formula in use today lets an inferred alert through', () => {
    for (const [key, proof] of Object.entries(CONSENT_TEXTS)) {
      const asStored = {
        consent_given: true, // the most permissive reading of the call sites
        consent_text: proof.text,
        consent_text_displayed: proof.displayed,
        consent_act: proof.act,
      };
      expect(hasAffirmativeJobAlertConsent(asStored), key).toBe(false);
    }
  });

  it('names the two entries that DO scope job alerts, so adding a third is a deliberate act', () => {
    const naming = Object.entries(CONSENT_TEXTS)
      .filter(([, proof]) => consentNamesJobAlerts(proof.text))
      .map(([key]) => key)
      .sort();
    // Both are job-board unlock gates: one an OAuth sign-in (`act:
    // 'authentication'`), one a typed address — and BOTH are `displayed: false`,
    // i.e. the string was recorded, never rendered. That is why the register
    // cannot admit anybody today, and it is a gap to close in the UI, not here.
    expect(naming).toEqual(['jobUnlockEmail', 'jobUnlockSocial']);
    for (const key of naming) {
      expect(CONSENT_TEXTS[key as keyof typeof CONSENT_TEXTS].displayed, key).toBe(false);
    }
  });
});

describe('the batch script cannot write, by construction (#5705)', () => {
  const src = readRepoFile('scripts/backfill-jobalerts-from-newsletter.mjs');

  it('contains no Firestore write call at all', () => {
    // Not "is configured not to write" — a flag can be passed. The statements
    // that created 7.167 alerts are gone from the file, so re-running it with
    // any argument, or relaxing the consent gate, still writes nothing.
    for (const forbidden of ['.set(', '.add(', '.create(', '.update(', '.delete(', 'batch(', 'FieldValue']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it('says so on its first lines, where someone about to run it will look', () => {
    expect(src.slice(0, 400)).toContain('REPORT ONLY');
  });
});

describe('backfill-jobalerts-from-newsletter — resolveSignalTier tier-3', () => {
  it('derives personalization-fallback from browsing data when flat fields are empty', () => {
    const result = resolveSignalTier({}, { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] });
    expect(result.tier).toBe('personalization-fallback');
    expect(result.patch).toMatchObject({ location_interest: 'Mendrisio', job_category: 'IT / Tecnologia' });
  });

  it('never consults personalization when a flat-field tier already resolves (patch stays null)', () => {
    const result = resolveSignalTier({ job_category: 'tech' }, { viewedJobs: [{ location: 'Lugano' }] });
    expect(result).toEqual({ tier: 'signal', patch: null });
  });

  it('does NOT emit personalization-fallback when filterUsage has only zero-count entries (#3378)', () => {
    // Adversarial: stale subdoc where every counter is explicitly 0.
    // derivePersonalizationPatch must return null so tier falls through to url-fallback/none.
    const result = resolveSignalTier(
      {},
      { filterUsage: { category: { 'Sanita / Ospedali': 0 }, location: { Lugano: 0 } } },
    );
    expect(result.tier).not.toBe('personalization-fallback');
    expect(result.patch).toBeNull();
  });

  it('prefers tier-3 personalization-fallback over tier-4 url-fallback when real signal exists (#3371)', () => {
    // Confirms the ordering introduced by #3371 is preserved: a subscriber who
    // browsed real jobs (viewedJobs) but also landed on a canton job-board URL
    // must be classified via the richer personalization signal, not the URL fallback.
    const result = resolveSignalTier(
      { consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/' },
      { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] },
    );
    expect(result.tier).toBe('personalization-fallback');
  });
});

describe('backfill-jobalerts-from-newsletter — buildAlertPayload', () => {
  it('builds a near-empty alert that leans on the linked newsletter_subscribers doc for matching', () => {
    const payload = buildAlertPayload(
      'a@b.ch',
      { job_category: 'tech', job_slug: 'dev-abc123', locale: 'it', source_channel: 'job_gate' },
      null,
    );
    expect(payload.keywords).toEqual([]);
    expect(payload.locations).toEqual([]);
    expect(payload.cantonFilter).toBeNull();
    expect(payload.frequency).toBe('daily');
    expect(payload.sourceJobSlug).toBe('dev-abc123');
    expect(payload.active).toBe(true);
    expect(payload.backfilled_from).toBe('newsletter_subscribers:job_gate');
  });

  it('records the actual source_channel in backfilled_from, not just job_gate', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech', source_channel: 'auth_google' }, null);
    expect(payload.backfilled_from).toBe('newsletter_subscribers:auth_google');
  });

  it('falls back to "unknown" in backfilled_from when source_channel is missing', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, null);
    expect(payload.backfilled_from).toBe('newsletter_subscribers:unknown');
  });

  it('tags backfilled_from with :location-fallback when built from the location-only tier', () => {
    const payload = buildAlertPayload('a@b.ch', { location_interest: 'Lugano', source_channel: 'popup' }, null);
    expect(payload.backfilled_from).toBe('newsletter_subscribers:popup:location-fallback');
    expect(payload.cantonFilter).toBeNull();
    expect(payload.keywords).toEqual([]);
  });

  it('tags backfilled_from with :personalization-fallback when built from browsing data', () => {
    const payload = buildAlertPayload(
      'a@b.ch',
      { source_channel: 'popup' },
      null,
      { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] },
    );
    expect(payload.backfilled_from).toBe('newsletter_subscribers:popup:personalization-fallback');
    expect(payload.cantonFilter).toBeNull();
    expect(payload.keywords).toEqual([]);
  });

  it('defaults locale to it when the subscriber has none', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, null);
    expect(payload.locale).toBe('it');
  });

  it('prefers preferred_locale over locale', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech', locale: 'it', preferred_locale: 'de' }, null);
    expect(payload.locale).toBe('de');
  });

  it('is idempotent — preserves matchCount/lastMatchedAt from an existing backfilled alert instead of resetting them', () => {
    const payload = buildAlertPayload(
      'a@b.ch',
      { job_category: 'tech' },
      { matchCount: 7, lastMatchedAt: 'sentinel-timestamp' },
    );
    expect(payload.matchCount).toBe(7);
    expect(payload.lastMatchedAt).toBe('sentinel-timestamp');
  });

  it('starts matchCount/lastMatchedAt fresh when no prior backfill exists', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, null);
    expect(payload.matchCount).toBe(0);
    expect(payload.lastMatchedAt).toBeNull();
  });

  it('defaults active to true on first creation', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, null);
    expect(payload.active).toBe(true);
  });

  it('never reactivates an alert the user explicitly disabled (deleteAlert sets active:false)', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, { active: false, matchCount: 3 });
    expect(payload.active).toBe(false);
  });

  it('keeps active true when the existing backfill doc never set it to false', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, { matchCount: 3 });
    expect(payload.active).toBe(true);
  });
});

describe('backfill-jobalerts-from-newsletter — normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  A@B.CH  ')).toBe('a@b.ch');
  });
});

describe('backfill-jobalerts-from-newsletter — constants', () => {
  it('uses a stable, deterministic alert id for idempotent re-runs', () => {
    expect(ALERT_ID).toBe('backfill-newsletter');
  });

  // Asserted as PARITY, not as a literal (#5012). The literal 3 this used to
  // carry made the test restate the value instead of checking what its name
  // promises, so raising the cap broke it even though the two sides still
  // agreed. The functions bundle cannot import outside `functions/`, which is
  // exactly why the constant is duplicated and why the parity check has to
  // live here.
  it('matches the client-side active-alerts cap (services/jobAlertService.ts)', () => {
    expect(MAX_ALERTS_PER_USER).toBe(CLIENT_MAX_ALERTS_PER_USER);
  });
});
