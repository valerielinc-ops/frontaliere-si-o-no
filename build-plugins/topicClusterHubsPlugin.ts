/**
 * Article topic hubs (issue #5001) — Vite build plugin.
 *
 * Emits one hub per (section × locale × topic): the editorial topic hub the
 * issue asks for and the site did not have. Before this, the only article hub
 * was the flat paginated archive (`/…/tutti/`), so the corpus had no
 * topic-level entry point at all — nothing between "one article" and "all
 * 3.098 of them".
 *
 * WHERE THE MEMBERSHIP COMES FROM
 * ───────────────────────────────
 * `packages/articles/engine/topicClusters.ts`, which derives it from the
 * TF-IDF similarity graph built for the related-links index in #5107 — not
 * from the 4-value `category` enum (`novita` alone holds 62% of the corpus).
 * That file's header carries the measurements that shaped the algorithm,
 * including why connected components alone do not work and why topic NAMES
 * are curated in `topicTaxonomy.ts` rather than derived.
 *
 * Assignment runs ONCE per section, on the Italian corpus, and every locale
 * renders that same membership with its own titles: the four locale variants
 * of a hub are hreflang siblings and must hold the same articles.
 *
 * THE FLOOR AND THE BRIDGE
 * ────────────────────────
 * A topic with fewer than TOPIC_HUB_MIN_ARTICLES articles in a section still
 * gets its page — as a `noindex,follow` bridge that links onward to the
 * section archive and the sibling topics — instead of being skipped
 * (AGENTS.md § Static SEO Pages). Skipping would turn a URL that was live on
 * an earlier build, when the topic was larger, into a hard 404. The paired
 * self-map lives in `searchConsoleCompat.ts`.
 *
 * Because membership is computed once rather than per locale, a topic is
 * above or below the floor identically in all four locales — so hreflang
 * never points from an indexable hub at a noindex sibling.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { buildLocaleAlternateBlock } from './shared/localeAlternateBlock';
import { clampMetaDescription } from './shared/titleSuffix';
import { WriteCollector } from './batchWrite';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { HUB_SLUG_BY_LOCALE } from './seoHubsData';
import {
  readArticleDates,
  readArticleExcerpts,
  readArticleSlugs,
  readBlogUrlSlugs,
} from './shared/articleReaders';
import { ARTICLE_SECTION_CORE } from '../packages/articles/engine/shared/articleSectionCore.mjs';
import { assignArticlesToTopics } from '../packages/articles/engine/topicClusters';
import { TOPIC_CLUSTERS, TOPIC_HUB_SEGMENT } from '../packages/articles/engine/topicTaxonomy';
import {
  buildTopicHubPath,
  topicSitemapFileName,
  TOPIC_HUB_LOCALES,
  TOPIC_HUB_MIN_ARTICLES,
  TOPIC_HUB_PAGE_SIZE,
  TOPIC_HUB_SECTIONS,
  type TopicHubLocale,
  type TopicHubSection,
} from './topicClusterHubsData';
import {
  H1_STYLE,
  H2_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  HERO_EYEBROW_STYLE,
  LINK_ACCENT_STYLE,
  renderStatGrid,
} from './shared/seoContentTokens';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LOCALE_PREFIX: Record<TopicHubLocale, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
const LOCALE_OG: Record<TopicHubLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const COPY: Record<TopicHubLocale, {
  home: string;
  eyebrow: string;
  allArticles: string;
  tileArticles: string;
  tileTopics: string;
  tileUpdated: string;
  otherTopics: string;
  readMore: string;
  pageOf: (p: number, t: number) => string;
  prev: string;
  next: string;
  bridgeTitle: (topic: string) => string;
  bridgeBody: (topic: string, n: number) => string;
  bridgeCta: string;
  intro: (topic: string, n: number) => string;
}> = {
  it: {
    home: 'Home',
    eyebrow: 'Argomento',
    allArticles: 'Tutti gli articoli',
    tileArticles: 'Articoli',
    tileTopics: 'Argomenti',
    tileUpdated: 'Aggiornato',
    otherTopics: 'Altri argomenti',
    readMore: 'Leggi',
    pageOf: (p, t) => `Pagina ${p} di ${t}`,
    prev: 'Precedente',
    next: 'Successiva',
    bridgeTitle: (topic) => `${topic}: archivio in crescita`,
    bridgeBody: (topic, n) =>
      `Su «${topic}» abbiamo per ora ${n} ${n === 1 ? 'articolo' : 'articoli'}: troppo pochi per una pagina di argomento a sé. Trovi tutto nell'archivio completo, che raccoglie ogni articolo pubblicato.`,
    bridgeCta: 'Vai all’archivio completo',
    intro: (topic, n) => `${n} articoli su ${topic.toLowerCase()}, dal più recente.`,
  },
  en: {
    home: 'Home',
    eyebrow: 'Topic',
    allArticles: 'All articles',
    tileArticles: 'Articles',
    tileTopics: 'Topics',
    tileUpdated: 'Updated',
    otherTopics: 'Other topics',
    readMore: 'Read',
    pageOf: (p, t) => `Page ${p} of ${t}`,
    prev: 'Previous',
    next: 'Next',
    bridgeTitle: (topic) => `${topic}: a growing archive`,
    bridgeBody: (topic, n) =>
      `We have ${n} article${n === 1 ? '' : 's'} on “${topic}” so far — too few for a topic page of its own. The full archive collects every article published.`,
    bridgeCta: 'Go to the full archive',
    intro: (topic, n) => `${n} articles on ${topic.toLowerCase()}, newest first.`,
  },
  de: {
    home: 'Home',
    eyebrow: 'Thema',
    allArticles: 'Alle Artikel',
    tileArticles: 'Artikel',
    tileTopics: 'Themen',
    tileUpdated: 'Aktualisiert',
    otherTopics: 'Weitere Themen',
    readMore: 'Lesen',
    pageOf: (p, t) => `Seite ${p} von ${t}`,
    prev: 'Zurück',
    next: 'Weiter',
    bridgeTitle: (topic) => `${topic}: Archiv im Aufbau`,
    bridgeBody: (topic, n) =>
      `Zu „${topic}“ liegen bisher ${n} Artikel vor — zu wenige für eine eigene Themenseite. Das vollständige Archiv enthält alle veröffentlichten Artikel.`,
    bridgeCta: 'Zum vollständigen Archiv',
    intro: (topic, n) => `${n} Artikel zu ${topic.toLowerCase()}, neueste zuerst.`,
  },
  fr: {
    home: 'Accueil',
    eyebrow: 'Sujet',
    allArticles: 'Tous les articles',
    tileArticles: 'Articles',
    tileTopics: 'Sujets',
    tileUpdated: 'Mis à jour',
    otherTopics: 'Autres sujets',
    readMore: 'Lire',
    pageOf: (p, t) => `Page ${p} sur ${t}`,
    prev: 'Précédent',
    next: 'Suivant',
    bridgeTitle: (topic) => `${topic} : archive en construction`,
    bridgeBody: (topic, n) =>
      `Nous avons pour l’instant ${n} article${n === 1 ? '' : 's'} sur « ${topic} » — trop peu pour une page de sujet dédiée. L’archive complète rassemble tous les articles publiés.`,
    bridgeCta: 'Aller à l’archive complète',
    intro: (topic, n) => `${n} articles sur ${topic.toLowerCase()}, du plus récent.`,
  },
};

const SECTION_LABEL: Record<TopicHubSection, Record<TopicHubLocale, string>> = {
  frontaliere: {
    it: 'Articoli per frontalieri',
    en: 'Cross-border articles',
    de: 'Grenzgänger-Artikel',
    fr: 'Articles pour frontaliers',
  },
  svizzera: {
    it: 'Articoli sulla Svizzera',
    en: 'Swiss articles',
    de: 'Schweiz-Artikel',
    fr: 'Articles sur la Suisse',
  },
};

interface ArticleRow {
  id: string;
  title: string;
  excerpt: string;
  urlSlug: string;
  date: string;
}

function sectionCfg(section: TopicHubSection) {
  return (ARTICLE_SECTION_CORE as Record<string, {
    indexSlug: Record<string, string>;
    metaPrefix: string;
    registryFile: string;
    slugDataFile: string;
    slugConst: string;
  }>)[section];
}

/**
 * Path of the section's flat archive, the page every hub links back to.
 *
 * The `tutti`/`all`/`alle`/`tous` map comes from `seoHubsData` rather than a
 * local literal: it already exists there and backs the archive the article
 * engine emits. A fourth copy would drift the day one locale's slug changes,
 * and every hub would then link at a 404 (AGENTS.md #6).
 */
