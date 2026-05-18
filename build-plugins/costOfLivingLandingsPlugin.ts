/**
 * Cost-of-living city landings — Vite build plugin (AE-4 · template B).
 *
 * Emits 24 static HTML pages (6 cities × 4 locales):
 *
 *   Cities:   Lugano, Mendrisio, Chiasso, Bellinzona, Locarno + Ticino rollup
 *   Locales:  IT canonical (/costo-vita-<city>-ticino/) + EN/DE/FR variants
 *
 * The 2026-05 redesign inverts the page so the killer numbers + live signal
 * (rent median, salary median, open jobs) and a primary CTA to the salary
 * calculator sit ABOVE the fold on mobile (≤414 px) — CLAUDE.md regola #15 / #17.
 * The detailed rent / basket / comparison tables and the long-form narrative
 * (frontaliere context + sources methodology) move BELOW an "Approfondisci"
 * divider so editorial filler can never push the data below the fold.
 *
 * Body order (template B, mobile-first):
 *   1. breadcrumb
 *   2. header (eyebrow · H1 · dense lede ≤120 chars)
 *   3. 3 stat tiles (median salary CHF · 2.5-room rent · live jobs in city)
 *   4. primary CTA → salary calculator
 *   5. featured live jobs (3 cards filtered by city) + "see all" CTA
 *      (falls back to an empty-state card when the city has <3 indexed jobs)
 *   6. employer grid (top 6 hiring brands in the city)
 *   7. ─── "Approfondisci" divider ───
 *   8. TL;DR paragraph + rent table (FSO) + basket table (ISTAT) +
 *      comparison table + frontaliere narrative + sources methodology
 *      (the existing 6-section block)
 *   9. FAQ block · related links · final CTAs
 *
 * Live signal comes from cityJobsAggregate (build-time read of data/jobs.json).
 * FSO rent + ISTAT basket numbers in costOfLivingLandingsCopy.ts remain the
 * editorial authority — this plugin only weaves the live job-market layer
 * around the existing data tables.
 *
 * Hub chrome: `hubChrome: { hubKey: 'confronti', activeSubTab: 'cost-of-living' }`
 * keeps the sub-nav visible on first paint (BUG-2 fix carried over).
 *
 * Sitemap: writes `dist/sitemap-cost-of-living.xml`, patches the index.
 * `sitemapAliasPlugin` auto-discovers the file — no manual wiring.
 *
 * Env gate: SKIP_COST_OF_LIVING=1 fast-exits (local builds only; CI always runs).
 */

import fs from 'node:fs';
import np from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

// ESM-safe __dirname for module-local data file resolution.
const __dirname_col_plugin = np.dirname(fileURLToPath(import.meta.url));
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import {
  COL_LOCALES,
  COL_CITY_IDS,
  COL_CITY_DISPLAY,
  COL_CITY_GEO,
  buildCostOfLivingLandingPath,
  type ColLocale,
  type ColCityId,
} from './costOfLivingLandingsData';
import {
  buildCitySections,
  buildFaqs,
  getLocaleStrings,
} from './costOfLivingLandingsCopy';
import {
  BREADCRUMB_STYLE,
  BREADCRUMB_LINK_STYLE,
  H1_STYLE,
  H2_STYLE,
  CARD_STYLE,
  CARD_BODY_STYLE,
  CARD_PADDING_STYLE,
  LINK_ACCENT_STYLE,
  CTA_PRIMARY_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  SMALL_HEADING_STYLE,
  ICON_BUILDING_SVG,
  renderStatGrid,
  differentiateH1FromTitle,
} from './shared/seoContentTokens';
import {
  aggregateAllCities,
  buildFeaturedJobUrl,
  buildCityJobBoardUrl,
  buildJobBoardUrl,
  type CityFeaturedJob,
  type CityJobsSnapshot,
} from './cityJobsAggregate';

// ── Escape ─────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OG_LOCALE: Record<ColLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

