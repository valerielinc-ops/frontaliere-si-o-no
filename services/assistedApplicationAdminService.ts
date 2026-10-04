/**
 * Client for the owner-only assisted-application operations endpoint.
 *
 * The browser never lists this Firestore collection directly: its `list` rule
 * is closed and the Cloud Function re-checks the verified owner email. CV access
 * is returned as a short-lived signed URL, never as a raw Storage object path.
 */

import { FUNCTIONS_BASE } from './functionsBase';
import type { AssistedApplicationVariant } from './assistedApplicationExperiment';
import { ASSISTED_APPLICATION_ADMIN_STATUSES as SHARED_ASSISTED_APPLICATION_ADMIN_STATUSES } from '@/functions/src/assistedApplicationConstants.js';

export const ASSISTED_APPLICATION_ADMIN_ENDPOINT =
  `${FUNCTIONS_BASE}/manageAssistedApplicationAdmin`;

export type AssistedApplicationAdminStatus =
  | 'awaiting_upload'
  | 'ready_for_manual_submission'
  | 'in_progress'
  | 'submitted'
  | 'blocked'
  | 'refunded';

export const ASSISTED_APPLICATION_ADMIN_STATUSES =
  SHARED_ASSISTED_APPLICATION_ADMIN_STATUSES as readonly AssistedApplicationAdminStatus[];

export interface AutomationRequirementView {
  requirement: string;
  importance: 'critical' | 'high' | 'meaningful' | 'preferred';
  basis: 'stated' | 'inferred';
  quote: string;
}

export interface AutomationQuestionView {
  id: string;
  question: string;
  why: string;
  type: string;
  options: string[];
  required: boolean;
}

/** Automated flow + AI draft, as functions/src/assistedApplicationAutomationAdmin.js returns them. */
export interface AtsReportView {
  structural: { score: number; grade: string; pass: boolean; issues: Array<{ code: string; severity: 'critical' | 'warning' | 'info' }>; notChecked: string[] };
  keywords: { coverage: number | null; present: string[]; thin: string[]; missing: string[]; roleTitle: string; roleTitleFound: boolean | null; ceiling?: number | null; overCeiling?: string[] };
}

/** What left with the application (scripts/assisted-application/lib/submit.mjs `sent`), each file with a signed link. */
export interface AutomationSentView {
  at: number | null;
  channel: string;
  packaging: 'separate' | 'single' | 'portal' | 'whatsapp' | null;
  reason: string | null;
  ad: '' | 'single' | 'separate';
  adCue: string;
  documentsGrouped: boolean;
  documentsReason: string | null;
  pages: number | null;
  bytes: number | null;
  letterRenderer: 'typst' | 'legacy' | null;
  /** A send whose outcome was uncertain, confirmed afterwards by the owner or by the employer's e-mail. */
  confirmedBy?: 'owner' | 'acknowledgement' | null;
  letterUrl: string | null;
  files: Array<{ kind: 'letter' | 'cv' | 'dossier' | 'documents' | 'document'; name: string; url: string | null }>;
}

