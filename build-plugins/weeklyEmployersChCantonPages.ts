/**
 * Per-canton "Aziende che assumono" pages for F5 (CH-wide expansion — T2.5).
 *
 * Phase 1 added the data scaffolding (loadChCantonMunicipalities,
 * resolveJobCanton, buildCantonJobsIndex, listEligibleChCantons) but
 * DEFERRED actual per-canton page emission. This module fills the gap.
 *
 * What it does
 * ────────────
 *   - Iterates the cantons returned by `listEligibleChCantons` (already
 *     gated by {@link MIN_JOBS_FOR_CANTON_PAGE} + TI excluded).
 *   - For each (canton, locale) pair emits ONE page at:
 *       /${localePrefix}/${jobBoardSlug}-${cantonSlug}/aziende-che-assumono/
 *     where `jobBoardSlug` is the locale-aware "find-jobs" prefix and
 *     `cantonSlug` is sourced from data/canton-url-slugs.json.
 *   - Lists the top employers (by active job count) in that canton.
 *   - Marked `noindex,follow` initially. Editorial pass + content gate
 *     pass before flipping to index,follow.
 *
 * Backward-compat: legacy TI emission path is untouched. This helper runs
 * AFTER the existing flow in closeBundle.
 */

import np from 'node:path';
import fs from 'node:fs';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CARD_STYLE,
  CTA_PRIMARY_STYLE,
  H1_STYLE,
  H2_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  STAT_TILE_ACCENT,
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_SUCCESS,
  STAT_TILE_VALUE,
} from './shared/seoContentTokens';
import {
  buildCantonJobsIndex,
  loadChCantonMunicipalities,
  type ChCantonJobsIndex,
  type WeeklyCountableJob,
} from './weeklyEmployersPlugin';
import {
  WEEKLY_EMPLOYERS_SECTION,
  type SwissCantonCode,
  type WeeklyEmployersLocale,
} from './weeklyEmployersData';

type Locale = WeeklyEmployersLocale;

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'] as const;

const LOCALE_PREFIX: Record<Locale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

const OG_LOCALE: Record<Locale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

/** Locale-aware "find-jobs" segment prefix (mirror of jobMarketSnapshotChCantonPages). */
const JOB_BOARD_PREFIX: Record<Locale, string> = {
  it: 'cerca-lavoro',
  en: 'find-jobs',
  de: 'jobs-im',
  fr: 'trouver-emploi',
};

const COPY: Record<
  Locale,
  {
    eyebrow: string;
    titlePrefix: string;
    descriptionPrefix: string;
    h1: (cantonName: string) => string;
    lede: (cantonName: string, employers: number, jobs: number) => string;
    activeEmployersLabel: string;
    activeJobsLabel: string;
    employersHeading: string;
    employerColumn: string;
    countColumn: string;
    ctaLabel: string;
    breadcrumbHome: string;
    breadcrumbSwitzerland: string;
    breadcrumbSection: string;
    methodologyHeading: string;
    methodologyP1: (cantonName: string, employers: number, jobs: number) => string;
    methodologyP2: string;
  }
