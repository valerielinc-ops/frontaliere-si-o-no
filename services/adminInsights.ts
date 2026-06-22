/**
 * adminInsights.ts — client for the ADMIN-only employer traffic insights list.
 *
 * Calls the `adminEmployerInsights` Cloud Function with the admin's Firebase ID
 * token in the Authorization header (same auth idiom as AdminPanel's
 * getGitHubConnection → getAdminGithubToken). The endpoint is admin-gated
 * server-side; this module never exposes the data to non-admins.
 */

const ADMIN_INSIGHTS_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/adminEmployerInsights';

export interface EmployerInsightsTotals {
  views: number;
  visitors: number;
  candidates: number;
  adsCount: number;
  lost: number;
  conversionRate: number;
}

export interface EmployerInsightsRow {
  companyKey: string;
  companyName: string;
  generatedAt: string | null;
  totals: EmployerInsightsTotals;
  /** Tokenized "open as company" stats-proof URL the company receives. */
  insightsUrl: string;
}

/** Minimal Firebase user shape — only getIdToken is needed. */
interface AuthLike {
  getIdToken: () => Promise<string>;
}

/**
 * Fetch all employer insights (lean) for the authenticated admin.
 * Throws on auth failure or non-OK response — callers surface the message.
 */
export async function fetchAdminEmployerInsights(
  user: AuthLike | null | undefined,
): Promise<EmployerInsightsRow[]> {
  if (!user) {
    throw new Error('Devi essere autenticato come admin per vedere le insights aziende.');
  }
  const idToken = await user.getIdToken();
  const res = await fetch(ADMIN_INSIGHTS_ENDPOINT, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (data.error === 'not_admin') {
      throw new Error('Accesso negato: questo account non è autorizzato alle insights aziende.');
    }
    throw new Error(`Impossibile caricare le insights (${data.error || res.status}).`);
  }
  return Array.isArray(data.insights) ? (data.insights as EmployerInsightsRow[]) : [];
}
