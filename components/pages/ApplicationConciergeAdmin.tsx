import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, Eye, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '@/services/authService';
import {
  createApplicationConciergeProposal,
  fetchApplicationConciergeAdminData,
  type ApplicationConciergeService,
} from '@/services/applicationConciergeService';
import {
  fetchApplicationConciergeAssistedOrders,
  type AssistedApplicationAdminOrder,
} from '@/services/assistedApplicationAdminService';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '@/services/replayPrivacy';
import { useAdminNavigation } from '@/components/admin/lib/AdminNavigationContext';
import { replaceAdminQuery } from '@/components/admin/lib/adminNavigation';
import { nextStepFor } from '@/services/assistedApplicationNextStep';
import CandidateEmails from './AssistedApplicationCandidateEmails';
import ApplicationInbox from './AssistedApplicationInbox';
import AssistedApplicationAutomationPanel from './AssistedApplicationAutomationPanel';

const CandidatePortal = lazy(() => import('@/components/community/ApplicationConciergePortal'));
const SERVICE_LABELS: Record<string, string> = { active: 'Attivo', awaiting_payment: 'In attesa di pagamento', payment_failed: 'Pagamento non riuscito', expired: 'Scaduto', refunded: 'Rimborsato' };
const PAYMENT_LABELS: Record<string, string> = { paid: 'Confermato', pending: 'In attesa', failed: 'Non riuscito', refunded: 'Rimborsato' };
const PROPOSAL_LABELS: Record<string, string> = { proposed: 'In attesa del candidato', accepted: 'Accettata', declined: 'Rifiutata', expired: 'Scaduta', retracted: 'Ritirata' };
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString('it-CH') : '—';

const EMPTY_FORM = { serviceId: '', jobId: '', jobUrl: '', companyId: '', companyName: '', jobTitle: '', location: '', applyMode: '' };

