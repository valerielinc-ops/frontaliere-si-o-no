/**
 * newsletterRecordConsent — record a consent-banner act through the SERVER,
 * behind a real proof of possession (#5928, phase 1).
 *
 * WHY A SERVER ROUND TRIP AT ALL
 * ------------------------------
 * `recordCommunicationsConsent` (services/newsletterConsentUpgrade.ts) writes
 * the proof straight from the browser with `updateDoc`, and `firestore.rules`
 * still allows that write with no auth. So the `consent_text` — the field the
 * art. 25 register exists to establish — is fabricable by anyone with the
 * project id, and the network of origin can never be captured (a browser
 * cannot see its own address). This helper hands the act to
 * `newsletterRecordConsent`, which writes the proof + IP only when Firebase
 * says `email_verified === true` for the calling account, on that account's
 * own document.
 *
 * THE TWO-OUTCOME CONTRACT the banner depends on:
 *  - `serverHandled: true`  — the endpoint answered 200: it either wrote the
 *    proof (`recorded: true`) or the write plan said not to (opt-out, existing
 *    proof, no document). Either way the SERVER owns this address's consent and
 *    the caller must NOT also write client-side.
 *  - `serverHandled: false` — the endpoint refused (not `email_verified`, no
 *    claim match, no token) or the round trip failed. The caller falls back to
 *    the existing client-side `recordCommunicationsConsent`, which is the
 *    unchanged behaviour for the shell-account cohort (`email_verified: false`)
 *    that is the banner's majority. NEVER THROWS: an evidence write must not be
 *    able to break the consent flow.
 */

import { FUNCTIONS_BASE } from './functionsBase';
import {
  buildNewsletterConsentProof,
  COMMS_BANNER_CONSENT_KEY,
} from './newsletterConsentUpgrade';
import { consentDisplayText } from './consentTexts';

export const RECORD_CONSENT_URL = `${FUNCTIONS_BASE}/newsletterRecordConsent`;

export type RecordConsentServerResult =
  | { readonly serverHandled: true; readonly recorded: boolean; readonly reason?: string | null }
  | { readonly serverHandled: false };

function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

/**
 * The current user's ID token, or null. Dynamic imports for the same reason
 * every other Firebase touch in services/ is dynamic: the vendor chunk must
 * not be pulled in for this. Deliberately does NOT wait for
 * `onAuthStateChanged` — every caller sits behind UI that only exists for an
 * already-identified visitor, so a null means signed out, not "not yet
 * restored".
 */
async function currentUserIdToken(): Promise<string | null> {
  try {
    const [{ getApp }, authModule] = await Promise.all([
      import('./firebase'),
      import('firebase/auth'),
    ]);
    const auth = authModule.getAuth(await getApp());
    const user = auth.currentUser;
    if (!user) return null;
    return await user.getIdToken();
  } catch {
    return null;
  }
}

/**
 * The proof payload the SERVER stores the register-derived half of. Only the
 * fields the browser legitimately owns (it is what displayed them): the bytes
 * on screen, their version, the displayed flag, the page version, and the
 * act/origin the server pins against its own constants. The IP, the UA and the
 * timestamp are added server-side and are NOT sent from here.
 */
function buildProofPayload(locale?: string | null): {
  consent_text: string;
  consent_text_version: string;
  consent_text_displayed: boolean;
  consent_page_version: string;
  consent_act: string;
  consent_origin: string;
} {
  // Built from the same function the client-side writer uses, so the bytes
  // sent are byte-identical to what a fallback write would store. `stampedAt`
  // is unused here (the server sets the timestamp) — a null placeholder.
  const proof = buildNewsletterConsentProof({ locale, sourceUrl: null, stampedAt: null });
  return {
    // `consent_text` re-derived from the register key rather than trusted from
    // the built object, so the byte-exact register sentence is what travels.
    consent_text: consentDisplayText(COMMS_BANNER_CONSENT_KEY, locale),
    consent_text_version: proof.consent_text_version,
    consent_text_displayed: proof.consent_text_displayed,
    consent_page_version: proof.consent_page_version,
    consent_act: proof.consent_act,
    consent_origin: proof.consent_origin,
  };
}

/**
 * Try to record the banner consent server-side. Resolves always; the result
 * tells the caller whether the server took ownership of this write or the
 * client-side fallback must run.
 */
export async function recordConsentViaEndpoint(
  email: string,
  locale?: string | null,
  opts?: {
    sourceUrl?: string | null;
    getIdToken?: () => Promise<string | null>;
    fetchImpl?: typeof fetch;
  },
): Promise<RecordConsentServerResult> {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) return { serverHandled: false };
  try {
    const token = await (opts?.getIdToken ?? currentUserIdToken)();
    if (!token) return { serverHandled: false };
    const doFetch = opts?.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return { serverHandled: false };

    const sourceUrl =
      opts?.sourceUrl
      ?? (typeof window !== 'undefined' && window.location ? window.location.href : null);

    const res = await doFetch(RECORD_CONSENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      // `email` is the TARGET, not the evidence: the server refuses unless the
      // token's own verified email claim IS this address.
      body: JSON.stringify({
        email: normalized,
        sourceUrl,
        proof: buildProofPayload(locale),
      }),
    });

    // Any non-200 — 401/403 (not verified, claim mismatch), 400, 5xx — is
    // "server did not take this write": fall back to the client path.
    if (!res.ok) return { serverHandled: false };
    const body = (await res.json().catch(() => null)) as
      | { recorded?: boolean; reason?: string | null }
      | null;
    return {
      serverHandled: true,
      recorded: body?.recorded === true,
      reason: body?.reason ?? null,
    };
  } catch {
    // Offline, blocked, malformed response: the consent still matters, so the
    // caller falls back to the client-side write.
    return { serverHandled: false };
  }
}
