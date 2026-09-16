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
  fetchAssistedApplicationOrders,
  refundAssistedApplication,
  updateAssistedApplicationStatus,
  type AssistedApplicationAdminOrder,
  type AssistedApplicationAdminStatus,
} from '@/services/assistedApplicationAdminService';
import { trackAssistedApplicationEvent } from '@/services/assistedApplicationExperiment';

type QueueFilter = AssistedApplicationAdminStatus | 'all';

const STATUS_LABELS: Record<QueueFilter, string> = {
  all: 'Tutte',
  ready_for_manual_submission: 'Pronte',
  in_progress: 'In lavorazione',
  submitted: 'Inviate',
  blocked: 'Bloccate',
  refunded: 'Rimborsate',
};

const STATUS_STYLES: Record<AssistedApplicationAdminStatus, string> = {
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

function formatDate(value: string | null): string {
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
    variant: order.experimentVariant === 'assisted_application' ? 'assisted_application' as const : 'control' as const,
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
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [notesByOrder, setNotesByOrder] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadOrders = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setMessage(null);
    try {
      setOrders(await fetchAssistedApplicationOrders(user));
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Impossibile caricare la coda candidature.' });
    } finally {
      setLoading(false);
      setRefreshing(false);
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
      ready_for_manual_submission: 0,
      in_progress: 0,
      submitted: 0,
      blocked: 0,
      refunded: 0,
    };
    orders.forEach((order) => { result[order.submissionStatus] += 1; });
    return result;
  }, [orders]);

  const visibleOrders = filter === 'all'
    ? orders
    : orders.filter((order) => order.submissionStatus === filter);

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

  return (
    <section className="space-y-5" aria-labelledby="assisted-application-admin-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="assisted-application-admin-title" className="flex items-center gap-2 text-lg font-bold font-display text-strong">
            <UserCheck size={20} className="text-accent" aria-hidden="true" />
            Coda candidature assistite
          </h2>
          <p className="mt-1 text-sm text-muted">Ordini pagati con CV e mandato disponibili per la sottomissione manuale.</p>
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
            return (
              <article key={order.orderId} className="rounded-2xl border border-edge bg-surface p-4 shadow-sm sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">{order.companyName || 'Azienda non indicata'}</p>
                    <h3 className="mt-1 text-base font-bold text-strong">{order.jobTitle || order.jobId || 'Annuncio non indicato'}</h3>
                    <p className="mt-1 text-xs text-muted">Ordine {order.orderId} · creato {formatDate(order.createdAt)}</p>
                  </div>
                  <StatusBadge status={order.submissionStatus} />
                </div>

                <dl className="mt-4 grid gap-4 border-t border-edge pt-4 sm:grid-cols-2 lg:grid-cols-4">
                  <DataRow label="Candidato">
                    <span className="font-semibold text-strong">{order.applicantName || '—'}</span>
                    {order.applicantEmail && <a className="mt-0.5 block text-link hover:underline" href={`mailto:${order.applicantEmail}`}>{order.applicantEmail}</a>}
                    {order.applicantPhone && <span className="mt-0.5 block text-subtle">{order.applicantPhone}</span>}
                  </DataRow>
                  <DataRow label="Annuncio">
                    {order.jobUrl ? <a className="inline-flex items-center gap-1 text-link hover:underline" href={order.jobUrl} target="_blank" rel="noreferrer">Apri annuncio <ExternalLink size={12} aria-hidden="true" /></a> : order.jobId || '—'}
                  </DataRow>
                  <DataRow label="Pagamento">
                    <span className="font-semibold text-strong">{paymentLabel(order)}</span>
                    <span className="mt-0.5 block text-xs text-subtle">{order.paymentStatus || '—'} · {formatDate(order.paidAt)}</span>
                  </DataRow>
                  <DataRow label="Mandato e CV">
                    <span className={order.consentVersion && order.consentedAt ? 'text-success' : 'text-danger'}>
                      {order.consentVersion && order.consentedAt ? `Consenso ${formatDate(order.consentedAt)}` : 'Consenso non disponibile'}
                    </span>
                    {order.cvUrl ? <a className="mt-1 inline-flex items-center gap-1 text-link hover:underline" href={order.cvUrl} target="_blank" rel="noreferrer"><FileText size={13} aria-hidden="true" /> Apri CV</a> : <span className="mt-1 block text-xs text-danger">CV non disponibile</span>}
                  </DataRow>
                </dl>

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