// City ↔ paired commuter province (mirrors costOfLivingLandingsCopy)
// — used to build the dense lede and the dense-tile delta percentage.
const CITY_PAIRED_PROVINCE: Record<ColCityId, Record<ColLocale, string>> = {
  lugano: { it: 'Como', en: 'Como', de: 'Como', fr: 'Côme' },
  mendrisio: { it: 'Como', en: 'Como', de: 'Como', fr: 'Côme' },
  chiasso: { it: 'Como', en: 'Como', de: 'Como', fr: 'Côme' },
  bellinzona: { it: 'Lecco', en: 'Lecco', de: 'Lecco', fr: 'Lecco' },
  locarno: { it: 'Varese', en: 'Varese', de: 'Varese', fr: 'Varèse' },
  ticino: { it: 'Lombardia', en: 'Lombardy', de: 'Lombardei', fr: 'Lombardie' },
};

// ── Template B renderers ─────────────────────────────────────────────────────

interface CityCopyView {
  readonly statTileSalaryLabel: string;
  readonly statTileRentLabel: string;
  readonly statTileLiveJobsLabel: string;
  readonly statSalaryFmt: (chf: number | null) => string;
  readonly statRentFmt: (chf: number) => string;
  readonly statLiveJobsFmt: (n: number) => string;
  readonly primaryCtaLabel: string;
  readonly featuredJobsTitle: string;
  readonly featuredJobsCtaAll: string;
  readonly featuredJobsEmpty: string;
  readonly employerGridTitle: string;
  readonly approfondisciHeading: string;
  readonly jobPostedLabel: (daysAgo: number) => string;
  readonly jobSalaryFmt: (min: number | null, max: number | null) => string;
}

function pickJobTitle(job: CityFeaturedJob, locale: ColLocale): string {
  return job.titleByLocale[locale] ?? job.title;
}

function renderFeaturedJobCard(
  job: CityFeaturedJob,
  locale: ColLocale,
  view: CityCopyView,
): string {
  const href = buildFeaturedJobUrl(job, locale);
  const title = pickJobTitle(job, locale);
  const subtitleParts: string[] = [];
  if (job.company) subtitleParts.push(job.company);
  if (job.city) subtitleParts.push(job.city);
  const subtitle = subtitleParts.join(' · ');
  const salary = view.jobSalaryFmt(job.salaryMin, job.salaryMax);
  const posted = view.jobPostedLabel(job.daysAgo);

  return `<a class="seo-card-link" href="${esc(href)}" style="${CARD_STYLE};text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:6px">
    <div style="font-weight:700;font-size:16px;line-height:1.35;color:var(--color-heading)">${esc(title)}</div>
    ${subtitle ? `<div style="font-size:14px;color:var(--color-body);line-height:1.4">${esc(subtitle)}</div>` : ''}
    <div style="display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;margin-top:4px;font-size:13px;color:var(--color-subtle)">
      ${salary ? `<span style="color:var(--color-accent);font-weight:700">${esc(salary)}</span>` : ''}
      <span>${esc(posted)}</span>
    </div>
  </a>`;
}

function renderFeaturedJobs(
  locale: ColLocale,
  cityId: ColCityId,
  snapshot: CityJobsSnapshot,
  view: CityCopyView,
): string {
  // Fall back garbato: city with <3 indexed jobs → empty-state card + CTA to
  // the full job board (the "Nessuna offerta indicizzata in questo momento"
  // path from the spec). This protects sparse cities (Chiasso, Bellinzona,
  // Locarno on quiet weeks) from a "graveyard" featured grid.
  if (snapshot.featured.length < 3) {
    const allJobsHref = buildJobBoardUrl(locale);
    return `<section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(view.featuredJobsTitle)}</h2>
      <div style="${CARD_STYLE};display:flex;flex-direction:column;gap:10px">
        <p style="margin:0;color:var(--color-body);font-size:14px;line-height:1.55">${esc(view.featuredJobsEmpty)}</p>
        <a href="${esc(allJobsHref)}" style="${LINK_ACCENT_STYLE};font-weight:700;font-size:15px">${esc(view.featuredJobsCtaAll)}</a>
      </div>
    </section>`;
  }
  const cards = snapshot.featured
    .map((j) => renderFeaturedJobCard(j, locale, view))
    .join('');
  const cityHref = buildCityJobBoardUrl(locale, cityId);
  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(view.featuredJobsTitle)}</h2>
    <div style="display:grid;gap:12px;margin-bottom:14px">${cards}</div>
    <a href="${esc(cityHref)}" style="${LINK_ACCENT_STYLE};font-weight:700;font-size:15px">${esc(view.featuredJobsCtaAll)}</a>
  </section>`;
}

function renderEmployerGrid(snapshot: CityJobsSnapshot, view: CityCopyView): string {
  if (snapshot.topEmployers.length === 0) return '';

  const cells = snapshot.topEmployers
    .map(
      (e) => `<div style="display:flex;align-items:center;gap:10px;${CARD_PADDING_STYLE};${CARD_BODY_STYLE}">
        <span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:var(--color-surface-alt);color:var(--color-subtle);flex-shrink:0">${ICON_BUILDING_SVG}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;color:var(--color-heading);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.name)}</div>
        </div>
        <div style="flex-shrink:0;font-weight:700;color:var(--color-accent);font-variant-numeric:tabular-nums">${e.count}</div>
      </div>`,
    )
    .join('');

  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(view.employerGridTitle)}</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${cells}</div>
  </section>`;
}

