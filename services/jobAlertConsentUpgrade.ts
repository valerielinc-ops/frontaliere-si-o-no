/**
 * jobAlertConsentUpgrade — turning a deduced consent into an explicit one, on
 * the person's own act and on nothing else (#5876).
 *
 * WHAT THIS EXISTS TO FIX
 * -----------------------
 * Measured on production 2026-08-14 over `collectionGroup('alerts')`:
 * 6.860 active job alerts across 6.323 recipients, of which **6.295 carry
 * `backfilled_from`** — they were created by an automatic travaso from the
 * newsletter list (#5705), nobody asked for them — and **0 carry any consent
 * proof at all**. The owner ruled the same day against a re-permission campaign
 * (#5681) and for the opposite move: leave those people alone, and when one of
 * them comes back to the site and EXPLICITLY presses "attiva alert", record the
 * consent as if they had subscribed in that moment.
 *
 * So this module writes proof onto an existing travaso alert, and the metric it
 * moves is exactly `consent_text != null AND backfilled_from != null`, which
 * starts at 0. The document keeps `backfilled_from` forever: that is the field
 * that lets an audit say "this alert was born from a travaso and was later
 * confirmed by an act", which is a different and much more defensible sentence
 * than "this alert was requested".
 *
 * THE ORDER OF THE CHECKS, WHICH IS THE WHOLE POINT
 * ------------------------------------------------
 * `planJobAlertConsentUpgrade` evaluates the OPT-OUT first, before it looks at
 * provenance and before it looks at whether a proof already exists. That order
 * is not defensive tidiness, it is the repair of a shape this codebase has paid
 * for twice:
 *
 *  - #5692: `hasConfirmationProof` was evaluated BEFORE the opt-out branch in
 *    the reminder runner, so two documents carrying a binding opt-out were
 *    invisible in the `opt-out` bucket and got written a sendable state — the
 *    same construction that produced the 186 "resuscitati" (#5672), where an
 *    `ac` code that never expired let a login re-subscribe somebody who had
 *    left;
 *  - the path this module plugs into had the stronger version of the same
 *    defect: `createAlert` (services/jobAlertService.ts) consults NO
 *    suppression state whatsoever. There was no order to get wrong because
 *    there was no gate. A person who unsubscribed and later mis-taps a CTA must
 *    not come back into contact, so the gate is introduced here and it runs
 *    first.
 *
 * Both spellings of every field are read, for the reason #5673 established: 458
 * production documents carry ONLY the camelCase `unsubscribedAt`, so a guard
 * that reads one name honours half the opt-outs. What we WRITE is snake_case,
 * because that is what the existing readers read — `consentNamesJobAlerts`
 * (functions/src/jobAlertBackfillCore.js) reads `data.consent_text`,
 * `scripts/report-job-alert-engagement-tiers.mjs` reads `data.backfilled_from`,
 * and the metric query above reads both. Read wide, write narrow.
 *
 * WHAT IT NEVER DOES
 * ------------------
 *  - it never writes `status`. Measured on 2026-08-13, closing by `status`
 *    would have cancelled 848 valid consents against 866 phantoms; the field is
 *    not trustworthy and it is not this module's business;
 *  - it never touches `active`, so it can neither resurrect nor delete;
 *  - it never writes onto `newsletter_subscribers`. The affirmative-consent
 *    gate that guards the travaso itself (`hasAffirmativeJobAlertConsent`)
 *    reads THAT document, and `JOB_ALERT_CONSENT_ACT` is deliberately absent
 *    from `AFFIRMATIVE_CONSENT_ACTS`: an act recorded here must never re-open
 *    automatic alert creation for anybody, which is the #5705 shape;
 *  - it never overwrites a proof that is already there. See
 *    `hasStoredConsentProof` — losing the date of the first consent is worse
 *    than failing to refresh it.
 */
