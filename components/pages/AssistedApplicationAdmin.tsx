import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Send,
  Shield,
  UserCheck,
} from 'lucide-react';
import { useAuth } from '@/services/authService';
import {
  ASSISTED_APPLICATION_ADMIN_STATUSES,
  fetchAssistedApplicationCandidateView,
  fetchAssistedApplicationAdminData,
  refundAssistedApplication,
  updateAssistedApplicationStatus,
  type AssistedApplicationCandidateView,
  type AssistedApplicationAdminOrder,
  type AssistedApplicationAdminStatus,
  type AssistedApplicationCandidateEmail,
  type AssistedApplicationPdfRendererCheck,
} from '@/services/assistedApplicationAdminService';
import { trackAssistedApplicationEvent } from '@/services/assistedApplicationExperiment';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '@/services/replayPrivacy';
import { NEXT_STEP_GROUP_LABELS, nextStepFor, type NextStep, type NextStepGroup } from '@/services/assistedApplicationNextStep';
import { pdfRendererLine, type PdfRendererTone } from '@/services/assistedApplicationPdfRendererStatus';
import AssistedApplicationAutomationPanel from './AssistedApplicationAutomationPanel';

type QueueFilter = AssistedApplicationAdminStatus | 'all';

const STATUS_LABELS: Record<QueueFilter, string> = {
  all: 'Tutte',
  awaiting_upload: 'In attesa materiali',
  ready_for_manual_submission: 'Pronte',
  in_progress: 'In lavorazione',
  submitted: 'Inviate',
  blocked: 'Bloccate',
  refunded: 'Rimborsate',
};

const STATUS_STYLES: Record<AssistedApplicationAdminStatus, string> = {
  awaiting_upload: 'bg-surface-alt text-subtle border-edge',
  ready_for_manual_submission: 'bg-warning-subtle text-warning border-warning-border',
  in_progress: 'bg-info-subtle text-info border-info-border',
  submitted: 'bg-success-subtle text-success border-success-border',
  blocked: 'bg-danger-subtle text-danger border-danger-border',
  refunded: 'bg-surface-alt text-muted border-edge',
};

const NEXT_STATUS_OPTIONS: Record<AssistedApplicationAdminStatus, Array<{
  status: AssistedApplicationAdminStatus;
  label: string;
}>> = {
  // Materials usually arrive as a reply to Valerie's email, not via the upload page.
  awaiting_upload: [
    { status: 'in_progress', label: 'Materiali ricevuti via email' },
    { status: 'submitted', label: 'Segna come inviata' },
    { status: 'blocked', label: 'Blocca' },
  ],
  ready_for_manual_submission: [
    { status: 'in_progress', label: 'Prendi in carico' },
    { status: 'submitted', label: 'Segna come inviata' },
    { status: 'blocked', label: 'Blocca' },
  ],
  in_progress: [
    { status: 'submitted', label: 'Segna come inviata' },
    { status: 'blocked', label: 'Blocca' },
  ],
  submitted: [],
  blocked: [{ status: 'in_progress', label: 'Riprendi lavorazione' }],
  refunded: [],
};

// Whose move it is (services/assistedApplicationNextStep.ts): the owner's first, then what is
// stuck on a fix, then what only waits.
const NEXT_STEP_ORDER: NextStepGroup[] = ['owner', 'fix', 'candidate', 'robot', 'done'];
const NEXT_STEP_STYLES: Record<NextStepGroup, string> = {
  owner: 'bg-warning-subtle text-warning border-warning-border',
  fix: 'bg-danger-subtle text-danger border-danger-border',
  candidate: 'bg-info-subtle text-info border-info-border',
  robot: 'bg-surface-alt text-subtle border-edge',
  done: 'bg-success-subtle text-success border-success-border',
};

// The renderer's self-check (services/assistedApplicationPdfRendererStatus.ts).
const PDF_RENDERER_STYLES: Record<PdfRendererTone, string> = {
  ok: 'bg-success-subtle text-success border-success-border',
  failed: 'bg-danger-subtle text-danger border-danger-border',
  legacy: 'bg-warning-subtle text-warning border-warning-border',
  unknown: 'bg-surface-alt text-subtle border-edge',
};

