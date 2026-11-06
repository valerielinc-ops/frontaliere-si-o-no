import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '@/services/authService';
import { fetchAdminAuditLog, type AdminAuditEntry } from '@/services/adminAuditLog';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminSkeleton } from '@/components/admin/ui/AdminSkeleton';
import { AdminStatusPill } from '@/components/admin/ui/AdminStatusPill';
import { adminSectionPath, replaceAdminQuery } from '@/components/admin/lib/adminNavigation';

const ACTION_LABELS: Record<string, string> = {
  workflow_dispatch: 'Avvio workflow',
  crawler_config_update: 'Configurazione crawler aggiornata',
  employer_contact_update: 'Contatto azienda salvato',
  employer_outreach_send: 'Outreach azienda inviato',
  journalist_role_grant: 'Ruolo giornalista assegnato',
  journalist_role_revoke: 'Ruolo giornalista revocato',
  editorial_profile_update: 'Profilo firma aggiornato',
  article_author_reassign: 'Autore articolo riassegnato',
  application_concierge_proposal_create: 'Proposta candidatura creata',
};

const ACTION_OPTIONS = Object.entries(ACTION_LABELS);

function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  if (action.startsWith('assisted_application_')) return `Candidatura: ${action.slice('assisted_application_'.length).replaceAll('_', ' ')}`;
  return action || 'Azione admin';
}

function targetHref(entry: AdminAuditEntry): string | null {
  const { action, target } = entry;
  if (action === 'employer_contact_update' || action === 'employer_outreach_send') return `${adminSectionPath('aziende')}?${new URLSearchParams({ azienda: target }).toString()}`;
  if (action === 'article_author_reassign' || action === 'editorial_profile_update') return adminSectionPath('redazione');
  if (action === 'application_concierge_proposal_create') return `${adminSectionPath('servizio-candidature')}?${new URLSearchParams({ servizio: target }).toString()}`;
  if (action.startsWith('assisted_application_')) return `${adminSectionPath('candidature')}?${new URLSearchParams({ ordine: target }).toString()}`;
  if (action === 'journalist_role_grant' || action === 'journalist_role_revoke') return adminSectionPath('giornalisti');
  if (action === 'crawler_config_update') return adminSectionPath('configurazione-crawler');
  if (action === 'workflow_dispatch') return adminSectionPath('automazioni');
  return null;
}

function dateLabel(value: string | null): string { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('it-CH'); }

function statusTone(status: AdminAuditEntry['status']): 'success' | 'warning' | 'danger' {
  return status === 200 || status === '200' ? 'success' : status === 'pending' ? 'warning' : 'danger';
}

