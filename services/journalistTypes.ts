/**
 * Journalist publishing portal — shared domain types (pure type module, no runtime).
 *
 * Firestore collections (see firestore.rules):
 *   journalists/{uid}            — role grant (owner-only read; Admin SDK write via
 *                                  the manageJournalistRole Cloud Function)
 *   journalist_articles/{id}     — one article draft/queued/published/failed record.
 *                                  `id` doubles as the article id used by the shared
 *                                  generation pipeline (scripts/create-article.mjs)
 *                                  once it is published.
 *
 * A journalist authors the IT (source) locale only — EN/DE/FR are produced
 * automatically by the same translateArticle()/enforceStrongInternalLinks()
 * steps the automated pipeline uses (see scripts/publish-journalist-article.mjs),
 * so this type only carries `content.it` client-side.
 */

/** Mirrors the categories accepted by scripts/create-article.mjs's article schema. */
export type JournalistArticleCategory = 'fiscale' | 'pratico' | 'novita' | 'pensione';

export type JournalistArticleStatus = 'draft' | 'queued' | 'published' | 'failed';

/**
 * The journalist authors only title + a single free-text body. Sentence-case
 * title normalization, excerpt, paragraph split (body1/body2/body3), and FAQ
 * are all derived server-side by scripts/publish-journalist-article.mjs at
 * publish time (deriveJournalistContent(), reusing the same generation
 * helpers as the automated article pipeline).
 */
export interface JournalistArticleLocaleContent {
  title: string;
  body: string;
}

export type ArticleLocale = 'it' | 'en' | 'de' | 'fr';

export interface JournalistArticleAnalytics {
  /** Composite score from scripts/fetch-article-performance.mjs (data/article-performance.json). */
  score?: number;
  clicks?: number;
  impressions?: number;
  /** Recency-weighted view count from scripts/fetch-article-trending.mjs (public/article-trending.json). */
  views?: number;
  updatedAt?: string; // ISO 8601, set by the writeback step in either fetch script
}

export interface JournalistArticleLinkCheckResult {
  checkedAt?: string; // ISO 8601
  totalLinks?: number;
  brokenLinks?: number;
  brokenUrls?: string[];
}

export interface JournalistArticle {
  /** Kebab-case slug; also the Firestore document id and the pipeline article id. */
  id: string;
  authorUid: string;
  authorName: string;
  authorEmail: string;
  category: JournalistArticleCategory;
  /** Storage download URL of the uploaded hero image (before publish) or repo-relative path (after). */
  image: string;
  imageAlt: string;
  content: { it: JournalistArticleLocaleContent };
  status: JournalistArticleStatus;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  publishedAt?: string;
  /** Filled by scripts/publish-journalist-article.mjs once registerArticleFiles() succeeds. */
  slugs?: Partial<Record<ArticleLocale, string>>;
  publishedUrls?: Partial<Record<ArticleLocale, string>>;
  /**
   * Null while status is 'published' but the deploy carrying this article
   * hasn't landed yet (registerArticleFiles() ran, commit/push/deploy did
   * not). Stamped by scripts/notify-journalist-article-live.mjs only after
   * curling all 4 locale URLs and confirming 200 post-deploy — this is the
   * field that means "actually reachable", not just "files registered".
   * See isArticleLive() below; the dashboard gates clickable links and the
   * "your article is live" copy on this, not on status alone.
   */
  liveVerifiedAt?: string;
  /** Set when status === 'failed'; cleared on successful resubmission. */
  errorMessage?: string;
  analytics?: JournalistArticleAnalytics;
  linkCheck?: Partial<Record<ArticleLocale, JournalistArticleLinkCheckResult>>;
}

export const JOURNALIST_STATUS_PILL: Record<JournalistArticleStatus, { label: string; color: string }> = {
  draft: { label: 'Bozza', color: '#6b7280' },
  queued: { label: 'In coda', color: '#d97706' },
  published: { label: 'Pubblicato', color: '#16a34a' },
  failed: { label: 'Errore', color: '#dc2626' },
};

export function canEditContent(status: JournalistArticleStatus): boolean {
  return status === 'draft' || status === 'failed';
}

export function canSubmit(status: JournalistArticleStatus): boolean {
  return status === 'draft' || status === 'failed';
}

export function canDelete(status: JournalistArticleStatus): boolean {
  return status === 'draft';
}

/** True only once the deploy has actually landed and every locale URL was
 * confirmed reachable (see `liveVerifiedAt` above) — status 'published'
 * alone means "files registered", not "live". */
export function isArticleLive(article: Pick<JournalistArticle, 'status' | 'liveVerifiedAt'>): boolean {
  return article.status === 'published' && !!article.liveVerifiedAt;
}

export const JOURNALIST_ARTICLE_CATEGORIES: JournalistArticleCategory[] = [
  'fiscale',
  'pratico',
  'novita',
  'pensione',
];
