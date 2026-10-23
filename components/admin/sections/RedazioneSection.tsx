import { useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, RefreshCw, Save, Search, X } from 'lucide-react';
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
import { AdminPagination } from '@/components/admin/ui/AdminPagination';
import { relativeTime } from '@/components/admin/lib/formatters';
import { replaceAdminQuery } from '@/components/admin/lib/adminNavigation';
import { useAdminNavigation } from '@/components/admin/lib/AdminNavigationContext';
import { pageSlice } from '@/components/admin/lib/pagination';

const PAGE_SIZE = 50;

function articleTitle(article: (typeof ARTICLES)[number]): string {
  const title = (article as { title?: unknown }).title;
  return typeof title === 'string' && title.trim() ? title.trim() : article.id;
}

export default function RedazioneSection() {
  const { user } = useAuth();
  const { locationKey } = useAdminNavigation();
  const { requestConfirmation } = useAdminConfirm();
  const [data, setData] = useState<RedazioneAdminData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<AdminMessage | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [editingProfileSlug, setEditingProfileSlug] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<AuthorProfilePatch>({});
  const [filter, setFilter] = useState(() => new URLSearchParams(window.location.search).get('q') || '');
  const [articlePage, setArticlePage] = useState(1);
  const [selectedArticleId, setSelectedArticleId] = useState('');
  const [selectedAuthorSlug, setSelectedAuthorSlug] = useState('');
  const latestArticleUpdate = data?.journalistArticles.map((article) => article.updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null;

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try { setData(await fetchRedazioneAdminData(user)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Errore sconosciuto'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadData(); }, [user]);

  const filteredArticles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return ARTICLES;
    return ARTICLES.filter((article) => `${articleTitle(article)} ${article.id} ${article.authorName || ''}`.toLowerCase().includes(query));
  }, [filter]);
  const selectedArticle = useMemo(() => ARTICLES.find((article) => article.id === selectedArticleId) || null, [selectedArticleId]);
  const pagedArticles = useMemo(() => pageSlice(filteredArticles, articlePage, PAGE_SIZE), [articlePage, filteredArticles]);
  useEffect(() => { setArticlePage(1); }, [filter]);
  useEffect(() => {
    if (selectedArticleId && !filteredArticles.some((article) => article.id === selectedArticleId)) setSelectedArticleId('');
  }, [filteredArticles, selectedArticleId]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get('q') || '';
    setFilter((current) => current === query ? current : query);
  }, [locationKey]);

  const saveProfile = async (slug: string) => {
    if (actionPending) return;
    setActionPending(true); setActionMessage(null);
    try { await updateAuthorProfile(user, slug, profileDraft); setActionMessage({ kind: 'ok', text: 'Profilo aggiornato.' }); setEditingProfileSlug(null); await loadData(); }
    catch (err) { setActionMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Errore sconosciuto' }); }
    finally { setActionPending(false); }
  };

  const reassignArticle = async () => {
    const articleId = selectedArticleId.trim();
    const author = getAllAuthors().find((candidate) => candidate.slug === selectedAuthorSlug.trim());
    if (!articleId || !author || actionPending) return;
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
    try { await reassignArticleAuthor(user, articleId, author.slug, author.name); setActionMessage({ kind: 'ok', text: `Articolo riassegnato a ${author.name}.` }); setSelectedArticleId(''); setSelectedAuthorSlug(''); await loadData(); }
    catch (err) { setActionMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Errore sconosciuto' }); }
    finally { setActionPending(false); }
  };

  return (
    <div className="space-y-6">
      <AdminSectionHeader title="Redazione" summary={`${getAllAuthors().length} profili editoriali · ${filteredArticles.length} articoli visibili · aggiornato ${relativeTime(latestArticleUpdate) || (loading ? 'in corso' : 'adesso')}`} secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading} onClick={() => void loadData()}>Aggiorna</AdminButton>} />
      {actionMessage && <AdminMessageBanner message={actionMessage} />}
      {error && <div className="bg-danger-subtle border border-danger-border rounded-stripe px-4 py-2 text-sm text-danger">{error}</div>}

      <section className="space-y-3" aria-labelledby="redazione-profili-title">
        <h3 id="redazione-profili-title" className="text-sm font-semibold text-strong">Firme e profili editoriali</h3>
        <p className="text-sm text-muted">Modifica descrizione, immagine e area editoriale delle firme senza deploy di codice. Le attribuzioni autenticate restano separate dal catalogo AI.</p>
        <div className="space-y-2">
          {getAllAuthors().map((author) => {
            const merged = { ...author, ...data?.authorProfiles[author.slug] };
            const editing = editingProfileSlug === author.slug;
            return <div key={author.slug} className="rounded-stripe border border-edge bg-surface p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold text-strong">{merged.name}</p><p className="text-sm text-subtle">{merged.role}</p></div>{!editing && <button type="button" onClick={() => { setEditingProfileSlug(author.slug); setProfileDraft({ name: merged.name, role: merged.role, bio: merged.bio, photoPath: merged.photoPath }); setActionMessage(null); }} className="inline-flex items-center gap-2 rounded-stripe border border-edge px-3 py-1.5 text-sm font-medium text-subtle"><Pencil size={14} aria-hidden="true" />Modifica</button>}</div>{editing && <div className="mt-3 space-y-2"><input value={profileDraft.name || ''} onChange={(event) => setProfileDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="Nome" aria-label={`Nome di ${merged.name}`} className="w-full rounded-stripe border border-edge bg-surface-alt px-3 py-2 text-sm text-strong" /><input value={profileDraft.role || ''} onChange={(event) => setProfileDraft((draft) => ({ ...draft, role: event.target.value }))} placeholder="Ruolo" aria-label={`Ruolo di ${merged.name}`} className="w-full rounded-stripe border border-edge bg-surface-alt px-3 py-2 text-sm text-strong" /><textarea value={profileDraft.bio || ''} onChange={(event) => setProfileDraft((draft) => ({ ...draft, bio: event.target.value }))} placeholder="Bio" rows={4} aria-label={`Bio di ${merged.name}`} className="w-full rounded-stripe border border-edge bg-surface-alt px-3 py-2 text-sm text-strong" /><input value={profileDraft.photoPath || ''} onChange={(event) => setProfileDraft((draft) => ({ ...draft, photoPath: event.target.value }))} placeholder="/images/authors/slug.webp" aria-label={`Immagine di ${merged.name}`} className="w-full rounded-stripe border border-edge bg-surface-alt px-3 py-2 text-sm text-strong" /><div className="flex items-center gap-2"><AdminButton variant="primary" icon={actionPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />} disabled={actionPending} onClick={() => void saveProfile(author.slug)}>Salva</AdminButton><AdminButton icon={<X size={14} aria-hidden="true" />} onClick={() => setEditingProfileSlug(null)}>Annulla</AdminButton></div></div>}</div>;
          })}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="redazione-catalogo-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h3 id="redazione-catalogo-title" className="text-sm font-semibold text-strong">Articoli del catalogo AI — {filteredArticles.length}{filter ? ` di ${ARTICLES.length}` : ''}</h3><p className="mt-1 text-xs text-muted">Cerca per titolo/slug o autore; seleziona un solo articolo per la riassegnazione.</p></div><div className="relative min-w-0 sm:w-72"><Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" /><input type="search" value={filter} onChange={(event) => { const value = event.target.value; setFilter(value); replaceAdminQuery({ q: value.trim() || null }); }} placeholder="Cerca titolo o autore…" aria-label="Cerca articolo per titolo o autore" className="w-full rounded-stripe border border-edge bg-surface-alt py-2 pl-8 pr-2 text-sm text-strong" /></div></div>
        <div className="grid gap-2 rounded-stripe border border-edge bg-surface p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-end"><div className="min-w-0"><p className="text-xs font-medium text-subtle">Articolo selezionato</p><p className={`mt-1 truncate text-sm ${selectedArticle ? 'text-heading' : 'text-muted'}`}>{selectedArticle ? articleTitle(selectedArticle) : 'Seleziona un articolo dalla tabella'}</p></div><label className="block text-xs font-medium text-subtle">Riassegna a<select value={selectedAuthorSlug} onChange={(event) => setSelectedAuthorSlug(event.target.value)} className="mt-1 w-full rounded-stripe border border-edge bg-surface-alt px-2 py-2 text-sm text-strong"><option value="">— seleziona autore —</option>{getAllAuthors().map((author) => <option key={author.slug} value={author.slug}>{author.name}</option>)}</select></label><AdminButton variant="primary" disabled={!selectedArticleId || !selectedAuthorSlug || actionPending} loading={actionPending} onClick={() => void reassignArticle()}>Riassegna articolo</AdminButton></div>
        <div className="overflow-x-auto rounded-stripe border border-edge bg-surface"><table className="w-full text-sm tabular-nums"><caption className="sr-only">Catalogo degli articoli AI</caption><thead className="bg-surface-alt"><tr className="border-b border-edge text-left text-xs uppercase text-muted"><th scope="col" className="px-4 py-2">Titolo/slug</th><th scope="col" className="px-4 py-2">Autore attuale</th><th scope="col" className="px-4 py-2">Selezionato</th></tr></thead><tbody>{pagedArticles.map((article) => { const override = data?.articleAuthorOverrides[article.id]; return <tr key={article.id} className="border-b border-edge last:border-0"><td className="px-4 py-2 text-strong">{articleTitle(article)}</td><td className="px-4 py-2 text-subtle">{override?.authorName || article.authorName || '—'}</td><td className="px-4 py-2"><button type="button" onClick={() => setSelectedArticleId(article.id)} className="min-h-10 rounded-stripe border border-edge px-3 py-1.5 text-xs font-medium text-body hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-pressed={selectedArticleId === article.id}>{selectedArticleId === article.id ? 'Selezionato' : 'Seleziona'}</button></td></tr>; })}{pagedArticles.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-muted">Nessun articolo trovato.</td></tr>}</tbody></table></div>
        <AdminPagination page={articlePage} total={filteredArticles.length} onPageChange={setArticlePage} pageSize={PAGE_SIZE} />
      </section>

      <section className="space-y-3" aria-labelledby="redazione-giornalisti-title"><h3 id="redazione-giornalisti-title" className="text-sm font-semibold text-strong">Articoli giornalisti (tutti gli autori) — {data?.journalistArticles.length ?? 0}</h3><div className="overflow-x-auto rounded-stripe border border-edge bg-surface"><table className="w-full text-sm tabular-nums"><caption className="sr-only">Articoli degli autori giornalisti</caption><thead><tr className="border-b border-edge text-left text-xs uppercase text-muted"><th scope="col" className="px-4 py-2">Titolo</th><th scope="col" className="px-4 py-2">Autore</th><th scope="col" className="px-4 py-2">Stato</th><th scope="col" className="px-4 py-2">Categoria</th><th scope="col" className="px-4 py-2">Aggiornato</th></tr></thead><tbody>{(!data || data.journalistArticles.length === 0) && !loading && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">Nessun articolo giornalista finora.</td></tr>}{data?.journalistArticles.map((article) => <tr key={article.id} className="border-b border-edge last:border-0"><td className="px-4 py-2 text-strong">{article.title || article.id}</td><td className="px-4 py-2 text-subtle">{article.authorName || article.authorEmail || '—'}</td><td className="px-4 py-2"><AdminStatusPill tone={article.status === 'published' ? 'success' : article.status === 'blocked' ? 'danger' : 'neutral'}>{article.status || '—'}</AdminStatusPill></td><td className="px-4 py-2 text-subtle">{article.category || '—'}</td><td className="px-4 py-2 text-subtle">{article.updatedAt ? new Date(article.updatedAt).toLocaleDateString('it-CH') : '—'}</td></tr>)}</tbody></table></div></section>
    </div>
  );
}
