/**
 * News Sitemap Topic Whitelist (Google News C1 — see docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4 FASE 3 C1).
 *
 * Google News rewards topical authority. The whitelist filters articles so only
 * those matching the 5 + 1 macro-themes survive in `sitemap-news.xml`:
 *   1. Fisco / tasse / dichiarazione / nuovo accordo 2026
 *   2. AVS / LPP / pensioni / previdenza
 *   3. LAMal / cassa malati / tassa salute
 *   4. Dogana / frontiera / permit G/B / lavoro frontaliere / salari
 *   5. Cambio valuta / CHF-EUR / bonifico / tasso
 *   6. Trasporti frontaliere / treno / auto / traffico / webcam dogana
 *
 * **Important** (per memory `feedback_never_noindex_without_approval`):
 * Filtered-out articles stay in `sitemap-blog.xml` and remain reachable —
 * we ONLY reduce noise in the news sitemap. Never noindex, never delete HTML.
 */

/** Case-insensitive substring tokens. Match runs against slug + title + section + tags + keywords. */
export const NEWS_SITEMAP_WHITELIST: readonly string[] = Object.freeze([
  // 1. Fisco / tasse / dichiarazione / accordo
  'fisco',
  'fiscale',
  'tasse',
  'tassa',
  '730',
  'dichiarazione',
  'irpef',
  'nuovo-accordo-2026',
  'nuovo accordo',
  'accordo-fiscale',
  'imposta-fonte',
  'imposta alla fonte',
  'valore-locativo',
  'valore locativo',
  'perequazione',
  'ristorni',

  // 2. AVS / LPP / pensione / previdenza
  'avs',
  'lpp',
  'pensione',
  'pensioni',
  'previdenza',
  'pilastro-3a',
  'terzo pilastro',

  // 3. LAMal / assicurazione malattia / cassa malati / tassa salute
  'lamal',
  'assicurazione-malattia',
  'assicurazione malattia',
  'cassa-malati',
  'cassa malati',
  'cmi',
  'tassa-salute',
  'tassa salute',

  // 4. Dogana / frontiera / permit / lavoro frontaliere / salari
  // NOTE: do NOT add standalone "frontaliere/frontalieri" — they appear in
  // virtually every Ticino-news slug and would defeat the filter. The compound
  // tokens below (lavoro-frontaliere, parita-frontalieri, ristorni-frontalieri)
  // are intentional: they capture genuine cross-border-worker stories.
  'dogana',
  'frontiera',
  'varco',
  'permit-g',
  'permit g',
  'permesso g',
  'permit-b',
  'permit b',
  'permesso b',
  'lavoro-frontaliere',
  'lavoro frontaliere',
  'parita-frontalieri',
  'parita frontalieri',
  'ristorni-frontalieri',
  'ristorni frontalieri',
  'salari',
  'salario',
  'stipendi',
  'stipendio',
  'contratto',
  'dumping-salariale',
  'dumping salariale',
  'frontalieri-ticino',
  'frontalieri del ticino',
  'frontaliere ticino',
  'lavoratori-frontalieri',
  'lavoratori frontalieri',
  'disoccupazione',
  'occupazione-ticino',
  'occupazione ticino',
  'mercato-lavoro',
  'mercato del lavoro',

  // 5. Cambio valuta / CHF-EUR / bonifico / tasso
  'cambio-valuta',
  'cambio valuta',
  'chf-eur',
  'chf eur',
  'franco-svizzero',
  'franco svizzero',
  'franco forte',
  'bonifico',
  'tasso',
  'tassi-bce',
  'tassi bce',
  'inflazione',
  'bce-tassi',
  'bce tassi',

  // 6. Trasporti frontaliere / treno / auto / traffico / webcam
  // NOTE: "auto" alone is too noisy (matches "automatic", "autorita", etc.).
  // Use compound tokens that name the frontaliere transport context.
  'trasporti-frontaliere',
  'trasporti frontaliere',
  'treno',
  'tilo',
  'traffico',
  'webcam-dogana',
  'webcam dogana',
  'autisti-bus',
  'autisti bus',
  'a2-melide',
  'a2 melide',
  'a2-chiasso',
  'a2 chiasso',
  'pendolarismo',
  'autostrada-a2',
  'autostrada a2',
  'ffs-ticino',
  'ffs ticino',
  'treni-svizzeri',
  'treni svizzeri',
  'ferrovia-ticino',
]);

/** Subset shape required to evaluate eligibility. Matches the runtime data we have available
 *  (`Article` from data/blog-articles-data.ts merged with optional SEO fields and a slug). */
export interface NewsEligibilityArticle {
  /** Canonical IT slug (URL path segment) — e.g. `a2-melide-chiusure-notturne-lavori`. */
  slug: string;
  /** Optional headline / title (from create-article.mjs `data.content.it.title`). */
  title?: string;
  /** Schema.org `articleSection` — usually `Fiscale | Pratico | Pensione | Novità`. */
  articleSection?: string;
  /** Free-form tags (any locale, any source). */
  tags?: readonly string[];
  /** Comma-separated keywords string from SEO metadata. */
  keywords?: string;
  /** ISO publication date. Required for the 48h news window. */
  publishedAt?: string | Date;
}

/** Google News sitemap window (per spec, articles older than ~2 days are dropped by Google). */
export const NEWS_SITEMAP_WINDOW_HOURS = 48;

/** Lowercase a value safely (handles undefined/null). */
function toLower(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase();
}

/**
 * Returns true iff the article matches at least one whitelist token AND was
 * published within the last {@link NEWS_SITEMAP_WINDOW_HOURS} hours.
 *
 * Match is a case-insensitive substring search across slug, title,
 * articleSection, tags, and keywords. This is intentional — slug tokens
 * (`a2-melide-...`) and free-form keywords need to overlap with the same list.
 *
 * @param article  The article to evaluate.
 * @param now      Optional clock injection for tests (defaults to Date.now()).
 */
export function isArticleNewsEligible(
  article: NewsEligibilityArticle,
  now: number = Date.now(),
): boolean {
  // 1. 48h freshness window — Google News spec.
  if (article.publishedAt !== undefined) {
    const ts = article.publishedAt instanceof Date
      ? article.publishedAt.getTime()
      : new Date(article.publishedAt).getTime();
    if (Number.isNaN(ts)) return false;
    const ageMs = now - ts;
    if (ageMs < 0) return false; // future-dated = malformed, drop
    if (ageMs > NEWS_SITEMAP_WINDOW_HOURS * 60 * 60 * 1000) return false;
  }

  // 2. Topic whitelist — substring match across all available text fields.
  const haystack = [
    toLower(article.slug),
    toLower(article.title),
    toLower(article.articleSection),
    toLower(article.keywords),
    ...(article.tags ?? []).map(toLower),
  ].join('  '); // unique separator avoids spurious cross-field matches

  for (const token of NEWS_SITEMAP_WHITELIST) {
    if (haystack.includes(token.toLowerCase())) return true;
  }
  return false;
}

/**
 * Returns the list of whitelist tokens that a given article matched.
 * Useful for dry-run reports and debugging the filter.
 */
export function matchedWhitelistTokens(article: NewsEligibilityArticle): string[] {
  const haystack = [
    toLower(article.slug),
    toLower(article.title),
    toLower(article.articleSection),
    toLower(article.keywords),
    ...(article.tags ?? []).map(toLower),
  ].join('  ');

  const matched: string[] = [];
  for (const token of NEWS_SITEMAP_WHITELIST) {
    if (haystack.includes(token.toLowerCase())) matched.push(token);
  }
  return matched;
}