> = {
  it: {
    eyebrow: 'Aziende che assumono',
    titlePrefix: 'Aziende che assumono',
    descriptionPrefix: 'Aziende attive nel canton',
    h1: (canton) => `Aziende che assumono in ${canton} questa settimana`,
    lede: (canton, employers, jobs) =>
      `${employers} aziende stanno cercando personale nel canton ${canton} con ${jobs} offerte attive aggiornate al giorno corrente.`,
    activeEmployersLabel: 'Aziende attive',
    activeJobsLabel: 'Offerte attive',
    employersHeading: 'Top aziende per numero di offerte',
    employerColumn: 'Azienda',
    countColumn: 'Offerte',
    ctaLabel: 'Vedi tutte le offerte cantonali',
    breadcrumbHome: 'Home',
    breadcrumbSwitzerland: 'Svizzera',
    breadcrumbSection: 'Aziende che assumono',
    methodologyHeading: 'Note di lettura',
    methodologyP1: (canton, employers, jobs) =>
      `La pagina elenca le ${employers} aziende che pubblicano almeno un\'offerta attiva nel canton ${canton}, per un totale di ${jobs} posizioni aperte. I dati sono raccolti da oltre 80 crawler dedicati ai principali datori di lavoro svizzeri e aggiornati più volte al giorno.`,
    methodologyP2:
      'Le aziende sono ordinate per numero di posizioni aperte. Per la lista completa delle offerte cantonali, segui il link alla pagina di ricerca; per i dettagli storici settimana per settimana, consulta gli archivi della pagina principale "aziende che assumono".',
  },
  en: {
    eyebrow: 'Companies hiring',
    titlePrefix: 'Companies hiring',
    descriptionPrefix: 'Active employers in canton',
    h1: (canton) => `Companies hiring in ${canton} this week`,
    lede: (canton, employers, jobs) =>
      `${employers} companies are recruiting in canton ${canton} with ${jobs} active openings refreshed throughout the day.`,
    activeEmployersLabel: 'Active employers',
    activeJobsLabel: 'Active openings',
    employersHeading: 'Top employers by openings',
    employerColumn: 'Employer',
    countColumn: 'Openings',
    ctaLabel: 'See all cantonal openings',
    breadcrumbHome: 'Home',
    breadcrumbSwitzerland: 'Switzerland',
    breadcrumbSection: 'Companies hiring',
    methodologyHeading: 'How to read this page',
    methodologyP1: (canton, employers, jobs) =>
      `This page lists the ${employers} companies with at least one active opening in canton ${canton}, totalling ${jobs} positions. Data is collected by 80+ crawlers tracking the main Swiss employers and refreshed multiple times daily.`,
    methodologyP2:
      'Companies are ordered by number of active openings. For the full cantonal openings list, follow the link to the search page; for week-by-week archives, see the main "companies hiring" landing.',
  },
  de: {
    eyebrow: 'Unternehmen, die einstellen',
    titlePrefix: 'Unternehmen, die einstellen',
    descriptionPrefix: 'Aktive Arbeitgeber im Kanton',
    h1: (canton) => `Unternehmen, die diese Woche im Kanton ${canton} einstellen`,
    lede: (canton, employers, jobs) =>
      `${employers} Unternehmen rekrutieren im Kanton ${canton} mit ${jobs} aktiven Stellen, mehrmals täglich aktualisiert.`,
    activeEmployersLabel: 'Aktive Arbeitgeber',
    activeJobsLabel: 'Aktive Stellen',
    employersHeading: 'Top-Arbeitgeber nach Stellenzahl',
    employerColumn: 'Arbeitgeber',
    countColumn: 'Stellen',
    ctaLabel: 'Alle kantonalen Stellen ansehen',
    breadcrumbHome: 'Startseite',
    breadcrumbSwitzerland: 'Schweiz',
    breadcrumbSection: 'Unternehmen, die einstellen',
    methodologyHeading: 'Lesehinweise',
    methodologyP1: (canton, employers, jobs) =>
      `Diese Seite listet die ${employers} Unternehmen, die mindestens eine aktive Stelle im Kanton ${canton} ausschreiben — insgesamt ${jobs} Positionen. Die Daten werden von über 80 Crawlern bei den wichtigsten Schweizer Arbeitgebern erfasst und mehrmals täglich aktualisiert.`,
    methodologyP2:
      'Unternehmen sind nach Anzahl aktiver Stellen sortiert. Für die vollständige kantonale Stellenliste folgen Sie dem Link zur Suchseite; für wöchentliche Archive siehe die Hauptseite "Unternehmen, die einstellen".',
  },
  fr: {
    eyebrow: 'Entreprises qui recrutent',
    titlePrefix: 'Entreprises qui recrutent',
    descriptionPrefix: 'Employeurs actifs dans le canton',
    h1: (canton) => `Entreprises qui recrutent dans le canton ${canton} cette semaine`,
    lede: (canton, employers, jobs) =>
      `${employers} entreprises recrutent dans le canton ${canton} avec ${jobs} offres actives mises à jour plusieurs fois par jour.`,
    activeEmployersLabel: 'Employeurs actifs',
    activeJobsLabel: 'Offres actives',
    employersHeading: 'Principaux employeurs par offres',
    employerColumn: 'Employeur',
    countColumn: 'Offres',
    ctaLabel: 'Voir toutes les offres cantonales',
    breadcrumbHome: 'Accueil',
    breadcrumbSwitzerland: 'Suisse',
    breadcrumbSection: 'Entreprises qui recrutent',
    methodologyHeading: 'Notes de lecture',
    methodologyP1: (canton, employers, jobs) =>
      `Cette page recense les ${employers} entreprises ayant au moins une offre active dans le canton ${canton}, pour un total de ${jobs} postes ouverts. Les données sont collectées par plus de 80 crawlers dédiés aux principaux employeurs suisses et actualisées plusieurs fois par jour.`,
    methodologyP2:
      'Les entreprises sont triées par nombre d\'offres actives. Pour la liste complète des offres cantonales, suivez le lien vers la page de recherche ; pour les archives semaine par semaine, consultez la page principale "entreprises qui recrutent".',
  },
};

