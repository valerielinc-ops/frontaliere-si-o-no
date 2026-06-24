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
const ADMIN_SEND_COLD_EMAIL_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/adminSendColdEmail';

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
  /** Outreach contact (editable from the dashboard; '' when not set yet). */
  contactEmail: string;
  /** Pattern-inferred guess (never auto-sent) — shown as a low-confidence hint. */
  contactEmailInferred: string;
  contactName: string;
  contactRole: string;
  /** Most-clicked role — drives the email preview personalization. */
  topRole: string;
  /**
   * Outreach telemetry (read-only): which cold-email touch was sent + when,
   * whether the company replied, and whether it opted out (STOP). Sourced from
   * the employer_outreach_sends / _replies / _suppression collections.
   */
  outreach?: EmployerOutreachStatus;
}

/** Per-company cold-email send/reply/opt-out status shown in the dashboard. */
export interface EmployerOutreachStatus {
  /** Highest touch number sent so far (0 = nothing sent). */
  lastTouch: number;
  /** ISO timestamp of the last send, or null. */
  lastSentAt: string | null;
  /** Distinct touch numbers sent, ascending. */
  touchesSent: number[];
  /** Total send events logged (counts re-sends). */
  sendCount: number;
  /** True once any inbound reply was recorded. */
  replied: boolean;
  /** ISO timestamp of the last reply, or null. */
  lastRepliedAt: string | null;
  /** Number of inbound replies recorded. */
  replyCount: number;
  /** True if the company opted out (STOP reply / one-click unsubscribe). */
  suppressed: boolean;
  /** ISO timestamp of opt-out, or null. */
  suppressedAt: string | null;
}

/** Editable fields the admin can push back for one company's outreach contact. */
export interface EmployerContactUpdate {
  companyKey: string;
  /** Non-empty sets the address; empty/omitted leaves it untouched (see clearEmail). */
  email?: string;
  /** Explicit intent to wipe a previously dashboard-set address. */
  clearEmail?: boolean;
  contactName?: string;
  topRole?: string;
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

/**
 * Upsert one company's outreach contact (email / name / role) as the verified
 * admin. POSTs to the same endpoint (method-branched server-side). The Firestore
 * `employer_contacts` doc is merged into the local send registry at send time.
 * Throws on auth failure or validation error — callers surface the message.
 */
export async function updateEmployerContact(
  user: AuthLike | null | undefined,
  update: EmployerContactUpdate,
): Promise<void> {
  if (!user) {
    throw new Error('Devi essere autenticato come admin per modificare il contatto.');
  }
  if (!update.companyKey) {
    throw new Error('Company key mancante.');
  }
  const idToken = await user.getIdToken();
  const res = await fetch(ADMIN_INSIGHTS_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (data.error === 'not_admin') {
      throw new Error('Accesso negato: questo account non è autorizzato.');
    }
    if (data.error === 'invalid_email') {
      throw new Error('Email non valida. Controlla l’indirizzo inserito.');
    }
    throw new Error(`Salvataggio non riuscito (${data.error || res.status}).`);
  }
}

/** Result of a web-UI cold-email send. `tracked: false` means the email went out
 *  but the send-log write failed (rare) — the dashboard may not reflect it yet. */
export interface SendColdEmailResult {
  touch: number;
  to: string;
  messageId: string;
  tracked: boolean;
}

/**
 * Send one cold-email touch to a company from the dashboard (admin only). The
 * Cloud Function re-checks the admin gate, verified email, suppression and dedup
 * server-side, sends via Resend, and logs to employer_outreach_sends. `force`
 * re-sends a touch already logged. Throws a human-readable message on refusal.
 */
export async function sendColdEmail(
  user: AuthLike | null | undefined,
  companyKey: string,
  touch: number,
  force = false,
): Promise<SendColdEmailResult> {
  if (!user) {
    throw new Error('Devi essere autenticato come admin per inviare email.');
  }
  if (!companyKey) {
    throw new Error('Company key mancante.');
  }
  const idToken = await user.getIdToken();
  const res = await fetch(ADMIN_SEND_COLD_EMAIL_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyKey, touch, force }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const reasons: Record<string, string> = {
      not_admin: 'Accesso negato: questo account non è autorizzato.',
      no_verified_email: 'Nessuna email verificata per questa azienda: impostala prima di inviare.',
      suppressed: 'Azienda disiscritta (opt-out): invio bloccato.',
      already_sent: `Touch ${touch} già inviata a questa azienda. Usa "forza re-invio" se vuoi rispedirla.`,
      no_insights: 'Nessun dato insights per questa azienda.',
      resend_key_missing: 'Provider email non configurato (RESEND_API_KEY).',
      send_failed: 'Invio email fallito dal provider. Riprova.',
    };
    throw new Error(reasons[data.error] || `Invio non riuscito (${data.error || res.status}).`);
  }
  return {
    touch: Number(data.touch ?? touch),
    to: String(data.to || ''),
    messageId: String(data.messageId || ''),
    tracked: data.tracked !== false,
  };
}
