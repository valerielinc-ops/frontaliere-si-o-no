/**
 * JournalistDashboardPage — self-serve authoring & publish-status dashboard
 * for accounts granted the journalist role (see hooks/useJournalistRole.ts;
 * granted/revoked from AdminPanel.tsx's "Giornalisti" section via the
 * manageJournalistRole Cloud Function).
 *
 * Flow:
 *  1. Auth gate (useAuth) — mirrors PublisherPublishPage.tsx's spinner +
 *     SocialSignInButtons pattern.
 *  2. Journalist-role gate (useJournalistRole) — plain "not authorized"
 *     message when the account has no active `journalists/{uid}` grant.
 *  3. Dashboard: article list -> create/edit a draft -> submit for
 *     publishing -> track status/analytics/link-health.
 *
 * The journalist authors the IT (source) locale only; EN/DE/FR are produced
 * server-side by scripts/publish-journalist-article.mjs once a draft is
 * submitted (status 'queued'). That script (and the resulting 'published' /
 * 'failed' transition) is out of scope here — this page only reads/writes
 * via services/journalistArticleService.ts (Firestore/Storage, journalist-owned
 * writes are restricted to 'draft'/'queued' by firestore.rules).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Newspaper,
  Plus,
  Trash2,
  Send,
  ImagePlus,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  ExternalLink,
  BarChart3,
  Link2,
  RotateCcw,
  Pencil,
  Clock,
  Bold,
  Sparkles,
  LayoutGrid,
  Upload,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useAuth } from '@/services/authService';
import { buildPath } from '@/services/router';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import { useJournalistRole } from '@/hooks/useJournalistRole';
import { reportCaughtError } from '@/services/errorReporter';
import {
  slugifyArticleTitle,
  createDraft,
  saveDraft,
  submitForPublish,
  deleteDraft,
  listMyArticles,
  getArticle,
  uploadArticleImage,
} from '@/services/journalistArticleService';
import {
  JOURNALIST_STATUS_PILL,
  JOURNALIST_ARTICLE_CATEGORIES,
  canEditContent,
  canSubmit,
  canDelete,
  isArticleLive,
} from '@/services/journalistTypes';
import type {
  JournalistArticle,
  JournalistArticleCategory,
  JournalistArticleLocaleContent,
  ArticleLocale,
} from '@/services/journalistTypes';
import { searchImageCatalog, listAllCatalogImages, type CatalogImageCandidate } from '@/services/journalistImageCatalog';
import { cdnBlogImage } from '@/services/seo/blogImageCdn';
import { extractArticleBodyFromFile, DOC_LEGACY_UNSUPPORTED } from '@/services/articleDocumentImport';

type ViewMode = 'list' | 'article';

const ARTICLE_LOCALES: ArticleLocale[] = ['it', 'en', 'de', 'fr'];
const CATALOG_PAGE_SIZE = 60;
const LOCALE_LABELS: Record<ArticleLocale, string> = {
  it: 'Italiano',
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
};

// Kept in sync with scripts/create-article.mjs's TITLE_CASING_PROPER_NOUNS.
const TITLE_CASING_PROPER_NOUNS = new Set([
  'ticino', 'zurigo', 'berna', 'ginevra', 'basilea', 'argovia', 'turgovia',
  'sciaffusa', 'soletta', 'lucerna', 'uri', 'svitto', 'untervaldo', 'glarona',
  'zugo', 'friburgo', 'vaud', 'vallese', 'neuchâtel', 'giura', 'grigioni',
  'appenzello', 'sangallo', 'lugano', 'bellinzona', 'locarno', 'chiasso',
  'mendrisio', 'losanna', 'svizzera', 'italia', 'germania', 'francia',
  'austria', 'liechtenstein',
]);

/**
 * Client-side preview of scripts/create-article.mjs's normalizeTitleCasing()
 * — kept as a small, deliberately-duplicated pure-string function rather than
 * a shared import: importing from scripts/*.mjs into the Vite client bundle
 * would drag in Node-only dependencies (fs/sharp/firebase-admin) transitively
 * pulled in by that file. The server-side copy is authoritative at publish
 * time; this is purely a "here's what will be saved" hint for the journalist.
 */
