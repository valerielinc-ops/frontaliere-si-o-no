/**
 * consentIpStamp — ask the server to record the network a CLIENT-SIDE consent
 * came from (#5920, closing the half of #5676 the browser cannot reach).
 *
 * WHAT THIS IS FOR
 * ----------------
 * `consent_ip` is stamped by Cloud Functions on every signup path, because a
 * browser cannot see its own public address and a value it was told is not
 * evidence (the argument is written out in
 * functions/src/lib/requestForensics.js). The consent acts that appeared with
 * #5902/#5920 — the banner's `communications_banner_confirm_click` and the
 * alert-side upgrades — are recorded by the browser writing Firestore
 * directly, so they reach no function and their proof lands with the date, the
 * formula and the act, and no network of origin.
 *
 * This module is the missing round trip, and NOTHING MORE: it hands the
 * server an ID token and an address, and the server reads the IP from its own
 * `cf-connecting-ip` — the client never sends, sees or influences the value
 * that gets stored.
 *
 * THE CONTRACT, in the order it matters:
 *  - NEVER THROWS, never rejects. An evidence field must not be able to break
 *    a consent flow — same refusal as `stampConsentIp` server-side, for the
 *    same reason: the act itself is worth more than the annotation on it.
 *  - NO TOKEN, NO CALL. The endpoint refuses an unauthenticated request
 *    anyway; asking is pointless and the failure is silent by design.
 *  - AT MOST ONCE PER ADDRESS PER PAGE SESSION. The banner's accept path and
 *    `upgradeBackfilledAlertConsent` are both stamped, and the banner triggers
 *    both — the server would ignore the second call (it never overwrites), so
 *    the deduplication is only about not making the request twice.
 */

import { FUNCTIONS_BASE } from './functionsBase';

export const CONSENT_IP_STAMP_URL = `${FUNCTIONS_BASE}/newsletterConsentIpStamp`;

/**
 * Addresses already asked for, this page session. Attempt-scoped, not
 * success-scoped: a failed stamp is not retried on the next click, because a
 * missing evidence field is a smaller harm than a retry loop against a
 * function that is having a bad minute.
 */
const attempted = new Set<string>();

/** Test seam — never called by product code. */
export function __resetConsentIpStampDedup(): void {
  attempted.clear();
}

function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

/**
 * The current user's ID token, or null. Dynamic imports for the same reason
 * every other Firebase touch in services/ is dynamic: the vendor chunk must
 * not be pulled in for this.
 */
async function currentUserIdToken(): Promise<string | null> {
  try {
    const [{ getApp }, authModule] = await Promise.all([
      import('./firebase'),
      import('firebase/auth'),
    ]);
    const auth = authModule.getAuth(await getApp());
    const user = auth.currentUser;
    // Deliberately NOT waiting for onAuthStateChanged: every caller runs
    // behind a UI that only exists for an already-identified visitor, so a
    // null here means signed out, not "not yet restored".
    if (!user) return null;
    return await user.getIdToken();
  } catch {
    return null;
  }
}

/**
 * Stamp `consent_ip` on `newsletter_subscribers/{email}` if it has none.
 *
 * Fire-and-forget by contract: the returned promise always resolves, and its
 * value says nothing — callers must not branch on it, because a stamp that did
 * not happen changes nothing the visitor or the consent depends on.
 */
export async function stampConsentIpViaEndpoint(
  email: string,
  deps?: { getIdToken?: () => Promise<string | null>; fetchImpl?: typeof fetch },
): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) return;
  if (attempted.has(normalized)) return;
  attempted.add(normalized);
  try {
    const token = await (deps?.getIdToken ?? currentUserIdToken)();
    if (!token) return;
    const doFetch = deps?.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return;
    await doFetch(CONSENT_IP_STAMP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      // The address is the TARGET, not the evidence: the server refuses unless
      // the token's own email claim is this same address.
      body: JSON.stringify({ email: normalized }),
    });
  } catch {
    /* offline, blocked, 4xx — the consent itself already landed. */
  }
}