export default function ApplicationConciergeAdmin() {
  const { user } = useAuth();
  const { locationKey } = useAdminNavigation();
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.search).get('servizio') || '');
  const [preview, setPreview] = useState(() => new URLSearchParams(window.location.search).get('vista') === 'candidato');
  const [filter, setFilter] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('stato');
    return value && SERVICE_LABELS[value] ? value : 'all';
  });
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('q') || '');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSelectedId(params.get('servizio') || '');
    setPreview(params.get('vista') === 'candidato');
  }, [locationKey]);
  const [services, setServices] = useState<ApplicationConciergeService[]>([]);
  const [orders, setOrders] = useState<AssistedApplicationAdminOrder[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [data, conciergeOrders] = await Promise.all([
        fetchApplicationConciergeAdminData(user),
        fetchApplicationConciergeAssistedOrders(user),
      ]);
      setServices(data.services);
      setOrders(conciergeOrders);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Impossibile caricare i servizi concierge.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [user]);

  const selected = services.find((service) => service.serviceId === selectedId) || null;
  const select = (serviceId: string) => {
    setSelectedId(serviceId);
    setPreview(false);
    setForm({ ...EMPTY_FORM, serviceId });
    replaceAdminQuery({ servizio: serviceId || null, vista: null, stato: filter === 'all' ? null : filter, q: search || null });
  };
  const groups = useMemo(() => {
    const byUser = new Map<string, ApplicationConciergeService[]>();
    for (const service of services) {
      const key = service.userId || service.customerEmail || service.applicantEmail || service.serviceId;
      byUser.set(key, [...(byUser.get(key) || []), service]);
    }
    return [...byUser.values()];
  }, [services]);
  const selectedUserServices = groups.find((group) => group.some((service) => service.serviceId === selectedId)) || [];
  const visibleUsers = groups.map((group) => group.filter((service) => filter === 'all' || service.serviceStatus === filter))
    .filter((group) => group.length && group.some((service) => `${service.applicantName || ''} ${service.applicantEmail || ''} ${service.customerEmail || ''}`.toLowerCase().includes(search.toLowerCase())));
  const selectedOrders = orders.filter((order) => order.parentServiceId === selectedId);
  useEffect(() => { setForm({ ...EMPTY_FORM, serviceId: selectedId }); }, [selectedId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || !form.serviceId) return;
    setBusy(true);
    setMessage(null);
    try {
      const updated = await createApplicationConciergeProposal(user, form);
      setServices((current) => current.map((service) => service.serviceId === updated.serviceId ? updated : service));
      setForm((current) => ({ ...EMPTY_FORM, serviceId: current.serviceId }));
      setMessage('Proposta aggiunta: resta in attesa dell’accettazione del candidato.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Proposta non aggiunta.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${REPLAY_PRIVATE_CLASS} space-y-6`} {...REPLAY_PRIVATE_ATTRS} aria-labelledby="application-concierge-admin-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="application-concierge-admin-title" className="font-display text-2xl font-semibold text-heading">Servizio candidature — 30 giorni</h1>
          <p className="mt-2 max-w-prose text-sm text-subtle">Apri un utente per controllare pagamento, profilo, proposte e candidature accettate.</p>
        </div>
        <button type="button" onClick={() => { void load(); }} disabled={loading} className="inline-flex min-h-11 items-center gap-2 rounded-stripe border border-edge px-3 text-sm font-semibold text-subtle hover:border-accent disabled:opacity-60">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} aria-hidden="true" />Aggiorna
        </button>
      </header>
      {message && <p role="status" className="rounded-stripe border border-info-border bg-info-subtle p-3 text-sm text-info">{message}</p>}
      {loading ? <p role="status" className="flex items-center gap-2 py-8 text-sm text-subtle"><Loader2 size={18} className="animate-spin" aria-hidden="true" />Caricamento utenti…</p> : selected ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge pb-4">
            <button type="button" onClick={() => select('')} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-link hover:underline"><ArrowLeft size={16} aria-hidden="true" />Tutti gli utenti</button>
            <button type="button" aria-pressed={preview} onClick={() => { setPreview(!preview); replaceAdminQuery({ vista: preview ? null : 'candidato' }); }} className="inline-flex min-h-11 items-center gap-2 rounded-stripe border border-edge px-3 text-sm font-semibold text-link hover:border-accent"><Eye size={16} aria-hidden="true" />{preview ? 'Torna alla gestione' : 'Vedi come candidato'}</button>
          </div>
          <div>
            <h2 className="break-words text-xl font-semibold text-heading">{selected.applicantName || selected.customerEmail || 'Candidato senza dati'}</h2>
            <p className="mt-1 text-sm text-subtle">{selected.applicantEmail || selected.customerEmail} {selected.applicantPhone ? ` · ${selected.applicantPhone}` : ''}</p>
            {selectedUserServices.length > 1 && <label className="mt-3 block text-sm text-body">Periodo del servizio
              <select value={selectedId} onChange={(event) => select(event.target.value)} className="ml-2 min-h-11 max-w-full rounded-stripe border border-edge bg-surface px-3 text-sm">
                {selectedUserServices.map((service) => <option key={service.serviceId} value={service.serviceId}>{SERVICE_LABELS[service.serviceStatus] || service.serviceStatus} · {date(service.paidAt)} → {date(service.expiresAt)}</option>)}
              </select>
            </label>}
          </div>
          {preview ? (
            <section aria-label="Anteprima del portale candidato" className="border-t border-edge pt-4">
              <p className="mb-4 rounded-stripe bg-info-subtle p-3 text-sm text-info">Anteprima della pagina del candidato. Pagamenti, modifiche e accettazione delle proposte sono disabilitati.</p>
              <fieldset disabled className="min-w-0" onClickCapture={(event) => { if ((event.target as HTMLElement).closest('a')) event.preventDefault(); }} onSubmitCapture={(event) => event.preventDefault()}>
                <legend className="sr-only">Portale candidato in sola lettura</legend>
                <Suspense fallback={<p role="status">Caricamento anteprima…</p>}><CandidatePortal key={selected.serviceId} serviceId={selected.serviceId} previewService={selected} locationSearch="" /></Suspense>
              </fieldset>
            </section>
          ) : (
            <>
              <dl className="grid gap-4 border-b border-edge pb-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-subtle">Stato servizio</dt><dd className="mt-1 font-semibold text-strong">{SERVICE_LABELS[selected.serviceStatus] || selected.serviceStatus}</dd></div>
                <div><dt className="text-subtle">Pagamento</dt><dd className="mt-1 text-body">{PAYMENT_LABELS[selected.paymentStatus] || selected.paymentStatus}{selected.amountTotal ? ` · ${(selected.amountTotal / 100).toLocaleString('it-CH', { style: 'currency', currency: 'EUR' })}` : ''}</dd></div>
                <div><dt className="text-subtle">Periodo</dt><dd className="mt-1 text-body">{date(selected.paidAt)} → {date(selected.expiresAt)}</dd></div>
                <div><dt className="text-subtle">Posizioni accettate</dt><dd className="mt-1 font-semibold tabular-nums text-strong">{selected.acceptedPositionsCount} / {selected.maxPositions}</dd></div>
                <div><dt className="text-subtle">Profilo e mandato</dt><dd className="mt-1 text-body">CV {selected.hasCv ? 'ricevuto' : 'mancante'} · consenso {selected.hasConsent ? 'ricevuto' : 'mancante'}</dd></div>
                <div><dt className="text-subtle">Località</dt><dd className="mt-1 text-body">{selected.applicantLocation || 'Non indicata'}</dd></div>
                <div><dt className="text-subtle">Documento</dt><dd className="mt-1 break-words text-body">{selected.cvFileName || 'Non caricato'}</dd></div>
              </dl>
              <section aria-labelledby="concierge-proposals-title">
                <h3 id="concierge-proposals-title" className="text-lg font-semibold text-heading">Proposte ({selected.proposals.length})</h3>
                {selected.proposals.length === 0 ? <p className="mt-2 text-sm text-subtle">Non sono ancora state proposte posizioni a questo utente.</p> : <ul className="mt-3 divide-y divide-edge">
                  {selected.proposals.map((proposal) => <li key={proposal.proposalId} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
                    <div className="min-w-0"><p className="break-words font-semibold text-strong">{proposal.jobTitle}</p><p className="text-subtle">{proposal.companyName} · proposta il {date(proposal.proposedAt)}</p></div>
                    <span className="text-subtle">{PROPOSAL_LABELS[proposal.status] || proposal.status}</span>
                  </li>)}
                </ul>}
              </section>
              <section className="space-y-4" aria-labelledby="concierge-orders-title">
                <h3 id="concierge-orders-title" className="text-lg font-semibold text-heading">Candidature accettate ({selectedOrders.length})</h3>
                {selectedOrders.length === 0 && <p className="text-sm text-subtle">Le candidature compariranno dopo l’accettazione delle proposte da parte di questo utente.</p>}
                {selectedOrders.map((order) => { const step = nextStepFor(order); return (
                  <article key={order.orderId} className="rounded-stripe border border-edge p-4 sm:p-5">
                    <h4 className="text-base font-semibold text-heading">{order.jobTitle || order.jobId}</h4>
                    <p className="mt-1 text-sm text-subtle">{order.companyName}</p>
                    <p className="mt-3 text-sm font-semibold text-strong">{step.label}</p><p className="mt-1 max-w-prose text-sm text-subtle">{step.detail}</p>
                    <div className="mt-4 border-t border-edge pt-4"><h5 className="mb-3 text-sm font-semibold text-heading">Email al candidato</h5><CandidateEmails emails={order.candidateEmails || []} /></div>
                    <ApplicationInbox automation={order.automation} />
                    {order.submissionStatus !== 'refunded' && <AssistedApplicationAutomationPanel order={order} user={user} onChanged={async (next) => {
                      setMessage(next.text);
                      try { setOrders(await fetchApplicationConciergeAssistedOrders(user)); }
                      catch (error) { setMessage(error instanceof Error ? `${next.text} Aggiornamento non riuscito: ${error.message}` : next.text); }
                    }} />}
                  </article>
                ); })}
              </section>
            </>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm text-body">Stato
              <select value={filter} onChange={(event) => setFilter(event.target.value)} className="ml-2 min-h-11 rounded-stripe border border-edge bg-surface px-3 text-sm">
                <option value="all">Tutti ({groups.length} utenti)</option>
                {Object.entries(SERVICE_LABELS).map(([value, label]) => <option key={value} value={value}>{label} ({groups.filter((group) => group.some((service) => service.serviceStatus === value)).length})</option>)}
              </select>
            </label>
            <label className="text-sm text-body">Cerca utente<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome o email" className="ml-2 min-h-11 max-w-full rounded-stripe border border-edge bg-surface px-3 text-sm" /></label>
          </div>
          {visibleUsers.length === 0 ? <p className="py-8 text-sm text-subtle">Nessun utente corrisponde ai filtri selezionati.</p> : <ul className="divide-y divide-edge border-y border-edge">
            {visibleUsers.map((group) => { const service = group.find((item) => item.serviceStatus === 'active') || group[0]; return (
              <li key={service.userId || service.customerEmail || service.serviceId}>
                <button type="button" onClick={() => select(service.serviceId)} className="flex w-full flex-wrap items-center justify-between gap-3 px-2 py-4 text-left hover:bg-surface-alt focus-visible:outline-accent">
                  <span className="min-w-0"><span className="block break-words text-sm font-semibold text-heading">{service.applicantName || service.customerEmail || 'Candidato senza dati'}</span><span className="mt-1 block break-all text-xs text-subtle">{service.applicantEmail || service.customerEmail}</span></span>
                  <span className="flex flex-wrap items-center gap-4 text-xs text-subtle"><span className={service.serviceStatus === 'active' ? 'font-semibold text-success' : ''}>{SERVICE_LABELS[service.serviceStatus] || service.serviceStatus}</span><span>{service.proposals.length} proposte · {service.acceptedPositionsCount}/{service.maxPositions} accettate</span><span className="font-semibold text-link">Apri utente →</span></span>
                </button>
              </li>
            ); })}
          </ul>}
          {selectedId && <p role="status" className="text-sm text-warning">Il servizio richiesto non è disponibile. Seleziona un utente dalla lista.</p>}
        </>
      )}
      {selected && selected.serviceStatus === 'active' && !preview && (
        <details className="rounded-stripe border border-edge p-4">
          <summary className="cursor-pointer text-sm font-semibold text-subtle">Proponi una posizione manualmente</summary>
          <form onSubmit={submit} className="mt-4">
          <h3 className="font-semibold text-heading">Nuova posizione proposta</h3>
          <p className="mt-1 text-xs text-subtle">Servizio selezionato: {selected.applicantName || selected.serviceId}. Il limite vale sulle posizioni accettate.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input required aria-label="ID annuncio" placeholder="ID annuncio" value={form.jobId} onChange={(event) => setForm({ ...form, jobId: event.target.value })} className="rounded-stripe border border-edge bg-surface px-3 py-2 text-sm" />
            <input required type="url" aria-label="URL annuncio https://…" placeholder="URL annuncio https://…" value={form.jobUrl} onChange={(event) => setForm({ ...form, jobUrl: event.target.value })} className="rounded-stripe border border-edge bg-surface px-3 py-2 text-sm sm:col-span-2" />
            <input required aria-label="ID azienda" placeholder="ID azienda" value={form.companyId} onChange={(event) => setForm({ ...form, companyId: event.target.value })} className="rounded-stripe border border-edge bg-surface px-3 py-2 text-sm" />
            <input required aria-label="Nome azienda" placeholder="Nome azienda" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} className="rounded-stripe border border-edge bg-surface px-3 py-2 text-sm" />
            <input required aria-label="Titolo posizione" placeholder="Titolo posizione" value={form.jobTitle} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} className="rounded-stripe border border-edge bg-surface px-3 py-2 text-sm" />
            <input aria-label="Località" placeholder="Località" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} className="rounded-stripe border border-edge bg-surface px-3 py-2 text-sm" />
            <input aria-label="Canale (email, portale…)" placeholder="Canale (email, portale…)" value={form.applyMode} onChange={(event) => setForm({ ...form, applyMode: event.target.value })} className="rounded-stripe border border-edge bg-surface px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={busy} className="mt-4 inline-flex min-h-[42px] items-center gap-2 rounded-stripe bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-60">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}Aggiungi proposta
          </button>
          </form>
        </details>
      )}
    </section>
  );
}
