/**
 * SEO Hub-pages emitter (Phase 2-UI)
 *
 * Generates 4 hub families × 4 locales of paginated index pages:
 *   - JobsHub      → all known job slugs (28k+) → ~284 pages × 4 locales
 *   - SectorsHub   → curated 50-sector list   → 1 page × 4 locales
 *   - CompaniesHub → known-company-slugs.json → ~2 pages × 4 locales
 *   - ArticlesHub  → blog-meta-{lang}.ts      → ~9 pages × 4 locales
 *
 * Each page is fully static HTML with canonical, hreflang alternates,
 * BreadcrumbList + CollectionPage JSON-LD, and the SPA bundle for
 * post-hydration chrome. The router maps every URL to `staticOverlay: true`
 * so React doesn't replace the body once it hydrates.
 *
 * The emitter is exposed as a plain function (not a Vite Plugin) and is
 * invoked from inside `staticPagesPlugin.ts:closeBundle()` to avoid touching
 * vite.config.ts (Phase-2-UI brief — vite.config is read-only).
 */

import type fsT from 'node:fs';
import type npT from 'node:path';
import { BASE_URL } from './constants';
import {
  ARTICLES_PAGE_SIZE,
  COMPANIES_PAGE_SIZE,
  HUB_LOCALES,
  HUB_SECTORS,
  HUB_SLUGS,
  JOBS_PAGE_SIZE,
  paginatedPath,
  type HubLocale,
} from './seoHubsData';

const LOCALE_OG: Record<HubLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

const SECTION_LABEL: Record<HubLocale, { jobBoard: string; companies: string; articles: string }> = {
  it: { jobBoard: 'Cerca lavoro in Ticino', companies: 'Aziende che assumono', articles: 'Articoli per frontalieri' },
  en: { jobBoard: 'Find jobs in Ticino', companies: 'Hiring companies', articles: 'Cross-border articles' },
  de: { jobBoard: 'Jobs im Tessin', companies: 'Einstellende Firmen', articles: 'Grenzgänger-Artikel' },
  fr: { jobBoard: 'Emplois au Tessin', companies: 'Entreprises qui recrutent', articles: 'Articles pour frontaliers' },
};

const HUB_TITLES: Record<HubLocale, { jobs: string; sectors: string; companies: string; articles: string }> = {
  it: {
    jobs: 'Tutti gli annunci di lavoro',
    sectors: 'Tutti i settori professionali',
    companies: 'Tutte le aziende che assumono',
    articles: 'Tutti gli articoli per frontalieri',
  },
  en: {
    jobs: 'All cross-border job listings',
    sectors: 'All professional sectors',
    companies: 'All hiring companies',
    articles: 'All cross-border worker articles',
  },
  de: {
    jobs: 'Alle Stellenangebote',
    sectors: 'Alle Branchen',
    companies: 'Alle einstellenden Firmen',
    articles: 'Alle Grenzgänger-Artikel',
  },
  fr: {
    jobs: 'Toutes les offres d’emploi',
    sectors: 'Tous les secteurs',
    companies: 'Toutes les entreprises qui recrutent',
    articles: 'Tous les articles pour frontaliers',
  },
};

