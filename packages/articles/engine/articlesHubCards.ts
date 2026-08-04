/**
 * The `ssg-article-grid` block on the article-hub landing pages
 * (`/articoli-frontaliere/`, `/articoli-svizzera/` and their locale slugs).
 *
 * ─── Why this lives here ──────────────────────────────────────────────────
 * Two producers need to emit this exact markup:
 *
 *   1. the site's full build — `build-plugins/staticPagesPlugin.ts`, which
 *      renders the whole landing page from scratch;
 *   2. nanako's fast-publish — which has to refresh the grid on every article
 *      it publishes, because the landing is the ONLY article surface a full
 *      deploy still owned.
 *
 * Before this module existed, only (1) could emit it. When
 * `ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP` was turned on (2026-07-29 19:28) the
 * site stopped writing the landing to the shard and nothing took over: the
 * grid froze at its 2026-07-29 contents while every article published after
 * it was live at its own URL, listed in `/tutti/`, and in the sitemap. The
 * hub — the page a reader actually lands on — kept showing a week-old set,
 * and nothing failed, which is why it went unnoticed.
 *
 * Extracted VERBATIM from staticPagesPlugin so the bytes are unchanged; the
 * two call sites differ only in where they read titles from (see
 * `resolveMeta`), because the site has its SEO map and the corpus has its
 * `blog-meta-<locale>` chunks.
 *
 * Pure by construction — no imports at all, so it stays inside the
 * `packages/articles` confinement boundary
 * (`tests/packages-articles-confinement.test.ts`).
 */

export type HubCardLocale = 'it' | 'en' | 'de' | 'fr';

/** One registry entry, as parsed from `blog-articles-data.ts`. */
export interface HubCardArticle {
  readonly id: string;
  readonly category: string;
  readonly date: string;
  readonly image: string;
}

/** Title + description for one card. `null` when the caller has neither. */
export interface HubCardMeta {
  readonly title: string;
  readonly desc: string;
}

export interface RenderArticleHubCardsArgs {
  /** Registry entries, ALREADY sorted newest-first — the order is the caller's. */
  readonly articles: readonly HubCardArticle[];
  readonly locale: HubCardLocale;
  /** Section slug for this locale, e.g. `articoli-frontaliere`. */
  readonly sectionSlug: string;
  /** `''` for IT (served at the root), else `en` / `de` / `fr`. */
  readonly localePrefix: string;
  /** id → slug for `locale`. Falls back to the id when absent, as the site does. */
  readonly resolveSlug: (id: string) => string | undefined;
  /**
   * Card title + description. The site passes its SEO map keyed by path; the
   * corpus passes its `blog-meta-<locale>` lookup keyed by id. Returning null
   * makes the card fall back to a de-slugified id, exactly as before.
   */
  readonly resolveMeta: (id: string, articlePath: string) => HubCardMeta | null;
  /** Cards to render. 100 on both call sites — see the page-weight note below. */
  readonly limit?: number;
}

export const ARTICLES_HEADING: Record<string, string> = {
  it: 'Ultimi Articoli per Frontalieri',
  en: 'Latest Articles for Cross-Border Workers',
  de: 'Neueste Artikel für Grenzgänger',
  fr: 'Derniers Articles pour Frontaliers',
};

const CATEGORY_COLORS: Record<string, string> = {
  fiscale: 'background:var(--color-accent-subtle);color:#4338ca',
  pratico: 'background:#ecfdf5;color:#047857',
  novita: 'background:#fff7ed;color:#c2410c',
  pensione: 'background:#fdf4ff;color:#7e22ce',
};

const CATEGORY_LABELS: Record<string, Record<string, string>> = {
  fiscale: { it: 'Fiscale', en: 'Tax', de: 'Steuer', fr: 'Fiscal' },
  pratico: { it: 'Pratico', en: 'Practical', de: 'Praktisch', fr: 'Pratique' },
  novita: { it: 'Novità', en: 'News', de: 'News', fr: 'Actualité' },
  pensione: { it: 'Pensione', en: 'Pension', de: 'Rente', fr: 'Retraite' },
};

