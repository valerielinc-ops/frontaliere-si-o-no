import { useEffect, useState } from 'react';
import { Check, RefreshCw, Store, X } from 'lucide-react';
import { useAuth } from '@/services/authService';
import {
  fetchAdminDirectEmployerListings,
  fetchAdminPermanentEmployerSignals,
  moderateDirectEmployerListing,
  moderatePermanentEmployerSignal,
  type DirectEmployerModerationListing,
  type PermanentEmployerSignal,
} from '@/services/directEmployerChannel';
import { useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminMessageBanner, type AdminMessage } from '@/components/admin/ui/AdminMessageBanner';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminSkeleton } from '@/components/admin/ui/AdminSkeleton';
import { AdminStatusPill } from '@/components/admin/ui/AdminStatusPill';

function dateLabel(value: DirectEmployerModerationListing['createdAt']): string {
  if (typeof value === 'string') return new Date(value).toLocaleDateString('it-CH');
  if (value && typeof value._seconds === 'number') return new Date(value._seconds * 1000).toLocaleDateString('it-CH');
  return 'data non disponibile';
}

export default function OfferteDiretteSection() {
  const { user } = useAuth();
  const { requestConfirmation } = useAdminConfirm();
  const [listings, setListings] = useState<DirectEmployerModerationListing[]>([]);
  const [signals, setSignals] = useState<PermanentEmployerSignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<AdminMessage | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [nextListings, nextSignals] = await Promise.all([
        fetchAdminDirectEmployerListings(user),
        fetchAdminPermanentEmployerSignals(user),
      ]);
      setListings(nextListings); setSignals(nextSignals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Coda di moderazione non disponibile.');
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [user]);

  async function moderate(kind: 'listing' | 'signal', id: string, action: 'approve' | 'reject', label: string) {
    const confirmed = await requestConfirmation({
      title: action === 'approve' ? 'Approva contenuto' : 'Rifiuta contenuto',
      what: `${action === 'approve' ? 'Approverai' : 'Rifiuterai'} ${label}.`,
      impact: action === 'approve' ? 'Il contenuto potrà entrare nel percorso pubblico previsto.' : 'Il contenuto resterà escluso dalla pubblicazione.',
      input: `${kind}=${id}`,
      confirmLabel: action === 'approve' ? 'Approva' : 'Rifiuta',
      confirmVariant: action === 'approve' ? 'primary' : 'danger',
      expectedDuration: 'meno di 1 min',
    });
    if (!confirmed) return;
    setPending(`${kind}:${id}`); setMessage(null);
    try {
      if (kind === 'listing') await moderateDirectEmployerListing(user, id, action);
      else await moderatePermanentEmployerSignal(user, id, action);
      setMessage({ kind: 'ok', text: action === 'approve' ? 'Contenuto approvato.' : 'Contenuto rifiutato.' });
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Moderazione non riuscita.' });
    } finally { setPending(null); }
  }

  return (
    <div className="space-y-6">
      <AdminSectionHeader title="Offerte dirette" summary="Ogni offerta viene verificata prima di entrare nel dataset; le segnalazioni di candidature spontanee restano separate dalle offerte di lavoro." secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading} onClick={() => void load()}>Aggiorna</AdminButton>} />
      {message && <AdminMessageBanner message={message} />}
      {error && <p role="alert" className="rounded-stripe border border-danger-border bg-danger-subtle px-4 py-3 text-sm text-danger">{error}</p>}
      {loading && listings.length === 0 && signals.length === 0 ? <div className="rounded-stripe border border-edge bg-surface p-5"><AdminSkeleton lines={6} /></div> : <>
        <section aria-labelledby="direct-listings-heading" className="space-y-3">
          <div className="flex items-center gap-2"><Store size={18} className="text-accent" aria-hidden="true" /><h2 id="direct-listings-heading" className="font-display text-xl font-semibold text-heading">Offerte da moderare ({listings.length})</h2></div>
          {listings.length === 0 ? <p className="rounded-stripe border border-edge bg-surface px-4 py-5 text-sm text-subtle">Nessuna offerta in attesa.</p> : <div className="space-y-3">{listings.map((listing) => <article key={listing.id} className="rounded-stripe border border-edge bg-surface p-4"><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-display text-lg font-semibold text-heading">{listing.title}</h3><AdminStatusPill tone={listing.riskFlags?.length ? 'warning' : 'info'}>{listing.riskFlags?.length ? 'Revisione attenta' : 'Controllo umano'}</AdminStatusPill></div><p className="mt-1 text-sm font-medium text-body">{listing.companyName} · {listing.locationLabel}</p><p className="mt-2 max-w-3xl text-sm leading-6 text-subtle">{listing.description}</p><dl className="mt-3 grid gap-1 text-xs text-subtle sm:grid-cols-2"><div><dt className="inline font-semibold text-body">Contatto verificato: </dt><dd className="inline">{listing.contactEmail || listing.contactPhone || listing.contactType || '—'}</dd></div><div><dt className="inline font-semibold text-body">Ricevuta: </dt><dd className="inline">{dateLabel(listing.createdAt)}</dd></div></dl>{listing.riskFlags?.length ? <p className="mt-2 text-xs text-warning">Indicatori: {listing.riskFlags.join(', ')}</p> : null}</div><div className="flex shrink-0 flex-wrap gap-2"><AdminButton variant="primary" icon={<Check size={15} aria-hidden="true" />} loading={pending === `listing:${listing.id}`} disabled={pending !== null} onClick={() => void moderate('listing', listing.id, 'approve', `l’offerta di ${listing.companyName}`)}>Approva</AdminButton><AdminButton variant="danger" icon={<X size={15} aria-hidden="true" />} loading={pending === `listing:${listing.id}`} disabled={pending !== null} onClick={() => void moderate('listing', listing.id, 'reject', `l’offerta di ${listing.companyName}`)}>Rifiuta</AdminButton></div></div></article>)}</div>}
        </section>
        <section aria-labelledby="permanent-signals-heading" className="space-y-3">
          <div className="flex items-center gap-2"><Store size={18} className="text-accent" aria-hidden="true" /><h2 id="permanent-signals-heading" className="font-display text-xl font-semibold text-heading">Candidature spontanee da moderare ({signals.length})</h2></div>
          {signals.length === 0 ? <p className="rounded-stripe border border-edge bg-surface px-4 py-5 text-sm text-subtle">Nessuna segnalazione in attesa.</p> : <div className="space-y-3">{signals.map((signal) => <article key={signal.id} className="rounded-stripe border border-edge bg-surface p-4"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-display text-lg font-semibold text-heading">{signal.companyName}</h3><p className="mt-1 text-sm text-subtle">{signal.locationLabel || 'Località non indicata'} · {signal.candidateMarks || 1} segnalazioni · <a className="text-accent underline-offset-2 hover:underline" href={signal.website} target="_blank" rel="noreferrer">sito ufficiale</a></p></div><div className="flex flex-wrap gap-2"><AdminButton variant="primary" icon={<Check size={15} aria-hidden="true" />} loading={pending === `signal:${signal.id}`} disabled={pending !== null} onClick={() => void moderate('signal', signal.id, 'approve', `la segnalazione per ${signal.companyName}`)}>Approva</AdminButton><AdminButton variant="danger" icon={<X size={15} aria-hidden="true" />} loading={pending === `signal:${signal.id}`} disabled={pending !== null} onClick={() => void moderate('signal', signal.id, 'reject', `la segnalazione per ${signal.companyName}`)}>Rifiuta</AdminButton></div></div></article>)}</div>}
        </section>
      </>}
    </div>
  );
}