const HUB_DESCRIPTIONS: Record<HubLocale, { jobs: string; sectors: string; companies: string; articles: string }> = {
  it: {
    jobs: 'Indice completo di tutte le offerte di lavoro indicizzate per i frontalieri in Ticino. Aggiornato quotidianamente con migliaia di posizioni aperte.',
    sectors: 'Esplora le offerte per settore: sanitario, ingegneria, banca, ristorazione, edilizia e oltre 40 categorie professionali.',
    companies: 'Indice alfabetico di oltre 200 aziende che assumono frontalieri in Ticino, con offerte attive per locale e settore.',
    articles: 'Archivio completo di guide, analisi fiscali e aggiornamenti dedicati ai lavoratori frontalieri italo-svizzeri.',
  },
  en: {
    jobs: 'Complete index of every indexed job posting for cross-border workers in Ticino. Updated daily with thousands of openings.',
    sectors: 'Explore jobs by sector: healthcare, engineering, banking, hospitality, construction and 40+ professional categories.',
    companies: 'Alphabetical index of 200+ companies hiring cross-border workers in Ticino, with active openings per location and sector.',
    articles: 'Full archive of guides, tax analysis and updates for Italian-Swiss cross-border workers.',
  },
  de: {
    jobs: 'Vollständiger Index aller indizierten Stellenangebote für Grenzgänger im Tessin. Täglich aktualisiert mit tausenden offenen Stellen.',
    sectors: 'Stellenangebote nach Branche: Gesundheit, Ingenieurwesen, Bank, Gastronomie, Bau und über 40 Berufsgruppen.',
    companies: 'Alphabetisches Verzeichnis von 200+ Firmen, die Grenzgänger im Tessin einstellen.',
    articles: 'Vollständiges Archiv von Leitfäden, Steueranalysen und Updates für italienisch-schweizerische Grenzgänger.',
  },
  fr: {
    jobs: 'Index complet de toutes les offres d’emploi indexées pour les frontaliers au Tessin. Mis à jour quotidiennement.',
    sectors: 'Offres d’emploi par secteur : santé, ingénierie, banque, restauration, construction et plus de 40 catégories.',
    companies: 'Index alphabétique de plus de 200 entreprises qui recrutent des frontaliers au Tessin.',
    articles: 'Archive complète de guides, analyses fiscales et actualités pour les frontaliers italo-suisses.',
  },
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert a job slug like "infermiera-bellinzona-eoc" → "Infermiera Bellinzona Eoc" */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w)
    .join(' ')
    .slice(0, 110);
}

function withSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

/**
 * Narrative H1 distinct from <title> (Semrush W3, Issue 105). Keeps the
 * count + section context user-facing, while the title is keyword-first.
 */
type HubKeyName = 'jobs' | 'sectors' | 'companies' | 'articles';
function buildHubH1(locale: HubLocale, hubKey: HubKeyName, count: number, page: number): string {
  const TEMPLATES: Record<HubLocale, Record<HubKeyName, (n: number) => string>> = {
    it: {
      jobs: (n) => `${n.toLocaleString('it-IT')} annunci di lavoro per frontalieri`,
      sectors: () => `Settori professionali con offerte di lavoro attive`,
      companies: (n) => `${n.toLocaleString('it-IT')} datori di lavoro in Ticino e Svizzera`,
      articles: (n) => `${n.toLocaleString('it-IT')} guide e approfondimenti per frontalieri`,
    },
    en: {
      jobs: (n) => `${n.toLocaleString('en-US')} cross-border job openings`,
      sectors: () => `Professional sectors with active openings`,
      companies: (n) => `${n.toLocaleString('en-US')} employers hiring in Ticino and Switzerland`,
      articles: (n) => `${n.toLocaleString('en-US')} guides and insights for cross-border workers`,
    },
    de: {
      jobs: (n) => `${n.toLocaleString('de-DE')} Stellenangebote für Grenzgänger`,
      sectors: () => `Branchen mit aktiven Stellenangeboten`,
      companies: (n) => `${n.toLocaleString('de-DE')} Arbeitgeber im Tessin und in der Schweiz`,
      articles: (n) => `${n.toLocaleString('de-DE')} Ratgeber und Hintergründe für Grenzgänger`,
    },
    fr: {
      jobs: (n) => `${n.toLocaleString('fr-FR')} offres d’emploi pour frontaliers`,
      sectors: () => `Secteurs professionnels avec offres actives`,
      companies: (n) => `${n.toLocaleString('fr-FR')} employeurs au Tessin et en Suisse`,
      articles: (n) => `${n.toLocaleString('fr-FR')} guides et analyses pour frontaliers`,
    },
  };
  const base = TEMPLATES[locale][hubKey](count);
  return page > 1 ? `${base} — ${pageLabel(locale, page)}` : base;
}

interface PaginatedHub {
  readonly hubKey: 'jobs' | 'sectors' | 'companies' | 'articles';
  readonly itemHrefBuilder: (item: string, locale: HubLocale) => string;
  readonly itemLabelBuilder: (item: string, locale: HubLocale) => string;
  readonly items: readonly string[];
  readonly pageSize: number;
}

/**
 * Read all-known-job-slugs.json — shape is `{ canonicalSlug: { locale: path } }`
 * We use the canonicalSlug list and build URLs per-locale from the inner map.
 */