function archivePath(locale: TopicHubLocale, section: TopicHubSection): string {
  return `${LOCALE_PREFIX[locale]}/${sectionCfg(section).indexSlug[locale]}/${HUB_SLUG_BY_LOCALE[locale].tutti}/`;
}

function articleHref(locale: TopicHubLocale, section: TopicHubSection, urlSlug: string): string {
  return `${LOCALE_PREFIX[locale]}/${sectionCfg(section).indexSlug[locale]}/${urlSlug}/`;
}

/**
 * Read one section's article rows for one locale, over the ITALIAN master id
 * set, falling back to the Italian title/excerpt when this locale's meta chunk
 * has no entry for an id.
 *
 * The master set and the fallback are what make the hreflang guarantee hold BY
 * CONSTRUCTION rather than by coincidence. Membership and the above/below-floor
 * decision are computed once on the Italian corpus; if the rendered row set
 * were instead built from each locale's own meta chunk, an id present in `it`
 * and missing in `de` would silently drop only from the German hub. In the
 * worst case that page falls under MIN_INDEXABLE_WORDS and becomes a
 * `noindex` bridge while the other three locales stay indexable hubs on the
 * same hreflang cluster — the exact violation this plugin's header claims is
 * impossible.
 *
 * The four `blog-meta-*.ts` chunks happen to carry identical id sets today,
 * but nothing enforces that at build time. `articleHubPagesPlugin.ts` defends
 * against the same gap the same way (`localeBySlug.get(slug) ?? itBySlug.get(slug)`).
 */
export function buildLocaleRows(args: {
  locale: TopicHubLocale;
  itTitles: ReadonlyMap<string, string>;
  itExcerpts: ReadonlyMap<string, string>;
  localeTitles: ReadonlyMap<string, string>;
  localeExcerpts: ReadonlyMap<string, string>;
  urlSlugs: Record<string, Record<string, string>>;
  dates: ReadonlyMap<string, string>;
}): Map<string, ArticleRow> {
  const { locale, itTitles, itExcerpts, localeTitles, localeExcerpts, urlSlugs, dates } = args;
  const rows = new Map<string, ArticleRow>();
  // Iterate the ITALIAN ids, never the locale's own: that is the invariant.
  for (const [id, itTitle] of itTitles) {
    rows.set(id, {
      id,
      title: localeTitles.get(id) ?? itTitle,
      excerpt: localeExcerpts.get(id) ?? itExcerpts.get(id) ?? '',
      urlSlug: urlSlugs[id]?.[locale] ?? id,
      date: dates.get(id) ?? '',
    });
  }
  return rows;
}

