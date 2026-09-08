/**
 * Newsletter subscriber → Auth account sync (gap-review, orphan-subscriber fix).
 *
 * ~522 of 5241 `newsletter_subscribers` docs have no Firebase Auth user behind
 * them, because lead-capture gates (job_gate, popup, lead_magnet, analysis_gate,
 * calculator_paywall, offerwall, chatbot, ...) write straight to Firestore via
 * `upsertNewsletterSubscriber` and never touch `firebase/auth`. Rather than
 * patch each of the ~16 call sites, this module is invoked by a single
 * `onDocumentWritten` trigger (see functions/index.js) on every new
 * `newsletter_subscribers/{email}` doc and on a tombstone re-registration,
 * then silently creates a matching Auth account (no password,
 * `emailVerified:false`, no email sent) when one doesn't
 * already exist. Subscribers coming from auth_google/auth_facebook/auth_linkedin
 * already have an Auth account created before the Firestore doc, so this is a
 * no-op for the common case.
 */

import admin from 'firebase-admin';
// Pragmatic email shape check (server-side) — single source of truth shared
// with adminEmployerInsights.js, journalistRoleCore.js and
// stripePublisherCore.js.
import { EMAIL_RE } from './lib/emailValidation.js';
import { isAccountDeletedTombstone } from './authAccountCleanup.js';

/**
 * @param {string} rawEmail  the newsletter_subscribers/{email} doc id (or an email field)
 * @param {{db?: import('firebase-admin/firestore').Firestore, auth?: import('firebase-admin/auth').Auth}} [deps]
 * @returns {Promise<{created: boolean, uid?: string, reason?: string, error?: string}>}
 */
export async function syncAuthAccountForSubscriber(rawEmail, deps = {}) {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

  if (!email || email === '_meta_' || !EMAIL_RE.test(email)) {
    return { created: false, reason: 'invalid_email' };
  }

 const db = deps.db || admin.firestore();
 try {
    // A tombstone marks the end of the previous Auth lifecycle, not a ban on
    // the address. Reading it still matters: a transient Firestore failure must
    // not make this trigger create an account without knowing whether the
    // subscriber write is valid.
    const subscriberSnapshot = await db.collection('newsletter_subscribers').doc(email).get();
    if (subscriberSnapshot.exists && isAccountDeletedTombstone(subscriberSnapshot.data())) {
      return { created: false, reason: 'account_deleted' };
    }
  } catch (error) {
    // Fail closed: retry the trigger later instead of creating an Auth account
    // while the subscriber state is unavailable.
    console.error('[syncAuthAccountForSubscriber] tombstone read', error instanceof Error ? error.message : String(error));
    return {
      created: false,
      reason: 'tombstone_check_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const auth = deps.auth || admin.auth();

  try {
    await auth.getUserByEmail(email);
    return { created: false, reason: 'already_exists' };
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') {
      console.error('[syncAuthAccountForSubscriber]', error instanceof Error ? error.message : String(error));
      return { created: false, reason: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    const userRecord = await auth.createUser({ email, emailVerified: false, disabled: false });
    return { created: true, uid: userRecord.uid };
  } catch (error) {
    if (error?.code === 'auth/email-already-exists') {
      // Race with a concurrent write (e.g. the client's own signup flow) — not an error.
      return { created: false, reason: 'already_exists' };
    }
    console.error('[syncAuthAccountForSubscriber]', error instanceof Error ? error.message : String(error));
    return { created: false, reason: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}