function readJobSlugsMap(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): { slugs: string[]; perLocale: Record<HubLocale, Record<string, string>> } {
  const file = np.resolve(rootDir, 'data/all-known-job-slugs.json');
  const empty = {
    slugs: [] as string[],
    perLocale: { it: {}, en: {}, de: {}, fr: {} } as Record<HubLocale, Record<string, string>>,
  };
  try {
    if (!fs.existsSync(file)) return empty;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') return empty;
    const slugs = Object.keys(raw).sort();
    const perLocale: Record<HubLocale, Record<string, string>> = { it: {}, en: {}, de: {}, fr: {} };
    for (const s of slugs) {
      const inner = raw[s];
      if (inner && typeof inner === 'object') {
        for (const loc of HUB_LOCALES) {
          const v = (inner as Record<string, unknown>)[loc];
          if (typeof v === 'string' && v.length > 0) perLocale[loc][s] = v;
        }
      }
    }
    return { slugs, perLocale };
  } catch (err) {
    console.warn('[seo-hubs] failed to read all-known-job-slugs.json', err);
    return empty;
  }
}

function readCompanySlugs(fs: typeof fsT, np: typeof npT, rootDir: string): string[] {
  const file = np.resolve(rootDir, 'data/known-company-slugs.json');
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(raw)) return [...raw].filter((s) => typeof s === 'string' && s.length > 0).sort();
  } catch (err) {
    console.warn('[seo-hubs] failed to read known-company-slugs.json', err);
  }
  return [];
}

/**
 * Read article slugs from blog-meta-{lang}.ts. Each line keyed
 * `'blog.article.<slug>.title'` is one article.
 */
function readArticleSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  locale: HubLocale,
): Array<{ slug: string; title: string }> {
  const file = np.resolve(rootDir, 'services/locales', `blog-meta-${locale}.ts`);
  const out: Array<{ slug: string; title: string }> = [];
  try {
    if (!fs.existsSync(file)) return out;
    const src = fs.readFileSync(file, 'utf-8');
    const seen = new Set<string>();
    const rx = /'blog\.article\.([^']+?)\.title':\s*'((?:[^'\\]|\\.)*)'/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(src)) !== null) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      const title = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
      out.push({ slug, title });
    }
  } catch (err) {
    console.warn(`[seo-hubs] failed to read blog-meta-${locale}.ts`, err);
  }
  return out;
}

interface BuildHtmlArgs {
  locale: HubLocale;
  hubKey: 'jobs' | 'sectors' | 'companies' | 'articles';
  basePath: string;
  page: number;
  totalPages: number;
  pageItems: ReadonlyArray<{ href: string; label: string }>;
  totalItems: number;
  hasSpaBundle: boolean;
  entryJs: string;
  entryCss: string;
}