function renderApprofondisciDivider(label: string): string {
  return `<div role="separator" aria-label="${esc(label)}" style="margin:36px 0 28px;display:flex;align-items:center;gap:14px;color:var(--color-subtle)">
    <span aria-hidden="true" style="flex:1;height:1px;background:var(--color-edge)"></span>
    <span style="${SMALL_HEADING_STYLE};margin:0">${esc(label)}</span>
    <span aria-hidden="true" style="flex:1;height:1px;background:var(--color-edge)"></span>
  </div>`;
}

// ── Salary-calculator URL per locale ─────────────────────────────────────────

const CALCULATOR_URL: Record<ColLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

// ── Page rendering ───────────────────────────────────────────────────────────

interface RenderResult {
  readonly urlPath: string;
  readonly html: string;
  readonly wordCount: number;
}

function renderPage(opts: {
  locale: ColLocale;
  city: ColCityId;
  dateStamp: string;
  distDir?: string;
  snapshot: CityJobsSnapshot;
}): RenderResult {
  const { locale, city, dateStamp, distDir, snapshot } = opts;
  const L = getLocaleStrings(locale);
  const cityName = COL_CITY_DISPLAY[city][locale];
  const geo = COL_CITY_GEO[city];
  const urlPath = buildCostOfLivingLandingPath(locale, city);
  const canonicalUrl = `${BASE_URL}${urlPath}`;
  const pairedProvince = CITY_PAIRED_PROVINCE[city][locale];

  const title = L.title(cityName);
  const description = L.description(cityName, pairedProvince);
  const h1 = differentiateH1FromTitle(L.h1(cityName), title, locale);

  // Hreflang — 4 locales + x-default (IT canonical).
  const hreflangLines = COL_LOCALES.map(
    (alt) =>
      `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${buildCostOfLivingLandingPath(alt, city)}">`,
  );
  hreflangLines.push(
    `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildCostOfLivingLandingPath('it', city)}">`,
  );
  const alternates = hreflangLines.join('\n');

  // Breadcrumbs
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const hubUrl = `${BASE_URL}${L.breadcrumbHubPath}`;
  const calculatorUrl = `${BASE_URL}${CALCULATOR_URL[locale]}`;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: L.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: L.breadcrumbHub, item: hubUrl },
      { '@type': 'ListItem', position: 3, name: cityName, item: canonicalUrl },
    ],
  };

  const faqs = buildFaqs(locale, city);
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: h1,
    description,
    inLanguage: locale,
    url: canonicalUrl,
    datePublished: dateStamp,
    dateModified: dateStamp,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
      logo: imageObjectLd({
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      }),
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  };

  // Place JSON-LD — city = AdministrativeArea (TI rollup) or City.
  const placeLd = {
    '@context': 'https://schema.org',
    '@type': city === 'ticino' ? 'AdministrativeArea' : 'City',
    name: cityName,
    ...(geo.addressLocality !== null && geo.lat !== null
      ? {
          address: {
            '@type': 'PostalAddress',
            addressCountry: 'CH',
            addressRegion: 'TI',
            addressLocality: geo.addressLocality,
            postalCode: geo.postalCode ?? undefined,
          },
          geo: { '@type': 'GeoCoordinates', latitude: geo.lat, longitude: geo.lon },
        }
      : {
          address: { '@type': 'PostalAddress', addressCountry: 'CH', addressRegion: 'TI' },
          geo:
            geo.lat !== null && geo.lon !== null
              ? { '@type': 'GeoCoordinates', latitude: geo.lat, longitude: geo.lon }
              : undefined,
        }),
    url: canonicalUrl,
  };

  // LocalBusiness JSON-LD — our org serving this area.
  const localBusinessLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: 'Frontaliere Ticino',
    url: BASE_URL,
    image: `${BASE_URL}/og-image.png`,
    areaServed: { '@type': city === 'ticino' ? 'AdministrativeArea' : 'City', name: cityName },
    description:
      locale === 'it'
        ? 'Consulenza frontalieri: simulazione stipendio, costo vita, permessi'
        : locale === 'en'
          ? 'Cross-border worker services: salary simulation, cost of living, permits'
          : locale === 'de'
            ? 'Grenzgänger-Service: Gehaltssimulation, Lebenshaltungskosten, Bewilligungen'
            : 'Services frontaliers : simulation salaire, coût de la vie, permis',
    address: {
      '@type': 'PostalAddress',
      addressCountry: 'CH',
      addressRegion: 'TI',
      addressLocality: geo.addressLocality ?? 'Lugano',
    },
  };

  // ── Long-form prose sections (existing rent / basket / comparison /
  //    frontaliere / sources blocks). We need the FSO rent median number
  //    for the stat tile + dense lede — pull it out before assembling the body.
  const sections = buildCitySections(locale, city);
  const sectionsHtml = sections
    .map(
      (s) => `
        <section style="margin:0 0 28px;max-width:960px">
          <h2 style="${H2_STYLE}">${esc(s.title)}</h2>
          ${s.html}
        </section>`,
    )
    .join('');

  // Extract the FSO 2.5-room median CHF/month from the structured copy
  // helper — we re-derive it here from the same source data so the value
  // on the stat tile is always in sync with the value rendered inside the
  // rent table below the fold.
  const rentMedianChf = extractRentMedian(city);
  // ISTAT 2.5-room rent for the paired province — used to compute the
  // headline "−XX% vs Como" delta on the dense lede.
  const pairedRentEur = extractPairedRentEur(city);
  // CHF→EUR approx. parity for the delta computation. Using a simple 0.95
  // CHF/EUR rate (mirrors the existing comparisonHtml block).
  const pairedDeltaPct = Math.max(
    1,
    Math.round((1 - pairedRentEur / (rentMedianChf * 0.95)) * 100),
  );

  // ── Template B header block ────────────────────────────────────────────
  const denseLede = L.denseLedeTemplate({
    city: cityName,
    rentMedianChf,
    pairedProvince,
    pairedDeltaPct,
    liveJobs: snapshot.liveCount,
  });

  const view: CityCopyView = {
    statTileSalaryLabel: L.statTileSalaryLabel,
    statTileRentLabel: L.statTileRentLabel,
    statTileLiveJobsLabel: L.statTileLiveJobsLabel,
    statSalaryFmt: L.statSalaryFmt,
    statRentFmt: L.statRentFmt,
    statLiveJobsFmt: L.statLiveJobsFmt,
    primaryCtaLabel: L.primaryCtaLabel(cityName),
    featuredJobsTitle: L.featuredJobsTitle(cityName),
    featuredJobsCtaAll: L.featuredJobsCtaAll(cityName, snapshot.liveCount),
    featuredJobsEmpty: L.featuredJobsEmpty(cityName),
    employerGridTitle: L.employerGridTitle(cityName),
    approfondisciHeading: L.approfondisciHeading,
    jobPostedLabel: L.jobPostedLabel,
    jobSalaryFmt: L.jobSalaryFmt,
  };

  const statTilesHtml = renderStatGrid([
    {
      label: view.statTileSalaryLabel,
      value: view.statSalaryFmt(snapshot.medianSalaryChf),
      tone: 'accent',
    },
    {
      label: view.statTileRentLabel,
      value: view.statRentFmt(rentMedianChf),
      // Rent is "the cost" — semantic warning tone (yellow), not green.
      tone: 'warning',
    },
    {
      label: view.statTileLiveJobsLabel,
      value: view.statLiveJobsFmt(snapshot.liveCount),
      // Live jobs are an opportunity signal — green when > 0.
      tone: snapshot.liveCount > 0 ? 'success' : 'neutral',
    },
  ]);

  const primaryCtaHtml = `<div style="margin:0 0 28px"><a href="${esc(calculatorUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(view.primaryCtaLabel)} →</a></div>`;
  const featuredHtml = renderFeaturedJobs(locale, city, snapshot, view);
  const employerGridHtml = renderEmployerGrid(snapshot, view);
  const dividerHtml = renderApprofondisciDivider(view.approfondisciHeading);

  const faqHtml = faqs
    .map(
      (f) => `
      <details style="margin:0 0 10px;${CARD_STYLE};border-radius:12px">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45">${esc(f.question)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.65">${esc(f.answer)}</p>
      </details>`,
    )
    .join('');

  const relatedHtml = L.related
    .map(
      (r) =>
        `<li style="margin:0 0 8px"><a href="${esc(r.href)}" style="${LINK_ACCENT_STYLE}">${esc(r.label)}</a></li>`,
    )
    .join('');

  const body = `
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${esc(homeUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(L.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(hubUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(L.breadcrumbHub)}</a>
      <span> / </span>
      <span>${esc(cityName)}</span>
    </nav>
    <header style="margin-bottom:20px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(L.eyebrow(cityName))} · ${esc(L.updatedLabel)} ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(denseLede)}</p>
    </header>
    ${statTilesHtml}
    ${primaryCtaHtml}
    ${featuredHtml}
    ${employerGridHtml}
    ${dividerHtml}
    ${sectionsHtml}
    <section style="margin:0 0 28px;max-width:960px">
      <h2 style="${H2_STYLE}">${esc(L.faqTitle)}</h2>
      ${faqHtml}
    </section>
    <section style="margin:0 0 28px;max-width:960px">
      <h2 style="${H2_STYLE}">${esc(L.relatedLabel)}</h2>
      <ul style="margin:0 0 0 20px;padding:0;color:var(--color-body);line-height:1.55">${relatedHtml}</ul>
    </section>
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(calculatorUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(L.ctaSimulator)}</a>
      <a href="${esc(hubUrl)}" style="${CARD_STYLE};text-decoration:none;font-weight:700;border-radius:12px">${esc(L.ctaCompare)}</a>
    </section>`;

  const bodyHtml = `<main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">${body}</main>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(h1)}">
    <meta name="twitter:description" content="${esc(description)}">`;

  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: alternates,
    extraHeadHtml: extraHead,
    jsonLdScripts: [
      JSON.stringify(breadcrumbLd),
      JSON.stringify(articleLd),
      JSON.stringify(faqLd),
      JSON.stringify(placeLd),
      JSON.stringify(localBusinessLd),
    ],
    bodyHtml,
    distDir,
    hubChrome: {
      hubKey: 'confronti',
      activeSubTab: 'cost-of-living',
    },
  });

  return { urlPath, html, wordCount };
}

