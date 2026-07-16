/**
 * Vite build plugin that emits static HTML for the 3 sector-based job hubs
 * (Infermieri / Case Anziani / Educatori) in all 4 locales — 12 pages total.
 *
 * Filters `data/jobs.json` to canton TI (via `resolveJobCanton`), then by
 * sector keyword pattern (title/description/category/tags), and emits a
 * dedicated landing that consolidates the signal for high-intent GSC queries
 * that currently land on random job detail pages.
 *
 * Writes `sitemap-sector.xml` and patches `sitemap.xml`.
 *
 * Kept standalone so it doesn't touch the much larger `jobsSeoPagesPlugin.ts`
 * (lower merge-conflict risk with parallel SEO work).
 */

import type { Plugin } from 'vite';
import { clampMetaDescription } from './shared/titleSuffix';
import { railGutters } from './shared/railGutters';
import { firstParsableMs } from './shared/firstParsableDate';
import {
  BASE_URL,
  FAVICON_LINKS,
  GTAG_SNIPPET,
  ADSENSE_SNIPPET,
  CDN_PRECONNECT_HINT,
} from './constants';
import { asyncCssHeadBlock, rootShell } from './htmlTemplate';
import {
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  LINK_ACCENT_STYLE,
  CTA_PRIMARY_CLASS,
  renderStatGrid,
  pickStatTileTone,
} from './shared/seoContentTokens';
import {
  renderJobCardListHtml,
  type JobCardJob,
  type JobCardListItem,
} from './shared/jobCardHtml';
import { renderJobBoardCommuterContext } from './shared/jobBoardCommuterContext';
import { inlineScriptJson } from './shared/inlineJsonScript';
import type { JobBoardLocale } from './jobBoardSeo';
import {
  SECTOR_HUB_KEYS,
  SECTOR_HUB_SLUG,
  SECTOR_HUB_SECTION,
  SECTOR_HUB_LOCALE_PREFIX,
  SECTOR_HUB_DISPLAY,
  buildSectorHubPath,
  buildSectorHubSeo,
  buildSectorProse,
  loadSectorProseData,
  filterSectorJobs,
  countSectorJobsByLocale,
  type SectorCountableJob,
  type SectorHubKey,
} from './jobSectorLanding';
import { buildDayStampIso } from './shared/buildDayStamp';
import { SECTOR_HUB_EMOJI } from './shared/sectorHubEmoji';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { resolveSectorPagesFlushed } from './shared/buildSignals';
import { SECTOR_HUB_SIBLINGS } from './shared/sectorHubClusters';
import { resolveJobCanton as sharedResolveJobCanton } from './shared/cantonSection';

const LOCALES: ReadonlyArray<JobBoardLocale> = ['it', 'en', 'de', 'fr'];

/**
 * Hard caps used by this plugin to keep emitted HTML inside the 200 KB
 * `audit:page-weight` budget. The 30-job ceiling was tuned so that the
 * heaviest sector (case-anziani / FR maisons-retraite) lands at ~190 KB
 * with a 5 KB safety margin. Bumping this number requires re-running
 * `scripts/audit-page-weight.mjs` and confirming the worst page stays
 * under SECTOR_PAGE_HARD_BUDGET_BYTES.
 */
const MAX_EMBEDDED_JOBS = 30;
const SECTOR_PAGE_HARD_BUDGET_BYTES = 195 * 1024; // 195 KB (5 KB safety margin under 200 KB).

const LOCALE_OG: Record<JobBoardLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const SECTION_NAME: Record<JobBoardLocale, string> = {
  it: 'Cerca lavoro in Ticino',
  en: 'Find jobs in Ticino',
  de: 'Jobs im Tessin',
  fr: 'Trouver un emploi au Tessin',
};

function esc(s: unknown): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function withSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

