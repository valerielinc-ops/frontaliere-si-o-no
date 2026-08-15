/**
 * newsletterConsentUpgrade — the consent-banner act, recorded on the
 * newsletter document of a person we can already name (#5842, owner direction
 * of 2026-08-15).
 *
 * WHAT THIS EXISTS TO FIX
 * -----------------------
 * Measured on production 2026-08-15: 8.820 `newsletter_subscribers`, of which
 * 375 carry a `consent_text` — the stock of documents with no stored proof
 * shrinks only at the pace of new signups and alert-activation clicks (#5902
 * moved the alert-side metric 0 → 1 in its first ~19 hours; at that pace the
 * 6.291 travaso alerts take years). The owner ruled for a second organic
 * surface: the consent banner slot also collects OUR communications consent,
 * from visitors the SPA can identify, once, with the refusal falling back to
 * the activation/subscription acts that already record proof.
 *
 * WHAT IT NEVER DOES — the same refusals as `jobAlertConsentUpgrade`, because
 * they are the lessons this cluster already paid for:
 *  - it never CREATES a document (`updateDoc`, not `setDoc`): no subscriber,
 *    no consent to attribute — a merge write on a missing id would manufacture
 *    a subscriber out of a banner click;
 *  - it never OVERWRITES an existing proof: losing the date of the first
 *    consent is worse than failing to refresh it;
 *  - the OPT-OUT is checked first, on both spellings (#5673), and a read
 *    failure aborts instead of defaulting to "no opt-out" — nothing here may
 *    make anybody contactable who was not already;
 *  - it never writes `status`, `active` or `consent_given`. The banner has a
 *    dedicated button, not a ticked checkbox, and the register's rule
 *    (services/consentTexts.ts, enforced by tests/consent-shown-at-signup) is
 *    that only a real checkbox may assert `consent_given`. What this module
 *    stores is narrower and true: the formula was on screen (`<ConsentNotice
 *    consentKey="communicationsOptIn">`, the same function that produces the
 *    stored bytes) and a button whose only purpose is that formula was
 *    pressed.
 *
 * The act is NOT `job_alert_activation_click`: nobody activated an alert.
 * Recording that act here would fabricate the one fact the register exists to
 * establish, so the banner stamps its own act — on this document and, through
 * `upgradeBackfilledAlertConsent`'s act override, on the travaso alerts too.
 */
import type { Firestore } from 'firebase/firestore';
import { COMMUNICATIONS_PAGE_VERSION } from './communicationChannels';
import { CONSENT_TEXTS, consentDisplayText, type ConsentTextKey } from './consentTexts';
import { CONSENT_TEXT_FIELDS, type DocData } from './jobAlertConsentUpgrade';
import { isNewsletterOptOutBinding } from './newsletterOptOut.mjs';

/** The register entry the banner renders — the same one the alert CTAs render. */
export const COMMS_BANNER_CONSENT_KEY: ConsentTextKey = 'communicationsOptIn';

/** What the person physically did: pressed the banner's dedicated confirm button. */
export const COMMUNICATIONS_BANNER_CONSENT_ACT = 'communications_banner_confirm_click';

/** Where the PROOF came from — distinguishable forever from a real signup's. */
export const CONSENT_ORIGIN_COMMS_BANNER = 'communications_consent_banner';

/**
 * localStorage key for the once-per-device throttle. Lives here (not in the
 * component) so tests and future surfaces read one constant. The banner is
 * shown at most once per device; any answer — either answer — retires it.
 */
export const COMMS_CONSENT_PROMPT_STORAGE_KEY = 'frontaliere_comms_consent_prompt';

/** Why the write did not happen. Named, so a caller can count them. */
export type NewsletterConsentSkipReason =
  | 'no-document'
  | 'opt-out-binding'
  | 'already-has-proof';

export type NewsletterConsentDecision =
  | { readonly write: false; readonly reason: NewsletterConsentSkipReason }
  | { readonly write: true };

/**
 * Decide whether this subscriber document may be stamped — and, read before
 * any write, whether the banner should be offered at all. THE ORDER IS THE
 * CONTRACT, same as `planJobAlertConsentUpgrade`: the opt-out outranks every
 * other answer, because a person who left must not be re-engaged by a banner
 * (#5692's shape, and the 186 "resuscitati" of #5672 before it).
 */
export function planNewsletterConsentUpgrade(subscriber: DocData): NewsletterConsentDecision {
  if (!subscriber || typeof subscriber !== 'object') {
    return { write: false, reason: 'no-document' };
  }
  if (isNewsletterOptOutBinding(subscriber)) {
    return { write: false, reason: 'opt-out-binding' };
  }
  const record = subscriber as Record<string, unknown>;
  for (const field of CONSENT_TEXT_FIELDS) {
    const v = record[field];
    if (v != null && v !== '') return { write: false, reason: 'already-has-proof' };
  }
  return { write: true };
}

