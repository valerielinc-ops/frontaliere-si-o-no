/**
 * Renderers of the corpus-owned pages of a CANTON article section that are
 * neither articles nor the `/tutti/` archive (piano «sezioni articoli per
 * cantone», P7a, decisions D1/D2/D4/D13/D17):
 *
 *   - the section LANDING, `/articoli-ticino/` (+ en/de/fr);
 *   - the THEMATIC HUB, `/articoli-ticino/carburanti/` (D17), one per
 *     (canton, theme, locale).
 *
 * Why here and not in the site. The historical landings come from
 * `build-plugins/staticPagesPlugin.ts` (6000+ lines, site-only); canton
 * sections are rendered by the CORPUS, uploaded to R2 under
 * `edge/sections/<path>/index.html` and served by the Worker
 * (`serveCorpusSection` in `infra/cloudflare-worker/locale-router.js`), so the
 * renderer has to travel with the engine mirror. It is a small, autonomous
 * template built from the engine's own parts — the archive chrome classes and
 * methodology accordion (`articleHubPagesPlugin.ts`), the article card grid
 * (`articlesHubCards.ts`), the robots directive and the route-owner meta —
 * not a port of staticPagesPlugin.
 *
 * Pure. Both renderers take their data as arguments and return HTML; nothing
 * here reads a dataset. `readCantonSectionLandingArticles` is the one reader,
 * a thin wrapper over the same corpus readers the archive uses, so the corpus
 * publisher (P7) does not have to re-implement them. The hub's datasets are
 * prepared by its producer (P10) and handed in.
 *
 * Always indexable. The owner decided (2026-10-05, `decisions.md`: refresh,
 * redirect, archiving or noindex need an explicit per-case evaluation) that no
 * canton page — landing, archive or hub — carries `noindex`, not even below a
 * news threshold. So there is no `indexable` switch and no below-floor bridge:
 * a hub with few news stands on its evergreen intro, key facts, data blocks
 * and tool links, and the renderer refuses input too thin to stand on its own
 * (AGENTS.md Non-Negotiable #4) instead of hiding it.
 *
 * Self-contained assets. Nothing on the serving path hosts `/assets/` (see
 * `scripts/lib/article-archive-assets.mjs`), and these pages are not built by
 * Vite: they reference the STABLE SPA entry on the CDN
 * (`cdn.frontaliereticino.ch/assets/index-entry.js`, `index.css`) and every
 * other `/assets/` reference the shell emits is rewritten to the CDN here, so a
 * page needs no offload pass after rendering.
 */

import type fsT from 'node:fs';
import type npT from 'node:path';
import { getSiteShell, type ArticleLocale, type StaticAdSlotKey } from './siteShell';
import { ARTICLE_ROBOTS_INDEX_ENHANCED } from './shared/robotsDirective';
import { CORPUS_ROUTE_OWNER_META_TAG } from './shared/corpusRouteOwner.mjs';
import {
  CANTON_SECTION_LOCALES,
  cantonArchiveCopy,
  cantonDisplayName,
  cantonSectionArchivePath,
  cantonSectionEntry,
  cantonSectionLabel,
  cantonSectionLandingPath,
  cantonTopicHubLabel,
  cantonTopicHubPath,
} from './shared/cantonSectionCopy.mjs';
import { CANTON_HUB_TOPIC_KEYS } from './shared/cantonArticleSectionCore.generated.mjs';
import { ARTICLE_HUB_GRID_OPEN, renderArticleHubCards } from './articlesHubCards';
import { LOCALE_OG, cantonMethodologyAccordionHtml, cantonTopicHubLinks } from './articleHubPagesPlugin';
import { rewriteBlogImageRefs } from './blogImageCdnFinalize';
import { readArticleRegistryMetadata } from './shared/articleRegistryMetadata';
import { readArticleDates, readArticleExcerpts, readArticleSlugs, readBlogUrlSlugs } from './shared/articleReaders';
import type { ArticleSection } from '../articleSections';

type Locale = ArticleLocale;

/** CDN base of the stable SPA build assets. */
export const CORPUS_PAGE_ASSET_BASE = 'https://cdn.frontaliereticino.ch/assets/';
/** Stable (not content-hashed) SPA entry, see `build-plugins/shared/spaEntryFilenames.ts`. */
export const CORPUS_PAGE_ENTRY_JS = `${CORPUS_PAGE_ASSET_BASE}index-entry.js`;
export const CORPUS_PAGE_ENTRY_CSS = `${CORPUS_PAGE_ASSET_BASE}index.css`;

/** Prefix of the R2 keys the Worker serves canton section pages from. */
export const CORPUS_SECTION_EDGE_PREFIX = 'edge/sections';

/**
 * Rewrite every same-origin `src="/assets/…"` / `href="/assets/…"` to the CDN.
 * The `="` anchor leaves the print-stylesheet swap selector
 * (`link[media="print"][href*="/assets/"]`) alone, exactly like
 * `SAME_ORIGIN_ASSET_RX` in `scripts/lib/article-archive-assets.mjs`.
 */