function readSectionRows(
  rootDir: string,
  section: TopicHubSection,
  locale: TopicHubLocale,
  urlSlugs: Record<string, Record<string, string>>,
  dates: Map<string, string>,
  itTitles: ReadonlyMap<string, string>,
  itExcerpts: ReadonlyMap<string, string>,
): Map<string, ArticleRow> {
  const cfg = sectionCfg(section);
  const localeTitles =
    locale === 'it'
      ? itTitles
      : new Map(
          readArticleSlugs(fs, np, rootDir, locale as 'it', cfg.metaPrefix).map((a) => [
            a.slug,
            a.title,
          ]),
        );
  const localeExcerpts =
    locale === 'it' ? itExcerpts : readArticleExcerpts(fs, np, rootDir, locale as 'it', cfg.metaPrefix);

  return buildLocaleRows({
    locale,
    itTitles,
    itExcerpts,
    localeTitles,
    localeExcerpts,
    urlSlugs,
    dates,
  });
}

function renderBreadcrumb(
  locale: TopicHubLocale,
  section: TopicHubSection,
  topicLabel: string,
): string {
  const home = `${LOCALE_PREFIX[locale]}/`;
  return `<nav aria-label="breadcrumb" class="text-sm text-subtle mb-3">
  <a href="${esc(home)}" style="${LINK_ACCENT_STYLE}">${esc(COPY[locale].home)}</a>
  <span aria-hidden="true"> › </span>
  <a href="${esc(archivePath(locale, section))}" style="${LINK_ACCENT_STYLE}">${esc(SECTION_LABEL[section][locale])}</a>
  <span aria-hidden="true"> › </span>
  <span aria-current="page">${esc(topicLabel)}</span>
</nav>`;
}

/** Sibling-topic links. This is the hub-to-hub layer the corpus had none of. */
function renderTopicNav(
  locale: TopicHubLocale,
  section: TopicHubSection,
  currentKey: string,
  eligible: ReadonlySet<string>,
): string {
  const items = TOPIC_CLUSTERS.filter((t) => t.key !== currentKey && eligible.has(t.key))
    .map(
      (t) =>
        `<li><a class="rounded-full bg-surface-alt px-3 py-1 text-sm" style="${LINK_ACCENT_STYLE}" href="${esc(buildTopicHubPath(locale, section, t.key))}">${esc(t.label[locale])}</a></li>`,
    )
    .join('');
  if (!items) return '';
  return `<section class="mt-8">
  <h2 style="${H2_STYLE}">${esc(COPY[locale].otherTopics)}</h2>
  <ul class="flex flex-wrap gap-2 mt-2">${items}</ul>
</section>`;
}

function renderPagination(
  locale: TopicHubLocale,
  section: TopicHubSection,
  topicKey: string,
  page: number,
  totalPages: number,
): string {
  if (totalPages <= 1) return '';
  const c = COPY[locale];
  const link = (p: number, label: string): string =>
    `<a style="${LINK_ACCENT_STYLE}" href="${esc(buildTopicHubPath(locale, section, topicKey, p))}" rel="${p < page ? 'prev' : 'next'}">${esc(label)}</a>`;
  const parts = [
    page > 1 ? link(page - 1, c.prev) : '',
    `<span class="text-subtle">${esc(c.pageOf(page, totalPages))}</span>`,
    page < totalPages ? link(page + 1, c.next) : '',
  ].filter(Boolean);
  const compactNav = `<nav aria-label="pagination" class="flex flex-wrap items-center gap-4 mt-8">${parts.join('')}</nav>`;

  // Flat crawler-facing ladder linking EVERY page-N, collapsed (#5414). The
  // compact nav above links only prev/next, so before this ladder page-K of a
  // hub sat K-1 hops from page 1 — with the hubs themselves entering at BFS
  // depth 2 (home → section archive → hub), every page-N ≥ 3 fell past the
  // depth-4 crawl budget and sitemap-topics-*.xml shipped them buried. Same
  // form (and same `.hp`/`.hc` classes, already in seo-static.css) as the
  // `/tutti/` archives' ladder in articleHubPagesPlugin.ts, whose header
  // comment records the original BFS-depth-closure measurement — but with NO
  // `total <= 5` shortcut: that shortcut is safe there because the archive's
  // compact nav links first/last/current±1, while this one links prev/next
  // only, so even a 4-page hub needs the ladder to keep page-4 at one hop.
  // BFS and crawlers read `<a>` inside `<details>` regardless of `open`.
  const flatLabel = {
    it: "Sfoglia tutto l'archivio per pagina",
    en: 'Browse the full archive by page',
    de: 'Vollständiges Archiv nach Seite durchsuchen',
    fr: 'Parcourir toutes les archives par page',
  }[locale];
  const flatAnchors: string[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === page) {
      flatAnchors.push(`<strong class="hc" aria-current="page">${p}</strong>`);
    } else {
      flatAnchors.push(`<a href="${esc(buildTopicHubPath(locale, section, topicKey, p))}" class="hp">${p}</a>`);
    }
  }
  const flatNav = `<nav class="s-4nYHgH" aria-label="${esc(flatLabel)}"><details class="s-Ery2Xe"><summary class="s-goeAUL">${esc(flatLabel)} (${totalPages})</summary><div class="s-6_t7LY">${flatAnchors.join('')}</div></details></nav>`;

  return `${compactNav}${flatNav}`;
}

interface RenderedPage {
  urlPath: string;
  html: string;
  wordCount: number;
  indexable: boolean;
}

