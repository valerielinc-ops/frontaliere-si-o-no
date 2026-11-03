import { useEffect, useState } from 'react';
import { Check, RefreshCw, Store, X } from 'lucide-react';
import { useAuth } from '@/services/authService';
import {
  fetchAdminPermanentEmployerSignals,
  moderatePermanentEmployerSignal,
  type PermanentEmployerSignal,
} from '@/services/directEmployerChannel';
import { useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminMessageBanner, type AdminMessage } from '@/components/admin/ui/AdminMessageBanner';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminSkeleton } from '@/components/admin/ui/AdminSkeleton';

export default function OfferteDiretteSection() {
  const { user } = useAuth();
  const { requestConfirmation } = useAdminConfirm();
  const [signals, setSignals] = useState<PermanentEmployerSignal[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<AdminMessage | null>(null);

  const load = async (append = false) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchAdminPermanentEmployerSignals(user, 'pending_moderation', append ? nextPageToken || '' : '');
      setSignals((current) => append ? [...current, ...page.items] : page.items);
      setNextPageToken(page.nextPageToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Coda di moderazione non disponibile.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [user]);

  async function moderate(id: string, action: 'approve' | 'reject', label: string) {
    const confirmed = await requestConfirmation({
      title: action === 'approve' ? 'Approva contenuto' : 'Rifiuta contenuto',
      what: `${action === 'approve' ? 'Approverai' : 'Rifiuterai'} ${label}.`,
      impact: action === 'approve' ? 'Il segnale potrà entrare nel percorso pubblico previsto.' : 'Il segnale resterà escluso dalla pubblicazione.',
      input: `signal=${id}`,
      confirmLabel: action === 'approve' ? 'Approva' : 'Rifiuta',
      confirmVariant: action === 'approve' ? 'primary' : 'danger',
      expectedDuration: 'meno di 1 min',
    });
    if (!confirmed) return;
    setPending(id);
    setMessage(null);
    try {
      await moderatePermanentEmployerSignal(user, id, action);
      setMessage({ kind: 'ok', text: action === 'approve' ? 'Segnalazione approvata.' : 'Segnalazione rifiutata.' });
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Moderazione non riuscita.' });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <AdminSectionHeader title="Offerte dirette" summary="La fonte principale delle candidature spontanee è il prospector; i segnali dei candidati restano secondari e separati dalle offerte di lavoro." secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading} onClick={() => void load()}>Aggiorna</AdminButton>} />
      {message && <AdminMessageBanner message={message} />}
      {error && <p role="alert" className="rounded-stripe border border-danger-border bg-danger-subtle px-4 py-3 text-sm text-danger">{error}</p>}
      {loading && signals.length === 0 ? <div className="rounded-stripe border border-edge bg-surface p-5"><AdminSkeleton lines={6} /></div> : <section aria-labelledby="permanent-signals-heading" className="space-y-3">
        <div className="flex items-center gap-2"><Store size={18} className="text-accent" aria-hidden="true" /><h2 id="permanent-signals-heading" className="font-display text-xl font-semibold text-heading">Segnalazioni di candidature spontanee da moderare ({signals.length})</h2></div>
        {signals.length === 0 ? <p className="rounded-stripe border border-edge bg-surface px-4 py-5 text-sm text-subtle">Nessuna segnalazione in attesa.</p> : <div className="space-y-3">{signals.map((signal) => <article key={signal.id} className="rounded-stripe border border-edge bg-surface p-4"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-display text-lg font-semibold text-heading">{signal.companyName}</h3><p className="mt-1 text-sm text-subtle">{signal.locationLabel || 'Località non indicata'} · {signal.candidateMarks || 1} segnalazioni · <a className="text-accent underline-offset-2 hover:underline" href={signal.website} target="_blank" rel="noreferrer">sito ufficiale</a></p></div><div className="flex flex-wrap gap-2"><AdminButton variant="primary" icon={<Check size={15} aria-hidden="true" />} loading={pending === signal.id} disabled={pending !== null} onClick={() => void moderate(signal.id, 'approve', `la segnalazione per ${signal.companyName}`)}>Approva</AdminButton><AdminButton variant="danger" icon={<X size={15} aria-hidden="true" />} loading={pending === signal.id} disabled={pending !== null} onClick={() => void moderate(signal.id, 'reject', `la segnalazione per ${signal.companyName}`)}>Rifiuta</AdminButton></div></div></article>)}</div>}
        {nextPageToken && <AdminButton loading={loading} disabled={pending !== null} onClick={() => void load(true)}>Carica altre segnalazioni</AdminButton>}
      </section>}
    </div>
  );
}