export default function RegistroSection() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [action, setAction] = useState(() => new URLSearchParams(window.location.search).get('azione') || '');
  const [from, setFrom] = useState(() => new URLSearchParams(window.location.search).get('dal') || '');
  const [to, setTo] = useState(() => new URLSearchParams(window.location.search).get('al') || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (requestedCursor: string | null = null) => {
    setLoading(true); setError(null);
    try { const page = await fetchAdminAuditLog(user, { cursor: requestedCursor || undefined, action: action.trim() || undefined, from: from || undefined, to: to || undefined }); setEntries(page.entries); setNextCursor(page.nextCursor); setCursor(requestedCursor); } catch (err) { setError(err instanceof Error ? err.message : 'Registro non disponibile.'); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [user]);
  return (
    <div className="space-y-6">
      <AdminSectionHeader title="Registro" summary="Le ultime 50 azioni del pannello, con filtri per azione e intervallo. Il registro non contiene segreti, email operative o testo CV." secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading} onClick={() => void load(cursor)}>Aggiorna</AdminButton>} />
      <form className="grid gap-3 rounded-stripe border border-edge bg-surface p-4 sm:grid-cols-[1fr_9rem_9rem_auto]" onSubmit={(event) => { event.preventDefault(); void load(null); }}><label className="text-sm text-subtle">Azione<select value={action} onChange={(event) => { setAction(event.target.value); replaceAdminQuery({ azione: event.target.value || null }); }} className="mt-1 min-h-10 w-full rounded-stripe border border-edge bg-surface-alt px-3 text-sm text-heading"><option value="">Tutte</option>{ACTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="text-sm text-subtle">Dal<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); replaceAdminQuery({ dal: event.target.value || null }); }} className="mt-1 min-h-10 w-full rounded-stripe border border-edge bg-surface-alt px-3 text-sm text-heading" /></label><label className="text-sm text-subtle">Al<input type="date" value={to} onChange={(event) => { setTo(event.target.value); replaceAdminQuery({ al: event.target.value || null }); }} className="mt-1 min-h-10 w-full rounded-stripe border border-edge bg-surface-alt px-3 text-sm text-heading" /></label><AdminButton type="submit" variant="primary" className="self-end">Filtra</AdminButton></form>
      {error && <p role="alert" className="rounded-stripe border border-danger-border bg-danger-subtle px-4 py-3 text-sm text-danger">{error}</p>}
      {loading && entries.length === 0 ? <div className="rounded-stripe border border-edge bg-surface p-5"><AdminSkeleton lines={6} /></div> : <>
        <div className="hidden overflow-x-auto rounded-stripe border border-edge bg-surface md:block"><table className="w-full text-left text-sm"><caption className="sr-only">Registro azioni del pannello</caption><thead className="bg-surface-alt text-xs font-semibold text-muted"><tr><th scope="col" className="px-3 py-3">Quando</th><th scope="col" className="px-3 py-3">Azione</th><th scope="col" className="px-3 py-3">Oggetto</th><th scope="col" className="px-3 py-3">Esito</th><th scope="col" className="px-3 py-3">Chi</th></tr></thead><tbody>{entries.map((entry) => { const href = targetHref(entry); return <tr key={entry.id} className="border-t border-edge"><td className="whitespace-nowrap px-3 py-3 text-subtle">{dateLabel(entry.at)}</td><td className="px-3 py-3 text-heading">{actionLabel(entry.action)}</td><td className="max-w-[24rem] break-all px-3 py-3 text-subtle">{href ? <a href={href} className="font-medium text-accent hover:underline">{entry.target || 'Apri sezione'}</a> : entry.target || '—'}</td><td className="px-3 py-3"><AdminStatusPill tone={statusTone(entry.status)}>{entry.status === 200 || entry.status === '200' ? 'OK' : entry.status === 'pending' ? 'In attesa' : String(entry.status || 'Errore')}</AdminStatusPill></td><td className="px-3 py-3 text-subtle">{entry.uid || '—'}</td></tr>; })}</tbody></table></div>
        <div className="space-y-3 md:hidden">{entries.map((entry) => { const href = targetHref(entry); return <article key={entry.id} className="rounded-stripe border border-edge bg-surface p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-heading">{actionLabel(entry.action)}</p><p className="mt-1 text-xs text-subtle">{dateLabel(entry.at)}</p></div><AdminStatusPill tone={statusTone(entry.status)}>{entry.status === 200 || entry.status === '200' ? 'OK' : entry.status === 'pending' ? 'In attesa' : String(entry.status || 'Errore')}</AdminStatusPill></div><p className="mt-3 break-all text-sm text-body">{href ? <a href={href} className="font-medium text-accent hover:underline">{entry.target || 'Apri sezione'}</a> : entry.target || '—'}</p><p className="mt-2 text-xs text-muted">Chi: {entry.uid || '—'}</p></article>; })}{entries.length === 0 && <p className="rounded-stripe border border-edge bg-surface px-4 py-6 text-center text-sm text-subtle">Nessuna azione nel filtro.</p>}</div>
        <div className="flex flex-wrap justify-between gap-2"><span className="text-sm text-subtle">{entries.length} record mostrati{cursor ? ' · pagina successiva' : ''}</span><div className="flex gap-2"><AdminButton disabled={!cursor || loading} onClick={() => void load(null)}>Più recenti</AdminButton><AdminButton disabled={!nextCursor || loading} onClick={() => void load(nextCursor)}>Più vecchi</AdminButton></div></div>
      </>}
    </div>
  );
}
