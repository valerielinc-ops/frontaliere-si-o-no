/**
 * journalistAdminService.ts — client for the ADMIN-only `manageJournalistRole`
 * Cloud Function (functions/src/journalistRoleCore.js, region europe-west6).
 *
 * Mirrors services/adminInsights.ts's calling convention exactly: same base
 * URL host, same `Authorization: Bearer <idToken>` header, same
 * `{ ok, ... }` / `{ ok: false, error }` response shape. Consumed by
 * AdminPanel.tsx's "Giornalisti" section (grant/revoke the `journalists/{uid}`
 * role doc that gates components/pages/JournalistDashboardPage.tsx).
 */

const MANAGE_JOURNALIST_ROLE_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/manageJournalistRole';

export interface JournalistGrant {
  uid: string;
  email: string;
  displayName: string;
  active: boolean;
  grantedAt: string | null;
  grantedBy: string | null;
}

/** Minimal Firebase user shape — only getIdToken is needed. */
interface AuthLike {
  getIdToken: () => Promise<string>;
}

/**
 * Lists every `journalists/{uid}` grant doc for the authenticated admin.
 * Throws a human-readable message on auth failure or non-OK response.
 */
export async function fetchJournalistGrants(user: AuthLike | null | undefined): Promise<JournalistGrant[]> {
  if (!user) {
    throw new Error('Devi essere autenticato come admin per vedere i giornalisti abilitati.');
  }
  const idToken = await user.getIdToken();
  const res = await fetch(MANAGE_JOURNALIST_ROLE_ENDPOINT, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (data.error === 'not_admin') {
      throw new Error('Accesso negato: questo account non è autorizzato a gestire i giornalisti.');
    }
    throw new Error(`Impossibile caricare i giornalisti (${data.error || res.status}).`);
  }
  return Array.isArray(data.journalists) ? (data.journalists as JournalistGrant[]) : [];
}

/**
 * Grants or revokes the journalist role for the Firebase Auth user with this
 * email (they must have signed into the site at least once). Throws a
 * human-readable message on auth failure, validation error, or unknown user.
 */
export async function setJournalistRole(
  user: AuthLike | null | undefined,
  action: 'grant' | 'revoke',
  email: string,
): Promise<void> {
  if (!user) {
    throw new Error('Devi essere autenticato come admin per gestire i giornalisti.');
  }
  const trimmedEmail = email.trim();
  if (!trimmedEmail) {
    throw new Error('Email mancante.');
  }
  const idToken = await user.getIdToken();
  const res = await fetch(MANAGE_JOURNALIST_ROLE_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, email: trimmedEmail }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const reasons: Record<string, string> = {
      not_admin: 'Accesso negato: questo account non è autorizzato a gestire i giornalisti.',
      invalid_input: 'Email o azione non valida.',
      user_not_found:
        'Nessun account trovato con questa email: la persona deve prima accedere una volta al sito.',
    };
    throw new Error(reasons[data.error] || `Operazione non riuscita (${data.error || res.status}).`);
  }
}
