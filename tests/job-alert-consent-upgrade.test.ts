/**
 * THE INVARIANT: a consent proof is written on a real act, on a travaso
 * document that has none, and NEVER over an opt-out (#5876).
 *
 * WHY THIS FILE IS SHAPED AROUND THE ORDER OF FOUR CHECKS
 * ------------------------------------------------------
 * On 2026-08-14, while repairing the 843 documents of #5692, `hasConfirmationProof`
 * turned out to be evaluated BEFORE the opt-out branch of the reminder runner:
 * two documents carrying a binding opt-out were invisible in the `opt-out`
 * bucket and were about to be written a sendable state — the construction that
 * produced the 186 "resuscitati" (#5672), where a never-expiring `ac` code let a
 * login re-subscribe somebody who had left.
 *
 * The path this feature plugs into had the stronger version of that defect:
 * `createAlert` (services/jobAlertService.ts) consults NO suppression state at
 * all, so there was no order to get wrong because there was no gate. The gate
 * now exists, it runs FIRST, and the assertions below fail if it is moved,
 * weakened or removed — including the three mutations recorded at the bottom.
 *
 * THE FOUR SHAPES THE OWNER LISTED AS "NEVER SEEN BY A TEST", ALL BELOW:
 *   1. a second accept must not overwrite the first proof with a newer page
 *      version — losing the date of the original consent is worse than not
 *      refreshing it;
 *   2. accept and then unsubscribe — the opt-out wins, the proof STAYS;
 *   3. a `consent_text` from a real subscription is not ours to touch;
 *   4. the stamp read in camelCase and written in snake_case (#5673: 458
 *      production documents carry ONLY the camelCase opt-out spelling).
 *
 * WHAT IT DOES NOT PROVE. That Firestore accepted the write — that is
 * `firestore.rules`, and the assertion further down is why the rule had to
 * change: measured 2026-08-14, 0 of 6.295 travaso alerts carry a `userId`, so
 * the previous `update` rule denied every one of these writes and the feature
 * would have shipped green and inert.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  BACKFILL_FIELDS,
  CONSENT_ORIGIN_BACKFILL_UPGRADE,
  CONSENT_TEXT_FIELDS,
  JOB_ALERT_CONSENT_ACT,
  JOB_ALERT_CONSENT_KEY,
  buildJobAlertConsentProof,
  hasStoredConsentProof,
  isBackfilledAlert,
  planJobAlertConsentUpgrade,
} from '@/services/jobAlertConsentUpgrade';
import { CONSENT_TEXTS, consentDisplayText } from '@/services/consentTexts';
import { COMMUNICATIONS_PAGE_VERSION } from '@/services/communicationChannels';
import { AFFIRMATIVE_CONSENT_ACTS } from '../functions/src/jobAlertBackfillCore.js';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const STAMP = '2026-08-14T10:00:00.000Z';
const proof = (locale = 'it') =>
  buildJobAlertConsentProof({ locale, sourceUrl: 'https://frontaliereticino.ch/lavoro/', stampedAt: STAMP });

/** A travaso alert exactly as `buildAlertPayload` writes it, minus the noise. */
const backfilledAlert = (extra: Record<string, unknown> = {}) => ({
  email: 'mario@example.ch',
  userId: null,
  active: true,
  keywords: [],
  frequency: 'daily',
  backfilled_from: 'newsletter_subscribers:popup',
  ...extra,
});