function normalizeTitleCasingPreview(rawTitle: string): string {
  const s = rawTitle.replace(/\s+/g, ' ').trim();
  if (!s) return s;
  const words = s.split(' ');
  const looksTitleCase = words.filter((w) => /^[A-ZÀ-Ý]/.test(w)).length >= Math.ceil(words.length * 0.6);
  if (!looksTitleCase) return s;
  return words
    .map((w, idx) => {
      const isAcronym = w.length > 1 && w === w.toUpperCase() && w !== w.toLowerCase();
      if (isAcronym) return w;
      const bareLower = w.replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ]+$/g, '').toLowerCase();
      if (TITLE_CASING_PROPER_NOUNS.has(bareLower)) return w;
      const lower = w.toLowerCase();
      return idx === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

function formatDate(iso: string | undefined, locale: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(locale === 'it' ? 'it-CH' : locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function StatusPill({ article }: { article: JournalistArticle }): React.ReactElement {
  const { t } = useTranslation();
  // status 'published' means "files registered", not "live" — see
  // isArticleLive()/liveVerifiedAt in journalistTypes.ts. Show a distinct
  // pending pill (reusing 'queued's amber) until the deploy is confirmed.
  const pendingDeploy = article.status === 'published' && !isArticleLive(article);
  const meta = pendingDeploy ? JOURNALIST_STATUS_PILL.queued : JOURNALIST_STATUS_PILL[article.status];
  const labelKey = pendingDeploy ? 'journalistDashboard.status.publishing' : `journalistDashboard.status.${article.status}`;
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ color: meta.color, backgroundColor: `${meta.color}1a`, border: `1px solid ${meta.color}40` }}
    >
      {t(labelKey, meta.label)}
    </span>
  );
}