function renderHubPage(opts: {
  locale: TopicHubLocale;
  section: TopicHubSection;
  topicKey: string;
  members: readonly ArticleRow[];
  page: number;
  totalPages: number;
  eligible: ReadonlySet<string>;
  dateStamp: string;
  distDir?: string;
}): RenderedPage {
  const { locale, section, topicKey, members, page, totalPages, eligible, dateStamp, distDir } = opts;
  const topic = TOPIC_CLUSTERS.find((t) => t.key === topicKey)!;
  const c = COPY[locale];
  const label = topic.label[locale];
  const urlPath = buildTopicHubPath(locale, section, topicKey, page);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  const slice = members.slice((page - 1) * TOPIC_HUB_PAGE_SIZE, page * TOPIC_HUB_PAGE_SIZE);
  const cards = slice
    .map((a) => {
      const href = articleHref(locale, section, a.urlSlug);
      return `<li class="border-b border-subtle py-3">
  <a class="font-medium" style="${LINK_ACCENT_STYLE}" href="${esc(href)}">${esc(a.title)}</a>
  ${a.excerpt ? `<p class="text-subtle mt-1" style="${BODY_STYLE}">${esc(a.excerpt)}</p>` : ''}
</li>`;
    })
    .join('');

  const newest = members.reduce((acc, a) => (a.date > acc ? a.date : acc), '');
  const tiles = renderStatGrid([
    { label: c.tileArticles, value: String(members.length), tone: 'accent' },
    { label: c.tileTopics, value: String(eligible.size) },
    { label: c.tileUpdated, value: newest || dateStamp },
  ]);

  // No `<main>` here: `buildSeoPageHtml` runs in `seoContentOutsideRoot` mode
  // and wraps this in `<main class="seo-static-content">` itself — that
  // wrapper is the lite-shell detection hook the SPA reads at boot.
  const body = `${renderBreadcrumb(locale, section, label)}
  <p style="${HERO_EYEBROW_STYLE}">${esc(c.eyebrow)}</p>
  <h1 style="${H1_STYLE}">${esc(label)}</h1>
  <p style="${LEDE_STYLE}">${esc(topic.intro[locale])}</p>
${tiles}
  <p class="mt-4" style="${BODY_STYLE}"><a style="${LINK_ACCENT_STYLE}" href="${esc(archivePath(locale, section))}">${esc(c.allArticles)}</a></p>
  <h2 class="mt-6" style="${H2_STYLE}">${esc(c.intro(label, members.length))}</h2>
  <ul class="mt-2">${cards}</ul>
${renderPagination(locale, section, topicKey, page, totalPages)}
${renderTopicNav(locale, section, topicKey, eligible)}`;
  // End-of-content multiplex, same as the 28 sibling static landings. The
  // helper returns '' for a non-indexable page, so the below-floor bridges
  // never carry an ad unit.
  const wordCount = countHtmlBodyWords(body);
  const bodyHtml = `<div class="mx-auto w-full max-w-3xl px-4 py-8">${body}${endOfContentMultiplexHtml(
    { indexable: wordCount >= MIN_INDEXABLE_WORDS },
  )}</div>`;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.home, item: `${BASE_URL}${LOCALE_PREFIX[locale]}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: SECTION_LABEL[section][locale],
        item: `${BASE_URL}${archivePath(locale, section)}`,
      },
      { '@type': 'ListItem', position: 3, name: label, item: canonicalUrl },
    ],
  };
  const collectionLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: label,
    description: topic.intro[locale],
    url: canonicalUrl,
    isPartOf: { '@type': 'WebSite', '@id': `${BASE_URL}/#website` },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: slice.length,
      itemListElement: slice.map((a, i) => ({
        '@type': 'ListItem',
        position: (page - 1) * TOPIC_HUB_PAGE_SIZE + i + 1,
        url: `${BASE_URL}${articleHref(locale, section, a.urlSlug)}`,
        name: a.title,
      })),
    },
  };

  const prevNext = [
    page > 1
      ? `<link rel="prev" href="${BASE_URL}${buildTopicHubPath(locale, section, topicKey, page - 1)}">`
      : '',
    page < totalPages
      ? `<link rel="next" href="${BASE_URL}${buildTopicHubPath(locale, section, topicKey, page + 1)}">`
      : '',
  ]
    .filter(Boolean)
    .join('\n  ');

  const html = buildSeoPageHtml({
    locale,
    title: `${label} — ${SECTION_LABEL[section][locale]}`,
    description: clampMetaDescription(topic.intro[locale]),
    canonicalUrl,
    ogLocale: LOCALE_OG[locale],
    hreflangHtml: buildLocaleAlternateBlock({
      eligibleLocales: TOPIC_HUB_LOCALES,
      hrefFor: (loc) => `${BASE_URL}${buildTopicHubPath(loc as TopicHubLocale, section, topicKey, page)}`,
    }),
    extraHeadHtml: prevNext,
    jsonLdScripts: [JSON.stringify(breadcrumbLd), JSON.stringify(collectionLd)],
    bodyHtml,
    distDir,
  });

  // Counted on the page's own content, not on the full document: the shell
  // adds nav and footer chrome that no thin-content floor should credit.
  return { urlPath, html, wordCount, indexable: true };
}

/**
 * Below-floor bridge: same URL, `noindex,follow`, real onward links. Emitted
 * instead of skipping so a topic that shrinks below the floor does not turn a
 * previously indexed URL into a 404 (AGENTS.md § Static SEO Pages).
 *
 * `page` defaults to 1, which is the below-floor case: the topic has one URL
 * and this is it. It is passed explicitly for the OTHER caller — a page N of
 * an above-floor topic that came out thin — and that argument is load-bearing,
 * not decorative. It used to be absent, so a thin page 5 emitted its bridge at
 * `buildTopicHubPath(locale, section, topicKey)`, i.e. page 1: the indexable
 * page 1 written moments earlier was OVERWRITTEN by a `noindex` bridge, page 5
 * was never written at all, and the sitemap kept announcing page 1 as
 * indexable. One `continue` in the loop below, three wrong outcomes. A bridge
 * belongs at the URL whose content was too thin — nowhere else.
 */