/** Same escaping the site applies — kept local so this module imports nothing. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The inner HTML of `<div class="ssg-article-grid">` — cards only, no wrapper.
 *
 * The per-card styles are CSS classes rather than inline style attributes:
 * 100 cards x ~750 bytes of repeated inline styles is ~75 KB, which put the
 * hub over the page-weight gate (260 KB — `scripts/audit-page-weight.mjs`).
 * The `.ssg-*` rules live in `public/assets/seo-static.css`, already linked on
 * these pages. Measured today: 839 B per card, the frontaliere hub at 124.5 KB
 * and the svizzera hub projected at 91.9 KB.
 */
export function renderArticleHubCards(args: RenderArticleHubCardsArgs): string {
  const { articles, locale, sectionSlug, localePrefix, resolveSlug, resolveMeta } = args;
  const limit = args.limit ?? 100;

  return articles.slice(0, limit).map((art, idx) => {
    const artSlug = resolveSlug(art.id) ?? art.id;
    const artPath = localePrefix
      ? `/${localePrefix}/${sectionSlug}/${artSlug}`
      : `/${sectionSlug}/${artSlug}`;
    const meta = resolveMeta(art.id, artPath);
    const title = meta
      ? esc(meta.title)
      : art.id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    // Truncate BEFORE escaping. The other way round cuts inside an entity when
    // a `&` lands near the limit — `…&am`, rendered literally.
    const desc = meta ? esc(meta.desc.substring(0, 150)) : '';
    const catColor = CATEGORY_COLORS[art.category] ?? CATEGORY_COLORS.fiscale;
    const catLabel = CATEGORY_LABELS[art.category]?.[locale] ?? art.category;
    // timeZone pinned: 17 registry entries are bare `YYYY-MM-DD`, parsed as
    // midnight UTC, and an unpinned toLocaleDateString formats them in the
    // runner's zone — `2026-06-30` renders "29 giu 2026" under TZ=America/*.
    // Dormant on GitHub runners (UTC) and exactly the drift to avoid now that
    // two different machines emit this same markup.
    const dateStr = new Date(art.date).toLocaleDateString(
      locale === 'it' ? 'it-IT' : locale,
      { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
    );
    // First two cards are above-the-fold on the hub — mark them
    // fetchpriority="high" (eager load, but flagged to the browser as LCP
    // candidates) so `audit-page-weight` sees the required loading signal.
    const imgLoadingAttrs = idx < 2 ? ' fetchpriority="high"' : ' loading="lazy"';
    return `<a href="${artPath}" aria-label="${title}" class="ssg-art-card"><img src="${art.image}" alt="${title}" width="400" height="200" class="ssg-art-img"${imgLoadingAttrs}><div class="ssg-art-body"><span class="ssg-art-cat" style="${catColor}">${esc(catLabel)}</span><span class="ssg-art-date">${dateStr}</span><h3 class="ssg-art-title">${title}</h3>${desc ? `<p class="ssg-art-desc">${desc}</p>` : ''}</div></a>`;
  }).join('');
}

/** Opening tag of the grid, as emitted by staticPagesPlugin. */
const GRID_OPEN = '<div class="ssg-article-grid">';

/**
 * Swap the grid inside an already-rendered landing page.
 *
 * The fast-publish path does NOT rebuild the landing — its editorial copy,
 * FAQ block, nav and head are the site build's output and must survive
 * untouched. Only the grid is a function of the corpus, so only the grid is
 * replaced.
 *
 * Scanned with a depth counter rather than a regex: the cards contain nested
 * `<div>`s, so `<div class="ssg-article-grid">[\s\S]*?</div>` would stop at
 * the first inner close and silently truncate the page — and a truncated hub
 * still returns 200, which is the failure mode worth engineering against.
 *
 * Returns `null` when the marker is absent or unbalanced; callers must treat
 * that as "leave the page alone", never as "write an empty grid".
 */
export function replaceArticleHubCards(html: string, cardsHtml: string): string | null {
  const start = html.indexOf(GRID_OPEN);
  if (start === -1) return null;

  let i = start + GRID_OPEN.length;
  let depth = 1;
  const openRx = /<div\b/gi;
  const closeRx = /<\/div>/gi;

  while (depth > 0) {
    openRx.lastIndex = i;
    closeRx.lastIndex = i;
    const nextOpen = openRx.exec(html);
    const nextClose = closeRx.exec(html);
    if (!nextClose) return null;               // unbalanced — refuse
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      i = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      i = nextClose.index + nextClose[0].length;
    }
  }

  const end = i - '</div>'.length;
  return html.slice(0, start + GRID_OPEN.length) + cardsHtml + html.slice(end);
}