export default function JournalistDashboardPage(): React.ReactElement {
  const { t, locale } = useTranslation();
  const { user, loading: authLoading } = useAuth();
  const { isJournalist, loading: roleLoading } = useJournalistRole(user);

  const [view, setView] = useState<ViewMode>('list');
  const [articles, setArticles] = useState<JournalistArticle[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // ── Editor / detail state for the currently-open article ──────
  const [draftId, setDraftId] = useState<string | null>(null); // null while composing a brand-new draft
  const [openArticle, setOpenArticle] = useState<JournalistArticle | null>(null); // full record once persisted
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const [importingDocument, setImportingDocument] = useState(false);
  const [category, setCategory] = useState<JournalistArticleCategory>(JOURNALIST_ARTICLE_CATEGORIES[0]);
  const [image, setImage] = useState('');
  const [imageAlt, setImageAlt] = useState('');
  const [slugTaken, setSlugTaken] = useState(false);
  const [checkingSlug, setCheckingSlug] = useState(false);
  const [imageCandidates, setImageCandidates] = useState<CatalogImageCandidate[] | null>(null);
  const [suggestingImages, setSuggestingImages] = useState(false);
  const [allCatalogImages, setAllCatalogImages] = useState<CatalogImageCandidate[] | null>(null);
  const [browsingCatalog, setBrowsingCatalog] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [visibleCatalogCount, setVisibleCatalogCount] = useState(CATALOG_PAGE_SIZE);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const computedSlug = useMemo(() => slugifyArticleTitle(title), [title]);

  const loadArticles = async (uid: string) => {
    setListError(null);
    try {
      const rows = await listMyArticles(uid);
      setArticles(rows);
    } catch (err) {
      reportCaughtError(err, 'journalistDashboard.list');
      setListError(t('journalistDashboard.list.error'));
      setArticles([]);
    }
  };

  useEffect(() => {
    if (user && isJournalist) {
      void loadArticles(user.uid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, isJournalist]);

  const resetForm = () => {
    setDraftId(null);
    setOpenArticle(null);
    setTitle('');
    setBody('');
    setCategory(JOURNALIST_ARTICLE_CATEGORIES[0]);
    setImage('');
    setImageAlt('');
    setSlugTaken(false);
    setSaveMsg(null);
    setShowSubmitConfirm(false);
    setShowDeleteConfirm(false);
    setImageCandidates(null);
  };

  const openNewDraft = () => {
    resetForm();
    setView('article');
  };

  const openExisting = (article: JournalistArticle) => {
    setDraftId(article.id);
    setOpenArticle(article);
    const content = article.content.it;
    setTitle(content.title);
    // Backward-compat: pre-PR#3222 drafts stored {title, excerpt, body1, body2, body3, faq}
    // instead of {title, body}. content.body is absent at runtime on those documents even though
    // the type says string — reconstruct from old fields to prevent silent data loss on open+save.
    const rawBody: string | undefined = content.body as string | undefined;
    const legacy = content as Record<string, unknown>;
    setBody(
      rawBody ||
        [legacy['excerpt'], legacy['body1'], legacy['body2'], legacy['body3']]
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .join('\n\n'),
    );
    setCategory(article.category);
    setImage(article.image);
    setImageAlt(article.imageAlt);
    setSlugTaken(false);
    setSaveMsg(null);
    setShowSubmitConfirm(false);
    setShowDeleteConfirm(false);
    setImageCandidates(null);
    setView('article');
  };

  const backToList = () => {
    setView('list');
    resetForm();
    if (user) void loadArticles(user.uid);
  };

  const handleTitleBlur = async () => {
    if (draftId || !title.trim()) return; // slug is only re-checked before the article exists
    setCheckingSlug(true);
    try {
      const existing = await getArticle(computedSlug);
      setSlugTaken(!!existing);
    } catch (err) {
      reportCaughtError(err, 'journalistDashboard.slugCheck');
    } finally {
      setCheckingSlug(false);
    }
  };

  const currentContent = (): JournalistArticleLocaleContent => ({
    title: title.trim(),
    body,
  });

  const handleSaveDraft = async () => {
    if (!user || saving) return;
    if (!title.trim()) {
      setSaveMsg({ ok: false, text: t('journalistDashboard.editor.titleRequired') });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      if (!draftId) {
        if (slugTaken) {
          setSaveMsg({ ok: false, text: t('journalistDashboard.editor.slugTaken') });
          setSaving(false);
          return;
        }
        const id = computedSlug || `articolo-${Date.now()}`;
        await createDraft({
          id,
          authorUid: user.uid,
          authorName: user.displayName || user.email || 'Redazione',
          authorEmail: user.email || '',
          category,
          imageAlt,
          content: currentContent(),
        });
        setDraftId(id);
        const fresh = await getArticle(id);
        if (fresh) setOpenArticle(fresh);
      } else {
        await saveDraft(draftId, { category, image, imageAlt, content: currentContent() });
        const fresh = await getArticle(draftId);
        if (fresh) setOpenArticle(fresh);
      }
      setSaveMsg({ ok: true, text: t('journalistDashboard.editor.saved') });
    } catch (err) {
      reportCaughtError(err, 'journalistDashboard.save');
      setSaveMsg({ ok: false, text: t('journalistDashboard.editor.saveError') });
    } finally {
      setSaving(false);
    }
  };

  /** Keeps a manually-entered alt untouched; only fills it in when blank (title-derived template). */
  const withAutoImageAlt = (currentAlt: string): string =>
    currentAlt.trim() || (title.trim() ? t('journalistDashboard.editor.imageAltAuto', { title: title.trim() }) : currentAlt);

  const handleImageUpload = async (file: File) => {
    if (!user || !draftId) return;
    setUploadingImage(true);
    try {
      const url = await uploadArticleImage(user.uid, draftId, file);
      const autoAlt = withAutoImageAlt(imageAlt);
      setImage(url);
      if (autoAlt !== imageAlt) setImageAlt(autoAlt);
      await saveDraft(draftId, { image: url, imageAlt: autoAlt });
      setSaveMsg({ ok: true, text: t('journalistDashboard.editor.imageSaved') });
    } catch (err) {
      reportCaughtError(err, 'journalistDashboard.imageUpload');
      setSaveMsg({ ok: false, text: t('journalistDashboard.editor.imageError') });
    } finally {
      setUploadingImage(false);
    }
  };

  /** Extracts plain text from an uploaded Word/PDF/Markdown file and fills the body textarea with it. */
  const handleDocumentImport = async (file: File) => {
    if (body.trim() && typeof window !== 'undefined' && !window.confirm(t('journalistDashboard.editor.importReplaceConfirm'))) {
      return;
    }
    setImportingDocument(true);
    setSaveMsg(null);
    try {
      const text = await extractArticleBodyFromFile(file);
      setBody(text);
      setSaveMsg({ ok: true, text: t('journalistDashboard.editor.importSuccess') });
    } catch (err) {
      reportCaughtError(err, 'journalistDashboard.documentImport');
      const message =
        err instanceof Error && err.message === DOC_LEGACY_UNSUPPORTED
          ? t('journalistDashboard.editor.importDocUnsupported')
          : t('journalistDashboard.editor.importError');
      setSaveMsg({ ok: false, text: message });
    } finally {
      setImportingDocument(false);
    }
  };

  /** Wraps the current textarea selection in `**...**` (or inserts an empty pair at the caret). No rich-text lib in this repo — plain markdown, same convention splitBodyIntoSections() preserves server-side. */
  const handleBoldToggle = () => {
    const el = bodyRef.current;
    if (!el) return;
    const { selectionStart, selectionEnd, value } = el;
    const selected = value.slice(selectionStart, selectionEnd);
    const next = `${value.slice(0, selectionStart)}**${selected}**${value.slice(selectionEnd)}`;
    setBody(next);
    const newStart = selectionStart + 2;
    const newEnd = newStart + selected.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newStart, newEnd);
    });
  };

  const handleSearchCatalog = async () => {
    if (suggestingImages || !title.trim()) return;
    setSuggestingImages(true);
    setImageCandidates(null);
    setBrowsingCatalog(false);
    try {
      const candidates = await searchImageCatalog(title, body);
      setImageCandidates(candidates);
    } catch (err) {
      reportCaughtError(err, 'journalistDashboard.searchCatalog');
      setSaveMsg({ ok: false, text: t('journalistDashboard.editor.suggestImagesError') });
    } finally {
      setSuggestingImages(false);
    }
  };

  const handleToggleBrowseCatalog = async () => {
    if (browsingCatalog) {
      setBrowsingCatalog(false);
      return;
    }
    setImageCandidates(null);
    setBrowsingCatalog(true);
    setVisibleCatalogCount(CATALOG_PAGE_SIZE);
    if (allCatalogImages) return;
    setLoadingCatalog(true);
    try {
      const all = await listAllCatalogImages();
      setAllCatalogImages(all);
    } catch (err) {
      reportCaughtError(err, 'journalistDashboard.browseCatalog');
      setSaveMsg({ ok: false, text: t('journalistDashboard.editor.suggestImagesError') });
      setBrowsingCatalog(false);
    } finally {
      setLoadingCatalog(false);
    }
  };

  const handlePickCatalogImage = async (path: string) => {
    const autoAlt = withAutoImageAlt(imageAlt);
    setImage(path);
    if (autoAlt !== imageAlt) setImageAlt(autoAlt);
    setImageCandidates(null);
    setBrowsingCatalog(false);
    if (draftId) {
      try {
        await saveDraft(draftId, { image: path, imageAlt: autoAlt });
        setSaveMsg({ ok: true, text: t('journalistDashboard.editor.imageSaved') });
      } catch (err) {
        reportCaughtError(err, 'journalistDashboard.imageUpload');
        setSaveMsg({ ok: false, text: t('journalistDashboard.editor.imageError') });
      }
    }
  };

  /** Shared thumbnail button for both keyword-suggested and browse-all-catalog grids. */
  const renderCatalogImageButton = (candidate: CatalogImageCandidate) => {
    const isSelected = candidate.path === image;
    return (
      <button
        key={candidate.path}
        type="button"
        onClick={() => { void handlePickCatalogImage(candidate.path); }}
        aria-label={t('journalistDashboard.editor.selectImage')}
        aria-pressed={isSelected}
        className={`relative rounded-xl overflow-hidden border transition-shadow ${
          isSelected ? 'border-accent ring-2 ring-accent' : 'border-edge hover:ring-2 hover:ring-accent'
        }`}
      >
        <img src={cdnBlogImage(candidate.path)} alt="" width={1200} height={675} loading="lazy" className="w-full h-20 object-cover" />
        {isSelected && (
          <span className="absolute top-1 right-1 rounded-full bg-accent text-on-accent p-0.5">
            <CheckCircle2 className="w-4 h-4" />
          </span>
        )}
      </button>
    );
  };

  const handleSubmit = async () => {
    if (!draftId || submitting) return;
    setSubmitting(true);
    try {
      await submitForPublish(draftId);
      const fresh = await getArticle(draftId);
      if (fresh) setOpenArticle(fresh);
      setShowSubmitConfirm(false);
      setSaveMsg({ ok: true, text: t('journalistDashboard.editor.submitted') });
      if (user) void loadArticles(user.uid);
    } catch (err) {
      reportCaughtError(err, 'journalistDashboard.submit');
      setSaveMsg({ ok: false, text: t('journalistDashboard.editor.submitError') });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!draftId || deleting) return;
    setDeleting(true);
    try {
      await deleteDraft(draftId);
      backToList();
    } catch (err) {
      reportCaughtError(err, 'journalistDashboard.delete');
      setSaveMsg({ ok: false, text: t('journalistDashboard.editor.deleteError') });
      setDeleting(false);
    }
  };

  // ── Auth gate ───────────────────────────────────────────────
  if (authLoading && !user) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-24 flex flex-col items-center justify-center text-center">
        <div
          className="animate-spin rounded-full h-8 w-8 border-2 border-edge border-t-accent"
          role="status"
          aria-label={t('journalistDashboard.loadingAuth')}
        />
        <span className="sr-only">{t('journalistDashboard.loadingAuth')}</span>
      </div>
    );
  }

  if (!authLoading && !user) {
    return (
      <div className="max-w-md mx-auto px-4 py-12">
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-subtle mb-1">
            <Newspaper className="w-7 h-7 text-link" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong">
            {t('journalistDashboard.title')}
          </h1>
          <p className="text-subtle max-w-sm mx-auto">{t('journalistDashboard.gate.subtitle')}</p>
        </div>
        <div className="mt-6 space-y-4">
          {/* No consent notice: signing in here subscribes the visitor, but the
              write is App.tsx's under `signInAutoSubscribe` (displayed: false),
              so a rendered formula would not be the stored one. Declared in
              `SIGN_IN_SURFACES`, tests/consent-shown-at-signup.test.tsx (#5739). */}
          <SocialSignInButtons locale={locale} googleWidth={320} errorContext="journalistDashboard.gate" />
        </div>
      </div>
    );
  }

  // ── Journalist-role gate ────────────────────────────────────
  if (roleLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-24 flex flex-col items-center justify-center text-center">
        <div
          className="animate-spin rounded-full h-8 w-8 border-2 border-edge border-t-accent"
          role="status"
          aria-label={t('journalistDashboard.loadingRole')}
        />
        <span className="sr-only">{t('journalistDashboard.loadingRole')}</span>
      </div>
    );
  }

  if (!isJournalist) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-surface-alt mb-4">
          <Newspaper className="w-7 h-7 text-muted" />
        </div>
        <h1 className="text-xl font-bold font-display text-strong mb-2">
          {t('journalistDashboard.notAuthorized.title')}
        </h1>
        <p className="text-subtle">{t('journalistDashboard.notAuthorized.body')}</p>
      </div>
    );
  }

  // ── List view ───────────────────────────────────────────────
  if (view === 'list') {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-8">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong">
              {t('journalistDashboard.title')}
            </h1>
            <p className="text-subtle mt-1">{t('journalistDashboard.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={openNewDraft}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" />
            {t('journalistDashboard.newDraftCta')}
          </button>
        </div>

        {articles === null && (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent border-t-transparent" />
          </div>
        )}

        {listError && <p className="text-sm text-danger py-8 text-center">{listError}</p>}

        {articles !== null && articles.length === 0 && !listError && (
          <div className="rounded-3xl border border-dashed border-edge bg-surface-alt px-6 py-14 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent-subtle text-link mb-4">
              <Newspaper className="w-8 h-8" />
            </div>
            <h2 className="text-xl font-bold font-display text-strong mb-1.5">
              {t('journalistDashboard.empty.title')}
            </h2>
            <p className="text-subtle max-w-sm mx-auto mb-6">{t('journalistDashboard.empty.body')}</p>
            <button
              type="button"
              onClick={openNewDraft}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors"
            >
              <Plus className="w-4 h-4" />
              {t('journalistDashboard.newDraftCta')}
            </button>
          </div>
        )}

        {articles !== null && articles.length > 0 && (
          <ul className="space-y-3">
            {articles.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => openExisting(a)}
                  className="w-full text-left flex items-center gap-4 p-4 bg-surface border border-edge rounded-2xl hover:border-accent transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-strong truncate">
                      {a.content.it.title || t('journalistDashboard.untitled')}
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      {t(`journalistDashboard.category.${a.category}`, a.category)}
                      {' · '}
                      {t('journalistDashboard.updatedAt', { date: formatDate(a.updatedAt, locale) })}
                    </p>
                  </div>
                  <StatusPill article={a} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ── Article view (new draft or existing) ───────────────────
  const editable = !openArticle || canEditContent(openArticle.status);
  const submittable = !!draftId && !!openArticle && canSubmit(openArticle.status);
  const deletable = !!draftId && !!openArticle && canDelete(openArticle.status);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <button
        type="button"
        onClick={backToList}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-link hover:text-link-hover mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        {t('journalistDashboard.backToList')}
      </button>

      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <h1 className="text-xl sm:text-2xl font-bold font-display text-strong">
          {openArticle ? openArticle.content.it.title || t('journalistDashboard.untitled') : t('journalistDashboard.newDraftCta')}
        </h1>
        {openArticle && <StatusPill article={openArticle} />}
      </div>

      <p className="text-xs text-muted bg-surface-alt border border-edge rounded-lg p-2.5 mb-6">
        {t('journalistDashboard.editor.languageNote')}
      </p>

      {/* ── Status banners ─────────────────────────────────── */}
      {openArticle?.status === 'failed' && (
        <div className="flex items-start gap-2.5 p-4 bg-danger-subtle border border-danger-border rounded-xl mb-6">
          <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-danger">{t('journalistDashboard.detail.failedTitle')}</p>
            <p className="text-sm text-danger mt-0.5">
              {openArticle.errorMessage || t('journalistDashboard.detail.failedFallback')}
            </p>
          </div>
        </div>
      )}

      {openArticle?.status === 'queued' && (
        <div className="flex items-start gap-2.5 p-4 bg-warning-subtle border border-warning-border rounded-xl mb-6">
          <Clock className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <p className="text-sm text-warning">{t('journalistDashboard.detail.queuedInfo')}</p>
        </div>
      )}

      {/* status 'published' means "files registered", not "live" — the
          deploy carrying this article may still be queued behind other
          commits (has taken 30+ min in practice). Links only go clickable
          once liveVerifiedAt confirms all 4 locale URLs actually resolve
          (scripts/notify-journalist-article-live.mjs), matching the same
          gate the "your article is online" email now waits on. */}
      {openArticle?.status === 'published' && !isArticleLive(openArticle) && (
        <div className="flex items-start gap-2.5 p-4 bg-warning-subtle border border-warning-border rounded-xl mb-6">
          <Clock className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-warning">{t('journalistDashboard.detail.publishingInfo')}</p>
            <ul className="mt-2 space-y-1">
              {ARTICLE_LOCALES.map((loc) => {
                const url = openArticle.publishedUrls?.[loc];
                return (
                  <li key={loc} className="flex items-center gap-2 text-sm">
                    <span className="text-muted w-20 shrink-0">{LOCALE_LABELS[loc]}</span>
                    <span className="text-muted truncate">{url || t('journalistDashboard.detail.urlPending')}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {openArticle?.status === 'published' && isArticleLive(openArticle) && (
        <div className="p-4 bg-success-subtle border border-success-border rounded-xl mb-6">
          <p className="flex items-center gap-2 text-sm font-semibold text-success mb-2">
            <CheckCircle2 className="w-5 h-5" />
            {t('journalistDashboard.detail.publishedTitle')}
          </p>
          <ul className="space-y-1">
            {ARTICLE_LOCALES.map((loc) => {
              const url = openArticle.publishedUrls?.[loc];
              return (
                <li key={loc} className="flex items-center gap-2 text-sm">
                  <span className="text-muted w-20 shrink-0">{LOCALE_LABELS[loc]}</span>
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-link hover:text-link-hover truncate"
                    >
                      {url}
                      <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-muted">{t('journalistDashboard.detail.urlPending')}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── Analytics + link-check panels (only once the article exists) ── */}
      {openArticle && (
        <div className="grid sm:grid-cols-2 gap-4 mb-6">
          <div className="p-4 bg-surface-alt border border-edge rounded-xl">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-link mb-3">
              <BarChart3 className="w-3.5 h-3.5" />
              {t('journalistDashboard.detail.analyticsHeading')}
            </p>
            {openArticle.analytics && Object.keys(openArticle.analytics).length > 0 ? (
              <dl className="space-y-1.5 text-sm">
                {openArticle.analytics.views != null && (
                  <div className="flex justify-between">
                    <dt className="text-muted">{t('journalistDashboard.detail.analytics.views')}</dt>
                    <dd className="font-semibold text-strong">{openArticle.analytics.views}</dd>
                  </div>
                )}
                {openArticle.analytics.clicks != null && (
                  <div className="flex justify-between">
                    <dt className="text-muted">{t('journalistDashboard.detail.analytics.clicks')}</dt>
                    <dd className="font-semibold text-strong">{openArticle.analytics.clicks}</dd>
                  </div>
                )}
                {openArticle.analytics.impressions != null && (
                  <div className="flex justify-between">
                    <dt className="text-muted">{t('journalistDashboard.detail.analytics.impressions')}</dt>
                    <dd className="font-semibold text-strong">{openArticle.analytics.impressions}</dd>
                  </div>
                )}
                {openArticle.analytics.score != null && (
                  <div className="flex justify-between">
                    <dt className="text-muted">{t('journalistDashboard.detail.analytics.score')}</dt>
                    <dd className="font-semibold text-strong">{openArticle.analytics.score}</dd>
                  </div>
                )}
                {openArticle.analytics.updatedAt && (
                  <p className="text-xs text-muted pt-1">
                    {t('journalistDashboard.updatedAt', { date: formatDate(openArticle.analytics.updatedAt, locale) })}
                  </p>
                )}
              </dl>
            ) : (
              <p className="text-sm text-muted">{t('journalistDashboard.detail.analyticsUnavailable')}</p>
            )}
          </div>

          <div className="p-4 bg-surface-alt border border-edge rounded-xl">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-link mb-3">
              <Link2 className="w-3.5 h-3.5" />
              {t('journalistDashboard.detail.linkCheckHeading')}
            </p>
            {openArticle.linkCheck ? (
              <p className={`text-sm ${openArticle.linkCheck.brokenLinks ? 'text-danger' : 'text-success'}`}>
                {openArticle.linkCheck.brokenLinks
                  ? t('journalistDashboard.detail.linkCheck.broken', {
                      broken: openArticle.linkCheck.brokenLinks,
                      total: openArticle.linkCheck.totalLinks ?? 0,
                    })
                  : t('journalistDashboard.detail.linkCheck.ok', { total: openArticle.linkCheck.totalLinks ?? 0 })}
              </p>
            ) : (
              <p className="text-sm text-muted">{t('journalistDashboard.detail.linkCheckUnavailable')}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Editable form ───────────────────────────────────── */}
      {editable ? (
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-strong mb-1.5" htmlFor="jd-title">
              {t('journalistDashboard.editor.titleLabel')}
            </label>
            <input
              id="jd-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleBlur}
              className="w-full px-3.5 py-2.5 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-strong text-sm"
              placeholder={t('journalistDashboard.editor.titlePlaceholder')}
            />
            {!draftId && title.trim() && (
              <p className={`text-xs mt-1 ${slugTaken ? 'text-danger' : 'text-muted'}`}>
                {checkingSlug
                  ? t('journalistDashboard.editor.checkingSlug')
                  : slugTaken
                    ? t('journalistDashboard.editor.slugTaken')
                    : t('journalistDashboard.editor.slugPreview', { slug: computedSlug })}
              </p>
            )}
            {title.trim() && normalizeTitleCasingPreview(title.trim()) !== title.trim() && (
              <p className="text-xs mt-1 text-muted">
                {t('journalistDashboard.editor.titleCasingHint', { title: normalizeTitleCasingPreview(title.trim()) })}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-strong mb-1.5" htmlFor="jd-category">
              {t('journalistDashboard.editor.categoryLabel')}
            </label>
            <select
              id="jd-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as JournalistArticleCategory)}
              className="w-full px-3.5 py-2.5 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-strong text-sm"
            >
              {JOURNALIST_ARTICLE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`journalistDashboard.category.${c}`, c)}
                </option>
              ))}
            </select>
          </div>

          <p className="text-xs text-muted bg-surface-alt border border-edge rounded-lg p-2.5">
            {t('journalistDashboard.editor.enrichmentHint')}
          </p>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-strong" htmlFor="jd-body">
                {t('journalistDashboard.editor.bodyLabel')}
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  ref={documentInputRef}
                  type="file"
                  accept=".docx,.doc,.md,.markdown,.txt,.pdf"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void handleDocumentImport(file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => documentInputRef.current?.click()}
                  disabled={importingDocument}
                  title={t('journalistDashboard.editor.importDocumentTooltip')}
                  className="inline-flex items-center gap-1 px-2.5 h-7 rounded-lg border border-edge text-subtle hover:bg-surface-alt hover:text-strong disabled:opacity-60 transition-colors text-xs font-semibold"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {importingDocument ? t('journalistDashboard.editor.importing') : t('journalistDashboard.editor.importDocument')}
                </button>
                <button
                  type="button"
                  onClick={handleBoldToggle}
                  title={t('journalistDashboard.editor.boldTooltip')}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-edge text-subtle hover:bg-surface-alt hover:text-strong transition-colors"
                >
                  <Bold className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <textarea
              id="jd-body"
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={16}
              className="w-full px-3.5 py-2.5 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-strong text-sm resize-y font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-strong mb-1.5" htmlFor="jd-image">
              {t('journalistDashboard.editor.imageLabel')}
            </label>
            {image && (
              <img src={cdnBlogImage(image)} alt={imageAlt} width={1200} height={675} className="w-full max-w-sm rounded-xl border border-edge mb-2" />
            )}
            {draftId ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="jd-image"
                    type="file"
                    accept="image/*"
                    disabled={uploadingImage}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleImageUpload(file);
                    }}
                    className="block text-sm text-subtle file:mr-3 file:py-2 file:px-3.5 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-accent-subtle file:text-link hover:file:bg-accent-subtle/80"
                  />
                  <button
                    type="button"
                    onClick={() => { void handleSearchCatalog(); }}
                    disabled={suggestingImages || !title.trim()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-link border border-edge rounded-xl hover:bg-surface-alt disabled:opacity-60 transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {suggestingImages
                      ? t('journalistDashboard.editor.suggestingImages')
                      : t('journalistDashboard.editor.suggestImages')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleToggleBrowseCatalog(); }}
                    disabled={loadingCatalog}
                    aria-pressed={browsingCatalog}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-link border border-edge rounded-xl hover:bg-surface-alt disabled:opacity-60 transition-colors"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    {loadingCatalog
                      ? t('journalistDashboard.editor.loadingCatalog')
                      : browsingCatalog
                        ? t('journalistDashboard.editor.hideCatalog')
                        : t('journalistDashboard.editor.browseCatalog')}
                  </button>
                </div>
                {imageCandidates && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                    {imageCandidates.length === 0 ? (
                      <p className="text-xs text-muted col-span-full">
                        {t('journalistDashboard.editor.suggestImagesEmpty')}
                      </p>
                    ) : (
                      imageCandidates.map(renderCatalogImageButton)
                    )}
                  </div>
                )}
                {browsingCatalog && allCatalogImages && (
                  <div className="mt-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-96 overflow-y-auto p-0.5">
                      {allCatalogImages.slice(0, visibleCatalogCount).map(renderCatalogImageButton)}
                    </div>
                    {visibleCatalogCount < allCatalogImages.length && (
                      <button
                        type="button"
                        onClick={() => setVisibleCatalogCount((n) => n + CATALOG_PAGE_SIZE)}
                        className="mt-2 w-full text-sm font-semibold text-link border border-edge rounded-xl py-2 hover:bg-surface-alt transition-colors"
                      >
                        {t('journalistDashboard.editor.loadMoreImages', {
                          shown: String(Math.min(visibleCatalogCount, allCatalogImages.length)),
                          total: String(allCatalogImages.length),
                        })}
                      </button>
                    )}
                  </div>
                )}
                <input
                  type="text"
                  value={imageAlt}
                  onChange={(e) => setImageAlt(e.target.value)}
                  placeholder={t('journalistDashboard.editor.imageAltPlaceholder')}
                  className="w-full mt-2 px-3.5 py-2 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-strong text-sm"
                />
                {uploadingImage && (
                  <p className="flex items-center gap-1.5 text-xs text-muted mt-1">
                    <ImagePlus className="w-3.5 h-3.5 animate-pulse" />
                    {t('journalistDashboard.editor.uploadingImage')}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted">{t('journalistDashboard.editor.imageNeedsDraft')}</p>
            )}
          </div>

          {saveMsg && (
            <div
              className={`flex items-start gap-2 p-3 rounded-xl text-sm ${
                saveMsg.ok ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'
              }`}
            >
              {saveMsg.ok ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>{saveMsg.text}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => { void handleSaveDraft(); }}
              disabled={saving}
              className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-link border border-edge rounded-xl hover:bg-surface-alt disabled:opacity-60 transition-colors"
            >
              <Pencil className="w-4 h-4" />
              {saving ? t('journalistDashboard.editor.saving') : t('journalistDashboard.editor.saveCta')}
            </button>

            {submittable && !showSubmitConfirm && (
              <button
                type="button"
                onClick={() => setShowSubmitConfirm(true)}
                className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors"
              >
                <Send className="w-4 h-4" />
                {t('journalistDashboard.editor.submitCta')}
              </button>
            )}

            {deletable && !showDeleteConfirm && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-danger hover:bg-danger-subtle rounded-xl transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                {t('journalistDashboard.editor.deleteCta')}
              </button>
            )}
          </div>

          {showSubmitConfirm && (
            <div className="p-4 bg-accent-subtle border border-accent rounded-xl">
              <p className="text-sm text-strong mb-3">{t('journalistDashboard.editor.submitConfirm')}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { void handleSubmit(); }}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-lg disabled:opacity-60"
                >
                  <Send className="w-3.5 h-3.5" />
                  {submitting ? t('journalistDashboard.editor.submitting') : t('journalistDashboard.editor.submitConfirmYes')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowSubmitConfirm(false)}
                  className="px-4 py-2 text-sm font-medium text-subtle hover:bg-surface-alt rounded-lg"
                >
                  {t('journalistDashboard.editor.cancel')}
                </button>
              </div>
            </div>
          )}

          {showDeleteConfirm && (
            <div className="p-4 bg-danger-subtle border border-danger-border rounded-xl">
              <p className="text-sm text-strong mb-3">{t('journalistDashboard.editor.deleteConfirm')}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { void handleDelete(); }}
                  disabled={deleting}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-on-accent bg-danger hover:opacity-90 rounded-lg disabled:opacity-60"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {deleting ? t('journalistDashboard.editor.deleting') : t('journalistDashboard.editor.deleteConfirmYes')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-4 py-2 text-sm font-medium text-subtle hover:bg-surface-alt rounded-lg"
                >
                  {t('journalistDashboard.editor.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="p-4 bg-surface-alt border border-edge rounded-xl">
          <p className="flex items-center gap-1.5 text-sm text-subtle">
            <RotateCcw className="w-4 h-4 shrink-0" />
            {t('journalistDashboard.detail.readOnlyNotice')}
          </p>
        </div>
      )}
    </div>
  );
}