// ── Rent-data helpers ────────────────────────────────────────────────────────
//
// The plugin reads FSO + ISTAT JSON once at module load (mirroring the copy
// module). We re-derive the city's 2.5-room rent + the paired province's
// 2.5-room rent so the stat tile + dense lede share a single source of truth
// with the rent / comparison tables rendered below the fold.

interface FsoCityRow {
  readonly city: string;
  readonly canton: string;
  readonly rooms_2_5: { readonly median_chf_month: number };
}
interface IstatProvinceRow {
  readonly province: string;
  readonly region: string;
  readonly rent_eur_month: { readonly rooms_2: number };
}

let _fsoRows: readonly FsoCityRow[] | null = null;
let _istatRows: readonly IstatProvinceRow[] | null = null;

function loadFsoRows(): readonly FsoCityRow[] {
  if (_fsoRows) return _fsoRows;
  // build-plugins/ lives at <root>/build-plugins/; the JSON is at <root>/data/seo/.
  const dataPath = np.resolve(__dirname_col_plugin, '..', 'data', 'seo', 'fso-rental-medians.json');
  try {
    const raw = fs.readFileSync(dataPath, 'utf-8');
    const parsed = JSON.parse(raw) as { cities: readonly FsoCityRow[] };
    _fsoRows = parsed.cities;
  } catch {
    _fsoRows = [];
  }
  return _fsoRows;
}