function renderBridgePage(opts: {
  locale: TopicHubLocale;
  section: TopicHubSection;
  topicKey: string;
  memberCount: number;
  eligible: ReadonlySet<string>;
  page?: number;
  distDir?: string;
}): RenderedPage {
  const { locale, section, topicKey, memberCount, eligible, page = 1, distDir } = opts;
  const topic = TOPIC_CLUSTERS.find((t) => t.key === topicKey)!;
  const c = COPY[locale];
  const label = topic.label[locale];
  const urlPath = buildTopicHubPath(locale, section, topicKey, page);

  const body = `${renderBreadcrumb(locale, section, label)}
  <h1 style="${H1_STYLE}">${esc(c.bridgeTitle(label))}</h1>
  <p style="${LEDE_STYLE}">${esc(c.bridgeBody(label, memberCount))}</p>
  <p class="mt-4" style="${BODY_STYLE}"><a style="${LINK_ACCENT_STYLE}" href="${esc(archivePath(locale, section))}">${esc(c.bridgeCta)}</a></p>
${renderTopicNav(locale, section, topicKey, eligible)}`;
  const bodyHtml = `<div class="mx-auto w-full max-w-3xl px-4 py-8">${body}</div>`;

  const html = buildSeoPageHtml({
    locale,
    title: `${label} — ${SECTION_LABEL[section][locale]}`,
    description: clampMetaDescription(topic.intro[locale]),
    canonicalUrl: `${BASE_URL}${urlPath}`,
    ogLocale: LOCALE_OG[locale],
    robots: 'noindex,follow',
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount: countHtmlBodyWords(body), indexable: false };
}

function buildSitemapXml(
  entries: ReadonlyArray<{ canonical: string; alternates: readonly string[] }>,
  today: string,
): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates
        .map((a) => {
          const [lang, ...rest] = a.split('|');
          return `    <xhtml:link rel="alternate" hreflang="${lang}" href="${rest.join('|')}" />`;
        })
        .join('\n');
      return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

/**
 * Cross-check a rendered `sitemap-topics-<section>.xml` against the set of URL
 * paths whose HTML the same run wrote. Returns both directions, because both
 * are defects and they fail differently:
 *
 *  - `announcedNotWritten` — a `<loc>` with no page behind it. This is the
 *    36 phantom `page-N` URLs #5290 half-fixed by silencing the sitemap; a
 *    crawler follows every one of them into a 404.
 *  - `writtenNotAnnounced` — an indexable hub nobody points a crawler at.
 *    Measured at 32 on the same snapshot, and invisible without this side of
 *    the check: a sitemap can be 100% accurate about pages that no longer
 *    exist and still miss every page that does.
 *
 * Pure (string in, arrays out) and exported so the property can be asserted
 * without a build, and so callers can assert it on a REAL render rather than
 * on a fixture that proves only that the fixture is consistent.
 */
export function auditTopicSitemapCoverage(
  xml: string,
  writtenUrlPaths: Iterable<string>,
): { announcedNotWritten: string[]; writtenNotAnnounced: string[] } {
  const written = new Set(writtenUrlPaths);
  const announced = new Set(
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(BASE_URL, '')),
  );
  return {
    announcedNotWritten: [...announced].filter((p) => !written.has(p)).sort(),
    writtenNotAnnounced: [...written].filter((p) => !announced.has(p)).sort(),
  };
}

/**
 * Compute one section's topic membership. Exported for tests: the assignment
 * is the part with real behaviour, and it must be assertable without a build.
 */
export function computeSectionTopics(
  rootDir: string,
  section: TopicHubSection,
): {
  byTopic: ReadonlyMap<string, readonly string[]>;
  rowsByLocale: Map<TopicHubLocale, Map<string, ArticleRow>>;
  directCount: number;
  propagatedCount: number;
  unassignedCount: number;
  total: number;
} {
  const cfg = sectionCfg(section);
  const urlSlugs = readBlogUrlSlugs(fs, np, rootDir, cfg.slugDataFile, cfg.slugConst);
  const dates = readArticleDates(fs, np, rootDir, cfg.registryFile);

  // Italian is the master: it decides which ids exist, and every locale renders
  // that same id set (see readSectionRows for why this is load-bearing).
  const itTitles = new Map(
    readArticleSlugs(fs, np, rootDir, 'it', cfg.metaPrefix).map((a) => [a.slug, a.title]),
  );
  const itExcerpts = readArticleExcerpts(fs, np, rootDir, 'it', cfg.metaPrefix);

  const rowsByLocale = new Map<TopicHubLocale, Map<string, ArticleRow>>();
  for (const locale of TOPIC_HUB_LOCALES) {
    rowsByLocale.set(
      locale,
      readSectionRows(rootDir, section, locale, urlSlugs, dates, itTitles, itExcerpts),
    );
  }

  // Membership from the Italian corpus only — see the module header.
  const itRows = rowsByLocale.get('it')!;
  const assignment = assignArticlesToTopics(
    [...itRows.values()].map((r) => ({
      articleId: r.id,
      title: r.title,
      excerpt: r.excerpt,
      datePub: r.date,
    })),
    TOPIC_CLUSTERS.map((t) => ({ key: t.key, seedText: t.seedText })),
  );

  return {
    byTopic: assignment.byTopic,
    rowsByLocale,
    directCount: assignment.directCount,
    propagatedCount: assignment.propagatedCount,
    unassignedCount: assignment.unassignedCount,
    total: itRows.size,
  };
}

interface TopicHubSectionCoreArgs {
  readonly rootDir: string;
  readonly distDir: string;
  readonly section: TopicHubSection;
  readonly dateStamp: string;
  /** Restrict rendering to these locales. Defaults to all four. */
  readonly locales?: readonly TopicHubLocale[];
  /** Queue a write. The plugin and the fast path both funnel into a WriteCollector. */
  readonly add: (filePath: string, content: string) => void;
  /** Dist-RELATIVE path of every PAGE emitted, for the shard push. */
  readonly onPageEmitted?: (locale: TopicHubLocale, relPath: string) => void;
}

