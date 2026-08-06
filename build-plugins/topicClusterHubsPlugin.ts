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
 * Read one section's article rows for one locale. Titles/excerpts come from
 * that locale's meta chunk; ids, URL slugs and dates are locale-independent.
 */
function readSectionRows(
  rootDir: string,
  section: TopicHubSection,
  locale: TopicHubLocale,
  urlSlugs: Record<string, Record<string, string>>,
  dates: Map<string, string>,
): Map<string, ArticleRow> {
  const cfg = sectionCfg(section);
  const titles = readArticleSlugs(fs, np, rootDir, locale as 'it', cfg.metaPrefix);
  const excerpts = readArticleExcerpts(fs, np, rootDir, locale as 'it', cfg.metaPrefix);
  const rows = new Map<string, ArticleRow>();
  for (const { slug, title } of titles) {
    rows.set(slug, {
      id: slug,
      title,
      excerpt: excerpts.get(slug) ?? '',
      urlSlug: urlSlugs[slug]?.[locale] ?? slug,
      date: dates.get(slug) ?? '',
    });
  }
  return rows;
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
  return `<nav aria-label="pagination" class="flex flex-wrap items-center gap-4 mt-8">${parts.join('')}</nav>`;
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
 */
function renderBridgePage(opts: {
  locale: TopicHubLocale;
  section: TopicHubSection;
  topicKey: string;
  memberCount: number;
  eligible: ReadonlySet<string>;
  distDir?: string;
}): RenderedPage {
  const { locale, section, topicKey, memberCount, eligible, distDir } = opts;
  const topic = TOPIC_CLUSTERS.find((t) => t.key === topicKey)!;
  const c = COPY[locale];
  const label = topic.label[locale];
  const urlPath = buildTopicHubPath(locale, section, topicKey);

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

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes('sitemap-topics.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-topics.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-topics\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[topic-hubs] failed to patch sitemap index', err);
  }
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

  const rowsByLocale = new Map<TopicHubLocale, Map<string, ArticleRow>>();
  for (const locale of TOPIC_HUB_LOCALES) {
    rowsByLocale.set(locale, readSectionRows(rootDir, section, locale, urlSlugs, dates));
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
      const sitemapEntries: Array<{ canonical: string; alternates: readonly string[] }> = [];
      let hubPages = 0;
      let bridgePages = 0;
      let thin = 0;

      for (const section of TOPIC_HUB_SECTIONS) {
        const { byTopic, rowsByLocale, directCount, propagatedCount, unassignedCount, total } =
          computeSectionTopics(rootDir, section);

        // Settle the indexable set BEFORE rendering anything, so the
        // sibling-topic nav on every page advertises only topics that really
        // get an indexable hub (#5114 class: never link a page that is not
        // written). Membership is locale-independent, so this set is too.
        const eligible = new Set(
          TOPIC_CLUSTERS.filter(
            (t) => (byTopic.get(t.key)?.length ?? 0) >= TOPIC_HUB_MIN_ARTICLES,
          ).map((t) => t.key),
        );

        console.log(
          `\x1b[36m[topic-hubs]\x1b[0m ${section}: ${total} articoli → ${directCount} diretti + ${propagatedCount} propagati, ${unassignedCount} senza argomento; ${eligible.size}/${TOPIC_CLUSTERS.length} argomenti sopra il floor`,
        );

        for (const topic of TOPIC_CLUSTERS) {
          const memberIds = byTopic.get(topic.key) ?? [];

          for (const locale of TOPIC_HUB_LOCALES) {
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
              collector.add(np.join(distDir, bridge.urlPath, 'index.html'), bridge.html);
              collector.add(
                np.join(distDir, `${bridge.urlPath.replace(/\/+$/, '')}.html`),
                bridge.html,
              );
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
                // the same URL rather than an indexable near-empty page
                // (Non-Negotiable #4).
                thin++;
                const bridge = renderBridgePage({
                  locale,
                  section,
                  topicKey: topic.key,
                  memberCount: members.length,
                  eligible,
                  distDir,
                });
                collector.add(np.join(distDir, bridge.urlPath, 'index.html'), bridge.html);
                collector.add(
                  np.join(distDir, `${bridge.urlPath.replace(/\/+$/, '')}.html`),
                  bridge.html,
                );
                bridgePages++;
                continue;
              }
              collector.add(np.join(distDir, rendered.urlPath, 'index.html'), rendered.html);
              collector.add(
                np.join(distDir, `${rendered.urlPath.replace(/\/+$/, '')}.html`),
                rendered.html,
              );
              hubPages++;
              sitemapEntries.push({
                canonical: rendered.urlPath,
                alternates: [
                  ...TOPIC_HUB_LOCALES.map(
                    (alt) => `${alt}|${BASE_URL}${buildTopicHubPath(alt, section, topic.key, page)}`,
                  ),
                  `x-default|${BASE_URL}${buildTopicHubPath('it', section, topic.key, page)}`,
                ],
              });
            }
          }
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          fs.writeFileSync(
            np.join(distDir, 'sitemap-topics.xml'),
            buildSitemapXml(sitemapEntries, dateStamp),
            'utf-8',
          );
          patchSitemapIndex(distDir, dateStamp);
        } catch (err) {
          console.warn('\x1b[33m[topic-hubs]\x1b[0m sitemap write failed:', err);
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
export { renderHubPage as __renderTopicHubPageForTest, renderBridgePage as __renderTopicBridgeForTest };