export interface AssistedApplicationAutomationView {
  /** Employer messages received on the order alias (newest first, max 10). */
  inbox?: Array<{ receivedAt: number | null; from: string; subject: string; category: string; summaryIt: string; interviewWhen: string; forwarded: string | null }>;
  /** Follow-ups of an e-mail application (day 7 and 14). */
  followup?: {
    state: 'scheduled' | 'awaiting_candidate' | 'sending' | 'done' | 'stopped' | null;
    sent: number;
    dueAt: number | null;
    stopReason: string | null;
    pending: { n: number; body: string; deadlineAt: number | null } | null;
  } | null;
  /** Interview prep pack sent on an interview invitation. */
  interviewPrep?: { status: string; sentAt: number | null; questions: number; stories: number } | null;
  /** Portal accounts the runner created on the order's alias (no password: automationRevealAccount). */
  accounts?: Array<{ host: string; email: string; createdAt: number | null; verifiedAt: number | null; lastSignInAt: number | null; revealedAt: number | null }>;
  flow: {
    state: string | null;
    round: number;
    deadlineAt: number | null;
    reminderAt: number | null;
    heldBy: string[];
    feedback: Array<{ round: number; at: number; text: string }>;
    answers: Record<string, string>;
    /** The fields the candidate corrected on the review page. */
    formOverrides?: Record<string, string>;
    dispatch: { mode: string; round: number; requestedAt: number; attempts: number; reason: string | null } | null;
    history: Array<{ at: number; event: string; state: string }>;
  } | null;
  draft: {
    status: string | null;
    round: number | null;
    language: string | null;
    job: { source: string; title: string; applyUrl: string } | null;
    liveness: { result: string | null; code: string | null; datasetGone: boolean } | null;
    channel: { type: string; label: string; email: string; applyUrl: string; requiresAccount: boolean } | null;
    verdict: 'strong' | 'good' | 'weak' | 'poor' | null;
    summaryIt: string;
    checksIt: string[];
    requirements: AutomationRequirementView[];
    matches: Array<{ index: number; status: 'met' | 'partial' | 'missing'; evidence: string }>;
    questions: AutomationQuestionView[];
    coverLetter: { text: string; subject: string } | null;
    applicationEmail: { to: string; subject: string; body: string } | null;
    formAnswers: Array<{ key: string; label: string; value: string; needsConfirmation: boolean; note: string }>;
    factCheck: { ok: boolean; unsupported: Array<{ field: string; kind: string; token: string; context: string }>; advisories?: Array<{ field: string; kind: string; token: string; context: string }>; basis: string | null } | null;
    factCheckAcknowledgedAt: number | null;
    editedAt: number | null;
    /** When the candidate last saved their own changes on the review page. */
    candidateEditedAt?: number | null;
    cvTextMethod: string | null;
    coverLetterUrl: string | null;
    /** Which renderer made the letter PDF: `legacy` is the standard-font fallback (null on a draft from before it was recorded). */
    coverLetterRenderer?: 'typst' | 'legacy' | null;
    /** career-ops ATS check: structural grade and keyword coverage, of the candidate's CV and of the tailored one. */
    ats: { original: AtsReportView; tailored?: AtsReportView } | null;
    /** career-ops Block G. */
    legitimacy: {
      tier: 'high_confidence' | 'caution' | 'suspicious';
      ageDays: number | null;
      signals: Array<{ key: string; weight: 'positive' | 'neutral' | 'concerning'; reliability: string; detail: string }>;
      notes: Array<{ key: string; quote?: string; detail?: string }>;
    } | null;
    tailoredCv: {
      status: 'ready' | 'fact_check_failed' | 'failed' | 'skipped'; dropped: string[]; unsupported: Array<{ token: string; context: string }>; url: string | null;
      /** Which renderer made the tailored CV's PDF, as `coverLetterRenderer`. */
      renderer?: 'typst' | 'legacy' | null;
      /** Phase 5: the candidate's own DOCX with the adapted lines (null when the switch was off or the CV is a PDF). */
      inplace?: { status: 'ready' | 'fallback' | 'failed'; reason: string | null; patched: number; kept: string[]; pageCheck: 'libreoffice' | null; url: string | null } | null;
    } | null;
    /** The choice that holds: `inplace` only while that file is ready to be sent. */
    cvChoice: 'tailored' | 'original' | 'inplace';
    /** What the candidate chose on the review page (null before a choice): `inplace` while `cvChoice` is not, when that file fell back. */
    candidateCvChoice?: 'tailored' | 'original' | 'inplace' | null;
    /** What the portal received, question by question (career-ops application-answers). */
    portalAnswers: { status: string; at: number; answers: Array<{ question: string; answer: string; source: string }> } | null;
    /** What left with the application, with signed links (null before it left or on an older order). */
    sent?: AutomationSentView | null;
  } | null;
}

/** One e-mail to the candidate and what the providers reported (opens are indicative). */
export interface AssistedApplicationCandidateEmail {
  key: string;
  status: string | null;
  sentAt: string | null;
  delivered: number;
  opens: number;
  clicks: number;
  bounces: number;
  complaints: number;
  firstOpenAt: string | null;
  lastOpenAt: string | null;
  lastClickAt: string | null;
  /** Without the query: review links carry a signed token. */
  lastClickUrl: string | null;
}

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
  /** Stripe checkout email: the only contact before the customer sends materials. */
  customerEmail: string | null;
  locale: string | null;
  hasCv: boolean;
  cvUrl: string | null;
  /** `unscanned` until a scanner writes a verdict; the link is withheld for bad verdicts. */
  cvScanStatus: string | null;
  /** Server-side magic-byte check of the stored CV (`ok`, `type_mismatch`, `missing`…). */
  cvFileCheck: string | null;
  /** Status of the automatic customer emails (`sent`, `failed`, `ambiguous`, `sending`). */
  emails: { intro: string | null; reminder: string | null; submitted: string | null };
  /** Every e-mail the candidate received, with the delivery, opens and clicks the providers reported. */
  candidateEmails?: AssistedApplicationCandidateEmail[];
  cvUploadedAt: string | null;
  consentVersion: string | null;
  consentedAt: string | null;
  submissionStatus: AssistedApplicationAdminStatus;
  /** Mirror of the automated flow state (null when the flow never started). */
  automationState?: string | null;
  automation?: AssistedApplicationAutomationView | null;
  submissionNotes: string | null;
  submittedAt: string | null;
  blockedAt: string | null;
  refundedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Last self-check of the PDF renderer inside the Cloud Functions
 * (functions/src/assistedApplicationRendererCheck.js): one invented letter and
 * one invented CV rendered with Typst and read back. Not personal.
 */