function buildHtml(args: BuildHtmlArgs): string {
  const { locale, hubKey, basePath, page, totalPages, pageItems, totalItems, hasSpaBundle, entryJs, entryCss } = args;
  const title = HUB_TITLES[locale][hubKey];
  const description = HUB_DESCRIPTIONS[locale][hubKey];
  // Title ≤60 char (Semrush W2): drop "| Frontaliere Ticino" suffix when adding it
  // would push us over budget. Page-N suffix is also keyword for SEO.
  const baseTitle = page > 1 ? `${title} — ${pageLabel(locale, page)}` : title;
  const brandSuffix = ' | Frontaliere Ticino';
  const pageTitle = baseTitle.length + brandSuffix.length <= 60 ? `${baseTitle}${brandSuffix}` : baseTitle;
  const canonicalPath = paginatedPath(basePath, page);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const dateStamp = new Date().toISOString().slice(0, 10);

  // hreflang: only emit alternates for page-1 (paginated pages share lang)
  const hreflangs = page === 1
    ? HUB_LOCALES
        .map((loc) => {
          const slugs = HUB_SLUGS[loc];
          const altPath =
            hubKey === 'jobs' ? slugs.jobsAll
            : hubKey === 'sectors' ? slugs.sectorsAll
            : hubKey === 'companies' ? slugs.companiesAll
            : slugs.articlesAll;
          return `    <link rel="alternate" hreflang="${loc}" href="${BASE_URL}${altPath}">`;
        })
        .join('\n')
    : '';
  const xDefault = page === 1
    ? `\n    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${
        hubKey === 'jobs' ? HUB_SLUGS.it.jobsAll
        : hubKey === 'sectors' ? HUB_SLUGS.it.sectorsAll
        : hubKey === 'companies' ? HUB_SLUGS.it.companiesAll
        : HUB_SLUGS.it.articlesAll
      }">`
    : '';

  const prevLink = page > 1 ? `\n    <link rel="prev" href="${BASE_URL}${paginatedPath(basePath, page - 1)}">` : '';
  const nextLink = page < totalPages ? `\n    <link rel="next" href="${BASE_URL}${paginatedPath(basePath, page + 1)}">` : '';

  // BreadcrumbList JSON-LD
  const sectionLabel = hubKey === 'companies'
    ? SECTION_LABEL[locale].companies
    : hubKey === 'articles'
    ? SECTION_LABEL[locale].articles
    : SECTION_LABEL[locale].jobBoard;

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: sectionLabel, item: `${BASE_URL}${basePath}` },
      ...(page > 1
        ? [{ '@type': 'ListItem', position: 3, name: pageLabel(locale, page), item: canonicalUrl }]
        : []),
    ],
  });

  const collectionLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: canonicalUrl,
    description,
    inLanguage: locale,
    dateModified: new Date().toISOString(),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: totalItems,
      itemListElement: pageItems.slice(0, 50).map((it, idx) => ({
        '@type': 'ListItem',
        position: (page - 1) * 100 + idx + 1,
        name: it.label,
        url: `${BASE_URL}${it.href}`,
      })),
    },
  });

  // Pagination chrome: prev / page-numbers / next
  const pagination = totalPages > 1 ? renderPagination(locale, basePath, page, totalPages) : '';

  // Items list
  const itemsHtml = pageItems.length === 0
    ? `<p style="color:var(--color-subtle);padding:16px 0">${esc(emptyLabel(locale))}</p>`
    : `<ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">${pageItems
        .map(
          (it) =>
            `<li><a href="${esc(it.href)}" style="display:block;padding:10px 12px;border-radius:8px;color:var(--color-heading);background:var(--color-surface);text-decoration:none;border:1px solid var(--color-edge);font-size:14px;line-height:1.4">${esc(it.label)}</a></li>`,
        )
        .join('')}</ul>`;

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(pageTitle)}</title>
    <meta name="description" content="${esc(description)}">
    <meta name="robots" content="index,follow">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[locale]}">
    <meta property="og:title" content="${esc(pageTitle)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="canonical" href="${canonicalUrl}">
${hreflangs}${xDefault}${prevLink}${nextLink}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
  </head>
  <body class="bg-surface-alt text-heading overflow-x-hidden">
    <div id="root"></div>
    <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
      <nav style="font-size:13px;color:var(--color-subtle);margin-bottom:16px" aria-label="Breadcrumb">
        <a href="${BASE_URL}/" style="color:var(--color-accent);text-decoration:none">Home</a>
        <span> / </span>
        <span>${esc(sectionLabel)}</span>
      </nav>
      <header style="margin-bottom:24px">
        <h1 style="font-size:32px;font-weight:800;line-height:1.2;color:var(--color-heading);margin:0 0 12px">${esc(buildHubH1(locale, hubKey, totalItems, page))}</h1>
        <p style="font-size:16px;color:var(--color-body);max-width:780px;line-height:1.55;margin:0">${esc(description)}</p>
        <p style="margin-top:8px;color:var(--color-subtle);font-size:13px">${esc(countLabel(locale, totalItems))} · ${esc(updatedLabel(locale))} ${dateStamp}</p>
      </header>
      <section>
        ${itemsHtml}
      </section>
      ${pagination}
    </main>
    <div id="footer-root"></div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
}

function pageLabel(locale: HubLocale, page: number): string {
  const word = { it: 'Pagina', en: 'Page', de: 'Seite', fr: 'Page' }[locale];
  return `${word} ${page}`;
}
function emptyLabel(locale: HubLocale): string {
  return { it: 'Nessun risultato disponibile.', en: 'No results available.', de: 'Keine Ergebnisse verfügbar.', fr: 'Aucun résultat disponible.' }[locale];
}
function countLabel(locale: HubLocale, n: number): string {
  return { it: `${n.toLocaleString('it')} risorse`, en: `${n.toLocaleString('en')} entries`, de: `${n.toLocaleString('de')} Einträge`, fr: `${n.toLocaleString('fr')} entrées` }[locale];
}
function updatedLabel(locale: HubLocale): string {
  return { it: 'Aggiornato', en: 'Updated', de: 'Aktualisiert', fr: 'Mis à jour' }[locale];
}

