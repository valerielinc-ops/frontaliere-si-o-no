import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { BriefcaseBusiness, Loader2, Plus, RefreshCw } from 'lucide-react';
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
import AssistedApplicationAutomationPanel from './AssistedApplicationAutomationPanel';

const EMPTY_FORM = { serviceId: '', jobId: '', jobUrl: '', companyId: '', companyName: '', jobTitle: '', location: '', applyMode: '' };

export default function ApplicationConciergeAdmin() {
  const { user } = useAuth();
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
      setForm((current) => ({ ...current, serviceId: current.serviceId || data.services[0]?.serviceId || '' }));
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Impossibile caricare i servizi concierge.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [user]);

  const selected = services.find((service) => service.serviceId === form.serviceId) || null;

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
    <section className={`${REPLAY_PRIVATE_CLASS} mt-8 space-y-5 border-t border-edge pt-8`} {...REPLAY_PRIVATE_ATTRS} aria-labelledby="application-concierge-admin-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="application-concierge-admin-title" className="flex items-center gap-2 text-lg font-bold font-display text-strong">
            <BriefcaseBusiness size={20} className="text-accent" aria-hidden="true" />Servizio candidature — 30 giorni
          </h2>
          <p className="mt-1 text-sm text-muted">Proponi gli annunci trovati nel lavoro quotidiano; l’automazione parte solo dopo l’accettazione esplicita di ogni posizione.</p>
        </div>
        <button type="button" onClick={() => { void load(); }} disabled={loading} className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm font-semibold text-subtle hover:border-accent disabled:opacity-60">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Aggiorna
        </button>
      </div>
      {message && <p role="status" className="rounded-xl border border-info-border bg-info-subtle p-3 text-sm text-info">{message}</p>}
      {loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-edge p-5 text-sm text-subtle" role="status">
          <Loader2 size={16} className="animate-spin" />Caricamento servizi…
        </div>
      ) : services.length === 0 ? (
        <p className="rounded-xl border border-edge p-5 text-sm text-subtle">Nessun servizio acquistato.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {services.map((service) => (
            <article key={service.serviceId} className="rounded-xl border border-edge bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-body">{service.applicantName || service.customerEmail || 'Candidato senza dati'}</p>
                  <p className="text-xs text-muted">{service.serviceId}</p>
                </div>
                <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${service.serviceStatus === 'active' ? 'bg-success-subtle text-success' : 'bg-surface-raised text-muted'}`}>
                  {service.serviceStatus}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-subtle">
                <span>Scadenza: {service.expiresAt ? new Date(service.expiresAt).toLocaleDateString('it-CH') : '—'}</span>
                <span>Quota: {service.acceptedPositionsCount}/{service.maxPositions}</span>
                <span>CV: {service.hasCv ? 'ricevuto' : 'mancante'}</span>
                <span>Proposte: {service.proposals.length}</span>
              </div>
              <button
                type="button"
                onClick={() => setForm((current) => ({ ...current, serviceId: service.serviceId }))}
                className={`mt-3 inline-flex min-h-[38px] items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${form.serviceId === service.serviceId ? 'border-accent text-accent' : 'border-edge text-subtle'}`}
              >
                <Plus size={14} />Usa questo servizio
              </button>
              {service.proposals.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-edge pt-3 text-xs text-subtle">
                  {service.proposals.map((proposal) => (
                    <li key={proposal.proposalId} className="flex justify-between gap-2">
                      <span className="truncate">{proposal.jobTitle} · {proposal.companyName}</span>
                      <span className="shrink-0">{proposal.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
      {!loading && (
        <div className="space-y-4 border-t border-edge pt-5" aria-labelledby="application-concierge-automation-title">
          <div>
            <h3 id="application-concierge-automation-title" className="font-bold text-heading">Automazioni delle posizioni accettate</h3>
            <p className="mt-1 text-sm text-muted">Gli ordini collegati al servizio concierge compaiono qui, separati dalla coda delle candidature singole.</p>
          </div>
          {orders.length === 0 ? (
            <p className="rounded-xl border border-edge p-5 text-sm text-subtle">Nessun ordine concierge da gestire.</p>
          ) : (
            <div className="space-y-4">
              {orders.map((order) => {
                const service = services.find((candidate) => candidate.serviceId === order.parentServiceId);
                return (
                  <article key={order.orderId} className="rounded-2xl border border-edge bg-surface p-4 shadow-sm sm:p-5">
                    <div className="mb-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{order.companyName || 'Azienda non indicata'}</p>
                      <h4 className="mt-1 text-base font-bold text-strong">{order.jobTitle || order.jobId || 'Annuncio non indicato'}</h4>
                      <p className="mt-1 text-xs text-muted">
                        {order.applicantName || service?.applicantName || 'Candidato'} · Ordine {order.orderId} · Servizio {order.parentServiceId || 'non collegato'}
                      </p>
                    </div>
                    {order.submissionStatus === 'refunded' ? (
                      <p className="rounded-xl border border-edge p-3 text-sm text-subtle">Ordine rimborsato: automazione non disponibile.</p>
                    ) : (
                      <AssistedApplicationAutomationPanel
                        order={order}
                        user={user}
                        onChanged={async (next) => {
                          setMessage(next.text);
                          try {
                            setOrders(await fetchApplicationConciergeAssistedOrders(user));
                          } catch (error) {
                            setMessage(error instanceof Error ? `${next.text} Aggiornamento non riuscito: ${error.message}` : next.text);
                          }
                        }}
                      />
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
      {selected && (
        <form onSubmit={submit} className="rounded-2xl border border-accent/30 bg-accent-subtle/30 p-5">
          <h3 className="font-bold text-heading">Nuova posizione proposta</h3>
          <p className="mt-1 text-xs text-subtle">Servizio selezionato: {selected.applicantName || selected.serviceId}. Il limite vale sulle posizioni accettate.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input required placeholder="ID annuncio" value={form.jobId} onChange={(event) => setForm({ ...form, jobId: event.target.value })} className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />
            <input required type="url" placeholder="URL annuncio https://…" value={form.jobUrl} onChange={(event) => setForm({ ...form, jobUrl: event.target.value })} className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm sm:col-span-2" />
            <input required placeholder="ID azienda" value={form.companyId} onChange={(event) => setForm({ ...form, companyId: event.target.value })} className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />
            <input required placeholder="Nome azienda" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />
            <input required placeholder="Titolo posizione" value={form.jobTitle} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />
            <input placeholder="Località" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />
            <input placeholder="Canale (email, portale…)" value={form.applyMode} onChange={(event) => setForm({ ...form, applyMode: event.target.value })} className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={busy} className="mt-4 inline-flex min-h-[42px] items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-on-accent disabled:opacity-60">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}Aggiungi proposta
          </button>
        </form>
      )}
    </section>
  );
}
