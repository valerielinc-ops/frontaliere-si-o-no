/**
 * Stable, non-contact identity used by the browser admin gate.
 *
 * The Firebase UID is not a credential and does not disclose an email address.
 * The server-side gates and Firestore rules remain authoritative; this module
 * only keeps the SPA from publishing a personal admin email in its bundle.
 */
export const SITE_ADMIN_UIDS = ['aAqGpXr2mUQNQlio3gCxut4bBzH3'] as const;

export function isSiteAdminUid(uid: string | null | undefined): boolean {
  return typeof uid === 'string' && (SITE_ADMIN_UIDS as readonly string[]).includes(uid);
}