export function offloadCorpusPageAssets(html: string): string {
  return html.replace(/((?:src|href)=")\/assets\//g, `$1${CORPUS_PAGE_ASSET_BASE}`);
}

/**
 * R2 key of the page served at a canonical directory path — the
 * `corpusSectionCdnKey` rule of the Worker, without the leading slash:
 * `/en/ticino-articles/fuel/` → `edge/sections/en/ticino-articles/fuel/index.html`.
 */
export function corpusSectionEdgeKey(canonicalPath: string): string {
  if (!/^\/[a-z0-9/-]*\/$/.test(canonicalPath) || canonicalPath.includes('//')) {
    throw new Error(`percorso canonico non valido: ${JSON.stringify(canonicalPath)}`);
  }
  return `${CORPUS_SECTION_EDGE_PREFIX}${canonicalPath}index.html`;
}

/** One rendered page of a canton section. */
export interface CantonSectionPage {
  readonly locale: Locale;
  /** Canonical root-relative directory path, e.g. `/articoli-ticino/carburanti/`. */
  readonly canonicalPath: string;
  /** dist-relative file path, e.g. `articoli-ticino/carburanti/index.html`. */
  readonly relPath: string;
  /** R2 key the Worker reads, e.g. `edge/sections/articoli-ticino/carburanti/index.html`. */
  readonly edgeKey: string;
  readonly html: string;
}

function pageFor(locale: Locale, canonicalPath: string, html: string): CantonSectionPage {
  return {
    locale,
    canonicalPath,
    relPath: `${canonicalPath.slice(1)}index.html`,
    edgeKey: corpusSectionEdgeKey(canonicalPath),
    html,
  };
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function checkLocale(locale: string): Locale {
  if (!(CANTON_SECTION_LOCALES as readonly string[]).includes(locale)) {
    throw new Error(`locale non supportata: "${locale}"`);
  }
  return locale as Locale;
}

/**
 * A link target a canton page may carry: a root-relative site path ending in
 * `/` (trailing slash is the site's canonical form, AGENTS.md › Architecture)
 * or an absolute `https://` URL. Anything else — `javascript:`, protocol-
 * relative `//host`, a slashless internal path — is refused, loudly.
 */
function safeHref(url: string, what: string): string {
  const value = String(url ?? '').trim();
  if (/^https:\/\/[^\s"<>]+$/.test(value)) return value;
  if (/^\/(?!\/)[^\s"<>]*$/.test(value)) {
    const path = value.split(/[?#]/)[0];
    if (!path.endsWith('/')) throw new Error(`${what}: link interno senza slash finale: ${value}`);
    return value;
  }
  throw new Error(`${what}: URL non ammesso: ${JSON.stringify(value)}`);
}

function absUrl(href: string): string {
  const { baseUrl } = getSiteShell();
  return /^https?:\/\//.test(href) ? href : `${baseUrl}${href}`;
}

function formatDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleDateString(locale === 'it' ? 'it-IT' : locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function requireDate(value: string, what: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${what}: data non valida: ${JSON.stringify(value)}`);
  }
  return value;
}

function countWords(text: string): number {
  return String(text ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

// ── Shared page chrome ─────────────────────────────────────────────────────

interface PageShellArgs {
  readonly locale: Locale;
  readonly title: string;
  readonly description: string;
  readonly canonicalPath: string;
  /** Page-1 path of THIS page in every locale (hreflang group). */
  readonly alternates: Record<Locale, string>;
  readonly jsonLd: readonly unknown[];
  readonly mainHtml: string;
}

/**
 * `<!doctype html>` … `</html>` around a page's `<main>`: the full head
 * (title, description, robots, route-owner meta, OG, canonical, 4 hreflang +
 * x-default IT, JSON-LD), the archive's body chrome (root shell, rail
 * gutters, footer root) and the stable SPA entry on the CDN.
 */
function renderCantonPageShell(a: PageShellArgs): string {
  const {
    baseUrl: BASE_URL,
    gtagSnippet: GTAG_SNIPPET,
    adsenseSnippet: ADSENSE_SNIPPET,
    partnerizeTagSnippet: PARTNERIZE_TAG_SNIPPET = '',
    faviconLinks: FAVICON_LINKS,
    cdnPreconnectHint: CDN_PRECONNECT_HINT,
    clampMetaDescription,
    buildTitleWithBrand,
    inlineScriptJson,
    asyncCssHeadBlock,
    rootShell,
    railGutters,
  } = getSiteShell();
  const pageTitle = buildTitleWithBrand(a.title);
  const description = clampMetaDescription(a.description, undefined, a.locale);
  const canonicalUrl = `${BASE_URL}${a.canonicalPath}`;
  const hreflangs = CANTON_SECTION_LOCALES
    .map((loc) => `    <link rel="alternate" hreflang="${loc}" href="${BASE_URL}${a.alternates[loc as Locale]}">`)
    .concat([`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${a.alternates.it}">`])
    .join('\n');
  const ldTags = a.jsonLd
    .map((ld) => `    <script type="application/ld+json">${inlineScriptJson(ld)}</script>`)
    .join('\n');
  const gutters = railGutters(true);
  const html = `<!doctype html>
<html lang="${a.locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${FAVICON_LINKS}
    ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n    ` : ''}<title>${esc(pageTitle)}</title>
    <meta name="description" content="${esc(description)}">
    <meta name="robots" content="${ARTICLE_ROBOTS_INDEX_ENHANCED}">
    ${CORPUS_ROUTE_OWNER_META_TAG}
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[a.locale]}">
    <meta property="og:title" content="${esc(pageTitle)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:alt" content="${esc(pageTitle)}">
    <link rel="canonical" href="${canonicalUrl}">
${hreflangs}
${ldTags}
    ${asyncCssHeadBlock(CORPUS_PAGE_ENTRY_CSS)}
    ${GTAG_SNIPPET}
    ${ADSENSE_SNIPPET}
    ${PARTNERIZE_TAG_SNIPPET}
  </head>
  <body class="bg-surface-alt text-heading overflow-x-hidden">
    ${rootShell(true)}
    ${gutters.open}
    <main class="seo-static-content s-xzWvwM">
      <div class="cth-page">
${a.mainHtml}
      </div>
    </main>${gutters.close}
    <div id="footer-root"></div>
    <script type="module" crossorigin src="${CORPUS_PAGE_ENTRY_JS}"></script>
  </body>
</html>`;
  return rewriteBlogImageRefs(offloadCorpusPageAssets(html));
}

/** Visible breadcrumb; the last crumb is the current page (no link). */
function breadcrumbNavHtml(locale: Locale, crumbs: ReadonlyArray<{ name: string; href?: string }>): string {
  const label = { it: 'Percorso di navigazione', en: 'Breadcrumb', de: 'Brotkrümelnavigation', fr: 'Fil d’Ariane' }[locale];
  const parts = [`<a class="s-wfUMYx" href="/">Home</a>`];
  for (const c of crumbs) {
    parts.push(c.href
      ? `<a class="s-wfUMYx" href="${esc(c.href)}">${esc(c.name)}</a>`
      : `<span aria-current="page">${esc(c.name)}</span>`);
  }
  return `      <nav class="s-AxRVCF" aria-label="${esc(label)}">${parts.join('<span aria-hidden="true"> / </span>')}</nav>`;
}

function breadcrumbLd(crumbs: ReadonlyArray<{ name: string; url: string }>): unknown {
  const { baseUrl } = getSiteShell();
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [{ name: 'Home', url: `${baseUrl}/` }, ...crumbs].map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  };
}

function aboutCanton(section: string, locale: Locale): unknown {
  return { '@type': 'AdministrativeArea', name: cantonDisplayName(section, locale), containedInPlace: { '@type': 'Country', name: 'Switzerland' } };
}

/**
 * One manual AdSense slot for a canton page. The host supplies only the raw
 * unit so the engine remains independent from the site's ad registry; this
 * wrapper owns the stable reserved space, label and page-specific styling.
 */
function cantonAdHtml(slot: StaticAdSlotKey, label: string, className: string): string {
  const { staticAdSlotHtml } = getSiteShell();
  const ad = staticAdSlotHtml?.(slot);
  if (!ad) return '';
  return `      <section class="cth-ad ${className}" aria-label="${esc(label)}"><p class="cth-ad-label">${esc(label)}</p>${ad}</section>`;
}

// ── Landing ────────────────────────────────────────────────────────────────

const LANDING_COPY: Record<Locale, {
  title: (label: string) => string;
  lede: string;
  description: (name: string) => string;
  topicsHeading: string;
  latestHeading: string;
  empty: string;
  count: (n: number) => string;
  advertisement: string;
}> = {
  it: {
    title: (label) => `${label}: notizie e guide`,
    lede: 'Notizie verificate e guide pratiche per chi vive o lavora in questo cantone.',
    description: (name) => `${name}: le ultime notizie e guide su lavoro, fisco, mobilità, eventi, pensioni e servizi.`,
    topicsHeading: 'Per tema',
    latestHeading: 'Ultimi articoli',
    empty: 'I primi articoli di questa sezione sono in preparazione.',
    count: (n) => (n === 1 ? '1 articolo pubblicato' : `${n.toLocaleString('it-IT')} articoli pubblicati`),
    advertisement: 'Pubblicità',
  },
  en: {
    title: (label) => `${label}: news and guides`,
    lede: 'Verified news and practical guides for people who live or work in this canton.',
    description: (name) => `${name}: the latest news and guides on work, taxes, mobility, events, pensions and services.`,
    topicsHeading: 'By topic',
    latestHeading: 'Latest articles',
    empty: 'The first articles of this section are being prepared.',
    count: (n) => (n === 1 ? '1 published article' : `${n.toLocaleString('en-US')} published articles`),
    advertisement: 'Advertisement',
  },
  de: {
    title: (label) => `${label}: Nachrichten und Ratgeber`,
    lede: 'Geprüfte Nachrichten und praktische Ratgeber für alle, die in diesem Kanton leben oder arbeiten.',
    description: (name) => `${name}: die neuesten Nachrichten und Ratgeber zu Arbeit, Steuern, Mobilität, Veranstaltungen, Renten und Dienstleistungen.`,
    topicsHeading: 'Nach Thema',
    latestHeading: 'Neueste Artikel',
    empty: 'Die ersten Artikel dieser Rubrik sind in Vorbereitung.',
    count: (n) => (n === 1 ? '1 veröffentlichter Artikel' : `${n.toLocaleString('de-DE')} veröffentlichte Artikel`),
    advertisement: 'Werbung',
  },
  fr: {
    title: (label) => `${label} : actualités et guides`,
    lede: 'Actualités vérifiées et guides pratiques pour celles et ceux qui vivent ou travaillent dans ce canton.',
    description: (name) => `${name} : les dernières actualités et les guides sur le travail, la fiscalité, la mobilité, les événements, les retraites et les services.`,
    topicsHeading: 'Par thème',
    latestHeading: 'Derniers articles',
    empty: 'Les premiers articles de cette rubrique sont en préparation.',
    count: (n) => (n === 1 ? '1 article publié' : `${n.toLocaleString('fr-FR')} articles publiés`),
    advertisement: 'Publicité',
  },
};

/** One article card on a landing, already localized for the page's locale. */
export interface CantonLandingArticle {
  readonly id: string;
  /** URL slug in the page's locale (falls back to the id when absent). */
  readonly slug?: string;
  readonly title: string;
  readonly description?: string;
  /** Registry date; `''` = unknown (no date shown). */
  readonly date: string;
  /** Hero path (`/images/blog/<file>`) or absolute URL. */
  readonly image: string;
  /** Registry category (`novita`, `pratico`, …). */
  readonly category: string;
}

export interface CantonSectionLandingInput {
  /** Canton section id, e.g. `canton-ti`. */
  readonly section: string;
  readonly locale: Locale;
  /** The section's articles, newest first (the order is the caller's). */
  readonly articles: readonly CantonLandingArticle[];
  /** Cards on the page (default 24); the archive lists the rest. */
  readonly limit?: number;
}

/** Default number of article cards on a landing. */
export const CANTON_LANDING_CARD_LIMIT = 24;

/**
 * The landing of a canton section in one locale: H1 «Articoli <cantone>»,
 * short lede, the 6 topic hubs, the newest articles, a link to the archive,
 * the methodology accordion. Indexable, self-canonical, hreflang over the 4
 * locales + x-default IT.
 */
export function renderCantonSectionLanding(input: CantonSectionLandingInput): CantonSectionPage {
  const locale = checkLocale(input.locale);
  const section = input.section;
  const entry = cantonSectionEntry(section);
  const { baseUrl } = getSiteShell();
  const copy = LANDING_COPY[locale];
  const name = cantonDisplayName(section, locale);
  const label = cantonSectionLabel(section, locale);
  const canonicalPath = cantonSectionLandingPath(section, locale);
  const alternates = Object.fromEntries(
    CANTON_SECTION_LOCALES.map((l) => [l, cantonSectionLandingPath(section, l)]),
  ) as Record<Locale, string>;
  const limit = input.limit ?? CANTON_LANDING_CARD_LIMIT;
  const shown = input.articles.slice(0, limit);
  const localePrefix = locale === 'it' ? '' : locale;
  const sectionSlug = entry.indexSlug[locale];
  const byId = new Map(input.articles.map((a) => [a.id, a]));

  const cardsHtml = renderArticleHubCards({
    articles: shown.map((a) => ({ id: a.id, category: a.category, date: a.date, image: a.image })),
    locale,
    sectionSlug,
    localePrefix,
    resolveSlug: (id) => byId.get(id)?.slug,
    resolveMeta: (id) => {
      const a = byId.get(id);
      return a ? { title: a.title, desc: a.description ?? '' } : null;
    },
    limit,
  });
  const articlePath = (a: CantonLandingArticle) => `${canonicalPath}${a.slug ?? a.id}/`;

  const hubLinks = cantonTopicHubLinks(section as ArticleSection, locale);
  const archivePath = cantonSectionArchivePath(section, locale);
  const archiveTitle = cantonArchiveCopy(section, locale).title;

  const mainHtml = [
    breadcrumbNavHtml(locale, [{ name: label }]),
    `      <header class="s-S1RSUf cth-hero"><h1 class="s-e3gkVi">${esc(label)}</h1><p class="s-OPPwy-">${esc(copy.lede)}</p>${input.articles.length ? `<p class="s-Sn0UIv">${esc(copy.count(input.articles.length))}</p>` : ''}</header>`,
    cantonAdHtml('canton-hub-top', copy.advertisement, 'cth-ad-top'),
    `      <section class="cth-section" aria-labelledby="canton-topics"><h2 id="canton-topics" class="s-sXAwQz cth-section-title">${esc(copy.topicsHeading)}</h2><ul class="s-N93mPe cth-topic-list">${hubLinks
      .map((l) => `<li><a class="s-7DS5hj" href="${esc(l.href)}">${esc(l.label)}</a></li>`)
      .join('')}</ul></section>`,
    `      <section class="cth-section" aria-labelledby="canton-latest"><h2 id="canton-latest" class="s-sXAwQz cth-section-title">${esc(copy.latestHeading)}</h2>${shown.length
      ? `${ARTICLE_HUB_GRID_OPEN}${cardsHtml}</div>`
      : `<p class="s-s6RP5r">${esc(copy.empty)}</p>`}</section>`,
    `      <p class="s-Sn0UIv cth-archive-link"><a class="s-7DS5hj" href="${esc(archivePath)}">${esc(archiveTitle)} →</a></p>`,
    `      ${cantonMethodologyAccordionHtml(section as ArticleSection, locale)}`,
    cantonAdHtml('canton-hub-end', copy.advertisement, 'cth-ad-bottom'),
  ].join('\n');

  const pageUrl = `${baseUrl}${canonicalPath}`;
  const description = copy.description(name);
  const jsonLd = [
    breadcrumbLd([{ name: label, url: pageUrl }]),
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: label,
      url: pageUrl,
      description,
      inLanguage: locale,
      about: aboutCanton(section, locale),
      hasPart: hubLinks.map((l) => ({ '@type': 'CollectionPage', name: l.label, url: absUrl(l.href) })),
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: shown.length,
        itemListElement: shown.map((a, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: a.title,
          url: absUrl(articlePath(a)),
        })),
      },
    },
  ];

  const html = renderCantonPageShell({
    locale,
    title: copy.title(label),
    description,
    canonicalPath,
    alternates,
    jsonLd,
    mainHtml,
  });
  return pageFor(locale, canonicalPath, html);
}

/**
 * The landing's article list for one locale, read from the corpus files the
 * archive reads (registry, `blog-meta-<section>-<locale>`, slug map) and
 * sorted newest first. Only ids present in the IT meta are listed — an id the
 * meta does not title has no rendered article page to link.
 */
export function readCantonSectionLandingArticles(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  section: string,
  locale: Locale,
): CantonLandingArticle[] {
  const cfg = cantonSectionEntry(section);
  let registrySrc = '';
  try {
    registrySrc = fs.readFileSync(np.resolve(rootDir, cfg.registryFile), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const registry = registrySrc ? readArticleRegistryMetadata(registrySrc) : [];
  const dates = readArticleDates(fs, np, rootDir, cfg.registryFile);
  const itTitles = new Map(readArticleSlugs(fs, np, rootDir, 'it', cfg.metaPrefix).map((a) => [a.slug, a.title]));
  const titles = locale === 'it' ? itTitles : new Map(readArticleSlugs(fs, np, rootDir, locale, cfg.metaPrefix).map((a) => [a.slug, a.title]));
  const itExcerpts = readArticleExcerpts(fs, np, rootDir, 'it', cfg.metaPrefix);
  const excerpts = locale === 'it' ? itExcerpts : readArticleExcerpts(fs, np, rootDir, locale, cfg.metaPrefix);
  const urlSlugs = readBlogUrlSlugs(fs, np, rootDir, cfg.slugDataFile, cfg.slugConst);

  const out: CantonLandingArticle[] = [];
  for (const r of registry) {
    const itTitle = itTitles.get(r.id);
    if (!itTitle) continue;
    out.push({
      id: r.id,
      slug: urlSlugs[r.id]?.[locale],
      title: titles.get(r.id) ?? itTitle,
      description: excerpts.get(r.id) ?? itExcerpts.get(r.id) ?? '',
      date: dates.get(r.id) ?? '',
      image: r.image ?? '/og-image.png',
      category: r.category ?? 'novita',
    });
  }
  return out
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      if (x.a.date && y.a.date && x.a.date !== y.a.date) return y.a.date.localeCompare(x.a.date);
      if (x.a.date && !y.a.date) return -1;
      if (!x.a.date && y.a.date) return 1;
      return x.i - y.i;
    })
    .map(({ a }) => a);
}

/**
 * The 4 locale landings of a canton section, read from the corpus at
 * `rootDir`. What the corpus publisher calls; the per-locale renderer above
 * stays pure.
 */
export async function renderCantonSectionLandingPages(opts: {
  readonly rootDir: string;
  readonly section: string;
  readonly limit?: number;
}): Promise<CantonSectionPage[]> {
  const fs = await import('node:fs');
  const np = await import('node:path');
  return CANTON_SECTION_LOCALES.map((l) => {
    const locale = l as Locale;
    return renderCantonSectionLanding({
      section: opts.section,
      locale,
      articles: readCantonSectionLandingArticles(fs as unknown as typeof fsT, np as unknown as typeof npT, opts.rootDir, opts.section, locale),
      limit: opts.limit,
    });
  });
}

// ── Thematic hub (D17) ─────────────────────────────────────────────────────

/** A headline number of the hub («Benzina 95: 1,79 CHF/l»). */
export interface CantonHubKeyFact {
  readonly label: string;
  readonly value: string;
  /** Short qualifier shown under the value («media cantonale, 3 ottobre»). */
  readonly note?: string;
  readonly sourceName?: string;
  readonly sourceUrl?: string;
}

/** One row of a data block. */
export interface CantonHubDataItem {
  readonly label: string;
  readonly value?: string;
  readonly detail?: string;
  /** ISO date of the item (event day, deadline, closure start…). */
  readonly date?: string;
  readonly url?: string;
}

/** A block of category data (fuel prices, upcoming events, road closures…). */
export interface CantonHubDataBlock {
  /** Stable id, used as the heading anchor (`[a-z0-9-]+`). */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly items: readonly CantonHubDataItem[];
  readonly sourceName?: string;
  readonly sourceUrl?: string;
  /** ISO timestamp of the dataset snapshot. */
  readonly updatedAt?: string;
}

/** A promoted news item — from this canton's section or from frontaliere/svizzera via `canton`. */
export interface CantonHubArticle {
  readonly title: string;
  /** Root-relative article URL (trailing slash) or absolute https URL. */
  readonly url: string;
  readonly excerpt?: string;
  readonly date?: string;
}

/** A pertinent site tool («Calcolatore stipendio netto»). */
export interface CantonHubLink {
  readonly label: string;
  readonly url: string;
  readonly description?: string;
}

export interface CantonTopicHubInput {
  /** Canton URL-group code (`TI`, `BASILEA`, …). */
  readonly canton: string;
  /** Theme id: carburanti | fisco | mobilita | eventi | pensioni | servizi. */
  readonly topic: string;
  readonly locale: Locale;
  /** Evergreen intro, plain text; blank lines separate paragraphs. */
  readonly intro: string;
  readonly keyFacts: readonly CantonHubKeyFact[];
  readonly dataBlocks: readonly CantonHubDataBlock[];
  readonly curatedArticles: readonly CantonHubArticle[];
  readonly links: readonly CantonHubLink[];
  /** ISO timestamp of the last content change of this hub. */
  readonly updatedAt: string;
}

/**
 * Minimum words of real content (intro + facts + data + promoted news) a hub
 * must carry. Every canton hub is indexable by the owner's decision, so thin
 * input is refused here rather than published (Non-Negotiable #4).
 */
export const CANTON_HUB_MIN_CONTENT_WORDS = 50;

const HUB_COPY: Record<Locale, {
  updated: string;
  keyFacts: string;
  source: string;
  curated: string;
  noCurated: string;
  tools: string;
  otherTopics: string;
  advertisement: string;
}> = {
  it: { updated: 'Aggiornato il', keyFacts: 'Dati chiave', source: 'Fonte', curated: 'Articoli consigliati', noCurated: 'Gli articoli su questo tema compariranno qui man mano che vengono pubblicati.', tools: 'Strumenti utili', otherTopics: 'Altri temi', advertisement: 'Pubblicità' },
  en: { updated: 'Updated on', keyFacts: 'Key data', source: 'Source', curated: 'Recommended articles', noCurated: 'Articles on this topic will appear here as they are published.', tools: 'Useful tools', otherTopics: 'Other topics', advertisement: 'Advertisement' },
  de: { updated: 'Aktualisiert am', keyFacts: 'Eckdaten', source: 'Quelle', curated: 'Empfohlene Artikel', noCurated: 'Artikel zu diesem Thema erscheinen hier, sobald sie veröffentlicht werden.', tools: 'Nützliche Tools', otherTopics: 'Weitere Themen', advertisement: 'Werbung' },
  fr: { updated: 'Mis à jour le', keyFacts: 'Données clés', source: 'Source', curated: 'Articles recommandés', noCurated: 'Les articles sur ce thème apparaîtront ici au fil de leur publication.', tools: 'Outils utiles', otherTopics: 'Autres thèmes', advertisement: 'Publicité' },
};

function sourceLineHtml(locale: Locale, name: string | undefined, url: string | undefined, what: string): string {
  if (!name) return '';
  const label = HUB_COPY[locale].source;
  return url
    ? `<p class="s-Sn0UIv">${esc(label)}: <a href="${esc(safeHref(url, what))}" rel="noopener">${esc(name)}</a></p>`
    : `<p class="s-Sn0UIv">${esc(label)}: ${esc(name)}</p>`;
}

/** Canton section id of a canton URL-group code (`TI` → `canton-ti`). */
export function cantonSectionIdFor(canton: string): string {
  const section = `canton-${String(canton).toLowerCase()}`;
  const entry = cantonSectionEntry(section);
  if (entry.canton !== canton) throw new Error(`codice cantone non valido: ${JSON.stringify(canton)}`);
  return section;
}

/**
 * The thematic hub of one canton in one locale (D17):
 * `/<section landing>/<localized theme slug>/`. Pure — the producer (P10)
 * hands in the intro, the dataset slices, the promoted news and the tools.
 */
export function renderCantonTopicHub(input: CantonTopicHubInput): CantonSectionPage {
  const locale = checkLocale(input.locale);
  const section = cantonSectionIdFor(input.canton);
  if (!(CANTON_HUB_TOPIC_KEYS as readonly string[]).includes(input.topic)) {
    throw new Error(`tema sconosciuto: "${input.topic}"`);
  }
  const topic = input.topic;
  const updatedAt = requireDate(input.updatedAt, 'updatedAt');
  const { baseUrl, organizationLd } = getSiteShell();
  const copy = HUB_COPY[locale];
  const sectionLabel = cantonSectionLabel(section, locale);
  const hubLabel = cantonTopicHubLabel(section, topic, locale);
  const landingPath = cantonSectionLandingPath(section, locale);
  const canonicalPath = cantonTopicHubPath(section, topic, locale);
  const alternates = Object.fromEntries(
    CANTON_SECTION_LOCALES.map((l) => [l, cantonTopicHubPath(section, topic, l)]),
  ) as Record<Locale, string>;

  const paragraphs = String(input.intro ?? '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (paragraphs.length === 0) throw new Error(`hub ${section}/${topic}/${locale}: intro evergreen mancante`);

  const contentWords =
    paragraphs.reduce((n, p) => n + countWords(p), 0) +
    input.keyFacts.reduce((n, f) => n + countWords(`${f.label} ${f.value} ${f.note ?? ''}`), 0) +
    input.dataBlocks.reduce((n, b) => n + countWords(`${b.title} ${b.description ?? ''}`) +
      b.items.reduce((m, it) => m + countWords(`${it.label} ${it.value ?? ''} ${it.detail ?? ''}`), 0), 0) +
    input.curatedArticles.reduce((n, a) => n + countWords(`${a.title} ${a.excerpt ?? ''}`), 0);
  if (contentWords < CANTON_HUB_MIN_CONTENT_WORDS) {
    throw new Error(`hub ${section}/${topic}/${locale}: contenuto insufficiente (${contentWords} parole < ${CANTON_HUB_MIN_CONTENT_WORDS})`);
  }

  const factsHtml = input.keyFacts.length
    ? `      <section class="s-iQjIAb cth-facts" aria-label="${esc(copy.keyFacts)}">${input.keyFacts.map((f) => {
        const source = f.sourceName
          ? (f.sourceUrl
            ? `<div class="s-tlbl"><a href="${esc(safeHref(f.sourceUrl, 'keyFacts.sourceUrl'))}" rel="noopener">${esc(f.sourceName)}</a></div>`
            : `<div class="s-tlbl">${esc(f.sourceName)}</div>`)
          : '';
        return `<div class="s-tacc cth-fact"><div class="s-tlbl">${esc(f.label)}</div><div class="s-tval">${esc(f.value)}</div>${f.note ? `<div class="s-tlbl">${esc(f.note)}</div>` : ''}${source}</div>`;
      }).join('')}</section>`
    : '';

  const blocksHtml = input.dataBlocks.map((b) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b.id)) throw new Error(`dataBlocks: id non valido ${JSON.stringify(b.id)}`);
    const headingId = `dati-${b.id}`;
    const items = b.items.map((it) => {
      const when = it.date ? ` <time datetime="${esc(requireDate(it.date, `dataBlocks.${b.id}.date`))}">${esc(formatDate(it.date, locale))}</time>` : '';
      const labelHtml = it.url
        ? `<a class="s-7DS5hj" href="${esc(safeHref(it.url, `dataBlocks.${b.id}.url`))}">${esc(it.label)}</a>`
        : `<strong>${esc(it.label)}</strong>`;
      return `<li>${labelHtml}${it.value ? `: ${esc(it.value)}` : ''}${it.detail ? ` — ${esc(it.detail)}` : ''}${when}</li>`;
    }).join('');
    const snapshot = b.updatedAt
      ? `<p class="s-Sn0UIv">${esc(copy.updated)} <time datetime="${esc(requireDate(b.updatedAt, `dataBlocks.${b.id}.updatedAt`))}">${esc(formatDate(b.updatedAt, locale))}</time></p>`
      : '';
    return `      <section class="cth-section cth-data-block" aria-labelledby="${headingId}"><h2 id="${headingId}" class="s-sXAwQz cth-section-title">${esc(b.title)}</h2>${b.description ? `<p class="cth-section-intro">${esc(b.description)}</p>` : ''}${items ? `<ul class="s-N93mPe cth-data-list">${items}</ul>` : ''}${snapshot}${sourceLineHtml(locale, b.sourceName, b.sourceUrl, `dataBlocks.${b.id}.sourceUrl`)}</section>`;
  }).join('\n');

  const curatedHtml = `      <section class="cth-section cth-curated" aria-labelledby="hub-articles"><h2 id="hub-articles" class="s-sXAwQz cth-section-title">${esc(copy.curated)}</h2>${input.curatedArticles.length
    ? `<ul class="s-0c2lhY cth-article-list">${input.curatedArticles.map((a) => {
        const date = a.date ? ` <time datetime="${esc(requireDate(a.date, 'curatedArticles.date'))}">${esc(formatDate(a.date, locale))}</time>` : '';
        return `<li><a class="s-6gbS_B" href="${esc(safeHref(a.url, 'curatedArticles.url'))}"><span class="s-lkdl0F">${esc(a.title)}</span>${a.excerpt ? `<span class="s-hNvHD_">${esc(a.excerpt)}</span>` : ''}</a>${date}</li>`;
      }).join('')}</ul>`
    : `<p class="s-s6RP5r">${esc(copy.noCurated)}</p>`}</section>`;

  const toolsHtml = input.links.length
    ? `      <section class="cth-section cth-tools" aria-labelledby="hub-tools"><h2 id="hub-tools" class="s-sXAwQz cth-section-title">${esc(copy.tools)}</h2><ul class="s-N93mPe cth-data-list">${input.links.map((l) =>
        `<li><a class="s-7DS5hj" href="${esc(safeHref(l.url, 'links.url'))}">${esc(l.label)}</a>${l.description ? ` — ${esc(l.description)}` : ''}</li>`).join('')}</ul></section>`
    : '';

  const otherTopics = cantonTopicHubLinks(section as ArticleSection, locale).filter((l) => l.topic !== topic);
  const navHtml = `      <nav class="s-4nYHgH cth-topic-nav" aria-label="${esc(copy.otherTopics)}"><h2 class="s-sXAwQz cth-section-title">${esc(copy.otherTopics)}</h2><ul class="s-N93mPe cth-topic-list">${otherTopics
    .map((l) => `<li><a class="s-7DS5hj" href="${esc(l.href)}">${esc(l.label)}</a></li>`)
    .join('')}<li><a class="s-7DS5hj" href="${esc(landingPath)}">${esc(sectionLabel)}</a></li><li><a class="s-7DS5hj" href="${esc(cantonSectionArchivePath(section, locale))}">${esc(cantonArchiveCopy(section, locale).title)}</a></li></ul></nav>`;

  const mainHtml = [
    breadcrumbNavHtml(locale, [{ name: sectionLabel, href: landingPath }, { name: hubLabel }]),
    `      <header class="s-S1RSUf cth-hero"><h1 class="s-e3gkVi">${esc(hubLabel)}</h1>${paragraphs.map((p, i) => `<p${i === 0 ? ' class="s-OPPwy-"' : ''}>${esc(p)}</p>`).join('')}<p class="s-Sn0UIv">${esc(copy.updated)} <time datetime="${esc(updatedAt)}">${esc(formatDate(updatedAt, locale))}</time></p></header>`,
    cantonAdHtml('canton-hub-top', copy.advertisement, 'cth-ad-top'),
    factsHtml,
    blocksHtml,
    curatedHtml,
    toolsHtml,
    navHtml,
    cantonAdHtml('canton-hub-end', copy.advertisement, 'cth-ad-bottom'),
  ].filter(Boolean).join('\n');

  const pageUrl = `${baseUrl}${canonicalPath}`;
  const description = paragraphs[0];
  const jsonLd: unknown[] = [
    breadcrumbLd([
      { name: sectionLabel, url: `${baseUrl}${landingPath}` },
      { name: hubLabel, url: pageUrl },
    ]),
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: hubLabel,
      url: pageUrl,
      description,
      inLanguage: locale,
      dateModified: updatedAt,
      about: aboutCanton(section, locale),
      isPartOf: { '@type': 'CollectionPage', name: sectionLabel, url: `${baseUrl}${landingPath}` },
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: input.curatedArticles.length,
        itemListElement: input.curatedArticles.map((a, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: a.title,
          url: absUrl(safeHref(a.url, 'curatedArticles.url')),
        })),
      },
    },
  ];
  // A Dataset only when the page actually carries data rows: a hub whose
  // blocks are all empty would describe a dataset it does not show.
  const dataBlocks = input.dataBlocks.filter((b) => b.items.length > 0);
  if (dataBlocks.length > 0) {
    const sources = [...new Set(dataBlocks.map((b) => b.sourceUrl).filter((u): u is string => Boolean(u)).map((u) => safeHref(u, 'dataBlocks.sourceUrl')))];
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `${hubLabel}: ${dataBlocks.map((b) => b.title).join(', ')}`,
      description: `${description} ${dataBlocks.map((b) => b.description ?? b.title).join(' ')}`.trim(),
      url: pageUrl,
      inLanguage: locale,
      dateModified: updatedAt,
      license: 'https://creativecommons.org/licenses/by/4.0/',
      isAccessibleForFree: true,
      spatialCoverage: { '@type': 'Place', name: cantonDisplayName(section, locale) },
      // Dataset creator is the same publisher entity used by every other
      // static emitter.  An anonymous same-name Organization creates a
      // second graph node beside `#organization`.
      creator: organizationLd,
      ...(sources.length ? { isBasedOn: sources.map(absUrl) } : {}),
    });
  }

  const html = renderCantonPageShell({
    locale,
    title: hubLabel,
    description,
    canonicalPath,
    alternates,
    jsonLd,
    mainHtml,
  });
  return pageFor(locale, canonicalPath, html);
}