import {
  CONSENT_TEXTS,
  consentDisplayText,
  type ConsentTextKey,
} from './consentTexts';
import { COMMUNICATIONS_PAGE_VERSION } from './communicationChannels';
import { isNewsletterOptOutBinding } from './newsletterOptOut.mjs';

/**
 * The register entry whose sentence the activation surfaces render.
 *
 * `communicationsOptIn` and not a new entry: it IS the one-line formula that
 * points at `/comunicazioni/` with `COMMUNICATIONS_PAGE_VERSION` inside it
 * (#5765), and the alert CTAs render it through
 * `<ConsentNotice consentKey="communicationsOptIn">` — the same function that
 * produces the stored bytes, so "what was shown" and "what was recorded" cannot
 * drift. A second entry carrying the identical four sentences would buy nothing
 * and would need pinning twice.
 */
export const JOB_ALERT_CONSENT_KEY: ConsentTextKey = 'communicationsOptIn';

/**
 * What the person physically did, in this domain's own vocabulary.
 *
 * NOT the register's `act` for `communicationsOptIn` (`typed_email_submit`):
 * nobody types an email into a one-tap "Sì, attiva" button, and the register's
 * own header says a record that overstated the act would be worth less than no
 * record. It is also NOT a member of `AFFIRMATIVE_CONSENT_ACTS`
 * (functions/src/jobAlertBackfillCore.js) and must never become one — that list
 * decides who the travaso may create alerts FOR, and this act describes
 * somebody who already has one.
 */
export const JOB_ALERT_CONSENT_ACT = 'job_alert_activation_click';

/**
 * The flag that keeps a converted document distinguishable from a natively
 * requested one, which the owner asked for in so many words: after the upgrade
 * one must still be able to say whether the consent was born of the travaso or
 * of the act. `backfilled_from` says where the ALERT came from; this says where
 * the PROOF came from.
 */
export const CONSENT_ORIGIN_BACKFILL_UPGRADE = 'backfill_upgraded_by_explicit_act';

/** Both spellings of the travaso marker (#5673: production carries both). */
export const BACKFILL_FIELDS = Object.freeze(['backfilled_from', 'backfilledFrom']);
/** Both spellings of a stored consent formula. */
export const CONSENT_TEXT_FIELDS = Object.freeze(['consent_text', 'consentText']);

/** A Firestore document's DATA (never a snapshot — see `newsletterOptOut.mjs`). */
export type DocData = Record<string, unknown> | null | undefined;

/**
 * The proof, in the field names the existing readers read.
 *
 * `consent_given` is absent on purpose, exactly as `consentProof`
 * (services/consentTexts.ts) omits it: this module is not a call site with a
 * ticked box, and asserting an affirmative opt-in it did not collect would
 * fabricate the one fact the record exists to establish. What it does assert is
 * narrower and true — a disclosure was on screen and a button was pressed.
 */
export interface JobAlertConsentProof {
  readonly consent_text: string;
  readonly consent_text_version: string;
  readonly consent_text_displayed: boolean;
  readonly consent_page_version: string;
  readonly consent_act: string;
  readonly consent_origin: string;
  readonly consent_source_url: string | null;
  /** The timestamp of the act. Opaque here so the pure layer never imports Firestore. */
  readonly consent_upgraded_at: unknown;
}

function firstPresent(doc: DocData, fields: readonly string[]): unknown {
  if (!doc || typeof doc !== 'object') return null;
  for (const f of fields) {
    const v = (doc as Record<string, unknown>)[f];
    if (v != null && v !== '') return v;
  }
  return null;
}

/** Was this alert created by the travaso, under either spelling? */
export function isBackfilledAlert(alert: DocData): boolean {
  return firstPresent(alert, BACKFILL_FIELDS) != null;
}

/**
 * Does this alert already carry a consent formula?
 *
 * Covers two of the four cases the owner listed at once, and deliberately with
 * one predicate: a person accepting a SECOND time (the newer page version must
 * not overwrite the date of the first act) and a document whose proof came from
 * a real subscription (not ours to touch). Both answers are "leave it alone",
 * so distinguishing them here would only create a branch that could be got
 * wrong later.
 */
