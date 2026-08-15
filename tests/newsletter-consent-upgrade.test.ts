/**
 * newsletterConsentUpgrade — the consent-banner act on the newsletter document
 * (#5842, owner direction 2026-08-15).
 *
 * The shapes covered here are the ones this cluster has already paid for:
 * the opt-out outranks every other answer (#5692's ordering defect, the 186
 * "resuscitati" of #5672), an existing proof is never overwritten (losing the
 * first consent's date is worse than not refreshing it), both spellings of
 * every field are read (#5673: 458 production documents carry ONLY camelCase),
 * and the recorded act is the banner's own — not an activation click that
 * never happened.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  COMMS_BANNER_CONSENT_KEY,
  COMMUNICATIONS_BANNER_CONSENT_ACT,
  CONSENT_ORIGIN_COMMS_BANNER,
  buildNewsletterConsentProof,
  planNewsletterConsentUpgrade,
} from '@/services/newsletterConsentUpgrade';
import {
  JOB_ALERT_CONSENT_ACT,
  buildJobAlertConsentProof,
} from '@/services/jobAlertConsentUpgrade';
import { CONSENT_TEXTS, consentDisplayText } from '@/services/consentTexts';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const STAMP = { fixed: 'test-clock' };

describe('planNewsletterConsentUpgrade — the order of the checks IS the contract', () => {
  it('no document → nothing to stamp, nothing to create', () => {
    expect(planNewsletterConsentUpgrade(null)).toEqual({ write: false, reason: 'no-document' });
    expect(planNewsletterConsentUpgrade(undefined)).toEqual({ write: false, reason: 'no-document' });
  });

  it('a binding opt-out outranks everything — even a document with no proof yet', () => {
    expect(planNewsletterConsentUpgrade({ status: 'unsubscribed' })).toEqual({
      write: false,
      reason: 'opt-out-binding',
    });
  });

  it('the opt-out is honoured under BOTH spellings of the stamp (#5673)', () => {
    expect(planNewsletterConsentUpgrade({ unsubscribed_at: '2026-01-05T00:00:00Z' })).toEqual({
      write: false,
      reason: 'opt-out-binding',
    });
    expect(planNewsletterConsentUpgrade({ unsubscribedAt: '2026-01-05T00:00:00Z' })).toEqual({
      write: false,
      reason: 'opt-out-binding',
    });
  });

  it('opt-out first, proof second: a document with both is an opt-out, not a refresh target', () => {
    // Reversing these two is the #5692 shape — the proof branch would swallow
    // the opt-out and the caller would treat the person as consentable.
    expect(
      planNewsletterConsentUpgrade({ unsubscribed_at: '2026-01-05T00:00:00Z', consent_text: 'x' }),
    ).toEqual({ write: false, reason: 'opt-out-binding' });
  });

  it('a later re-opt-in supersedes the opt-out stamp', () => {
    expect(
      planNewsletterConsentUpgrade({
        unsubscribed_at: '2026-01-05T00:00:00Z',
        resubscribed_at: '2026-02-01T00:00:00Z',
      }),
    ).toEqual({ write: true });
  });

  it('never overwrites an existing proof, under either spelling', () => {
    expect(planNewsletterConsentUpgrade({ consent_text: 'stored formula' })).toEqual({
      write: false,
      reason: 'already-has-proof',
    });
    expect(planNewsletterConsentUpgrade({ consentText: 'stored formula' })).toEqual({
      write: false,
      reason: 'already-has-proof',
    });
  });

  it('a clean confirmed document may be stamped', () => {
    expect(planNewsletterConsentUpgrade({ status: 'confirmed', email: 'a@b.c' })).toEqual({
      write: true,
    });
  });
});

describe('buildNewsletterConsentProof — what is stored is what was on screen', () => {
  it('stores the register sentence of the locale the visitor was reading (#5712)', () => {
    const proof = buildNewsletterConsentProof({ locale: 'de', sourceUrl: 'https://x/', stampedAt: STAMP });
    expect(proof.consent_text).toBe(consentDisplayText(COMMS_BANNER_CONSENT_KEY, 'de'));
    expect(proof.consent_text).not.toBe(consentDisplayText(COMMS_BANNER_CONSENT_KEY, 'it'));
  });

  it('carries the register version, the displayed flag and the page version', () => {
    const entry = CONSENT_TEXTS[COMMS_BANNER_CONSENT_KEY];
    const proof = buildNewsletterConsentProof({ locale: 'it', stampedAt: STAMP });
    expect(proof.consent_text_version).toBe(entry.version);
    expect(proof.consent_text_displayed).toBe(true);
    expect(proof.consent_page_version).toBeTruthy();
    expect(proof.consent_upgraded_at).toBe(STAMP);
  });

  it('records the banner act and origin — distinguishable forever from a signup and from an activation click', () => {
    const proof = buildNewsletterConsentProof({ locale: 'it', stampedAt: STAMP });
    expect(proof.consent_act).toBe(COMMUNICATIONS_BANNER_CONSENT_ACT);
    expect(proof.consent_act).not.toBe(JOB_ALERT_CONSENT_ACT);
    expect(proof.consent_origin).toBe(CONSENT_ORIGIN_COMMS_BANNER);
  });

  it('never asserts consent_given: a dedicated button is an act, not a ticked checkbox', () => {
    // The register's rule (services/consentTexts.ts, enforced per file by
    // tests/consent-shown-at-signup.test.tsx) reserves `consent_given` for a
    // real checkbox the visitor has to tick. Overstating the act would be
    // worth less than no record.
    const proof = buildNewsletterConsentProof({ locale: 'it', stampedAt: STAMP });
    expect('consent_given' in proof).toBe(false);
  });

  it('never touches consent_method: the banner is not how the address reached us', () => {
    // `consent_method` is the closed ConsentMethod union of the ORIGINAL
    // signup (email_checkbox, google_oauth, …), printed by the art. 25 export
    // (scripts/lib/subscriberExport.mjs). The write path spreads the whole
    // proof into `updateDoc`, so a consent_method key here would OVERWRITE the
    // document's real provenance with this surface's name — the reviewer
    // caught exactly that in the first cut of this module.
    const proof = buildNewsletterConsentProof({ locale: 'it', stampedAt: STAMP });
    expect('consent_method' in proof).toBe(false);
  });
});

describe('the act override on the alert-side builder', () => {
  it('defaults to the activation act, so the eight CTAs are byte-identical to before', () => {
    const proof = buildJobAlertConsentProof({ locale: 'it', stampedAt: STAMP });
    expect(proof.consent_act).toBe(JOB_ALERT_CONSENT_ACT);
  });

  it('the banner records its own act on the travaso alerts it upgrades', () => {
    const proof = buildJobAlertConsentProof({
      locale: 'it',
      stampedAt: STAMP,
      act: COMMUNICATIONS_BANNER_CONSENT_ACT,
    });
    expect(proof.consent_act).toBe(COMMUNICATIONS_BANNER_CONSENT_ACT);
  });
});

describe('the write side keeps the refusals it promises', () => {
  const src = read('services/newsletterConsentUpgrade.ts');
  const fn = src.slice(src.indexOf('export async function recordCommunicationsConsent'));

  it('updates, never creates: a banner click must not manufacture a subscriber', () => {
    expect(fn).toContain('updateDoc');
    expect(fn).not.toMatch(/\bsetDoc\s*\(/);
    expect(fn).not.toMatch(/\baddDoc\s*\(/);
  });

  it('leaves status, active and consent_given untouched on the write path', () => {
    expect(fn).not.toMatch(/status\s*:/);
    expect(fn).not.toMatch(/active\s*:/);
    expect(fn).not.toMatch(/consent_given\s*:/);
  });

  it('re-plans at write time instead of trusting the visibility check', () => {
    expect(fn).toContain('planNewsletterConsentUpgrade');
  });
});