function renderPagination(locale: HubLocale, basePath: string, current: number, total: number): string {
  // Compact pagination: prev, 1, current-1, current, current+1, last, next
  const pages = new Set<number>();
  pages.add(1);
  pages.add(total);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const prevLabel = { it: '« Precedente', en: '« Previous', de: '« Zurück', fr: '« Précédent' }[locale];
  const nextLabel = { it: 'Successiva »', en: 'Next »', de: 'Weiter »', fr: 'Suivant »' }[locale];

  const baseStyle = 'display:inline-block;padding:6px 12px;margin:2px;border-radius:6px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-size:14px';
  const activeStyle = 'display:inline-block;padding:6px 12px;margin:2px;border-radius:6px;background:var(--color-accent);color:white;font-size:14px;font-weight:700';

  const parts: string[] = [];
  if (current > 1) {
    parts.push(`<a href="${BASE_URL}${paginatedPath(basePath, current - 1)}" style="${baseStyle}" rel="prev">${prevLabel}</a>`);
  }
  let last = 0;
  for (const p of sorted) {
    if (last && p - last > 1) parts.push(`<span style="padding:0 6px;color:var(--color-subtle)">…</span>`);
    if (p === current) {
      parts.push(`<span style="${activeStyle}" aria-current="page">${p}</span>`);
    } else {
      parts.push(`<a href="${BASE_URL}${paginatedPath(basePath, p)}" style="${baseStyle}">${p}</a>`);
    }
    last = p;
  }
  if (current < total) {
    parts.push(`<a href="${BASE_URL}${paginatedPath(basePath, current + 1)}" style="${baseStyle}" rel="next">${nextLabel}</a>`);
  }
  return `<nav aria-label="Pagination" style="margin-top:32px;text-align:center">${parts.join('')}</nav>`;
}

interface EmitArgs {
  rootDir: string;
  distDir: string;
  fs: typeof fsT;
  np: typeof npT;
  entryJs: string;
  entryCss: string;
  hasSpaBundle: boolean;
  /** Buffered writer from staticPagesPlugin (or noop if direct fs is used). */
  qw: (filePath: string, content: string) => void;
}

/**
 * Emits all 4 hub families × 4 locales × all paginated pages to dist/.
 * Returns the number of pages written and the sitemap entries to append.
 */