/** The proof, in the field names the existing subscriber-document readers read. */
export interface NewsletterConsentProof {
  readonly consent_text: string;
  readonly consent_text_version: string;
  readonly consent_text_displayed: boolean;
  readonly consent_page_version: string;
  readonly consent_act: string;
  readonly consent_method: string;
  readonly consent_origin: string;
  readonly consent_source_url: string | null;
  readonly consent_user_agent: string | null;
  /** The timestamp of the act. Opaque here so the pure layer never imports Firestore. */
  readonly consent_upgraded_at: unknown;
}

/**
 * Build the proof for one banner act. `locale` is the locale the visitor is
 * READING in, so the stored sentence is the sentence they saw (#5712).
 */
export function buildNewsletterConsentProof(opts: {
  locale?: string | null;
  sourceUrl?: string | null;
  /** Whatever the caller's clock is — `serverTimestamp()` in the browser, a fixed value in tests. */
  stampedAt: unknown;
}): NewsletterConsentProof {
  const entry = CONSENT_TEXTS[COMMS_BANNER_CONSENT_KEY];
  return {
    consent_text: consentDisplayText(COMMS_BANNER_CONSENT_KEY, opts.locale),
    consent_text_version: entry.version,
    consent_text_displayed: entry.displayed,
    consent_page_version: COMMUNICATIONS_PAGE_VERSION,
    consent_act: COMMUNICATIONS_BANNER_CONSENT_ACT,
    consent_method: CONSENT_ORIGIN_COMMS_BANNER,
    consent_origin: CONSENT_ORIGIN_COMMS_BANNER,
    consent_source_url: opts.sourceUrl ?? null,
    consent_user_agent:
      typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : null,
    consent_upgraded_at: opts.stampedAt,
  };
}

// ── Lazy Firestore init (same shape as services/jobAlertService.ts) ──

let _db: Firestore | null = null;

async function getDb(): Promise<Firestore> {
  if (_db) return _db;
  const { getFirestore } = await import('firebase/firestore');
  const { getApp } = await import('./firebase');
  const app = await getApp();
  _db = getFirestore(app);
  return _db;
}

const NEWSLETTER_COLLECTION = 'newsletter_subscribers';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Should the banner be offered to this address at all?
 *
 * Fail CLOSED: any read failure answers "no banner" — a prompt that cannot
 * verify the opt-out state must not show, for the same reason the write path
 * aborts. Never throws.
 */
export async function shouldOfferCommunicationsConsent(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email || '');
  if (!normalized) return false;
  try {
    const db = await getDb();
    const { doc, getDoc } = await import('firebase/firestore');
    const snap = await getDoc(doc(db, NEWSLETTER_COLLECTION, normalized));
    if (!snap.exists()) return false;
    return planNewsletterConsentUpgrade(snap.data() as Record<string, unknown>).write === true;
  } catch {
    return false;
  }
}

/**
 * Record the banner act on the subscriber document. Re-reads and re-plans at
 * write time — the visibility check ran earlier and the document may have
 * changed under it. NEVER THROWS INTO A CTA: returns the outcome instead.
 */
export async function recordCommunicationsConsent(
  email: string,
  locale?: string | null,
  opts?: { sourceUrl?: string | null },
): Promise<{ recorded: boolean; reason?: NewsletterConsentSkipReason | 'write-failed' }> {
  const normalized = normalizeEmail(email || '');
  if (!normalized) return { recorded: false, reason: 'no-document' };
  try {
    const db = await getDb();
    const { doc, getDoc, updateDoc, serverTimestamp } = await import('firebase/firestore');
    const ref = doc(db, NEWSLETTER_COLLECTION, normalized);
    const snap = await getDoc(ref);
    const decision = planNewsletterConsentUpgrade(
      snap.exists() ? (snap.data() as Record<string, unknown>) : null,
    );
    if (decision.write !== true) return { recorded: false, reason: decision.reason };
    const proof = buildNewsletterConsentProof({
      locale,
      sourceUrl:
        opts?.sourceUrl
        ?? (typeof window !== 'undefined' && window.location ? window.location.href : null),
      stampedAt: serverTimestamp(),
    });
    // A field-level update: `status`, `active` and every counter are left
    // exactly as they are, and a missing document makes this fail rather than
    // create — see the header.
    await updateDoc(ref, { ...proof });
    return { recorded: true };
  } catch {
    return { recorded: false, reason: 'write-failed' };
  }
}