interface TopicHubSectionCoreResult {
  readonly hubPages: number;
  readonly bridgePages: number;
  readonly thin: number;
  /**
   * Dist-relative path of the section sitemap, or null when this render
   * produced no indexable hub at all and therefore has nothing to announce.
   */
  readonly sitemapPath: string | null;
  /** Canonical URL paths listed in that sitemap — every one of them written above. */
  readonly announcedUrlPaths: readonly string[];
}

/**
 * Render ONE section's topic hubs. The single implementation behind both the
 * full build (`topicClusterHubsPlugin` below, both sections) and the fast
 * publish path (`renderTopicClusterHubPages`, the published section only) —
 * so a fast-published hub is byte-identical to what the next full build emits
 * for the same URL BY CONSTRUCTION, not by a comparison test.
 *
 * That is the same shape `renderArticleHubPagesCore` has for the `/tutti/`
 * archive (#4881 Fase 1), and it is deliberate: the archive grew a second
 * consumer first, and the lesson recorded there — "no second implementation,
 * no copy-pasted rendering chrome" — applies here unchanged.
 */
function renderTopicHubSectionCore(args: TopicHubSectionCoreArgs): TopicHubSectionCoreResult {
  const { rootDir, distDir, section, dateStamp, locales, add, onPageEmitted } = args;

  const { byTopic, rowsByLocale, directCount, propagatedCount, unassignedCount, total } =
    computeSectionTopics(rootDir, section);

  // Settle the indexable set BEFORE rendering anything, so the
  // sibling-topic nav on every page advertises only topics that really
  // get an indexable hub (#5114 class: never link a page that is not
  // written). Membership is locale-independent, so this set is too.
  //
  // Computed over ALL topics regardless of the `locales` filter, for the same
  // reason membership is: the nav must advertise the same siblings in a
  // narrowed render as in a full one, or a fast-published page would disagree
  // with its own hreflang cluster.
  const eligible = new Set(
    TOPIC_CLUSTERS.filter((t) => (byTopic.get(t.key)?.length ?? 0) >= TOPIC_HUB_MIN_ARTICLES).map(
      (t) => t.key,
    ),
  );

  console.log(
    `\x1b[36m[topic-hubs]\x1b[0m ${section}: ${total} articoli → ${directCount} diretti + ${propagatedCount} propagati, ${unassignedCount} senza argomento; ${eligible.size}/${TOPIC_CLUSTERS.length} argomenti sopra il floor`,
  );

  let hubPages = 0;
  let bridgePages = 0;
  let thin = 0;

  /**
   * The sitemap is derived from THIS list, and this list is appended to only
   * by `emit()` — i.e. only by the act of queueing the page's own bytes.
   *
   * That is the whole fix for the phantom-pagination class. The list used to
   * be a second array (`sitemapEntries`) filled at a different point in the
   * loop from the one that wrote the file, so "announced" and "written" were
   * two claims that merely happened to agree; when the two producers drifted
   * apart they stopped agreeing and nothing noticed. Now there is one claim:
   * a URL can only reach the sitemap by having been written, and a page that
   * is written but not indexable (a bridge) is recorded as not-announced
   * rather than omitted, so the audit can see it too.
   */
  const emitted: Array<{
    urlPath: string;
    indexable: boolean;
    topicKey: string;
    page: number;
  }> = [];

  /** Emit both the directory index and its flat sibling, reporting each relpath. */
  const emit = (
    locale: TopicHubLocale,
    urlPath: string,
    html: string,
    meta: { indexable: boolean; topicKey: string; page: number },
  ): void => {
    const indexRel = np.join(urlPath.slice(1), 'index.html');
    const flatRel = `${urlPath.replace(/^\/+/, '').replace(/\/+$/, '')}.html`;
    add(np.join(distDir, indexRel), html);
    add(np.join(distDir, flatRel), html);
    onPageEmitted?.(locale, indexRel);
    onPageEmitted?.(locale, flatRel);
    emitted.push({ urlPath, ...meta });
  };

  for (const topic of TOPIC_CLUSTERS) {
    const memberIds = byTopic.get(topic.key) ?? [];

    for (const locale of locales ?? TOPIC_HUB_LOCALES) {
      const rows = rowsByLocale.get(locale)!;
      // Newest first, id as the deterministic tie-break — an article the
      // registry has no date for sorts last but keeps a stable place.
      const members = memberIds
        .map((id) => rows.get(id))
        .filter((r): r is ArticleRow => Boolean(r))
        .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

      if (!eligible.has(topic.key)) {
        const bridge = renderBridgePage({
          locale,
          section,
          topicKey: topic.key,
          memberCount: members.length,
          eligible,
          distDir,
        });
        emit(locale, bridge.urlPath, bridge.html, {
          indexable: false,
          topicKey: topic.key,
          page: 1,
        });
        bridgePages++;
        continue;
      }

      const totalPages = Math.max(1, Math.ceil(members.length / TOPIC_HUB_PAGE_SIZE));
      for (let page = 1; page <= totalPages; page++) {
        const rendered = renderHubPage({
          locale,
          section,
          topicKey: topic.key,
          members,
          page,
          totalPages,
          eligible,
          dateStamp,
          distDir,
        });
        if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
          // Above the article floor but still thin: emit the bridge at
          // THIS page's URL rather than an indexable near-empty page
          // (Non-Negotiable #4) — and `page` is what keeps it at this page's
          // URL instead of stamping it over page 1. See renderBridgePage.
          thin++;
          const bridge = renderBridgePage({
            locale,
            section,
            topicKey: topic.key,
            memberCount: members.length,
            eligible,
            page,
            distDir,
          });
          emit(locale, bridge.urlPath, bridge.html, {
            indexable: false,
            topicKey: topic.key,
            page,
          });
          bridgePages++;
          continue;
        }
        emit(locale, rendered.urlPath, rendered.html, {
          indexable: true,
          topicKey: topic.key,
          page,
        });
        hubPages++;
      }
    }
  }

  // ── The sitemap, written by the same run that wrote the pages ──────────
  //
  // Both producers reach this line: the full build for a section it emits,
  // and `renderTopicClusterHubPages` for the section a fast publish just
  // rendered and is about to push. Whoever writes the pages writes the claim
  // about them, in the same pass, from the same list — which is the property
  // #5290 was reaching for and could not express while the sitemap was
  // written by a producer that did not write the pages.
  //
  // Nothing rendered indexable ⇒ no file. Not an empty `<urlset>`: "there is
  // nothing to announce" and "I announce nothing" read the same to a crawler
  // but not to the sitemap index, which would carry a dead entry.
  const indexable = emitted.filter((e) => e.indexable);
  const announcedUrlPaths = indexable.map((e) => e.urlPath);
  let sitemapPath: string | null = null;
  if (indexable.length > 0) {
    sitemapPath = topicSitemapFileName(section);
    add(
      np.join(distDir, sitemapPath),
      buildSitemapXml(
        indexable.map((e) => ({
          canonical: e.urlPath,
          alternates: [
            ...TOPIC_HUB_LOCALES.map(
              (alt) => `${alt}|${BASE_URL}${buildTopicHubPath(alt, section, e.topicKey, e.page)}`,
            ),
            `x-default|${BASE_URL}${buildTopicHubPath('it', section, e.topicKey, e.page)}`,
          ],
        })),
        dateStamp,
      ),
    );
  }

  return { hubPages, bridgePages, thin, sitemapPath, announcedUrlPaths };
}