export function hasStoredConsentProof(alert: DocData): boolean {
  return firstPresent(alert, CONSENT_TEXT_FIELDS) != null;
}

/** Why an upgrade did not happen. Named, so a caller can count them. */
export type UpgradeSkipReason =
  | 'no-document'
  | 'opt-out-binding'
  | 'inactive'
  | 'not-backfilled'
  | 'already-has-proof';

export type UpgradeDecision =
  | { readonly write: false; readonly reason: UpgradeSkipReason }
  | { readonly write: true; readonly payload: JobAlertConsentProof };

/**
 * Build the proof for one act.
 *
 * `locale` is the locale the visitor is READING in, so the stored sentence is
 * the sentence they saw — the divergence #5712 found, where a German visitor's
 * document recorded an Italian literal they had never read.
 */
export function buildJobAlertConsentProof(opts: {
  locale?: string | null;
  sourceUrl?: string | null;
  /** Whatever the caller's clock is — `serverTimestamp()` in the browser, a fixed value in tests. */
  stampedAt: unknown;
}): JobAlertConsentProof {
  const entry = CONSENT_TEXTS[JOB_ALERT_CONSENT_KEY];
  return {
    consent_text: consentDisplayText(JOB_ALERT_CONSENT_KEY, opts.locale),
    consent_text_version: entry.version,
    consent_text_displayed: entry.displayed,
    consent_page_version: COMMUNICATIONS_PAGE_VERSION,
    consent_act: JOB_ALERT_CONSENT_ACT,
    consent_origin: CONSENT_ORIGIN_BACKFILL_UPGRADE,
    consent_source_url: opts.sourceUrl ?? null,
    consent_upgraded_at: opts.stampedAt,
  };
}

/**
 * Decide whether this one alert document may be stamped.
 *
 * THE ORDER IS THE CONTRACT — see the header. Opt-out first, on the alert AND
 * on its parent subscriber document, because an opt-out recorded at either
 * level is an opt-out; then provenance; then the existing-proof guard. Reversing
 * the first two is the #5692 shape and `tests/job-alert-consent-upgrade.test.ts`
 * fails on it.
 */
export function planJobAlertConsentUpgrade(input: {
  alert: DocData;
  subscriber?: DocData;
  proof: JobAlertConsentProof;
}): UpgradeDecision {
  const { alert, subscriber, proof } = input;
  if (!alert || typeof alert !== 'object') return { write: false, reason: 'no-document' };

  // 1. THE OPT-OUT, FIRST AND ALWAYS. `isNewsletterOptOutBinding` reads
  //    `status: 'unsubscribed'` and both spellings of the stamp, and honours a
  //    later re-opt-in; job-alert unsubscribes write `unsubscribed_at` onto the
  //    alert itself (functions/src/jobAlertUnsubscribe.js), so the same reader
  //    covers both documents.
  if (isNewsletterOptOutBinding(alert) || isNewsletterOptOutBinding(subscriber)) {
    return { write: false, reason: 'opt-out-binding' };
  }

  // 2. A soft-deleted alert is not something to record a fresh consent against,
  //    even when the deletion left no stamp. Still ahead of provenance: it is
  //    part of the same "this person is not asking for mail" family.
  if ((alert as Record<string, unknown>).active === false) {
    return { write: false, reason: 'inactive' };
  }

  // 3. Only travaso documents are in scope. An alert somebody created
  //    themselves is already an explicit act and needs nothing from here.
  if (!isBackfilledAlert(alert)) return { write: false, reason: 'not-backfilled' };

  // 4. Never overwrite an existing proof — neither our own from an earlier
  //    accept, nor one from a real subscription.
  if (hasStoredConsentProof(alert)) return { write: false, reason: 'already-has-proof' };

  return { write: true, payload: proof };
}