/** Localised display name for a canton. */
const CANTON_DISPLAY: Record<string, Record<Locale, string>> = {
  AG: { it: 'Argovia', en: 'Aargau', de: 'Aargau', fr: 'Argovie' },
  // Half-canton URL groups (2026-05-10 merge): AI+AR -> APPENZELLO, BL+BS -> BASILEA.
  APPENZELLO: { it: 'Appenzello', en: 'Appenzell', de: 'Appenzell', fr: 'Appenzell' },
  BE: { it: 'Berna', en: 'Bern', de: 'Bern', fr: 'Berne' },
  BASILEA: { it: 'Basilea', en: 'Basel', de: 'Basel', fr: 'Bâle' },
  FR: { it: 'Friburgo', en: 'Fribourg', de: 'Freiburg', fr: 'Fribourg' },
  GE: { it: 'Ginevra', en: 'Geneva', de: 'Genf', fr: 'Genève' },
  GL: { it: 'Glarona', en: 'Glarus', de: 'Glarus', fr: 'Glaris' },
  GR: { it: 'Grigioni', en: 'Graubünden', de: 'Graubünden', fr: 'Grisons' },
  JU: { it: 'Giura', en: 'Jura', de: 'Jura', fr: 'Jura' },
  LU: { it: 'Lucerna', en: 'Lucerne', de: 'Luzern', fr: 'Lucerne' },
  NE: { it: 'Neuchâtel', en: 'Neuchâtel', de: 'Neuenburg', fr: 'Neuchâtel' },
  NW: { it: 'Nidvaldo', en: 'Nidwalden', de: 'Nidwalden', fr: 'Nidwald' },
  OW: { it: 'Obvaldo', en: 'Obwalden', de: 'Obwalden', fr: 'Obwald' },
  SG: { it: 'San Gallo', en: 'St. Gallen', de: 'St. Gallen', fr: 'Saint-Gall' },
  SH: { it: 'Sciaffusa', en: 'Schaffhausen', de: 'Schaffhausen', fr: 'Schaffhouse' },
  SO: { it: 'Soletta', en: 'Solothurn', de: 'Solothurn', fr: 'Soleure' },
  SZ: { it: 'Svitto', en: 'Schwyz', de: 'Schwyz', fr: 'Schwytz' },
  TG: { it: 'Turgovia', en: 'Thurgau', de: 'Thurgau', fr: 'Thurgovie' },
  TI: { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' },
  UR: { it: 'Uri', en: 'Uri', de: 'Uri', fr: 'Uri' },
  VD: { it: 'Vaud', en: 'Vaud', de: 'Waadt', fr: 'Vaud' },
  VS: { it: 'Vallese', en: 'Valais', de: 'Wallis', fr: 'Valais' },
  ZG: { it: 'Zugo', en: 'Zug', de: 'Zug', fr: 'Zoug' },
  ZH: { it: 'Zurigo', en: 'Zürich', de: 'Zürich', fr: 'Zurich' },
};

interface CantonSlugFile {
  cantons: Record<string, Record<Locale, string>>;
  cantonGroups?: Record<string, { members: readonly string[] }>;
  aggregate: Record<Locale, string>;
}

let cantonSlugFileCache: CantonSlugFile | null = null;
let memberToGroupCache: ReadonlyMap<string, string> | null = null;

function loadCantonSlugFile(rootDir: string): CantonSlugFile | null {
  if (cantonSlugFileCache) return cantonSlugFileCache;
  try {
    const raw = fs.readFileSync(np.resolve(rootDir, 'data/canton-url-slugs.json'), 'utf-8');
    const parsed = JSON.parse(raw) as CantonSlugFile;
    if (!parsed?.cantons || !parsed?.aggregate) return null;
    cantonSlugFileCache = parsed;
    const map = new Map<string, string>();
    for (const [groupKey, def] of Object.entries(parsed.cantonGroups ?? {})) {
      for (const m of def?.members ?? []) {
        map.set(String(m).toUpperCase(), groupKey);
      }
    }
    memberToGroupCache = map;
    return parsed;
  } catch (err) {
    console.warn('[weekly-employers] canton-url-slugs.json missing — CH-wide canton pages disabled', err);
    return null;
  }
}

/**
 * Half-canton merge: collapse 'AI'/'AR' onto 'APPENZELLO', 'BL'/'BS' onto
 * 'BASILEA'. Every other canton code (and the aggregate sentinel) round-trips
 * unchanged. Requires {@link loadCantonSlugFile} to have been called first.
 */
function resolveCantonGroup(cantonCode: string): string {
  const code = String(cantonCode || '').toUpperCase().trim();
  if (!code) return code;
  return memberToGroupCache?.get(code) ?? code;
}

/** Reset the canton-slug file cache (test-only). */
export function clearChCantonPagesCache(): void {
  cantonSlugFileCache = null;
  memberToGroupCache = null;
}

function getCantonUrlSlugLocal(file: CantonSlugFile, code: string, locale: Locale): string | null {
  const entry = file.cantons[code];
  if (!entry) return null;
  return entry[locale] ?? entry.it ?? null;
}

function getCantonDisplayName(code: string, locale: Locale): string {
  return CANTON_DISPLAY[code]?.[locale] ?? CANTON_DISPLAY[code]?.it ?? code;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build canonical path for the per-canton weekly-employers page. */
export function buildCantonEmployersPath(
  locale: Locale,
  cantonSlug: string,
): string {
  return `${LOCALE_PREFIX[locale]}/${JOB_BOARD_PREFIX[locale]}-${cantonSlug}/${WEEKLY_EMPLOYERS_SECTION[locale]}/`.replace(/\/{2,}/g, '/');
}

interface RankedEmployer {
  employer: string;
  count: number;
}

/** Top employers (display name + active count) for a canton bucket. */
function rankEmployers(
  byEmployer: ReadonlyMap<string, readonly WeeklyCountableJob[]>,
  limit = 15,
): RankedEmployer[] {
  const out: RankedEmployer[] = [];
  for (const [, jobs] of byEmployer.entries()) {
    if (jobs.length === 0) continue;
    const display = String(jobs[0]?.company || '').trim();
    if (!display) continue;
    out.push({ employer: display, count: jobs.length });
  }
  out.sort((a, b) => (b.count - a.count) || a.employer.localeCompare(b.employer));
  return out.slice(0, limit);
}

interface RenderInputs {
  locale: Locale;
  cantonCode: string;
  cantonName: string;
  cantonSlug: string;
  canonicalPath: string;
  totalEmployers: number;
  totalJobs: number;
  topEmployers: RankedEmployer[];
  searchHref: string;
  distDir?: string;
}

function renderEmployersPage(inp: RenderInputs): string {
  const c = COPY[inp.locale];
  const cantonName = inp.cantonName;
  const homeHref = inp.locale === 'it' ? '/' : `${LOCALE_PREFIX[inp.locale]}/`;

  const breadcrumb = `<nav aria-label="breadcrumb" style="${BREADCRUMB_STYLE}">
    <a href="${homeHref}" style="${BREADCRUMB_LINK_STYLE}">${esc(c.breadcrumbHome)}</a>
    <span> / </span>
    <span>${esc(c.breadcrumbSwitzerland)}</span>
    <span> / </span>
    <span>${esc(cantonName)}</span>
    <span> / </span>
    <span aria-current="page">${esc(c.breadcrumbSection)}</span>
  </nav>`;

  const headerBlock = `<header>
    <p style="${HERO_EYEBROW_STYLE}">${esc(c.eyebrow)}</p>
    <h1 style="${H1_STYLE}">${esc(c.h1(cantonName))}</h1>
    <p style="${LEDE_STYLE}">${esc(c.lede(cantonName, inp.totalEmployers, inp.totalJobs))}</p>
  </header>`;

  const tilesBlock = `<section aria-label="${esc(c.eyebrow)}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0">
    <div style="${STAT_TILE_ACCENT}">
      <span style="${STAT_TILE_LABEL}">${esc(c.activeEmployersLabel)}</span>
      <span style="${STAT_TILE_VALUE}">${inp.totalEmployers}</span>
    </div>
    <div style="${STAT_TILE_SUCCESS}">
      <span style="${STAT_TILE_LABEL}">${esc(c.activeJobsLabel)}</span>
      <span style="${STAT_TILE_VALUE}">${inp.totalJobs}</span>
    </div>
    <div style="${STAT_TILE_BASE}">
      <span style="${STAT_TILE_LABEL}">${esc(c.employersHeading)}</span>
      <span style="${STAT_TILE_VALUE}">${inp.topEmployers.length}</span>
    </div>
  </section>`;

  const ctaBlock = `<p style="margin:16px 0 24px"><a href="${esc(inp.searchHref)}" style="${CTA_PRIMARY_STYLE}">${esc(c.ctaLabel)} →</a></p>`;

  const employerRows = inp.topEmployers
    .map(
      (emp) =>
        `<tr><td style="padding:8px 12px">${esc(emp.employer)}</td><td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums">${emp.count}</td></tr>`,
    )
    .join('\n');
  const employerTable = inp.topEmployers.length
    ? `<section><h2 style="${H2_STYLE}">${esc(c.employersHeading)}</h2>
        <div style="${CARD_STYLE}"><table style="width:100%;border-collapse:collapse">
          <thead><tr><th style="text-align:left;padding:8px 12px">${esc(c.employerColumn)}</th><th style="text-align:right;padding:8px 12px">${esc(c.countColumn)}</th></tr></thead>
          <tbody>${employerRows}</tbody>
        </table></div></section>`
    : '';

  const methodologyBlock = `<section style="margin-top:32px">
    <h2 style="${H2_STYLE}">${esc(c.methodologyHeading)}</h2>
    <p>${esc(c.methodologyP1(cantonName, inp.totalEmployers, inp.totalJobs))}</p>
    <p>${esc(c.methodologyP2)}</p>
  </section>`;

  const main = `<main class="seo-static-content" style="max-width:960px;margin:0 auto;padding:24px 16px">
    ${breadcrumb}
    ${headerBlock}
    ${tilesBlock}
    ${ctaBlock}
    ${employerTable}
    ${methodologyBlock}
    <p style="margin-top:24px"><a href="${esc(inp.searchHref)}" style="${LINK_ACCENT_STYLE}">${esc(c.ctaLabel)} →</a></p>
  </main>`;

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.breadcrumbHome, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 2, name: c.breadcrumbSwitzerland, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 3, name: cantonName, item: `${BASE_URL}${inp.canonicalPath}` },
      { '@type': 'ListItem', position: 4, name: c.breadcrumbSection, item: `${BASE_URL}${inp.canonicalPath}` },
    ],
  });

  const title = `${c.titlePrefix} ${cantonName}`;
  const description = `${c.descriptionPrefix} ${cantonName}: ${inp.totalEmployers} ${c.activeEmployersLabel.toLowerCase()}, ${inp.totalJobs} ${c.activeJobsLabel.toLowerCase()}.`;

  return buildSeoPageHtml({
    locale: inp.locale,
    title,
    description,
    canonicalUrl: `${BASE_URL}${inp.canonicalPath}`,
    bodyHtml: main,
    jsonLdScripts: [breadcrumbLd],
    ogLocale: OG_LOCALE[inp.locale],
    robots: 'noindex,follow',
    distDir: inp.distDir,
  });
}