export interface RenderTopicClusterHubsOptions {
  readonly rootDir: string;
  /** Absolute dist directory to render into — the fast path's scratch dir. */
  readonly distDir: string;
  readonly section: TopicHubSection;
  readonly locales?: readonly TopicHubLocale[];
}

export interface RenderTopicClusterHubsResult {
  readonly written: number;
  /** Dist-relative paths emitted per locale, ready for the shard push. */
  readonly pathsByLocale: Record<TopicHubLocale, string[]>;
  /**
   * Dist-relative path of the section sitemap this render produced, or null
   * when it produced no indexable hub. Deliberately NOT in `pathsByLocale`:
   * that list drives the per-locale SHARD push and this file is an apex
   * artifact — pushing it into a shard would bury it under a subtree the
   * Worker never serves it from. The caller publishes it to the apex
   * separately (`EDGE_PUSHED_FILES` + `public/`), which is the same split
   * `sitemap-blog-ch.xml` already lives on.
   */
  readonly sitemapPath: string | null;
  /** The canonical URL paths that sitemap announces — all of them written here. */
  readonly announcedUrlPaths: readonly string[];
}

/**
 * Fast-publish entry point (issue #5001 follow-up): re-render one section's
 * topic hubs into an arbitrary dist directory.
 *
 * WHY THE WHOLE SECTION AND NOT JUST THE NEW ARTICLE'S TOPIC
 * ─────────────────────────────────────────────────────────
 * Publishing one article does not perturb one hub in isolation. It changes the
 * corpus the TF-IDF model is built from, so every article's IDF-weighted score
 * against every topic seed shifts a little and a borderline article can flip
 * topics; it can push a topic across TOPIC_HUB_MIN_ARTICLES, which rewrites the
 * sibling-topic nav on EVERY hub of the section; and it moves the "Argomenti"
 * stat tile. Re-rendering only the new article's own topic would therefore
 * leave the rest of the section disagreeing with what the next full build
 * emits — the drift class this function exists to avoid.
 *
 * The whole section is affordable: assignment is 381 ms for the 3.103-article
 * frontaliere corpus and 50 ms for svizzera (measured 2026-08-07), and the
 * render is string building. This mirrors `renderArticleHubPages`, which
 * likewise re-renders the section's entire `/tutti/` archive rather than the
 * pages the new article happens to land on.
 *
 * THE SITEMAP IS WRITTEN HERE, and that is the point.
 * ───────────────────────────────────────────────────
 * It used to be skipped, on the reasoning that `sitemap-topics.xml` was a
 * whole-site artifact covering both sections while a fast publish knows only
 * one — true of a single shared file, and the reason there is no longer one.
 * `sitemap-topics-<section>.xml` is exactly the scope this function has, so
 * "the producer announces what it wrote" costs nothing extra here.
 *
 * Leaving it to the next full build did not work, and could not: the build
 * skips both article sections (BUILD_EMIT_SKIP, see below), so after #5290 it
 * writes no topic sitemap at all — 536 live URLs with no sitemap naming them.
 * Before #5290 it wrote one from ITS corpus snapshot while these pages came
 * from a fast publish at another one, which is where the 36 phantom `page-N`
 * URLs came from. Same file, two producers, one of them not looking at what
 * was on disk.
 *
 * IT DOES NOT HONOUR `<SECTION>_BUILD_EMIT_SKIP, AND MUST NOT (#5290).
 * ──────────────────────────────────────────────────────────────────
 * That flag is checked in `closeBundle` below, and it means «the BUILD does not
 * ship this section» — deploy.yml excludes such a section from the full-replace
 * shard push, so pages the build writes there would never reach production
 * while `sitemap-topics.xml`, written at the apex, would advertise them. #5290
 * fixed exactly that: thousands of sitemap'd 404s.
 *
 * «The build does not ship it» is NOT «these pages must not exist». Both
 * article sections default to `BUILD_EMIT_SKIP=true`
 * (deploy.yml:339-340 — true unless the repo var is explicitly 'false'), and
 * deploy.yml:691 spells out why: «excluded from full-replace push (served by
 * fast-publish only)». This function IS that fast publish, and it pushes what
 * it renders through `shards[].paths`. Gating it on the same flag would skip
 * both sections — every section there is — and silently turn the whole
 * freshness fix into dead code while every test still passed.
 *
 * So: gate the producer that cannot deliver, not the one that can.
 */
