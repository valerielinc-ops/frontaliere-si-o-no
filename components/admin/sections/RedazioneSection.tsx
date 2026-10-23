import { useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, RefreshCw, Save, Search, Users, X } from 'lucide-react';
import { ARTICLES } from '@/data/blog-articles-data';
import { useAuth } from '@/services/authService';
import { getAllAuthors } from '@/data/authors';
import { fetchRedazioneAdminData, reassignArticleAuthor, updateAuthorProfile, type RedazioneAdminData } from '@/services/redazioneAdminService';
import type { AuthorProfilePatch } from '@/services/authorProfileService';
import { AdminMessageBanner, type AdminMessage } from '@/components/admin/ui/AdminMessageBanner';
import { useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminStatusPill } from '@/components/admin/ui/AdminStatusPill';
import { relativeTime } from '@/components/admin/lib/formatters';
import { replaceAdminQuery } from '@/components/admin/lib/adminNavigation';

export default function RedazioneSection() {
  const { user } = useAuth();
  const { requestConfirmation } = useAdminConfirm();
  const [data, setData] = useState<RedazioneAdminData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<AdminMessage | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [editingProfileSlug, setEditingProfileSlug] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<AuthorProfilePatch>({});
  const [reassignDraftByArticle, setReassignDraftByArticle] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState(() => new URLSearchParams(window.location.search).get('q') || '');
  const latestArticleUpdate = data?.journalistArticles.map((article) => article.updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null;

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try { setData(await fetchRedazioneAdminData(user)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Errore sconosciuto'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadData(); }, []);

  const filteredArticles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return ARTICLES;
    return ARTICLES.filter((article) => `${article.id} ${article.authorName || ''}`.toLowerCase().includes(query));
  }, [filter]);

  const saveProfile = async (slug: string) => {
    if (actionPending) return;
    setActionPending(true); setActionMessage(null);
    try { await updateAuthorProfile(user, slug, profileDraft); setActionMessage({ kind: 'ok', text: 'Profilo aggiornato.' }); setEditingProfileSlug(null); await loadData(); }
    catch (err) { setActionMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Errore sconosciuto' }); }
    finally { setActionPending(false); }
  };

  const reassignArticle = async (articleId: string) => {
    const authorSlug = (reassignDraftByArticle[articleId] || '').trim();
    if (!authorSlug || actionPending) return;
    const author = getAllAuthors().find((candidate) => candidate.slug === authorSlug);
    if (!author) return;
    const confirmed = await requestConfirmation({
      title: 'Riassegna articolo',
      what: `Stai per riassegnare l’articolo a ${author.name}.`,
      impact: 'Modifica l’attribuzione editoriale dell’articolo nel catalogo amministrativo.',
      input: `articolo=${articleId}, autore=${author.name}`,
      expectedDuration: 'meno di 1 min',
      confirmLabel: 'Riassegna articolo',
    });
    if (!confirmed) return;
    setActionPending(true); setActionMessage(null);
    try { await reassignArticleAuthor(user, articleId, author.slug, author.name); setActionMessage({ kind: 'ok', text: `Articolo riassegnato a ${author.name}.` }); await loadData(); }
    catch (err) { setActionMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Errore sconosciuto' }); }
    finally { setActionPending(false); }
  };

  return (
    <div className="space-y-6">
      <AdminSectionHeader title="Redazione" summary={`${getAllAuthors().length} profili editoriali · ${filteredArticles.length} articoli visibili · aggiornato ${relativeTime(latestArticleUpdate) || (loading ? 'in corso' : 'adesso')}`} secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading} onClick={() => void loadData()}>Aggiorna</AdminButton>} />
      {actionMessage && <AdminMessageBanner message={actionMessage} />}
      {error && <div className="bg-danger-subtle border border-danger-border rounded-stripe px-4 py-2 text-sm text-danger">{error}</div>}
      <div className="space-y-3"><h3 className="text-sm font-semibold text-strong">Firme e profili editoriali</h3><p className="text-sm text-muted">Qui modifichi descrizione, immagine e area editoriale delle firme senza deploy di codice. Marco Ferrari, Laura Bianchi e Redazione sono profili editoriali; Samuele Valente è un autore reale e mantiene la propria attribuzione autenticata e i dati pubblici del registro.</p><div className="space-y-2">{getAllAuthors().map((author) => { const merged = { ...author, ...data?.authorProfiles[author.slug] }; const editing = editingProfileSlug === author.slug; return <div key={author.slug} className="bg-surface rounded-stripe border border-edge p-3"><div className="flex items-center justify-between gap-3 flex-wrap"><div><p className="font-semibold text-strong">{merged.name}</p><p className="text-sm text-subtle">{merged.role}</p></div>{!editing && <button type="button" onClick={() => { setEditingProfileSlug(author.slug); setProfileDraft({ name: merged.name, role: merged.role, bio: merged.bio, photoPath: merged.photoPath }); setActionMessage(null); }} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-stripe border border-edge text-sm font-medium text-subtle"><Pencil size={14} />Modifica</button>}</div>{editing && <div className="mt-3 space-y-2"><input value={profileDraft.name || ''} onChange={(event) => setProfileDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="Nome" className="w-full px-3 py-2 rounded-stripe border border-edge bg-surface-alt text-sm text-strong" /><input value={profileDraft.role || ''} onChange={(event) => setProfileDraft((draft) => ({ ...draft, role: event.target.value }))} placeholder="Ruolo" className="w-full px-3 py-2 rounded-stripe border border-edge bg-surface-alt text-sm text-strong" /><textarea value={profileDraft.bio || ''} onChange={(event) => setProfileDraft((draft) => ({ ...draft, bio: event.target.value }))} placeholder="Bio" rows={4} className="w-full px-3 py-2 rounded-stripe border border-edge bg-surface-alt text-sm text-strong" /><input value={profileDraft.photoPath || ''} onChange={(event) => setProfileDraft((draft) => ({ ...draft, photoPath: event.target.value }))} placeholder="/images/authors/slug.webp" className="w-full px-3 py-2 rounded-stripe border border-edge bg-surface-alt text-sm text-strong" /><div className="flex items-center gap-2"><button type="button" onClick={() => void saveProfile(author.slug)} disabled={actionPending} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-stripe bg-accent text-on-accent text-sm font-medium disabled:opacity-60">{actionPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}Salva</button><button type="button" onClick={() => setEditingProfileSlug(null)} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-stripe border border-edge text-sm font-medium text-subtle"><X size={14} />Annulla</button></div></div>}</div>; })}</div></div>
      <div className="space-y-3"><div className="flex items-center justify-between gap-3 flex-wrap"><h3 className="text-sm font-semibold text-strong">Articoli (catalogo AI) — {filteredArticles.length}{filter ? ` di ${ARTICLES.length}` : ''}</h3><div className="relative min-w-[220px]"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" /><input type="search" value={filter} onChange={(event) => { const value = event.target.value; setFilter(value); replaceAdminQuery({ q: value.trim() || null }); }} placeholder="Cerca articolo…" aria-label="Cerca articolo o autore" className="w-full rounded-stripe border border-edge bg-surface-alt py-1.5 pl-8 pr-2 text-sm text-strong" /></div></div><div className="bg-surface rounded-stripe border border-edge overflow-auto max-h-96"><table className="w-full text-sm tabular-nums"><thead className="sticky top-0 bg-surface"><tr className="border-b border-edge text-left text-xs uppercase text-muted"><th className="px-4 py-2">Articolo</th><th className="px-4 py-2">Autore attuale</th><th className="px-4 py-2">Riassegna a</th><th className="px-4 py-2" /></tr></thead><tbody>{filteredArticles.map((article) => { const override = data?.articleAuthorOverrides[article.id]; return <tr key={article.id} className="border-b border-edge last:border-0"><td className="px-4 py-2 text-strong">{article.id}</td><td className="px-4 py-2 text-subtle">{override?.authorName || article.authorName || '—'}</td><td className="px-4 py-2"><select value={reassignDraftByArticle[article.id] || ''} onChange={(event) => setReassignDraftByArticle((draft) => ({ ...draft, [article.id]: event.target.value }))} className="px-2 py-1 rounded-stripe border border-edge bg-surface-alt text-sm text-strong"><option value="">— seleziona —</option>{getAllAuthors().map((author) => <option key={author.slug} value={author.slug}>{author.name}</option>)}</select></td><td className="px-4 py-2 text-right"><button type="button" onClick={() => void reassignArticle(article.id)} disabled={actionPending || !reassignDraftByArticle[article.id]} className="text-xs font-medium text-link hover:underline disabled:opacity-60">Riassegna</button></td></tr>; })}</tbody></table></div></div>
      <div className="space-y-3"><h3 className="text-sm font-semibold text-strong">Articoli giornalisti (tutti gli autori) — {data?.journalistArticles.length ?? 0}</h3><div className="bg-surface rounded-stripe border border-edge overflow-x-auto"><table className="w-full text-sm tabular-nums"><thead><tr className="border-b border-edge text-left text-xs uppercase text-muted"><th className="px-4 py-2">Titolo</th><th className="px-4 py-2">Autore</th><th className="px-4 py-2">Stato</th><th className="px-4 py-2">Categoria</th><th className="px-4 py-2">Aggiornato</th></tr></thead><tbody>{(!data || data.journalistArticles.length === 0) && !loading && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">Nessun articolo giornalista finora.</td></tr>}{data?.journalistArticles.map((article) => <tr key={article.id} className="border-b border-edge last:border-0"><td className="px-4 py-2 text-strong">{article.title || article.id}</td><td className="px-4 py-2 text-subtle">{article.authorName || article.authorEmail || '—'}</td><td className="px-4 py-2"><AdminStatusPill tone={article.status === 'published' ? 'success' : article.status === 'blocked' ? 'danger' : 'neutral'}>{article.status || '—'}</AdminStatusPill></td><td className="px-4 py-2 text-subtle">{article.category || '—'}</td><td className="px-4 py-2 text-subtle">{article.updatedAt ? new Date(article.updatedAt).toLocaleDateString('it-CH') : '—'}</td></tr>)}</tbody></table></div></div>
    </div>
  );
}