function loadIstatRows(): readonly IstatProvinceRow[] {
  if (_istatRows) return _istatRows;
  const dataPath = np.resolve(__dirname_col_plugin, '..', 'data', 'seo', 'istat-cost-basket.json');
  try {
    const raw = fs.readFileSync(dataPath, 'utf-8');
    const parsed = JSON.parse(raw) as { provinces: readonly IstatProvinceRow[] };
    _istatRows = parsed.provinces;
  } catch {
    _istatRows = [];
  }
  return _istatRows;
}

function extractRentMedian(city: ColCityId): number {
  const target = city === 'ticino' ? 'Ticino' : city.charAt(0).toUpperCase() + city.slice(1);
  const row = loadFsoRows().find((c) => c.city === target);
  if (!row) {
    // Defensive default — the upstream JSON ships with all 6 cities so this
    // branch should never fire in practice. Returning 1 keeps the tile + delta
    // computation finite if the data file is missing in a hypothetical drift.
    return 1;
  }
  return row.rooms_2_5.median_chf_month;
}

const CITY_TO_PROVINCE: Record<ColCityId, string | 'rollup'> = {
  lugano: 'Como',
  mendrisio: 'Como',
  chiasso: 'Como',
  bellinzona: 'Lecco',
  locarno: 'Varese',
  ticino: 'rollup',
};