export async function renderTopicClusterHubPages(
  opts: RenderTopicClusterHubsOptions,
): Promise<RenderTopicClusterHubsResult> {
  const { rootDir, distDir, section, locales } = opts;

  const collector = new WriteCollector({ distDir, pluginName: 'topicClusterHubsPlugin' });
  const pathsByLocale = Object.fromEntries(
    TOPIC_HUB_LOCALES.map((l) => [l, [] as string[]]),
  ) as Record<TopicHubLocale, string[]>;

  const { sitemapPath, announcedUrlPaths } = renderTopicHubSectionCore({
    rootDir,
    distDir,
    section,
    dateStamp: new Date().toISOString().slice(0, 10),
    locales,
    add: (filePath, content) => collector.add(filePath, content),
    onPageEmitted: (locale, relPath) => {
      pathsByLocale[locale].push(relPath);
    },
  });

  const written = await collector.flush();
  return { written, pathsByLocale, sitemapPath, announcedUrlPaths };
}

export function topicClusterHubsPlugin(rootDir: string): Plugin {
  return {
    name: 'topic-cluster-hubs',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_TOPIC_HUBS === '1') {
        console.log('\x1b[33m[topic-hubs]\x1b[0m Skipped (SKIP_TOPIC_HUBS=1)');
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'topicClusterHubsPlugin' });
      let hubPages = 0;
      let bridgePages = 0;
      let thin = 0;

      // Build-time emit skip, same flags seoHubsPlugin.ts and
      // staticPagesPlugin.ts already honour for the article sections.
      //
      // WHY THIS MATTERS HERE. These hubs live UNDER the article sections
      // (`/articoli-frontaliere/topics/…`, `/en/cross-border-articles/topics/…`).
      // When a section's emit is skipped the deploy excludes its whole subtree
      // from the shard push — so pages written here never reach production,
      // while `sitemap-topics.xml`, which is written at the apex, ships and
      // advertises them. Measured 2026-08-07 on the live site:
      //
      //   /en/cross-border-articles/topics/salaries/page-9/  → 404
      //   /en/cross-border-articles/topics/salaries/         → 404
      //   /articoli-frontaliere/topics/                      → 404
      //
      // and `nanakokyobashi-rgb/frontaliere-articolifrontaliere-en` has no
      // `topics/` directory at all. The corpus HAS the engine (topicClusters.ts
      // and topicTaxonomy.ts are mirrored) but does not render these hubs, so
      // nobody produces them: the sitemap was submitting thousands of 404s to
      // search engines, and `scripts/ci/assert-dist-complete.mjs` — which runs
      // in post-deploy-validate-dist.yml — was about to go red on
      // `sitemap-topics.xml: 40/40 sampled URLs missing (100%)`.
      //
      // This is the plugin's own rule applied one level up: it already settles
      // the eligible topic set before rendering so the sibling nav never links
      // a page that is not written (#5114 class). A section that is not pushed
      // is the same thing at section scale.
      const buildEmitSkip: Record<TopicHubSection, boolean> = {
        frontaliere: process.env.ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP === 'true',
        svizzera: process.env.ARTICOLISVIZZERA_BUILD_EMIT_SKIP === 'true',
      };

      for (const section of TOPIC_HUB_SECTIONS) {
        // The gate lives HERE, in the build's own loop, and deliberately NOT
        // inside `renderTopicHubSectionCore`: it encodes "the BUILD does not
        // ship this section", which is not the same claim as "these pages must
        // not exist". `renderTopicClusterHubPages` — the fast-publish entry
        // point — calls the core directly and is unaffected, which is the whole
        // point. See that function's header.
        if (buildEmitSkip[section]) {
          console.log(
            `\x1b[33m[topic-hubs]\x1b[0m ${section}: emit skipped (BUILD_EMIT_SKIP) — no pages, no ${topicSitemapFileName(section)}`,
          );
          continue;
        }

        // The section sitemap is written by the core, from the pages the core
        // just queued — so skipping the section above skips its sitemap too,
        // and there is no longer a place where this loop could write one for
        // a section it did not render (#5290's failure mode, now unreachable
        // rather than guarded).
        //
        // No `patchSitemapIndex` here any more, and none is needed:
        // `sitemapAliasPlugin` runs `enforce: 'post'` + `closeBundle.order:
        // 'post'` AFTER this plugin and REGENERATES dist/sitemap.xml by
        // discovering every dist/sitemap-*.xml. It overwrote the patch this
        // plugin used to apply, so the patch never reached production —
        // auto-discovery is what put the file in the index, and it is also
        // what correctly leaves it out when the file is absent.
        const counts = renderTopicHubSectionCore({
          rootDir,
          distDir,
          section,
          dateStamp,
          add: (filePath, content) => collector.add(filePath, content),
        });
        hubPages += counts.hubPages;
        bridgePages += counts.bridgePages;
        thin += counts.thin;
        if (counts.sitemapPath) {
          console.log(
            `\x1b[36m[topic-hubs]\x1b[0m ${section}: ${counts.sitemapPath} — ${counts.announcedUrlPaths.length} URL annunciate, tutte scritte in questo run`,
          );
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[topic-hubs]\x1b[0m ${hubPages} hub + ${bridgePages} bridge (${thin} thin→bridge) — ${written} file in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    },
  };
}

// Test-only exports.
export {
  renderHubPage as __renderTopicHubPageForTest,
  renderBridgePage as __renderTopicBridgeForTest,
  renderPagination as __renderTopicPaginationForTest,
};