describe('the proof itself', () => {
  it('stores the sentence the notice renders, not a reconstruction of it', () => {
    // Same function the component calls — `<ConsentNotice consentKey="…">`
    // prints `consentDisplayText(key, locale)`, so shown and stored cannot drift.
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(proof(locale).consent_text).toBe(consentDisplayText(JOB_ALERT_CONSENT_KEY, locale));
    }
    // …and the version of the page that sentence points at travels with it.
    expect(proof().consent_text).toContain(COMMUNICATIONS_PAGE_VERSION);
    expect(proof().consent_page_version).toBe(COMMUNICATIONS_PAGE_VERSION);
    expect(proof().consent_text_version).toBe(CONSENT_TEXTS[JOB_ALERT_CONSENT_KEY].version);
    expect(proof().consent_upgraded_at).toBe(STAMP);
  });

  it('records that the consent came from an act on a travaso document', () => {
    expect(proof().consent_origin).toBe(CONSENT_ORIGIN_BACKFILL_UPGRADE);
    expect(proof().consent_act).toBe(JOB_ALERT_CONSENT_ACT);
  });

  it('never asserts an affirmative opt-in the travaso could reuse', () => {
    // `consent_given` would re-open automatic alert creation through
    // `hasAffirmativeJobAlertConsent` — the #5705 shape that produced 6.308
    // unrequested alerts. Neither the field nor the act may leak into it.
    expect(Object.keys(proof())).not.toContain('consent_given');
    expect(AFFIRMATIVE_CONSENT_ACTS).not.toContain(JOB_ALERT_CONSENT_ACT);
  });

  it('never carries a field that would change who is contactable', () => {
    // `status` above all: measured 2026-08-13, closing by status would have
    // cancelled 848 valid consents against 866 phantoms.
    const keys = Object.keys(proof());
    for (const forbidden of ['status', 'active', 'unsubscribed_at', 'unsubscribedAt', 'resubscribed_at']) {
      expect(keys, `the proof must never write ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('case 4 — the stamp is read in both spellings and written in one', () => {
  it('writes snake_case, which is the shape the existing readers read', () => {
    // `consentNamesJobAlerts` reads `data.consent_text`,
    // scripts/report-job-alert-engagement-tiers.mjs reads `data.backfilled_from`,
    // and the progress metric queries both. A camelCase write would be invisible
    // to all three while looking perfectly fine in the console.
    for (const key of Object.keys(proof())) {
      expect(key, `${key} is not the shape the readers expect`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(Object.keys(proof())).toContain('consent_text');
  });

  it('recognises a document stamped ONLY in camelCase', () => {
    // #5673: 458 production documents carry only `unsubscribedAt`. A reader
    // that honours one spelling honours half the facts.
    expect(isBackfilledAlert({ backfilledFrom: 'newsletter_subscribers:popup' })).toBe(true);
    expect(hasStoredConsentProof({ consentText: 'Ricevo aggiornamenti…' })).toBe(true);
    expect(BACKFILL_FIELDS).toEqual(['backfilled_from', 'backfilledFrom']);
    expect(CONSENT_TEXT_FIELDS).toEqual(['consent_text', 'consentText']);

    // And the guard acts on it: a camelCase proof is still a proof.
    expect(
      planJobAlertConsentUpgrade({
        alert: backfilledAlert({ consentText: 'una formula più vecchia' }),
        proof: proof(),
      }),
    ).toEqual({ write: false, reason: 'already-has-proof' });

    // A camelCase opt-out is still an opt-out.
    expect(
      planJobAlertConsentUpgrade({
        alert: backfilledAlert({ unsubscribedAt: '2026-08-01T00:00:00.000Z' }),
        proof: proof(),
      }),
    ).toEqual({ write: false, reason: 'opt-out-binding' });
  });
});

describe('the upgrade happens, and only on the shape it is meant for', () => {
  it('stamps a travaso alert that has no proof', () => {
    const decision = planJobAlertConsentUpgrade({ alert: backfilledAlert(), proof: proof() });
    expect(decision.write).toBe(true);
    expect(decision.write && decision.payload).toEqual(proof());
    // The provenance is NOT erased: "born of the travaso, later confirmed" is a
    // different and more defensible sentence than "requested".
    expect(decision.write && Object.keys(decision.payload)).not.toContain('backfilled_from');
  });

  it('leaves an alert somebody created themselves alone', () => {
    expect(
      planJobAlertConsentUpgrade({ alert: { active: true, keywords: ['sanità'] }, proof: proof() }),
    ).toEqual({ write: false, reason: 'not-backfilled' });
  });

  it('refuses an empty or unreadable document instead of inventing one', () => {
    expect(planJobAlertConsentUpgrade({ alert: null, proof: proof() })).toEqual({
      write: false,
      reason: 'no-document',
    });
  });
});

describe('case 1 — a second accept does not overwrite the first proof', () => {
  it('refuses to restamp, even when the page version has moved on', () => {
    // The document was stamped at page version 2026-08-13.1; the visitor comes
    // back after the page changed and presses the button again. Overwriting
    // would silently move the DATE of the consent forward onto an act that
    // merely repeated an earlier one — and the date is the whole proof.
    const alreadyUpgraded = backfilledAlert({
      consent_text: `…frontaliereticino.ch/comunicazioni (versione 2026-08-13.1).`,
      consent_page_version: '2026-08-13.1',
      consent_upgraded_at: '2026-08-13T09:00:00.000Z',
      consent_origin: CONSENT_ORIGIN_BACKFILL_UPGRADE,
    });
    const newer = buildJobAlertConsentProof({ locale: 'it', stampedAt: '2026-08-20T09:00:00.000Z' });
    expect(newer.consent_page_version).not.toBe('2026-08-13.1');

    expect(planJobAlertConsentUpgrade({ alert: alreadyUpgraded, proof: newer })).toEqual({
      write: false,
      reason: 'already-has-proof',
    });
  });
});

describe('case 2 — accept, then unsubscribe: the opt-out wins and the proof stays', () => {
  const stamped = {
    consent_text: consentDisplayText(JOB_ALERT_CONSENT_KEY, 'it'),
    consent_upgraded_at: '2026-08-14T10:00:00.000Z',
  };

  it('refuses to write anything once the opt-out is binding', () => {
    const optedOut = backfilledAlert({
      ...stamped,
      active: false,
      unsubscribed_at: '2026-08-15T08:00:00.000Z',
    });
    expect(planJobAlertConsentUpgrade({ alert: optedOut, proof: proof() })).toEqual({
      write: false,
      reason: 'opt-out-binding',
    });
  });

  it('produces no payload at all, so nothing can erase the proof already there', () => {
    // The refusal is the guarantee: a decision that carries no payload cannot
    // clear `consent_text`. The record of what the person agreed to on the day
    // they agreed survives their departure — which is what an art. 25 request
    // asks about.
    const optedOut = backfilledAlert({ ...stamped, unsubscribed_at: '2026-08-15T08:00:00.000Z' });
    const decision = planJobAlertConsentUpgrade({ alert: optedOut, proof: proof() });
    expect(decision.write).toBe(false);
    expect(decision).not.toHaveProperty('payload');
  });

  it('honours an opt-out recorded on the parent subscriber document', () => {
    // A person can leave from the newsletter side; the alert document knows
    // nothing about it. Reading only the alert would let a mis-tap on a CTA
    // bring them back into contact — the 186-resuscitati shape (#5672).
    expect(
      planJobAlertConsentUpgrade({
        alert: backfilledAlert(),
        subscriber: { status: 'unsubscribed' },
        proof: proof(),
      }),
    ).toEqual({ write: false, reason: 'opt-out-binding' });
  });

  it('lets a genuine later re-opt-in through, and not a stale one', () => {
    // `isNewsletterOptOutBinding` requires the re-opt-in to land STRICTLY after
    // the opt-out — the property that stops an old stamp from cancelling a
    // recent departure.
    expect(
      planJobAlertConsentUpgrade({
        alert: backfilledAlert({
          unsubscribed_at: '2026-08-01T00:00:00.000Z',
          resubscribed_at: '2026-08-10T00:00:00.000Z',
        }),
        proof: proof(),
      }).write,
    ).toBe(true);
    expect(
      planJobAlertConsentUpgrade({
        alert: backfilledAlert({
          unsubscribed_at: '2026-08-10T00:00:00.000Z',
          resubscribed_at: '2026-08-01T00:00:00.000Z',
        }),
        proof: proof(),
      }),
    ).toEqual({ write: false, reason: 'opt-out-binding' });
  });

  it('refuses a soft-deleted alert even when no stamp was left behind', () => {
    expect(
      planJobAlertConsentUpgrade({ alert: backfilledAlert({ active: false }), proof: proof() }),
    ).toEqual({ write: false, reason: 'inactive' });
  });
});

describe('case 3 — a consent_text from a real subscription is not touched', () => {
  it('leaves a document that already carries a real proof exactly as it is', () => {
    const realSignup = backfilledAlert({
      consent_text: 'Acconsento a ricevere la newsletter per frontalieri.',
      consent_text_version: '2026-07-01.1',
      consent_act: 'typed_email_submit',
      consent_given: true,
    });
    expect(planJobAlertConsentUpgrade({ alert: realSignup, proof: proof() })).toEqual({
      write: false,
      reason: 'already-has-proof',
    });
  });
});

describe('THE ORDER OF THE CHECKS — the #5692 shape, in this path', () => {
  /**
   * Each case below is a document where two refusals apply at once. The REASON
   * is what says which check ran first, and it is the only observable that can
   * catch the gate being moved after the others while every outcome still looks
   * correct — which is exactly how #5692 survived review.
   */
  it('evaluates the opt-out BEFORE the existing-proof check', () => {
    const both = backfilledAlert({
      consent_text: consentDisplayText(JOB_ALERT_CONSENT_KEY, 'it'),
      unsubscribed_at: '2026-08-15T08:00:00.000Z',
    });
    expect(planJobAlertConsentUpgrade({ alert: both, proof: proof() }).write).toBe(false);
    expect(
      (planJobAlertConsentUpgrade({ alert: both, proof: proof() }) as { reason: string }).reason,
      'the proof check ran first — this is the #5692 ordering, verbatim',
    ).toBe('opt-out-binding');
  });

  it('evaluates the opt-out BEFORE the provenance check', () => {
    const both = { active: true, keywords: ['sanità'], unsubscribed_at: '2026-08-15T08:00:00.000Z' };
    expect(
      (planJobAlertConsentUpgrade({ alert: both, proof: proof() }) as { reason: string }).reason,
    ).toBe('opt-out-binding');
  });

  it('never writes for a document carrying a binding opt-out, whatever else is true', () => {
    // The exhaustive statement, so no combination has to be trusted to the two
    // cases above: every shape this module can meet, crossed with an opt-out.
    const shapes = [
      {},
      { backfilled_from: 'newsletter_subscribers:popup' },
      { backfilledFrom: 'newsletter_subscribers:popup' },
      { backfilled_from: 'newsletter_subscribers:popup', consent_text: 'x' },
      { backfilled_from: 'newsletter_subscribers:popup', consentText: 'x' },
      { keywords: ['sanità'] },
    ];
    const optOuts = [
      { status: 'unsubscribed' },
      { unsubscribed_at: '2026-08-15T08:00:00.000Z' },
      { unsubscribedAt: '2026-08-15T08:00:00.000Z' },
    ];
    for (const shape of shapes) {
      for (const optOut of optOuts) {
        const decision = planJobAlertConsentUpgrade({
          alert: { active: true, ...shape, ...optOut },
          proof: proof(),
        });
        expect(decision, JSON.stringify({ shape, optOut })).toEqual({
          write: false,
          reason: 'opt-out-binding',
        });
      }
    }
  });
});

describe('the write side can actually reach the documents it is written for', () => {
  const service = read('services/jobAlertService.ts');

  it('enumerates the alerts by email, never through the userId-scoped query', () => {
    // Measured on production 2026-08-14: 0 of 6.295 travaso alerts carry a
    // `userId` (`buildAlertPayload` writes `data?.user_id || null`, and the
    // newsletter documents had none). `getUserAlerts` filters on
    // `where('userId','==',uid)`, so it returns none of them — a version of
    // this feature built on it would run, log success and upgrade nothing.
    const fn = service.slice(service.indexOf('export async function upgradeBackfilledAlertConsent'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    expect(body).toContain('ALERTS_SUBCOLLECTION');
    expect(body, 'a userId-scoped read cannot see a travaso alert').not.toMatch(/getUserAlerts\s*\(/);
  });

  it('the rule that governs that update accepts a document with no userId', () => {
    // Without this, every one of the 6.295 writes is permission-denied and the
    // metric stays at 0 behind a green CI.
    const rules = read('firestore.rules');
    const block = rules.slice(rules.indexOf('match /alerts/{alertId}'));
    const update = block.slice(block.indexOf('allow update'), block.indexOf('}', block.indexOf('allow update')));
    expect(update).toContain('resource.data.userId == null');
    expect(update, 'the caller must still own the email the document lives under')
      .toContain('request.auth.token.email.lower() == email');
  });

  it('leaves status and active untouched on the write path', () => {
    const fn = service.slice(service.indexOf('export async function upgradeBackfilledAlertConsent'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    expect(body).not.toMatch(/status\s*:/);
    expect(body).not.toMatch(/active\s*:/);
  });
});

describe('what is stored is what was on screen', () => {
  /**
   * The pairing, per file and mechanically: a surface that records the proof
   * MUST render the notice whose sentence it records, and a surface that
   * renders it must be one that records. This is the `displayed: true` contract
   * of `services/consentTexts.ts` applied to the job-alert domain — the same
   * rule `tests/consent-shown-at-signup.test.tsx` enforces for the newsletter
   * gates, which do not cover these files because none of them creates a
   * `newsletter_subscribers` document.
   */
  const SURFACES = [
    'components/community/JobDetailAlertPrompt.tsx',
    'components/community/JobMatchAlertCta.tsx',
    'components/community/JobBoardFilterAlertCta.tsx',
    'components/community/JobDetailJobAlertButton.tsx',
    'components/community/SavedJobsAlertNudge.tsx',
    'components/community/JobAlertForm.tsx',
    'components/calculator/SalaryAlertCTA.tsx',
  ];

  it('the register entry these surfaces render is the one the proof stores', () => {
    expect(JOB_ALERT_CONSENT_KEY).toBe('communicationsOptIn');
    expect(CONSENT_TEXTS[JOB_ALERT_CONSENT_KEY].displayed).toBe(true);
  });

  it.each(SURFACES)('%s renders the sentence it records', (file) => {
    const src = read(file);
    expect(src, `${file} must record the proof`).toMatch(/upgradeBackfilledAlertConsent/);
    expect(src, `${file} records a formula it never puts on screen`).toMatch(
      new RegExp(`<ConsentNotice[^>]*consentKey="${JOB_ALERT_CONSENT_KEY}"`),
    );
  });

  it('no other component records the proof without showing it', () => {
    // Discovered from disk rather than listed: a new CTA that calls the upgrade
    // and shows nothing fails on the day it is written, not on the day somebody
    // reads the collection.
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const walk = (dir: string): string[] =>
      readdirSync(path.join(ROOT, dir)).flatMap((name) => {
        const rel = `${dir}/${name}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) return walk(rel);
        return rel.endsWith('.tsx') ? [rel] : [];
      });
    const callers = walk('components').filter((rel) =>
      /upgradeBackfilledAlertConsent/.test(read(rel)),
    );
    expect(callers.sort()).toEqual(SURFACES.filter((s) => s.startsWith('components')).sort());
  });
});