function slugify(input: unknown): string {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

function localizedJobSlug(job: SectorCountableJob, locale: JobBoardLocale): string {
  const slugByLocale = job.slugByLocale as Record<string, string> | undefined;
  const explicit = String(slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  const canonical = String(job.slug || '').trim();
  if (canonical) return canonical;
  const titleByLocale = job.titleByLocale as Record<string, string> | undefined;
  const localizedTitle = String(titleByLocale?.[locale] || job.title || '');
  return slugify(`${localizedTitle}-${job.company || ''}-${job.location || ''}`) || slugify(localizedTitle);
}

function buildJobHref(
  locale: JobBoardLocale,
  job: SectorCountableJob,
): string {
  const prefix = SECTOR_HUB_LOCALE_PREFIX[locale];
  const section = SECTOR_HUB_SECTION[locale];
  const slug = localizedJobSlug(job, locale);
  return `${BASE_URL}${prefix}/${section}/${slug}/`.replace(/([^:])\/+/g, '$1/');
}

/** Localized heading for the sibling-sector rail. */
const SIBLING_RAIL_HEADING: Record<JobBoardLocale, string> = {
  it: 'Settori correlati',
  en: 'Related sectors',
  de: 'Verwandte Branchen',
  fr: 'Secteurs connexes',
};

/**
 * Render a small `<nav>` rail linking the current sector hub to its 3-5
 * nearest siblings (same vertical) so each hub is mutually reachable in the
 * BFS-from-`/` graph instead of being an orphan with ~0 internal links.
 *
 * Hrefs come from {@link buildSectorHubPath} (trailing-slash by construction)
 * and labels from {@link SECTOR_HUB_DISPLAY} (auto-localized). Returns an empty
 * string when the sector has no curated siblings, so unmapped long-tail hubs
 * simply render nothing rather than weak cross-links. The rail markup is a few
 * hundred bytes — well inside the 195 KB page-weight budget.
 */
function renderSiblingSectorRail(locale: JobBoardLocale, sector: SectorHubKey): string {
  const siblings = SECTOR_HUB_SIBLINGS[sector];
  if (!siblings || siblings.length === 0) return '';
  const items = siblings
    .map((sib) => {
      const href = buildSectorHubPath(locale, sib);
      const label = SECTOR_HUB_DISPLAY[locale][sib];
      return `<li class="s-sib-li"><a class="s-sib-a" href="${esc(href)}">${esc(label)}</a></li>`;
    })
    .join('');
  return `<nav class="s-sib-rail" aria-label="${esc(SIBLING_RAIL_HEADING[locale])}"><p class="s-sib-h">${esc(SIBLING_RAIL_HEADING[locale])}</p><ul class="s-sib-ul">${items}</ul></nav>`;
}

export interface BuildSectorLandingHtmlOptions {
  sector: SectorHubKey;
  locale: JobBoardLocale;
  /** Pre-filtered job list — already capped to MAX_EMBEDDED_JOBS by caller. */
  matchingJobs: ReadonlyArray<SectorCountableJob>;
  /** Total active job count for the sector (the H1/stat-tile number). */
  count: number;
  year: number;
  /** YYYY-MM-DD date stamp for the "updated" label. */
  dateStamp: string;
  /** Pre-loaded sector prose data map (or empty `{}`). */
  sectorProseData: Parameters<typeof buildSectorProse>[3];
  /** Hashed asset filenames discovered from dist/index.html (empty when SPA bundle absent). */
  entryJs?: string;
  entryCss?: string;
  /**
   * Full-set stat-tile metrics, computed by the caller over ALL matching jobs
   * (not the 30-card cap) so the tiles stay honest for popular sectors. When
   * omitted (e.g. the byte-weight unit test), company/city counts fall back to
   * the visible `matchingJobs` sample and the fresh tile is dropped.
   */
  companyCount?: number;
  cityCount?: number;
  freshCount?: number;
}

/**
 * Pure HTML builder for a single sector landing page. Extracted so the
 * regression unit test (`tests/seo/job-sector-page-weight.test.ts`) can
 * exercise the exact byte-for-byte output without driving a full Vite
 * build. Callers must cap `matchingJobs.length` to `MAX_EMBEDDED_JOBS`
 * (the cap is the primary lever keeping HTML under the 195 KB budget).
 */
export function buildSectorLandingHtml(opts: BuildSectorLandingHtmlOptions): string {
  const { sector, locale, matchingJobs, count, year, dateStamp, sectorProseData } = opts;
  const uniqCount = (vals: ReadonlyArray<unknown>): number =>
    new Set(vals.map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean)).size;
  const companyCount = opts.companyCount ?? uniqCount(matchingJobs.map((j) => j.company));
  const cityCount = opts.cityCount ?? uniqCount(matchingJobs.map((j) => j.location));
  const freshCount = opts.freshCount ?? 0;
  const entryJs = opts.entryJs || '';
  const entryCss = opts.entryCss || '';
  const hasSpaBundle = !!(entryJs && entryCss);

  const seo = buildSectorHubSeo(locale, sector, count, year);
  const proseDisplayName = SECTOR_HUB_DISPLAY[locale][sector];
  const prose = buildSectorProse(sector, locale, proseDisplayName, sectorProseData);

  const canonicalPath = buildSectorHubPath(locale, sector);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const alternates = LOCALES.map((altLocale) => {
    const altPath = buildSectorHubPath(altLocale, sector);
    return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${altPath}">`;
  }).join('\n');
  const xDefaultPath = buildSectorHubPath('it', sector);

  const cardItems: JobCardListItem[] = matchingJobs.map((job) => ({
    job: job as JobCardJob,
    href: buildJobHref(locale, job),
  }));

  const jobCards = cardItems.map(({ job, href }) => {
    const titleByLocale = job.titleByLocale as Record<string, string> | undefined;
    const localizedTitle = String(titleByLocale?.[locale] || job.title || 'Offerta lavoro');
    return {
      title: String(localizedTitle).replace(/\s+/g, ' ').trim(),
      company: String(job.company || '').replace(/\s+/g, ' ').trim(),
      location: String(job.location || '').replace(/\s+/g, ' ').trim(),
      href,
      datePosted: job.datePosted || job.postedDate || undefined,
    };
  });

  const noResultsLabel = {
    it: 'Nessuna offerta al momento. Torna a breve — la lista si aggiorna più volte al giorno.',
    en: 'No listings right now. Check back soon — the list refreshes multiple times per day.',
    de: 'Aktuell keine Angebote. Schauen Sie bald wieder vorbei — die Liste wird mehrmals täglich aktualisiert.',
    fr: "Aucune offre pour l'instant. Revenez bientôt — la liste est mise à jour plusieurs fois par jour.",
  }[locale];
  const emptyStateHtml = `<p class="s-_Ig0vF">${esc(noResultsLabel)}</p>`;
  const jobsHtml = renderJobCardListHtml(cardItems, { locale, emptyStateHtml });

  const faqHtml = seo.faq.length > 0
    ? `<section class="s-m_ILbB">
    <h2 class="s-sOn5-B">FAQ</h2>
    ${seo.faq.map((f) => `<details class="s-card" style="margin-bottom:8px"><summary class="s-HBR0NM">${esc(f.question)}</summary><p class="s-bOIp6r">${esc(f.answer)}</p></details>`).join('')}
  </section>`
    : '';

  // Crawler-facing commuter-context prose in a collapsed accordion below
  // the real content (CLAUDE.md rule #14, mobile-first). Bumps the
  // text-to-HTML ratio above the 10% Semrush floor — sector hub pages have
  // ~45 KB of JobCard markup with ~5 KB of prose, landing at 5-7% ratio
  // without this.
  const hubContextSummary: Record<JobBoardLocale, string> = {
    it: 'Guida frontalieri: salario, permesso G, fisco, rientro',
    en: 'Cross-border guide: salary, G permit, tax, weekly return',
    de: 'Grenzgänger-Leitfaden: Lohn, G-Bewilligung, Steuer, Rückkehr',
    fr: 'Guide frontaliers : salaire, permis G, fiscalité, retour',
  };
  const sectorContextHtml = `<details class="hub-seo-context s-mxdIN0">
    <summary class="s-1yn7b_">${hubContextSummary[locale]}</summary>
    <div class="s-yZU6bn">
      <section class="s-p_RJwm">
        ${renderJobBoardCommuterContext({ locale, location: 'Ticino', omitCommute: true, sectorOrType: proseDisplayName })}
      </section>
    </div>
  </details>`;

  // Sibling-sector rail — links this hub to its 3-5 nearest siblings so the
  // 49 sector hubs are mutually reachable in the BFS graph (the orphan fix).
  // Empty string for unmapped long-tail sectors.
  const siblingRailHtml = renderSiblingSectorRail(locale, sector);

  const sectionRootUrl = `${BASE_URL}${withSlash(
    `${SECTOR_HUB_LOCALE_PREFIX[locale]}/${SECTOR_HUB_SECTION[locale]}`.replace(/\/+/g, '/'),
  )}`;

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: SECTION_NAME[locale], item: sectionRootUrl },
      { '@type': 'ListItem', position: 3, name: seo.h1, item: canonicalUrl },
    ],
  });

  const itemListLd = jobCards.length > 0
    ? inlineScriptJson({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: seo.h1,
        numberOfItems: jobCards.length,
        itemListElement: jobCards.map((j, idx) => ({
          '@type': 'ListItem',
          position: idx + 1,
          name: j.title,
          url: j.href,
        })),
      })
    : '';

  const collectionLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: seo.h1,
    url: canonicalUrl,
    description: seo.desc,
    inLanguage: locale,
    isPartOf: sectionRootUrl,
    // Day-granularity, not a full build timestamp — see
    // build-plugins/shared/buildDayStamp.ts (per-build churn fix).
    dateModified: buildDayStampIso(),
  });

  const faqLd = seo.faq.length > 0
    ? inlineScriptJson({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: seo.faq.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        })),
      })
    : '';

  const countsLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Offerte attive',
    en: 'Active jobs',
    de: 'Aktive Stellen',
    fr: 'Offres actives',
  };
  const updatedLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Aggiornato',
    en: 'Updated',
    de: 'Aktualisiert',
    fr: 'Mis à jour',
  };
  const jobsSectionLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Annunci disponibili',
    en: 'Available listings',
    de: 'Verfügbare Angebote',
    fr: 'Annonces disponibles',
  };
  const openAllByLocale: Record<JobBoardLocale, string> = {
    it: 'Vedi tutte le offerte di lavoro in Ticino',
    en: 'See all jobs in Ticino',
    de: 'Alle Stellenangebote im Tessin ansehen',
    fr: "Voir toutes les offres d'emploi au Tessin",
  };
  const freshLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Nuove · 7gg',
    en: 'New · 7d',
    de: 'Neu · 7T',
    fr: 'Récent · 7j',
  };
  const companiesLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Aziende',
    en: 'Companies',
    de: 'Unternehmen',
    fr: 'Entreprises',
  };
  const citiesLabelByLocale: Record<JobBoardLocale, string> = {
    it: 'Località',
    en: 'Locations',
    de: 'Standorte',
    fr: 'Localités',
  };

  // Stat tiles — headline count is always shown; secondary tiles only when
  // they carry a non-zero signal, so an empty sector degrades to a single
  // clean tile instead of a row of zeros. Tones colour the row (green = many
  // openings / fresh listings) so the hero reads lively rather than flat.
  const statTiles: Array<{ label: string; value: string; tone: ReturnType<typeof pickStatTileTone> }> = [
    { label: countsLabelByLocale[locale], value: String(count), tone: pickStatTileTone('openings', count) },
  ];
  if (freshCount > 0) {
    statTiles.push({ label: freshLabelByLocale[locale], value: `+${freshCount}`, tone: pickStatTileTone('fresh', freshCount) });
  }
  if (companyCount > 0) {
    statTiles.push({ label: companiesLabelByLocale[locale], value: String(companyCount), tone: 'neutral' });
  }
  if (cityCount > 0) {
    statTiles.push({ label: citiesLabelByLocale[locale], value: String(cityCount), tone: 'neutral' });
  }
  const statGridHtml = renderStatGrid(statTiles);
  const ctaHtml = `<a href="${sectionRootUrl}" class="${CTA_PRIMARY_CLASS}" style="margin:0 0 24px">${esc(openAllByLocale[locale])} →</a>`;

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n    ` : ''}${FAVICON_LINKS}
    <title>${esc(seo.title)}</title>
    <meta name="description" content="${esc(clampMetaDescription(seo.desc))}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[locale]}">
    <meta property="og:title" content="${esc(seo.ogT)}">
    <meta property="og:description" content="${esc(clampMetaDescription(seo.ogD))}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:alt" content="${esc(seo.ogT)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${xDefaultPath}">
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}${faqLd ? `\n    <script type="application/ld+json">${faqLd}</script>` : ''}
    ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
    ${GTAG_SNIPPET}
    ${ADSENSE_SNIPPET}
  </head>
  <body>
    ${rootShell(hasSpaBundle)}
    ${railGutters(true).open}
    <main class="seo-static-content s-Ziv1Xn">
        <nav class="s-bcr">
          <a href="/" class="s-bcl">Home</a>
          <span> / </span>
          <a href="${sectionRootUrl}" class="s-bcl">${esc(SECTION_NAME[locale])}</a>
          <span> / </span>
          <span>${esc(seo.h1)}</span>
        </nav>
        <header class="s-sy52lX">
          <p style="${HERO_EYEBROW_STYLE}"><span aria-hidden="true" style="font-size:15px">${SECTOR_HUB_EMOJI[sector]}</span> ${esc(updatedLabelByLocale[locale])} · ${dateStamp}</p>
          <h1 style="${H1_STYLE}">${esc(seo.h1)}</h1>
          <p style="${LEDE_STYLE}">${esc(seo.desc)}</p>
          <p style="${BODY_STYLE}">${esc(seo.intro)}</p>
        </header>
        ${statGridHtml}
        ${ctaHtml}
        <section class="s-ziawP1">
          <div class="s-r2QmTP">
            <h2 class="s-CqexyJ">${esc(jobsSectionLabelByLocale[locale])}</h2>
          </div>
          ${jobsHtml}
        </section>
        ${prose.html}
        ${faqHtml}
        ${sectorContextHtml}
        ${siblingRailHtml}
      </main>${railGutters(true).close}
    <div id="footer-root"></div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
}

export function jobSectorPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'job-sector-pages',
    apply: 'build',
    async closeBundle() {
      const fs = await import('node:fs');
      const np = await import('node:path');
      const distDir = np.resolve(rootDir, 'dist');
      const jobsPath = np.resolve(rootDir, 'data/jobs.json');

      // `dateStamp` is fixed once per build and baked into HTML.
      const dateStamp = new Date().toISOString().slice(0, 10);
      const year = new Date().getUTCFullYear();

      // Read jobs.json (gitignored in dev; present in CI).
      let jobs: SectorCountableJob[] = [];
      try {
        if (fs.existsSync(jobsPath)) {
          const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
          if (Array.isArray(raw)) jobs = raw as SectorCountableJob[];
        }
      } catch (err) {
        console.warn('[job-sector-pages] failed to read data/jobs.json', err);
      }

      // These pages are branded "Cerca lavoro in Ticino" — scope to TI jobs only.
      // Without this, sector counts/listings ingest every canton in Switzerland
      // (same bug class as #3232, fixed for employer hubs in jobsSeoPagesPlugin.ts).
      jobs = jobs.filter((job) => sharedResolveJobCanton(job) === 'TI');

      const counts = countSectorJobsByLocale(jobs);
      const sectorProseData = loadSectorProseData(rootDir);

      // Race-free SPA bundle hash extraction. See spaBundleResolver.ts.
      const { resolveSpaBundle } = await import('./spaBundleResolver');
      const spaBundle = resolveSpaBundle(distDir);
      const entryJs = spaBundle.entryJs;
      const entryCss = spaBundle.entryCss;
      const hasSpaBundle = spaBundle.hasSpaBundle;

      const sitemapEntries: string[] = [];

      const ensuredDirs = new Set<string>();
      const ensureDir = (dir: string): void => {
        if (ensuredDirs.has(dir)) return;
        fs.mkdirSync(dir, { recursive: true });
        ensuredDirs.add(dir);
      };

      for (const sector of SECTOR_HUB_KEYS) {
        for (const locale of LOCALES) {
          // Per-locale shard render-skip (BUILD_LOCALE matrix builds). The full
          // page render below (buildSectorLandingHtml + the two fs.writeFileSync
          // emits) is the bulk of this plugin's ~150s closeBundle cost, and on a
          // shard build 3 of every 4 locales it produces are deleted afterwards
          // by scripts/ci/prune-locale-shard.mjs. Skipping the non-owned locales
          // here removes that wasted render. SAFE for cross-locale SEO: the
          // sitemap-sector.xml entry (with its 4-locale xhtml:link alternates) is
          // built ONLY in the `locale === 'it'` branch below from buildSectorHubPath
          // path-builders — independent of whether en/de/fr iterations ran — and
          // the it/main shard never skips `it`, so its sitemap stays complete.
          // No-op (always true) on the default all-locale build.
          if (!shouldEmitLocale(locale)) continue;
          const count = counts[locale][sector];
          // Cap embedded JobPosting cards at 30 per landing. The full count
          // is still surfaced via the stat tile + H1 ("X open positions"),
          // but only the freshest 30 are rendered as cards. Without this
          // cap, popular sectors (case-anziani, ingegneri, ristorazione)
          // pushed the page HTML past the 200 KB audit:page-weight budget
          // — each JobCard with logo + Tailwind classes + icons is ~1.5 KB,
          // so 50 cards added ~30 KB on top of prose/FAQ/JSON-LD and broke
          // the gate. 30 cards keeps every page comfortably under 195 KB.
          const matchingJobs = filterSectorJobs(jobs, sector, locale, MAX_EMBEDDED_JOBS);

          // Full (uncapped) match set, used ONLY to compute honest stat-tile
          // metrics (companies / cities / fresh) — popular sectors show >30
          // jobs, so deriving these from the 30-card cap would undercount.
          // Cards themselves stay capped via `matchingJobs` above.
          const allMatching = filterSectorJobs(jobs, sector, locale, Number.MAX_SAFE_INTEGER);
          const normKey = (v: unknown): string => String(v ?? '').trim().toLowerCase();
          const companyCount = new Set(allMatching.map((j) => normKey(j.company)).filter(Boolean)).size;
          const cityCount = new Set(allMatching.map((j) => normKey(j.location)).filter(Boolean)).size;
          const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
          const freshCutoff = Date.parse(`${dateStamp}T00:00:00Z`) - FRESH_WINDOW_MS;
          const freshCount = allMatching.filter((j) => {
            // First PARSEABLE date, not first truthy: a malformed postedDate must
            // not collapse the timestamp to 0 and undercount the fresh tile.
            const t = firstParsableMs(j.datePosted, j.postedDate);
            return t >= freshCutoff;
          }).length;

          const canonicalPath = buildSectorHubPath(locale, sector);
          const canonicalUrl = `${BASE_URL}${canonicalPath}`;

          const html = buildSectorLandingHtml({
            sector,
            locale,
            matchingJobs,
            count,
            year,
            dateStamp,
            sectorProseData,
            entryJs,
            entryCss,
            companyCount,
            cityCount,
            freshCount,
          });

          // Hard budget gate — prevents future regressions from quietly
          // breaking the 200 KB audit:page-weight CI gate. CLAUDE.md
          // non-negotiable rule #1: never lower thresholds — instead,
          // compress the offending content (cap embedded jobs further,
          // strip unused JSON-LD fields, etc.).
          const htmlBytes = Buffer.byteLength(html, 'utf-8');
          if (htmlBytes > SECTOR_PAGE_HARD_BUDGET_BYTES) {
            throw new Error(
              `[job-sector-pages] HTML for ${canonicalPath} is ${(htmlBytes / 1024).toFixed(1)} KB, ` +
                `exceeds hard budget of ${SECTOR_PAGE_HARD_BUDGET_BYTES / 1024} KB. ` +
                `Reduce MAX_EMBEDDED_JOBS, compress JSON-LD, or trim per-card markup.`,
            );
          }

          // Write both /path/index.html and /path.html
          const outDir = np.join(distDir, canonicalPath.slice(1));
          ensureDir(outDir);
          const indexFile = np.join(outDir, 'index.html');
          fs.writeFileSync(indexFile, html, 'utf-8');
          const flatPath = canonicalPath.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
            ensureDir(np.dirname(flatFile));
            fs.writeFileSync(flatFile, html, 'utf-8');
          }

          // Every locale gets its own reciprocal <loc> entry (all 4 carry the
          // same alternate set) — an IT-only push here would leave en/de/fr
          // as one-sided alternates, stripped by sanitizeSitemapHreflangReciprocity.
          const altLinks = LOCALES.map((altLocale) => {
            const altPath = buildSectorHubPath(altLocale, sector);
            return `    <xhtml:link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${altPath}" />`;
          }).join('\n');
          // x-default always anchors to the IT canonical, regardless of which
          // locale this <url> block itself represents.
          const itUrl = `${BASE_URL}${buildSectorHubPath('it', sector)}`;
          sitemapEntries.push(
            `  <url>\n    <loc>${canonicalUrl}</loc>\n${altLinks}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${itUrl}" />\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`,
          );
        }
      }

      // Write sitemap-sector.xml.
      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemapEntries.join('\n')}
