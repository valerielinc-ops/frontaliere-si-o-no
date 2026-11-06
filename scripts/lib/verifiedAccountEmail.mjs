/**
 * The address an account-keyed sender may mail: the one Firebase Auth holds
 * for the uid, only when Auth marks it verified.
 *
 * `users/{uid}.email` is not that address. firestore.rules lets the signed-in
 * owner write anything on their own `users/{uid}` document, so the field is a
 * claim; Auth is the record of what the provider (or the email link) proved.
 * When the profile does carry an address it must be the same one: a mismatch
 * means the two disagree about who the person is, and nothing is sent.
 *
 * Shared by the senders that pick recipients from `users/{uid}` instead of from
 * `newsletter_subscribers`: scripts/send-application-intent-reminders.mjs and
 * the saved-jobs digest for an account without a central row
 * (scripts/send-saved-jobs-digest.mjs). `firebase-admin/auth` is imported
 * lazily so the callers keep their own Admin app initialisation.
 */

/** @param {unknown} value */
export function normalizeAccountEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * @param {string} uid
 * @param {{ email?: unknown } | null | undefined} userData the `users/{uid}` data
 * @returns {Promise<string>} the verified address, or '' when there is none
 */
export async function verifiedEmailForUid(uid, userData) {
  const candidate = normalizeAccountEmail(userData?.email);
  const { getAuth } = await import('firebase-admin/auth');
  const authUser = await getAuth().getUser(uid);
  const authEmail = normalizeAccountEmail(authUser.email);
  if (!authUser.emailVerified || !authEmail || (candidate && authEmail !== candidate)) return '';
  return authEmail;
}