const CANDIDATE_PAGE_STATE_LABELS: Record<AssistedApplicationCandidateView['pageState'], string> = {
  pending: 'Pagamento in attesa',
  paid: 'Pagamento confermato',
  submitted: 'Candidatura presa in carico',
  error: 'Pagamento non confermato',
};

const CANDIDATE_PAGE_STATE_STYLES: Record<AssistedApplicationCandidateView['pageState'], string> = {
  pending: 'border-warning-border bg-warning-subtle/60 text-warning',
  paid: 'border-success-border bg-success-subtle text-success',
  submitted: 'border-success-border bg-success-subtle text-success',
  error: 'border-danger-border bg-danger-subtle text-danger',
};

function CandidatePageStateIcon({ state }: { state: AssistedApplicationCandidateView['pageState'] }) {
  if (state === 'error') return <AlertTriangle size={15} aria-hidden="true" />;
  if (state === 'pending') return <Clock3 size={15} aria-hidden="true" />;
  return <CheckCircle2 size={15} aria-hidden="true" />;
}

function candidatePageMessage(view: AssistedApplicationCandidateView): string {
  if (view.pageState === 'pending') {
    return 'La pagina dell’utente mostra che il pagamento è ancora in attesa di conferma.';
  }
  if (view.pageState === 'paid') {
    return 'La pagina dell’utente mostra il modulo per inviare il CV e i dati necessari per l’annuncio.';
  }
  if (view.pageState === 'submitted') {
    return 'La pagina dell’utente mostra che la candidatura è stata presa in carico.';
  }
  return 'La pagina dell’utente mostra che il pagamento non è stato confermato e invita a riprovare dal link dell’annuncio.';
}

function CandidateStatusPreview({ view }: { view: AssistedApplicationCandidateView }) {
  const missing = view.pageState === 'paid'
    ? [!view.hasConsent ? 'mandato specifico' : null, !view.hasCv ? 'CV' : null].filter(Boolean).join(' e ')
    : '';
  return (
    <section
      className="mt-4 rounded-xl border border-accent-border bg-accent-subtle/30 p-4"
      aria-label="Stato visto dal candidato"
      data-testid="assisted-application-candidate-preview"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Vista candidato</p>
          <p className="mt-1 text-sm font-semibold text-strong">Stato attuale della pagina ordine</p>
          <p className="mt-0.5 text-xs text-subtle">{view.jobTitle || 'Annuncio non indicato'}{view.companyName ? ` — ${view.companyName}` : ''}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${CANDIDATE_PAGE_STATE_STYLES[view.pageState]}`}>
          <CandidatePageStateIcon state={view.pageState} />
          {CANDIDATE_PAGE_STATE_LABELS[view.pageState]}
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-body">{candidatePageMessage(view)}</p>
      {missing && <p className="mt-2 text-xs text-subtle">Nel modulo risultano ancora da completare: {missing}.</p>}
      <dl className="mt-3 grid gap-3 border-t border-accent-border pt-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="font-semibold uppercase tracking-wide text-muted">Pagamento</dt>
          <dd className="mt-1 text-body">{view.paymentStatus || '—'}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-wide text-muted">Stato operativo</dt>
          <dd className="mt-1 text-body">{STATUS_LABELS[view.submissionStatus as QueueFilter] || view.submissionStatus || '—'}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-wide text-muted">Ultimo aggiornamento</dt>
          <dd className="mt-1 text-body">{formatDate(view.updatedAt)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-[11px] leading-relaxed text-muted">Lettura generata dal backend in sola lettura; non apre né modifica il CV o la candidatura.</p>
    </section>
  );
}

function NextStepIcon({ group }: { group: NextStepGroup }) {
  if (group === 'done') return <CheckCircle2 size={13} aria-hidden="true" />;
  if (group === 'fix') return <AlertTriangle size={13} aria-hidden="true" />;
  if (group === 'owner') return <UserCheck size={13} aria-hidden="true" />;
  if (group === 'robot') return <Loader2 size={13} aria-hidden="true" />;
  return <Clock3 size={13} aria-hidden="true" />;
}

function NextStepBadge({ step }: { step: NextStep }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${NEXT_STEP_STYLES[step.group]}`}>
      <NextStepIcon group={step.group} />
      {step.label}
    </span>
  );
}