export interface ChCantonEmployersEmitOptions {
  rootDir: string;
  distDir: string;
  jobs: readonly WeeklyCountableJob[];
}

export interface ChCantonEmployersEmitResult {
  pagesWritten: number;
  // `code` may be either a real BFS canton code (TI/ZH/...) or a virtual
  // URL group key ('APPENZELLO' | 'BASILEA') after the half-canton merge.
  cantonsEmitted: Array<{ code: SwissCantonCode | string; jobsCount: number; employersCount: number }>;
  cantonsSkipped: Array<{ code: SwissCantonCode | string; jobsCount: number }>;
  pagesSkippedForWordCount: number;
}

/**
 * Emit per-canton "companies hiring" pages for every canton that passes the
 * MIN_JOBS_FOR_CANTON_PAGE gate (TI is excluded — it has the legacy
 * regional + per-city pipeline).
 */
export async function emitChCantonEmployersPages(
  opts: ChCantonEmployersEmitOptions,
): Promise<ChCantonEmployersEmitResult> {
  const result: ChCantonEmployersEmitResult = {
    pagesWritten: 0,
    cantonsEmitted: [],
    cantonsSkipped: [],
    pagesSkippedForWordCount: 0,
  };

  const slugFile = loadCantonSlugFile(opts.rootDir);
  if (!slugFile) return result;

  const cantonMunicipalities = loadChCantonMunicipalities(opts.rootDir);
  const index: ChCantonJobsIndex = buildCantonJobsIndex(opts.jobs, cantonMunicipalities);

  // Half-canton merge: collapse buckets keyed by AI/AR into APPENZELLO and
  // BL/BS into BASILEA before the threshold gate, so the merged jobs count
  // (and merged byEmployer map) drives eligibility + emission. We don't call
  // listEligibleChCantons here because it operates on individual BFS buckets
  // — combining AI+AR and BL+BS may push the merged group above threshold
  // even when each member alone is below it.
  type MergedBucket = {
    code: string; // URL group key (e.g. 'APPENZELLO') or single canton code
    activeJobsCount: number;
    byEmployer: Map<string, readonly WeeklyCountableJob[]>;
  };
  const MERGE_THRESHOLD = 5; // mirrors MIN_JOBS_FOR_CANTON_PAGE in weeklyEmployersPlugin
  const mergedByCanton = new Map<string, MergedBucket>();
  for (const [bfsCode, bucket] of index.byCanton.entries()) {
    if (bfsCode === 'TI') continue; // legacy TI pipeline owns its hubs
    const urlKey = resolveCantonGroup(bfsCode);
    let merged = mergedByCanton.get(urlKey);
    if (!merged) {
      merged = { code: urlKey, activeJobsCount: 0, byEmployer: new Map() };
      mergedByCanton.set(urlKey, merged);
    }
    merged.activeJobsCount += bucket.activeJobsCount;
    for (const [empKey, jobs] of bucket.byEmployer.entries()) {
      const existing = merged.byEmployer.get(empKey);
      if (existing) {
        merged.byEmployer.set(empKey, [...existing, ...jobs]);
      } else {
        merged.byEmployer.set(empKey, jobs);
      }
    }
  }

  const eligibleCantons: string[] = [];
  for (const [code, bucket] of mergedByCanton.entries()) {
    if (bucket.activeJobsCount >= MERGE_THRESHOLD) {
      eligibleCantons.push(code);
    } else {
      result.cantonsSkipped.push({ code, jobsCount: bucket.activeJobsCount });
    }
  }

  const collector = new WriteCollector({
    distDir: opts.distDir,
    pluginName: 'weeklyEmployersChCantonPages',
  });

  for (const cantonCode of eligibleCantons) {
    const bucket = mergedByCanton.get(cantonCode);
    if (!bucket) continue;
    const employerCount = bucket.byEmployer.size;
    result.cantonsEmitted.push({
      code: cantonCode,
      jobsCount: bucket.activeJobsCount,
      employersCount: employerCount,
    });

    const topEmployers = rankEmployers(bucket.byEmployer, 15);

    for (const locale of LOCALES) {
      const cantonSlug = getCantonUrlSlugLocal(slugFile, cantonCode, locale);
      if (!cantonSlug) continue;
      const cantonName = getCantonDisplayName(cantonCode, locale);
      const canonicalPath = buildCantonEmployersPath(locale, cantonSlug);
      const searchHref = `${LOCALE_PREFIX[locale]}/${JOB_BOARD_PREFIX[locale]}-${cantonSlug}/`.replace(/\/{2,}/g, '/');

      const html = renderEmployersPage({
        locale,
        cantonCode,
        cantonName,
        cantonSlug,
        canonicalPath,
        totalEmployers: employerCount,
        totalJobs: bucket.activeJobsCount,
        topEmployers,
        searchHref,
        distDir: opts.distDir,
      });

      const words = countHtmlBodyWords(html);
      if (words < MIN_INDEXABLE_WORDS) {
        result.pagesSkippedForWordCount++;
        continue;
      }
      const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
      collector.add(np.join(outDir, 'index.html'), html);
      result.pagesWritten++;
    }
  }

  await collector.flush();
  return result;
}