function extractPairedRentEur(city: ColCityId): number {
  const rows = loadIstatRows();
  const target = CITY_TO_PROVINCE[city];
  if (target === 'rollup') {
    if (rows.length === 0) return 1;
    const sum = rows.reduce((s, r) => s + r.rent_eur_month.rooms_2, 0);
    return Math.round(sum / rows.length);
  }
  const row = rows.find((p) => p.province === target);
  return row ? row.rent_eur_month.rooms_2 : 1;
}

// ── Sitemap ───────────────────────────────────────────────────────

function buildSitemapXml(
  entries: ReadonlyArray<{ readonly canonical: string; readonly alternates: readonly string[] }>,
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
      return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes('sitemap-cost-of-living.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-cost-of-living.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-cost-of-living\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[cost-of-living] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ──────────────────────────────────────────────────

export function costOfLivingLandingsPlugin(rootDir: string): Plugin {
  return {
    name: 'cost-of-living-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_COST_OF_LIVING === '1') {
        console.log(
          '\x1b[33m[cost-of-living]\x1b[0m Skipped (SKIP_COST_OF_LIVING=1)',
        );
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const dateStamp = new Date().toISOString().slice(0, 10);

      // Aggregate live city jobs ONCE per build (module-level cached).
      const snapshots = aggregateAllCities(rootDir);

      const collector = new WriteCollector({
        distDir,
        pluginName: 'costOfLivingLandingsPlugin',
      });
      const sitemapEntries: Array<{
        readonly canonical: string;
        readonly alternates: readonly string[];
      }> = [];

      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const city of COL_CITY_IDS) {
        const altLinks = COL_LOCALES.map(
          (alt) => `${alt}|${BASE_URL}${buildCostOfLivingLandingPath(alt, city)}`,
        );
        altLinks.push(`x-default|${BASE_URL}${buildCostOfLivingLandingPath('it', city)}`);

        for (const locale of COL_LOCALES) {
          const rendered = renderPage({
            locale,
            city,
            dateStamp,
            distDir,
            snapshot: snapshots[city],
          });

          if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
            thinSkipped++;
            console.warn(
              `\x1b[33m[cost-of-living]\x1b[0m ${locale}/${city} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — skipping`,
            );
            continue;
          }

          const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
          const flatPath = np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
          collector.add(indexPath, rendered.html);
          collector.add(flatPath, rendered.html);

          if (locale === 'it') {
            sitemapEntries.push({ canonical: rendered.urlPath, alternates: altLinks });
          }

          pagesWritten++;
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          const xml = buildSitemapXml(sitemapEntries, dateStamp);
          fs.mkdirSync(distDir, { recursive: true });
          const sitemapPath = np.join(distDir, 'sitemap-cost-of-living.xml');
          fs.writeFileSync(sitemapPath, xml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[cost-of-living]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[cost-of-living]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} skipped as thin) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      // Always-run: patch sitemap.xml index lastmod regardless of cache state,
      // since sitemap.xml is regenerated each build by sitemapAliasPlugin.
      if (fs.existsSync(np.join(distDir, 'sitemap-cost-of-living.xml'))) {
        try {
          patchSitemapIndex(distDir, dateStamp);
        } catch (err) {
          console.warn('\x1b[33m[cost-of-living]\x1b[0m sitemap-index patch failed:', err);
        }
      }
    },
  };
}
