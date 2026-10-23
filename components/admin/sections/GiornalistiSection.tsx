import { useEffect, useState } from 'react';
import { Loader2, Newspaper, RefreshCw, UserCheck } from 'lucide-react';
import { useAuth } from '@/services/authService';
import { fetchJournalistGrants, setJournalistRole, type JournalistGrant } from '@/services/journalistAdminService';
import { AdminMessageBanner, type AdminMessage } from '@/components/admin/ui/AdminMessageBanner';

export default function GiornalistiSection() {
  const { user } = useAuth();
  const [grants, setGrants] = useState<JournalistGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<AdminMessage | null>(null);

  const loadGrants = async () => {
    setLoading(true); setError(null);
    try { setGrants(await fetchJournalistGrants(user)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Errore sconosciuto'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadGrants(); }, []);

  const roleAction = async (action: 'grant' | 'revoke', value: string) => {
    const trimmedEmail = value.trim();
    if (!trimmedEmail || pending) return;
    if (typeof window !== 'undefined' && !window.confirm(action === 'grant' ? `Abilitare ${trimmedEmail} come giornalista?` : `Disabilitare ${trimmedEmail} come giornalista?`)) return;
    setPending(true); setMessage(null);
    try { await setJournalistRole(user, action, trimmedEmail); setMessage({ kind: 'ok', text: action === 'grant' ? 'Giornalista abilitato.' : 'Giornalista disabilitato.' }); setEmail(''); await loadGrants(); }
    catch (err) { setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Errore sconosciuto' }); }
    finally { setPending(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap"><h2 className="text-lg font-bold font-display text-strong flex items-center gap-2"><Newspaper size={20} className="text-accent" />Giornalisti</h2><button type="button" onClick={() => void loadGrants()} disabled={loading} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent text-on-accent text-sm font-medium disabled:opacity-60">{loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Aggiorna</button></div>
      <div className="bg-surface rounded-xl border border-edge px-4 py-2"><p className="text-sm text-muted">Abilita o disabilita l&apos;accesso alla dashboard redazionale (bozza articolo, invio in pubblicazione, analytics). La persona deve aver già effettuato l&apos;accesso al sito almeno una volta con questa email.</p></div>
      <form onSubmit={(event) => { event.preventDefault(); void roleAction('grant', email); }} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-surface rounded-xl border border-edge p-3"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="email@esempio.ch" className="flex-1 px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong" /><button type="submit" disabled={pending || !email.trim()} className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-accent text-on-accent text-sm font-medium disabled:opacity-60">{pending ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}Abilita</button><button type="button" onClick={() => void roleAction('revoke', email)} disabled={pending || !email.trim()} className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-edge text-subtle text-sm font-medium disabled:opacity-60">Disabilita</button></form>
      {message && <AdminMessageBanner message={message} />}{error && <div className="bg-danger-subtle border border-danger-border rounded-xl px-4 py-2 text-sm text-danger">{error}</div>}
      <div className="bg-surface rounded-xl border border-edge overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-edge text-left text-xs uppercase text-muted"><th className="px-4 py-2">Email</th><th className="px-4 py-2">Nome</th><th className="px-4 py-2">Stato</th><th className="px-4 py-2">Concesso il</th><th className="px-4 py-2">Da</th><th className="px-4 py-2" /></tr></thead><tbody>{grants.length === 0 && !loading && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted">Nessun giornalista abilitato finora.</td></tr>}{grants.map((grant) => <tr key={grant.uid} className="border-b border-edge last:border-0"><td className="px-4 py-2 text-strong">{grant.email}</td><td className="px-4 py-2 text-subtle">{grant.displayName}</td><td className="px-4 py-2"><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${grant.active ? 'bg-success-subtle text-success border-success-border' : 'bg-surface-alt text-muted border-edge'}`}>{grant.active ? 'Attivo' : 'Disattivo'}</span></td><td className="px-4 py-2 text-subtle">{grant.grantedAt ? new Date(grant.grantedAt).toLocaleDateString('it-CH') : '—'}</td><td className="px-4 py-2 text-subtle">{grant.grantedBy || '—'}</td><td className="px-4 py-2 text-right"><button type="button" onClick={() => void roleAction(grant.active ? 'revoke' : 'grant', grant.email)} disabled={pending} className="text-xs font-medium text-link hover:underline disabled:opacity-60">{grant.active ? 'Disabilita' : 'Riabilita'}</button></td></tr>)}</tbody></table></div>
    </div>
  );
}
