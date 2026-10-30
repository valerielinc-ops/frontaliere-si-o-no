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
import { normalizeExternalJobDetailUrl } from '@/services/jobApplicationDestination';
import {
  ASSISTED_APPLICATION_ADMIN_STATUSES,
  fetchAssistedApplicationCandidateView,
  fetchAssistedApplicationAdminData,
  refundAssistedApplication,
  updateAssistedApplicationStatus,
  type AssistedApplicationCandidateView,
  type AssistedApplicationAdminOrder,
  type AssistedApplicationAdminStatus,
  type AssistedApplicationPdfRendererCheck,
} from '@/services/assistedApplicationAdminService';
import {
  normalizeAssistedApplicationLayoutVariant,
  trackAssistedApplicationEvent,
} from '@/services/assistedApplicationExperiment';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '@/services/replayPrivacy';
import { NEXT_STEP_GROUP_LABELS, nextStepFor, type NextStep, type NextStepGroup } from '@/services/assistedApplicationNextStep';
import { pdfRendererLine, type PdfRendererTone } from '@/services/assistedApplicationPdfRendererStatus';
import { replaceAdminQuery } from '@/components/admin/lib/adminNavigation';
import { useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';
import CandidateEmails from './AssistedApplicationCandidateEmails';
import ApplicationInbox from './AssistedApplicationInbox';
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
      className="mt-4 rounded-stripe border border-accent-border bg-accent-subtle/30 p-4"
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
      <p className="mt-3 text-xs leading-relaxed text-muted">Lettura generata dal backend in sola lettura; non apre né modifica il CV o la candidatura.</p>
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
  const layoutVariant = normalizeAssistedApplicationLayoutVariant(order.layoutVariant);
  return {
    variant: order.experimentVariant === 'assisted_application'
      ? 'assisted_application' as const
      : order.experimentVariant === 'offerwall_fallback' ? 'rewarded_ad' as const : 'control' as const,
    jobId: order.jobId || 'unknown',
    companyId: order.companyId || order.companyName || 'unknown',
    ...(layoutVariant ? { layout_variant: layoutVariant } : {}),
  };
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

function DataRow({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-body">{children}</dd>
    </div>
  );
}

function readAdminQuery(): URLSearchParams {
  return typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
}

function queueFilterFromQuery(value: string | null): QueueFilter {
  if (value === 'all') return 'all';
  return ASSISTED_APPLICATION_ADMIN_STATUSES.includes(value as AssistedApplicationAdminStatus)
    ? value as AssistedApplicationAdminStatus
    : 'all';
}

function queueFiltersFromQuery() {
  const params = readAdminQuery();
  const action = params.get('azione') as NextStepGroup;
  const step: NextStepGroup | 'all' = NEXT_STEP_ORDER.includes(action) ? action : 'all';
  return { step, status: step === 'all' ? queueFilterFromQuery(params.get('stato')) : 'all' as QueueFilter };
}

export default function AssistedApplicationAdmin({ locationKey, onSummary }: { locationKey?: string; onSummary?: (summary: { count: number; updatedAt: string }) => void }) {
  const { user, loading: authLoading } = useAuth();
  const { requestConfirmation } = useAdminConfirm();
  const [orders, setOrders] = useState<AssistedApplicationAdminOrder[]>([]);
  // undefined until the queue has loaded once: nothing is said about the renderer before.
  const [pdfRenderer, setPdfRenderer] = useState<AssistedApplicationPdfRendererCheck | null | undefined>(undefined);
  const [filter, setFilter] = useState<QueueFilter>(() => queueFiltersFromQuery().status);
  const [stepFilter, setStepFilter] = useState<NextStepGroup | 'all'>(() => queueFiltersFromQuery().step);
  const [notesByOrder, setNotesByOrder] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [candidatePreview, setCandidatePreview] = useState<AssistedApplicationCandidateView | null>(null);
  const [candidatePreviewLoading, setCandidatePreviewLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const selected = queueFiltersFromQuery();
    setFilter(selected.status);
    setStepFilter(selected.step);
  }, [locationKey]);

  const loadOrders = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setMessage(null);
    setCandidatePreview(null);
    try {
      const data = await fetchAssistedApplicationAdminData(user);
      setOrders(data.orders);
      setPdfRenderer(data.pdfRenderer);
      onSummary?.({ count: data.orders.length, updatedAt: new Date().toISOString() });
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
      replaceAdminQuery({ ordine: null });
      return;
    }
    if (candidatePreviewLoading || pendingAction) return;
    setCandidatePreview(null);
    setCandidatePreviewLoading(order.orderId);
    replaceAdminQuery({ ordine: order.orderId });
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
    const orderId = readAdminQuery().get('ordine');
    if (!orderId) {
      if (candidatePreview) setCandidatePreview(null);
      return;
    }
    const order = orders.find((candidate) => candidate.orderId === orderId);
    if (!order || candidatePreview?.orderId === orderId || candidatePreviewLoading) return;
    void toggleCandidatePreview(order);
    // The URL is the source of truth for a deep-linked order; the callback is
    // intentionally invoked only after the queue has loaded the matching row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, locationKey, candidatePreview, candidatePreviewLoading]);

  const selectQueueFilter = (value: string) => {
    const [kind, selected] = value.split(':');
    const step = kind === 'step' ? selected as NextStepGroup : 'all';
    const status = kind === 'status' ? selected as QueueFilter : 'all';
    setStepFilter(step);
    setFilter(status);
    replaceAdminQuery({ azione: step === 'all' ? null : step, stato: status === 'all' ? null : status });
  };

  useEffect(() => {
    // Firebase restores a persisted session asynchronously. Do not make the
    // first admin request with a null user: that turns a valid owner session
    // into a permanent "not authenticated" queue until the page is refreshed.
    if (authLoading) return;
    void loadOrders();
    // The explicit refresh button handles later reads without refetching on
    // every render; user is included so the restored owner session is used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

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
    const confirmed = await requestConfirmation({
      title: 'Avvia rimborso',
      what: `Stai per avviare il rimborso di ${paymentLabel(order)} per ${order.applicantName || 'questa candidatura'}.`,
      impact: 'Modifica il pagamento e marca l’ordine come rimborsato; l’automazione si ferma.',
      input: `ordine=${order.orderId}, importo=${paymentLabel(order)}`,
      expectedDuration: 'meno di 1 min',
      confirmLabel: 'Avvia rimborso',
      confirmVariant: 'danger',
    });
    if (!confirmed) return;
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
          <h2 id="assisted-application-admin-title" className="flex items-center gap-2 text-lg font-semibold font-display text-strong">
            <UserCheck size={20} className="text-accent" aria-hidden="true" />
            Coda candidature assistite
          </h2>
          <p className="mt-1 text-sm text-muted">Tutti gli ordini pagati: i materiali arrivano dalla pagina dell’ordine o come risposta all’email di Valerie.</p>
        </div>
        <button
          type="button"
          onClick={() => { void loadOrders(true); }}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 rounded-stripe border border-edge px-3 py-2 text-sm font-medium text-subtle transition-colors hover:border-accent hover:text-link disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          Aggiorna
        </button>
      </div>

      {rendererLine && rendererLine.tone !== 'ok' && (
        <p className={`rounded-stripe border px-3 py-2 text-xs ${PDF_RENDERER_STYLES[rendererLine.tone]}`} title={pdfRenderer?.error || undefined}>
          {rendererLine.text}
        </p>
      )}

      {message && (
        <div role="status" className={`rounded-stripe border px-4 py-3 text-sm ${message.ok ? 'border-success-border bg-success-subtle text-success' : 'border-danger-border bg-danger-subtle text-danger'}`}>
          {message.text}
        </div>
      )}

      <label className="flex flex-wrap items-center gap-3 text-sm font-medium text-body">
        Mostra candidature
        <select
          aria-label="Mostra candidature"
          value={stepFilter !== 'all' ? `step:${stepFilter}` : filter !== 'all' ? `status:${filter}` : 'all'}
          onChange={(event) => selectQueueFilter(event.target.value)}
          className="min-h-11 max-w-full rounded-stripe border border-edge bg-surface px-3 py-2 text-sm text-strong"
        >
          <option value="all">Tutte ({orders.length})</option>
          <optgroup label="Chi deve agire">
            {NEXT_STEP_ORDER.map((group) => <option key={group} value={`step:${group}`}>{NEXT_STEP_GROUP_LABELS[group]} ({stepCounts[group]})</option>)}
          </optgroup>
          <optgroup label="Stato della candidatura">
            {ASSISTED_APPLICATION_ADMIN_STATUSES.map((status) => <option key={status} value={`status:${status}`}>{STATUS_LABELS[status]} ({counts[status]})</option>)}
          </optgroup>
        </select>
        <span className="text-xs text-subtle">{visibleOrders.length} {visibleOrders.length === 1 ? 'risultato' : 'risultati'} · prima le candidature che richiedono attenzione</span>
      </label>

      {loading ? (
        <div className="flex items-center gap-2 rounded-stripe border border-edge bg-surface p-6 text-sm text-subtle" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Caricamento coda candidature…
        </div>
      ) : visibleOrders.length === 0 ? (
        <div className="rounded-stripe border border-edge bg-surface p-6 text-sm text-subtle">
          Nessuna candidatura nello stato selezionato.
        </div>
      ) : (
        <div className="space-y-4">
          {visibleOrders.map((order) => {
            const options = NEXT_STATUS_OPTIONS[order.submissionStatus];
            const step = steps.get(order.orderId) || nextStepFor(order);
            return (
              <article key={order.orderId} className="rounded-stripe border border-edge bg-surface p-4 shadow-stripe-sm sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="mt-1 text-base font-semibold text-strong">{order.jobTitle || order.jobId || 'Annuncio non indicato'}</h3>
                    <p className="mt-1 text-sm text-subtle">{order.companyName || 'Azienda non indicata'}</p>
                    <p className="mt-1 text-xs text-muted">Ordine {order.orderId} · creato {formatDate(order.createdAt)}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <NextStepBadge step={step} />
                  </div>
                </div>

                <p className={`mt-3 rounded-stripe border px-3 py-2 text-sm ${NEXT_STEP_STYLES[step.group]}`}>
                  <strong>{NEXT_STEP_GROUP_LABELS[step.group]}.</strong> <span className="text-body">{step.detail}</span>
                </p>

                <dl className="mt-4 grid gap-4 border-t border-edge pt-4 sm:grid-cols-2 lg:grid-cols-4">
                  <DataRow label="Candidato">
                    <span className="font-semibold text-strong">{order.applicantName || '—'}</span>
                    {(order.applicantEmail || order.customerEmail) && <a className="mt-0.5 block text-link hover:underline" href={`mailto:${order.applicantEmail || order.customerEmail}`}>{order.applicantEmail || order.customerEmail}</a>}
                    {order.applicantPhone && <span className="mt-0.5 block text-subtle">{order.applicantPhone}</span>}
                  </DataRow>
                  <DataRow label="Annuncio">
                    <div className="flex flex-col items-start gap-1">
                      {order.jobUrl ? <a className="inline-flex items-center gap-1 text-link hover:underline" href={normalizeExternalJobDetailUrl(order.jobUrl)} target="_blank" rel="noreferrer">Apri annuncio <ExternalLink size={12} aria-hidden="true" /></a> : order.jobId || '—'}
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
                  <DataRow label="Email al candidato" className="sm:col-span-2 lg:col-span-4">
                    <CandidateEmails emails={order.candidateEmails || []} />
                  </DataRow>
                </dl>

                <ApplicationInbox automation={order.automation} />

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
                  <div className="mt-4 rounded-stripe border border-warning-border bg-warning-subtle/60 px-3 py-2 text-sm text-body">
                    <strong>Nota operativa:</strong> {order.submissionNotes}
                  </div>
                )}

                {options.length > 0 && (
                  <details className="mt-4 border-t border-edge pt-4">
                    <summary className="cursor-pointer text-sm font-semibold text-subtle">Gestione manuale e rimborso</summary>
                    <div className="mt-3 space-y-3">
                    <label className="block text-sm font-medium text-body">
                      Nota audit (obbligatoria per bloccare)
                      <textarea
                        value={notesByOrder[order.orderId] || ''}
                        onChange={(event) => setNotesByOrder((current) => ({ ...current, [order.orderId]: event.target.value }))}
                        rows={2}
                        maxLength={2000}
                        className="mt-1 w-full rounded-stripe border border-edge bg-surface-alt px-3 py-2 text-sm text-strong"
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
                            className={`inline-flex items-center gap-2 rounded-stripe px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${option.status === 'blocked' ? 'border border-danger-border text-danger hover:bg-danger-subtle' : 'bg-accent text-on-accent hover:bg-accent-hover'}`}
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
                          className="inline-flex items-center gap-2 rounded-stripe border border-danger-border px-3 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger-subtle disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {pendingAction === `${order.orderId}:refund` ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
                          Avvia rimborso
                        </button>
                      )}
                    </div>
                    </div>
                  </details>
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
