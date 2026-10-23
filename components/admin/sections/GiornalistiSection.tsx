import { useEffect, useState } from 'react';
import { Newspaper, RefreshCw, UserCheck } from 'lucide-react';
import { useAuth } from '@/services/authService';
import { fetchJournalistGrants, setJournalistRole, type JournalistGrant } from '@/services/journalistAdminService';
import { AdminMessageBanner, type AdminMessage } from '@/components/admin/ui/AdminMessageBanner';
import { useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminStatusPill } from '@/components/admin/ui/AdminStatusPill';
import { relativeTime } from '@/components/admin/lib/formatters';

export default function GiornalistiSection() {
  const { user } = useAuth();
  const { requestConfirmation } = useAdminConfirm();
  const [grants, setGrants] = useState<JournalistGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<AdminMessage | null>(null);
  const latestGrant = grants.map((grant) => grant.grantedAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null;

  const loadGrants = async () => {
    setLoading(true); setError(null);
    try { setGrants(await fetchJournalistGrants(user)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Errore sconosciuto'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadGrants(); }, [user]);

  const roleAction = async (action: 'grant' | 'revoke', value: string) => {
    const trimmedEmail = value.trim();
    if (!trimmedEmail || pending) return;
    const confirmed = await requestConfirmation({
      title: action === 'grant' ? 'Abilita giornalista' : 'Disabilita giornalista',
      what: action === 'grant' ? `Stai per abilitare ${trimmedEmail} come giornalista.` : `Stai per disabilitare ${trimmedEmail} come giornalista.`,
      impact: action === 'grant' ? 'La persona potrà accedere alla dashboard redazionale.' : 'La persona perderà l’accesso alla dashboard redazionale.',
      input: trimmedEmail,
      expectedDuration: 'meno di 1 min',
      confirmLabel: action === 'grant' ? 'Abilita accesso' : 'Disabilita accesso',
      confirmVariant: action === 'grant' ? 'primary' : 'danger',
    });
    if (!confirmed) return;
    setPending(true); setMessage(null);
    try { await setJournalistRole(user, action, trimmedEmail); setMessage({ kind: 'ok', text: action === 'grant' ? 'Giornalista abilitato.' : 'Giornalista disabilitato.' }); setEmail(''); await loadGrants(); }
    catch (err) { setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Errore sconosciuto' }); }
    finally { setPending(false); }
  };

  return (
    <div className="space-y-4">
      <AdminSectionHeader title="Giornalisti" summary={`${grants.length} accessi registrati · aggiornato ${relativeTime(latestGrant) || (loading ? 'in corso' : 'adesso')}`} secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading} onClick={() => void loadGrants()}>Aggiorna</AdminButton>} />
      <div className="bg-surface rounded-stripe border border-edge px-4 py-2"><p className="text-sm text-muted">Abilita o disabilita l&apos;accesso alla dashboard redazionale (bozza articolo, invio in pubblicazione, analytics). La persona deve aver già effettuato l&apos;accesso al sito almeno una volta con questa email.</p></div>
      <form onSubmit={(event) => { event.preventDefault(); void roleAction('grant', email); }} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-surface rounded-stripe border border-edge p-3"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="email@esempio.ch" className="flex-1 px-3 py-2 rounded-stripe border border-edge bg-surface-alt text-sm text-strong" /><AdminButton type="submit" variant="primary" icon={<UserCheck size={14} aria-hidden="true" />} loading={pending} loadingLabel="Abilitazione…" disabled={!email.trim()}>Abilita</AdminButton><AdminButton type="button" variant="danger" onClick={() => void roleAction('revoke', email)} loading={pending} loadingLabel="Disabilitazione…" disabled={!email.trim()}>Disabilita</AdminButton></form>
      {message && <AdminMessageBanner message={message} />}{error && <div className="bg-danger-subtle border border-danger-border rounded-stripe px-4 py-2 text-sm text-danger">{error}</div>}
      <div className="bg-surface rounded-stripe border border-edge overflow-x-auto"><table className="w-full text-sm tabular-nums"><thead><tr className="border-b border-edge text-left text-xs uppercase text-muted"><th className="px-4 py-2">Email</th><th className="px-4 py-2">Nome</th><th className="px-4 py-2">Stato</th><th className="px-4 py-2">Concesso il</th><th className="px-4 py-2">Da</th><th className="px-4 py-2" /></tr></thead><tbody>{grants.length === 0 && !loading && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted">Nessun giornalista abilitato finora.</td></tr>}{grants.map((grant) => <tr key={grant.uid} className="border-b border-edge last:border-0"><td className="px-4 py-2 text-strong">{grant.email}</td><td className="px-4 py-2 text-subtle">{grant.displayName}</td><td className="px-4 py-2"><AdminStatusPill tone={grant.active ? 'success' : 'neutral'}>{grant.active ? 'Attivo' : 'Disattivo'}</AdminStatusPill></td><td className="px-4 py-2 text-subtle">{grant.grantedAt ? new Date(grant.grantedAt).toLocaleDateString('it-CH') : '—'}</td><td className="px-4 py-2 text-subtle">{grant.grantedBy || '—'}</td><td className="px-4 py-2 text-right"><AdminButton type="button" variant={grant.active ? 'danger' : 'primary'} onClick={() => void roleAction(grant.active ? 'revoke' : 'grant', grant.email)} loading={pending} loadingLabel="Aggiornamento…" className="px-2 py-1 text-xs">{grant.active ? 'Disabilita' : 'Riabilita'}</AdminButton></td></tr>)}</tbody></table></div>
    </div>
  );
}