// An ISO string, or epoch milliseconds (the renderer's self-check).
function formatDate(value: string | number | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

function paymentLabel(order: AssistedApplicationAdminOrder): string {
  if (order.amountTotal === null) return order.paymentStatus || '—';
  try {
    return (order.amountTotal / 100).toLocaleString('it-IT', {
      style: 'currency',
      currency: order.currency || 'EUR',
    });
  } catch {
    return `${order.amountTotal} ${order.currency || 'EUR'}`;
  }
}

function orderEventContext(order: AssistedApplicationAdminOrder) {
  return {
    variant: order.experimentVariant === 'assisted_application'
      ? 'assisted_application' as const
      : order.experimentVariant === 'offerwall_fallback' ? 'rewarded_ad' as const : 'control' as const,
    jobId: order.jobId || 'unknown',
    companyId: order.companyId || order.companyName || 'unknown',
  };
}

function StatusBadge({ status }: { status: AssistedApplicationAdminStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[status]}`}>
      {status === 'submitted' ? <CheckCircle2 size={13} aria-hidden="true" /> : status === 'blocked' ? <AlertTriangle size={13} aria-hidden="true" /> : <Clock3 size={13} aria-hidden="true" />}
      {STATUS_LABELS[status]}
    </span>
  );
}

const EMAIL_STATUS_LABELS: Record<string, string> = {
  sent: 'inviata',
  sending: 'in invio',
  failed: 'non riuscita (ritento)',
  ambiguous: 'esito incerto',
};

function emailStatusLabel(status: string | null): string {
  return status ? EMAIL_STATUS_LABELS[status] || status : 'non inviata';
}

const CANDIDATE_EMAIL_LABELS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^customer_intro$/, () => 'Benvenuto'],
  [/^customer_materials_received$/, () => 'CV ricevuto'],
  [/^customer_materials_reminder$/, () => 'Promemoria 48 h'],
  [/^customer_submitted$/, () => 'Conferma invio'],
  [/^auto_candidate_review_r(\d+)(_held)?$/, (m) => `Revisione della bozza, round ${m[1]}${m[2] ? ' (con domande)' : ''}`],
  [/^auto_candidate_reminder_r(\d+)$/, (m) => `Promemoria revisione, round ${m[1]}`],
  [/^auto_candidate_action_\d+$/, () => 'Serve una risposta del candidato'],
  [/^auto_candidate_handoff$/, () => 'Invio dal portale affidato al candidato'],
  [/^auto_candidate_handoff_reminder$/, () => 'Promemoria invio dal portale'],
  [/^auto_candidate_posting_closed$/, () => 'Annuncio chiuso e rimborso'],
  [/^followup_review_(\d+)$/, (m) => `Follow-up ${m[1]} da rivedere`],
  [/^interview_prep$/, () => 'Preparazione al colloquio'],
  [/^employer_message_forward$/, () => 'Risposta del datore inoltrata'],
];

function candidateEmailLabel(key: string): string {
  for (const [pattern, label] of CANDIDATE_EMAIL_LABELS) {
    const match = key.match(pattern);
    if (match) return label(match);
  }
  return key;
}

/** Delivery, opens and clicks of each e-mail the candidate received. */
function CandidateEmails({ emails }: { emails: AssistedApplicationCandidateEmail[] }) {
  if (!emails.length) return <span className="block text-xs text-subtle">Nessuna email al candidato finora</span>;
  return (
    <ul className="space-y-1.5">
      {emails.map((email) => {
        const facts = [
          email.sentAt ? `inviata ${formatDate(email.sentAt)}` : null,
          email.delivered ? 'consegnata' : null,
          email.opens ? `aperta ${email.opens}× (prima ${formatDate(email.firstOpenAt)})` : 'non ancora aperta',
          email.clicks ? `${email.clicks} clic (ultimo ${formatDate(email.lastClickAt)})` : null,
          email.bounces ? 'rimbalzata' : null,
          email.complaints ? 'segnalata come spam' : null,
        ].filter(Boolean);
        return (
          <li key={email.key} className="text-xs">
            <span className="font-semibold text-strong">{candidateEmailLabel(email.key)}</span>
            <span className={`block ${email.bounces || email.complaints ? 'text-danger' : email.opens ? 'text-success' : 'text-subtle'}`}>{facts.join(' · ')}</span>
            {email.lastClickUrl && <span className="block truncate text-subtle" title={email.lastClickUrl}>{email.lastClickUrl}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function CvLink({ order }: { order: AssistedApplicationAdminOrder }) {
  if (!order.hasCv) {
    return <span className="mt-1 block text-xs text-subtle">CV non ancora ricevuto sul sito (può arrivare via email)</span>;
  }
  if (!order.cvUrl) {
    const reason = order.cvFileCheck && order.cvFileCheck !== 'ok'
      ? 'il file caricato non è un PDF/DOC/DOCX valido'
      : `verifica antivirus: ${order.cvScanStatus || 'non disponibile'}`;
    return <span className="mt-1 block text-xs text-danger">CV non apribile: {reason}. Chiedilo via email.</span>;
  }
  return (
    <>
      <a className="mt-1 inline-flex items-center gap-1 text-link hover:underline" href={order.cvUrl} target="_blank" rel="noreferrer"><FileText size={13} aria-hidden="true" /> Apri CV</a>
      {order.cvScanStatus !== 'clean' && (
        <span className="mt-1 block text-xs text-warning">
          Non scansionato{order.cvFileCheck === 'ok' ? ' · formato verificato' : ''}: aprilo come un allegato email.
        </span>
      )}
    </>
  );
}

function DataRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-body">{children}</dd>
    </div>
  );
}

export default function AssistedApplicationAdmin() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<AssistedApplicationAdminOrder[]>([]);
  // undefined until the queue has loaded once: nothing is said about the renderer before.
  const [pdfRenderer, setPdfRenderer] = useState<AssistedApplicationPdfRendererCheck | null | undefined>(undefined);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [stepFilter, setStepFilter] = useState<NextStepGroup | 'all'>('all');
  const [notesByOrder, setNotesByOrder] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [candidatePreview, setCandidatePreview] = useState<AssistedApplicationCandidateView | null>(null);
  const [candidatePreviewLoading, setCandidatePreviewLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadOrders = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setMessage(null);
    setCandidatePreview(null);
    try {
      const data = await fetchAssistedApplicationAdminData(user);
      setOrders(data.orders);
      setPdfRenderer(data.pdfRenderer);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Impossibile caricare la coda candidature.' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const toggleCandidatePreview = async (order: AssistedApplicationAdminOrder) => {
    if (candidatePreview?.orderId === order.orderId) {
      setCandidatePreview(null);
      return;
    }
    if (candidatePreviewLoading || pendingAction) return;
    setCandidatePreview(null);
    setCandidatePreviewLoading(order.orderId);
    setMessage(null);
    try {
      setCandidatePreview(await fetchAssistedApplicationCandidateView(user, order.orderId));
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Impossibile leggere lo stato visto dal candidato.' });
    } finally {
      setCandidatePreviewLoading(null);
    }
  };

  useEffect(() => {
    void loadOrders();
    // The queue is loaded once when its admin section is mounted; the explicit
    // refresh button handles later reads without refetching on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const result: Record<AssistedApplicationAdminStatus, number> = {
      awaiting_upload: 0,
      ready_for_manual_submission: 0,
      in_progress: 0,
      submitted: 0,
      blocked: 0,
      refunded: 0,
    };
    orders.forEach((order) => { result[order.submissionStatus] += 1; });
    return result;
  }, [orders]);

  // The next move of each order, and how many orders wait on each side.
  const steps = useMemo(() => new Map(orders.map((order) => [order.orderId, nextStepFor(order)])), [orders]);
  const stepCounts = useMemo(() => {
    const result: Record<NextStepGroup, number> = { owner: 0, fix: 0, candidate: 0, robot: 0, done: 0 };
    steps.forEach((step) => { result[step.group] += 1; });
    return result;
  }, [steps]);
  const groupOf = (order: AssistedApplicationAdminOrder): NextStepGroup => steps.get(order.orderId)?.group || 'owner';

  // What needs the owner comes first; within a group the queue's own order is kept.
  const visibleOrders = orders
    .filter((order) => filter === 'all' || order.submissionStatus === filter)
    .filter((order) => stepFilter === 'all' || groupOf(order) === stepFilter)
    .map((order, index) => ({ order, index }))
    .sort((a, b) => NEXT_STEP_ORDER.indexOf(groupOf(a.order)) - NEXT_STEP_ORDER.indexOf(groupOf(b.order)) || a.index - b.index)
    .map(({ order }) => order);

  const rendererLine = pdfRenderer === undefined ? null : pdfRendererLine(pdfRenderer, Date.now(), formatDate);

  const transition = async (
    order: AssistedApplicationAdminOrder,
    nextStatus: AssistedApplicationAdminStatus,
  ) => {
    const notes = (notesByOrder[order.orderId] || '').trim();
    if (nextStatus === 'blocked' && !notes) {
      setMessage({ ok: false, text: 'Inserisci una motivazione prima di bloccare la candidatura.' });
      return;
    }
    const actionKey = `${order.orderId}:${nextStatus}`;
    if (pendingAction) return;
    setPendingAction(actionKey);
    setMessage(null);
    try {
      await updateAssistedApplicationStatus(user, order.orderId, nextStatus, notes);
      const eventName = nextStatus === 'submitted'
        ? 'manual_submission_completed'
        : nextStatus === 'blocked'
          ? 'manual_submission_blocked'
          : null;
      if (eventName) trackAssistedApplicationEvent(eventName, orderEventContext(order));
      setMessage({ ok: true, text: `Stato aggiornato: ${STATUS_LABELS[nextStatus]}.` });
      await loadOrders(true);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Aggiornamento non riuscito.' });
    } finally {
      setPendingAction(null);
    }
  };

  const refund = async (order: AssistedApplicationAdminOrder) => {
    if (pendingAction) return;
    if (typeof window !== 'undefined' && !window.confirm(`Avviare il rimborso di ${paymentLabel(order)} per ${order.applicantName || 'questa candidatura'}?`)) return;
    const actionKey = `${order.orderId}:refund`;
    setPendingAction(actionKey);
    setMessage(null);
    try {
      await refundAssistedApplication(user, order.orderId, (notesByOrder[order.orderId] || '').trim());
      trackAssistedApplicationEvent('refund_issued', orderEventContext(order));
      setMessage({ ok: true, text: 'Rimborso avviato e ordine marcato come rimborsato.' });
      await loadOrders(true);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Rimborso non riuscito.' });
    } finally {
      setPendingAction(null);
    }
  };

  // Every candidate's data, the automation panel included: never in a session replay.
  return (
    <section className={`${REPLAY_PRIVATE_CLASS} space-y-5`} {...REPLAY_PRIVATE_ATTRS} aria-labelledby="assisted-application-admin-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="assisted-application-admin-title" className="flex items-center gap-2 text-lg font-bold font-display text-strong">
            <UserCheck size={20} className="text-accent" aria-hidden="true" />
            Coda candidature assistite
          </h2>
          <p className="mt-1 text-sm text-muted">Tutti gli ordini pagati: i materiali arrivano dalla pagina dell’ordine o come risposta all’email di Valerie.</p>
        </div>
        <button
          type="button"
          onClick={() => { void loadOrders(true); }}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm font-medium text-subtle transition-colors hover:border-accent hover:text-link disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          Aggiorna
        </button>
      </div>

      {rendererLine && (
        <p className={`rounded-xl border px-3 py-2 text-xs ${PDF_RENDERER_STYLES[rendererLine.tone]}`} title={pdfRenderer?.error || undefined}>
          {rendererLine.text}
        </p>
      )}

      {message && (
        <div role="status" className={`rounded-xl border px-4 py-3 text-sm ${message.ok ? 'border-success-border bg-success-subtle text-success' : 'border-danger-border bg-danger-subtle text-danger'}`}>
          {message.text}
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto border-b border-edge pb-1" role="tablist" aria-label="Filtra stati candidature">
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'all'}
          onClick={() => setFilter('all')}
          className={`shrink-0 rounded-t-lg px-3 py-2 text-sm font-medium ${filter === 'all' ? 'border border-b-0 border-edge bg-surface text-accent' : 'text-muted hover:text-body'}`}
        >
          Tutte <span className="ml-1 text-xs">({orders.length})</span>
        </button>
        {ASSISTED_APPLICATION_ADMIN_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            role="tab"
            aria-selected={filter === status}
            onClick={() => setFilter(status)}
            className={`shrink-0 rounded-t-lg px-3 py-2 text-sm font-medium ${filter === status ? 'border border-b-0 border-edge bg-surface text-accent' : 'text-muted hover:text-body'}`}
          >
            {STATUS_LABELS[status]} <span className="ml-1 text-xs">({counts[status]})</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtra per prossima mossa">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Prossima mossa</span>
        <button
          type="button"
          aria-pressed={stepFilter === 'all'}
          onClick={() => setStepFilter('all')}
          className={`min-h-[36px] rounded-full border px-3 text-xs font-semibold ${stepFilter === 'all' ? 'border-accent bg-accent-subtle text-accent' : 'border-edge text-subtle hover:text-body'}`}
        >
          Tutte ({orders.length})
        </button>
        {NEXT_STEP_ORDER.map((group) => (
          <button
            key={group}
            type="button"
            aria-pressed={stepFilter === group}
            onClick={() => setStepFilter(stepFilter === group ? 'all' : group)}
            className={`inline-flex min-h-[36px] items-center gap-1 rounded-full border px-3 text-xs font-semibold ${stepFilter === group ? NEXT_STEP_STYLES[group] : 'border-edge text-subtle hover:text-body'}`}
          >
            <NextStepIcon group={group} />
            {NEXT_STEP_GROUP_LABELS[group]} ({stepCounts[group]})
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-edge bg-surface p-6 text-sm text-subtle" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Caricamento coda candidature…
        </div>
      ) : visibleOrders.length === 0 ? (
        <div className="rounded-xl border border-edge bg-surface p-6 text-sm text-subtle">
          Nessuna candidatura nello stato selezionato.
        </div>
      ) : (
        <div className="space-y-4">
          {visibleOrders.map((order) => {
            const options = NEXT_STATUS_OPTIONS[order.submissionStatus];
            const step = steps.get(order.orderId) || nextStepFor(order);
            return (
              <article key={order.orderId} className="rounded-2xl border border-edge bg-surface p-4 shadow-sm sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">{order.companyName || 'Azienda non indicata'}</p>
                    <h3 className="mt-1 text-base font-bold text-strong">{order.jobTitle || order.jobId || 'Annuncio non indicato'}</h3>
                    <p className="mt-1 text-xs text-muted">Ordine {order.orderId} · creato {formatDate(order.createdAt)}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <NextStepBadge step={step} />
                    <StatusBadge status={order.submissionStatus} />
                  </div>
                </div>

                <p className={`mt-3 rounded-xl border px-3 py-2 text-sm ${NEXT_STEP_STYLES[step.group]}`}>
                  <strong>{NEXT_STEP_GROUP_LABELS[step.group]}.</strong> <span className="text-body">{step.detail}</span>
                </p>

                <dl className="mt-4 grid gap-4 border-t border-edge pt-4 sm:grid-cols-2 lg:grid-cols-5">
                  <DataRow label="Candidato">
                    <span className="font-semibold text-strong">{order.applicantName || '—'}</span>
                    {(order.applicantEmail || order.customerEmail) && <a className="mt-0.5 block text-link hover:underline" href={`mailto:${order.applicantEmail || order.customerEmail}`}>{order.applicantEmail || order.customerEmail}</a>}
                    {order.applicantPhone && <span className="mt-0.5 block text-subtle">{order.applicantPhone}</span>}
                  </DataRow>
                  <DataRow label="Annuncio">
                    <div className="flex flex-col items-start gap-1">
                      {order.jobUrl ? <a className="inline-flex items-center gap-1 text-link hover:underline" href={order.jobUrl} target="_blank" rel="noreferrer">Apri annuncio <ExternalLink size={12} aria-hidden="true" /></a> : order.jobId || '—'}
                      <button
                        type="button"
                        onClick={() => { void toggleCandidatePreview(order); }}
                        disabled={Boolean(pendingAction) || Boolean(candidatePreviewLoading)}
                        aria-expanded={candidatePreview?.orderId === order.orderId}
                        className="inline-flex items-center gap-1 text-left text-link hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                        data-testid={`assisted-application-candidate-preview-link-${order.orderId}`}
                      >
                        {candidatePreviewLoading === order.orderId && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                        {candidatePreview?.orderId === order.orderId ? 'Nascondi stato candidato' : 'Vedi stato candidato'}
                      </button>
                    </div>
                  </DataRow>
                  <DataRow label="Pagamento">
                    <span className="font-semibold text-strong">{paymentLabel(order)}</span>
                    <span className="mt-0.5 block text-xs text-subtle">{order.paymentStatus || '—'} · {formatDate(order.paidAt)}</span>
                  </DataRow>
                  <DataRow label="Mandato e CV">
                    <span className={order.consentVersion && order.consentedAt ? 'text-success' : 'text-danger'}>
                      {order.consentVersion && order.consentedAt ? `Consenso ${formatDate(order.consentedAt)}` : 'Consenso non disponibile'}
                    </span>
                    <CvLink order={order} />
                  </DataRow>
                  <DataRow label="Email automatiche">
                    <span className="block text-xs text-subtle">Benvenuto: {emailStatusLabel(order.emails?.intro ?? null)}</span>
                    <span className="block text-xs text-subtle">Promemoria 48 h: {emailStatusLabel(order.emails?.reminder ?? null)}</span>
                    <span className="block text-xs text-subtle">Conferma invio: {emailStatusLabel(order.emails?.submitted ?? null)}</span>
                  </DataRow>
                  <DataRow label="Aperture e clic del candidato">
                    <CandidateEmails emails={order.candidateEmails || []} />
                    <span className="mt-1 block text-[11px] text-muted">Le aperture sono indicative: alcuni client aprono ogni email alla consegna.</span>
                  </DataRow>
                </dl>

                {candidatePreview?.orderId === order.orderId && <CandidateStatusPreview view={candidatePreview} />}

                {order.submissionStatus !== 'refunded' && (
                  <AssistedApplicationAutomationPanel
                    order={order}
                    user={user}
                    onChanged={async (next) => {
                      setMessage(next);
                      await loadOrders(true);
                      setMessage(next);
                    }}
                  />
                )}

                {order.submissionNotes && (
                  <div className="mt-4 rounded-xl border border-warning-border bg-warning-subtle/60 px-3 py-2 text-sm text-body">
                    <strong>Nota operativa:</strong> {order.submissionNotes}
                  </div>
                )}

                {options.length > 0 && (
                  <div className="mt-4 space-y-3 border-t border-edge pt-4">
                    <label className="block text-sm font-medium text-body">
                      Nota audit (obbligatoria per bloccare)
                      <textarea
                        value={notesByOrder[order.orderId] || ''}
                        onChange={(event) => setNotesByOrder((current) => ({ ...current, [order.orderId]: event.target.value }))}
                        rows={2}
                        maxLength={2000}
                        className="mt-1 w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-sm text-strong"
                        placeholder="Es. CAPTCHA obbligatorio, annuncio ritirato…"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {options.map((option) => {
                        const actionKey = `${order.orderId}:${option.status}`;
                        return (
                          <button
                            key={option.status}
                            type="button"
                            onClick={() => { void transition(order, option.status); }}
                            disabled={pendingAction !== null}
                            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${option.status === 'blocked' ? 'border border-danger-border text-danger hover:bg-danger-subtle' : 'bg-accent text-on-accent hover:bg-accent-hover'}`}
                          >
                            {pendingAction === actionKey && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                            {option.status === 'submitted' ? <Send size={14} aria-hidden="true" /> : option.status === 'in_progress' ? <UserCheck size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
                            {option.label}
                          </button>
                        );
                      })}
                      {order.submissionStatus !== 'submitted' && order.submissionStatus !== 'refunded' && (
                        <button
                          type="button"
                          onClick={() => { void refund(order); }}
                          disabled={pendingAction !== null}
                          className="inline-flex items-center gap-2 rounded-lg border border-danger-border px-3 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger-subtle disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {pendingAction === `${order.orderId}:refund` ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
                          Avvia rimborso
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
        <Shield size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        Dati e CV sono visibili solo all’account owner verificato. Il link al CV è firmato dal server e non viene mai letto direttamente dal browser tramite Storage.
      </p>
    </section>
  );
}
