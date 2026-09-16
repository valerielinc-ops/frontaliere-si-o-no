/**
 * Client for the owner-only assisted-application operations endpoint.
 *
 * The browser never lists this Firestore collection directly: its `list` rule
 * is closed and the Cloud Function re-checks the verified owner email. CV access
 * is returned as a short-lived signed URL, never as a raw Storage object path.
 */

import { FUNCTIONS_BASE } from './functionsBase';
import type { AssistedApplicationVariant } from './assistedApplicationExperiment';

export const ASSISTED_APPLICATION_ADMIN_ENDPOINT =
  `${FUNCTIONS_BASE}/manageAssistedApplicationAdmin`;

export const ASSISTED_APPLICATION_ADMIN_STATUSES = [
  'ready_for_manual_submission',
  'in_progress',
  'submitted',
  'blocked',
  'refunded',
] as const;

export type AssistedApplicationAdminStatus = (typeof ASSISTED_APPLICATION_ADMIN_STATUSES)[number];

export interface AssistedApplicationAdminOrder {
  orderId: string;
  jobId: string;
  jobUrl: string;
  companyId: string;
  companyName: string;
  jobTitle: string;
  experimentVariant: AssistedApplicationVariant | string;
  paymentStatus: string;
  amountTotal: number | null;
  currency: string;
  paidAt: string | null;
  applicantName: string | null;
  applicantEmail: string | null;
  applicantPhone: string | null;
  hasCv: boolean;
  cvUrl: string | null;
  cvUploadedAt: string | null;
  consentVersion: string | null;
  consentedAt: string | null;
  submissionStatus: AssistedApplicationAdminStatus;
  submissionNotes: string | null;
  submittedAt: string | null;
  blockedAt: string | null;
  refundedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AssistedApplicationAdminData {
  orders: AssistedApplicationAdminOrder[];
}

/** Minimal Firebase user shape — only getIdToken is needed. */
interface AuthLike {
  getIdToken: () => Promise<string>;
}

function errorMessage(error: unknown, status: number): string {
  const code = typeof error === 'string' ? error : '';
  const messages: Record<string, string> = {
    not_admin: 'Accesso negato: questo account non è autorizzato alla coda candidature.',
    invalid_input: 'Dati non validi.',
    invalid_status: 'Stato non valido.',
    order_not_found: 'Ordine candidatura non trovato.',
    invalid_transition: 'Transizione di stato non consentita.',
    blocked_reason_required: 'Inserisci una motivazione per bloccare la candidatura.',
    payment_not_confirmed: 'Il pagamento non è confermato.',
    payment_not_refundable: 'Questo ordine non può essere rimborsato.',
    payment_reference_missing: 'Riferimento Stripe mancante: rimborso non eseguito.',
    already_submitted: 'La candidatura è già stata inviata e non è rimborsabile da questa coda.',
    stripe_refund_failed: 'Stripe non ha completato il rimborso; nessun dato è stato marcato come rimborsato.',
  };
  return messages[code] || `Operazione non riuscita (${code || status}).`;
}

async function requestAdmin(
  user: AuthLike | null | undefined,
  input: RequestInit & { url?: string } = {},
): Promise<Record<string, unknown>> {
  if (!user) throw new Error('Devi essere autenticato come admin per gestire le candidature.');
  const idToken = await user.getIdToken();
  const { url = ASSISTED_APPLICATION_ADMIN_ENDPOINT, ...init } = input;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(errorMessage(data.error, response.status));
  return data as Record<string, unknown>;
}

/** Fetches all visible queue statuses, newest orders first. */
export async function fetchAssistedApplicationOrders(
  user: AuthLike | null | undefined,
  status?: AssistedApplicationAdminStatus,
): Promise<AssistedApplicationAdminOrder[]> {
  const url = new URL(ASSISTED_APPLICATION_ADMIN_ENDPOINT);
  if (status) url.searchParams.set('status', status);
  const data = await requestAdmin(user, { method: 'GET', url: url.toString() });
  return Array.isArray(data.orders) ? data.orders as AssistedApplicationAdminOrder[] : [];
}

/** Named data-shaped wrapper for callers that render the full admin section. */
export async function fetchAssistedApplicationAdminData(
  user: AuthLike | null | undefined,
  status?: AssistedApplicationAdminStatus,
): Promise<AssistedApplicationAdminData> {
  return { orders: await fetchAssistedApplicationOrders(user, status) };
}

/** Requests a server-validated submission-status transition and audit entry. */
export async function updateAssistedApplicationStatus(
  user: AuthLike | null | undefined,
  orderId: string,
  submissionStatus: AssistedApplicationAdminStatus,
  submissionNotes = '',
): Promise<void> {
  await requestAdmin(user, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'transitionStatus', orderId, submissionStatus, submissionNotes }),
  });
}

export const transitionAssistedApplicationStatus = updateAssistedApplicationStatus;

/** Issues a full Stripe refund, then records the refunded status and audit event. */
export async function refundAssistedApplication(
  user: AuthLike | null | undefined,
  orderId: string,
  submissionNotes = '',
): Promise<void> {
  await requestAdmin(user, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'refund', orderId, submissionNotes }),
  });
}