</urlset>
`;
        try {
          const sitemapPath = np.join(distDir, 'sitemap-sector.xml');
          fs.writeFileSync(sitemapPath, sitemapXml, 'utf-8');
        } catch (err) {
          console.warn('[job-sector-pages] failed to write sitemap-sector.xml', err);
        }
      }

      const totalPages = LOCALES.length * SECTOR_HUB_KEYS.length;
      console.log(
        `\x1b[36m[job-sector-pages]\x1b[0m Generated ${totalPages} sector hubs (${jobs.length} candidate jobs)`,
      );

      // Always-run: patch sitemap.xml index lastmod entry. Other plugins
      // regenerate sitemap.xml every build, so our entry's <lastmod> would
      // otherwise drop out. Runs whether the cache hit or miss, but only
      // when our sitemap actually exists (freshly written or restored).
      if (fs.existsSync(np.join(distDir, 'sitemap-sector.xml'))) {
        try {
          const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
          if (fs.existsSync(sitemapIndexPath)) {
            let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
            if (!idx.includes('sitemap-sector.xml')) {
              idx = idx.replace(
                '</sitemapindex>',
                `  <sitemap>\n    <loc>${BASE_URL}/sitemap-sector.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
              );
            } else {
              idx = idx.replace(
                /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-sector\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
                `$1${dateStamp}$2`,
              );
            }
            fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
          }
        } catch (err) {
          console.warn('[job-sector-pages] sitemap-index patch failed', err);
        }
      }

      // Signal downstream consumers (sectorHubLinksPlugin) that every sector-
      // hub landing is on disk, so the injector can safely add anchors to them
      // from the 4 job-board root hubs. Same fail-fast contract as
      // resolveJobsSeoPagesFlushed: closeBundle has no early return, so this is
      // reached on every normal exit. A thrown budget-error above propagates to
      // Vite and fails the build (consumer terminates — not a deadlock).
      resolveSectorPagesFlushed();
    },
  };
}

// Re-export for tests/consumers
export { SECTOR_HUB_SLUG, SECTOR_HUB_KEYS, buildSectorHubPath };
export type { SectorHubKey };