export interface AssistedApplicationPdfRendererCheck {
  status: 'ok' | 'failed';
  /** What the Remote Config switch said at the check, apart from the status: on `legacy` no document uses Typst. */
  switch: 'typst' | 'legacy';
  /** First line of the synthetic render's error. */
  error: string | null;
  node: string | null;
  /** The function and the revision that ran the check. */
  service: string | null;
  revision: string | null;
  rssMb: number | null;
  /** Epoch milliseconds. */
  checkedAt: number | null;
  failingSince: number | null;
}

export interface AssistedApplicationAdminData {
  orders: AssistedApplicationAdminOrder[];
  /** Null before the first check, or when the stored result could not be read. */
  pdfRenderer: AssistedApplicationPdfRendererCheck | null;
}

/** Minimal Firebase user shape — only getIdToken is needed. */
interface AuthLike {
  getIdToken: () => Promise<string>;
}

interface AdminRequestInit extends Omit<RequestInit, 'headers'> {
  url?: string;
  headers?: Record<string, string>;
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
    refund_in_progress: 'Per questo ordine è già in corso un rimborso.',
    refund_state_changed: 'L’ordine è cambiato durante il rimborso; verifica lo stato prima di riprovare.',
    payment_reference_missing: 'Riferimento Stripe mancante: rimborso non eseguito.',
    already_submitted: 'La candidatura è già stata inviata e non è rimborsabile da questa coda.',
    stripe_refund_failed: 'Stripe non ha completato il rimborso; nessun dato è stato marcato come rimborsato.',
    invalid_cv_file: 'Il file non è un PDF, DOC o DOCX valido (max 5 MB).',
    draft_not_ready: 'La bozza AI non è ancora pronta.',
    changed_meanwhile: 'Il candidato ha cambiato la bozza nel frattempo: ricarica e ripeti la modifica.',
    not_owner_review: 'L’automazione non è in attesa della tua revisione.',
    not_regenerable: 'In questo stato non si può rigenerare la bozza.',
    not_taken_over: 'L’automazione non è sospesa.',
    already_started_or_ineligible: 'Automazione già avviata, oppure ordine senza CV verificato.',
    no_flow: 'L’automazione non è stata avviata per questo ordine.',
    invalid_email: 'Indirizzo email non valido.',
    already_sent: 'Questa candidatura risulta già inviata.',
    submission_unconfirmed: 'Il pulsante d’invio è già stato premuto senza conferma del portale.',
  };
  return messages[code] || `Operazione non riuscita (${code || status}).`;
}

async function requestAdmin(
  user: AuthLike | null | undefined,
  input: AdminRequestInit = {},
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
  // The code travels with the message: the queue reacts to some (submission_unconfirmed).
  if (!response.ok || !data.ok) throw Object.assign(new Error(errorMessage(data.error, response.status)), { code: String(data.error || '') });
  return data as Record<string, unknown>;
}

/** Everything the admin section renders: the queue (newest orders first) and the renderer's last self-check. */
export async function fetchAssistedApplicationAdminData(
  user: AuthLike | null | undefined,
  status?: AssistedApplicationAdminStatus,
): Promise<AssistedApplicationAdminData> {
  const url = new URL(ASSISTED_APPLICATION_ADMIN_ENDPOINT);
  if (status) url.searchParams.set('status', status);
  const data = await requestAdmin(user, { method: 'GET', url: url.toString() });
  return {
    orders: Array.isArray(data.orders) ? data.orders as AssistedApplicationAdminOrder[] : [],
    pdfRenderer: data.pdfRenderer && typeof data.pdfRenderer === 'object' ? data.pdfRenderer as AssistedApplicationPdfRendererCheck : null,
  };
}

/** Fetches all visible queue statuses, newest orders first. */
export async function fetchAssistedApplicationOrders(
  user: AuthLike | null | undefined,
  status?: AssistedApplicationAdminStatus,
): Promise<AssistedApplicationAdminOrder[]> {
  return (await fetchAssistedApplicationAdminData(user, status)).orders;
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


export type AutomationAdminAction =
  | 'automationStart'
  | 'automationApprove'
  | 'automationTakeover'
  | 'automationResume'
  | 'automationRegenerate'
  | 'automationRetrySubmit'
  | 'automationHandoff'
  | 'automationEditDraft'
  | 'automationSetAnswers'
  | 'automationRevealAccount'
  | 'automationFillKit'
  | 'automationMarkClicked'
  | 'automationMarkSubmitted'
  | 'automationVerificationLink';

/** One action of the automated flow (functions/src/assistedApplicationAutomationAdmin.js). */
export async function runAutomationAdminAction(
  user: AuthLike | null | undefined,
  orderId: string,
  action: AutomationAdminAction,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return requestAdmin(user, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, orderId, ...extra }),
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

/** The CV arrived by e-mail: upload it for the customer (type-checked server-side). */
export async function uploadAssistedApplicationCv(
  user: AuthLike | null | undefined,
  orderId: string,
  file: File,
): Promise<void> {
  if (file.size > 5 * 1024 * 1024) throw new Error(errorMessage('invalid_cv_file', 400));
  await requestAdmin(user, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'uploadCv', orderId, fileName: file.name, contentBase64: await fileToBase64(file) }),
  });
}