export function emitSeoHubs(args: EmitArgs): { pagesEmitted: number; sitemapEntries: string[] } {
  const { rootDir, distDir, fs, np, entryJs, entryCss, hasSpaBundle, qw } = args;
  let pagesEmitted = 0;
  const sitemapEntries: string[] = [];
  const dateStamp = new Date().toISOString().slice(0, 10);

  const { slugs: jobSlugs, perLocale: jobPerLocale } = readJobSlugsMap(fs, np, rootDir);
  const companySlugs = readCompanySlugs(fs, np, rootDir);

  const ensuredDirs = new Set<string>();
  function writeFile(canonicalPath: string, html: string): void {
    const indexFile = np.join(distDir, canonicalPath.slice(1), 'index.html');
    qw(indexFile, html);
    pagesEmitted++;
  }

  function emitHub(hubKey: 'jobs' | 'sectors' | 'companies' | 'articles', locale: HubLocale): void {
    const basePath = (
      hubKey === 'jobs' ? HUB_SLUGS[locale].jobsAll
      : hubKey === 'sectors' ? HUB_SLUGS[locale].sectorsAll
      : hubKey === 'companies' ? HUB_SLUGS[locale].companiesAll
      : HUB_SLUGS[locale].articlesAll
    );

    let items: Array<{ href: string; label: string }> = [];
    let pageSize = 100;

    if (hubKey === 'jobs') {
      pageSize = JOBS_PAGE_SIZE;
      const localeMap = jobPerLocale[locale];
      for (const slug of jobSlugs) {
        const localePath = localeMap[slug];
        if (!localePath) continue;
        items.push({ href: localePath, label: humanizeSlug(slug) });
      }
    } else if (hubKey === 'sectors') {
      pageSize = HUB_SECTORS.length;
      const sectionRoot = locale === 'it' ? '/cerca-lavoro-ticino' : `/${locale}/${
        locale === 'en' ? 'find-jobs-ticino' : locale === 'de' ? 'jobs-im-tessin' : 'trouver-emploi-tessin'
      }`;
      for (const sector of HUB_SECTORS) {
        items.push({
          href: `${sectionRoot}/?q=${encodeURIComponent(sector[locale])}`,
          label: sector[locale],
        });
      }
    } else if (hubKey === 'companies') {
      pageSize = COMPANIES_PAGE_SIZE;
      const sectionRoot = locale === 'it' ? '/cerca-lavoro-ticino' : `/${locale}/${
        locale === 'en' ? 'find-jobs-ticino' : locale === 'de' ? 'jobs-im-tessin' : 'trouver-emploi-tessin'
      }`;
      for (const slug of companySlugs) {
        items.push({
          href: `${sectionRoot}/azienda-${slug}/`,
          label: humanizeSlug(slug),
        });
      }
    } else {
      pageSize = ARTICLES_PAGE_SIZE;
      const articles = readArticleSlugs(fs, np, rootDir, locale);
      const blogSection = locale === 'it' ? 'articoli-frontaliere'
        : locale === 'en' ? 'cross-border-articles'
        : locale === 'de' ? 'grenzgaenger-artikel'
        : 'articles-frontalier';
      const prefix = locale === 'it' ? '' : `/${locale}`;
      for (const a of articles) {
        items.push({ href: `${prefix}/${blogSection}/${a.slug}/`, label: a.title });
      }
    }

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    for (let page = 1; page <= totalPages; page++) {
      const slice = items.slice((page - 1) * pageSize, page * pageSize);
      const html = buildHtml({
        locale, hubKey, basePath, page, totalPages,
        pageItems: slice, totalItems: total, hasSpaBundle, entryJs, entryCss,
      });
      const canonicalPath = paginatedPath(basePath, page);
      writeFile(canonicalPath, html);

      // Sitemap: only emit IT entries (one per (hub, page) tuple), matches existing pattern
      if (locale === 'it') {
        const altLinks = HUB_LOCALES.map((alt) => {
          const altBase = alt === 'it' ? HUB_SLUGS.it[
            hubKey === 'jobs' ? 'jobsAll' : hubKey === 'sectors' ? 'sectorsAll' : hubKey === 'companies' ? 'companiesAll' : 'articlesAll'
          ] : HUB_SLUGS[alt][
            hubKey === 'jobs' ? 'jobsAll' : hubKey === 'sectors' ? 'sectorsAll' : hubKey === 'companies' ? 'companiesAll' : 'articlesAll'
          ];
          return `    <xhtml:link rel="alternate" hreflang="${alt}" href="${BASE_URL}${page === 1 ? altBase : paginatedPath(altBase, page)}" />`;
        }).join('\n');
        const url = `${BASE_URL}${canonicalPath}`;
        const priority = page === 1 ? '0.7' : '0.5';
        sitemapEntries.push(
          `  <url>\n    <loc>${url}</loc>\n${altLinks}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>${priority}</priority>\n  </url>`,
        );
      }
    }
  }

  for (const locale of HUB_LOCALES) {
    emitHub('jobs', locale);
    emitHub('sectors', locale);
    emitHub('companies', locale);
    emitHub('articles', locale);
  }

  // Patch sitemap.xml index to include sitemap-seo-hubs.xml
  if (sitemapEntries.length > 0) {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemapEntries.join('\n')}
</urlset>
`;
    try {
      fs.writeFileSync(np.join(distDir, 'sitemap-seo-hubs.xml'), sitemapXml, 'utf-8');
      const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
      if (fs.existsSync(sitemapIndexPath)) {
        let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
        if (!idx.includes('sitemap-seo-hubs.xml')) {
          idx = idx.replace(
            '</sitemapindex>',
            `  <sitemap>\n    <loc>${BASE_URL}/sitemap-seo-hubs.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
          );
          fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
        }
      }
    } catch (err) {
      console.warn('[seo-hubs] failed to write sitemap-seo-hubs.xml', err);
    }
  }

  // Suppress unused warning when ensuredDirs is only used inside writeFile path
  void ensuredDirs;

  return { pagesEmitted, sitemapEntries };
}
