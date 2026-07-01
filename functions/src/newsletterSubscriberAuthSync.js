/**
 * Newsletter subscriber → Auth account sync (gap-review, orphan-subscriber fix).
 *
 * ~522 of 5241 `newsletter_subscribers` docs have no Firebase Auth user behind
 * them, because lead-capture gates (job_gate, popup, lead_magnet, analysis_gate,
 * calculator_paywall, offerwall, chatbot, ...) write straight to Firestore via
 * `upsertNewsletterSubscriber` and never touch `firebase/auth`. Rather than
 * patch each of the ~16 call sites, this module is invoked by a single
 * `onDocumentCreated` trigger (see functions/index.js) on every new
 * `newsletter_subscribers/{email}` doc, and silently creates a matching Auth
 * account (no password, `emailVerified:false`, no email sent) when one doesn't
 * already exist. Subscribers coming from auth_google/auth_facebook/auth_linkedin
 * already have an Auth account created before the Firestore doc, so this is a
 * no-op for the common case.
 */

import admin from 'firebase-admin';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {string} rawEmail  the newsletter_subscribers/{email} doc id (or an email field)
 * @returns {Promise<{created: boolean, uid?: string, reason?: string, error?: string}>}
 */
export async function syncAuthAccountForSubscriber(rawEmail) {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

  if (!email || email === '_meta_' || !EMAIL_RE.test(email)) {
    return { created: false, reason: 'invalid_email' };
  }

  try {
    await admin.auth().getUserByEmail(email);
    return { created: false, reason: 'already_exists' };
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') {
      console.error('[syncAuthAccountForSubscriber]', error instanceof Error ? error.message : String(error));
      return { created: false, reason: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    const userRecord = await admin.auth().createUser({ email, emailVerified: false, disabled: false });
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
