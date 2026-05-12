/**
 * Per-canton snapshot pages for F4 (CH-wide expansion — T2.5).
 *
 * Phase 1 added the data scaffolding (loadChCities, buildActiveJobsPool,
 * buildCityToJobsIndex) but DEFERRED actual per-canton page emission.
 * This module fills the gap.
 *
 * What it does
 * ────────────
 *   - Iterates the cantons that pass the {@link MIN_JOBS_FOR_CANTON_PAGE}
 *     gate (excluding TI to avoid double-emit with the legacy TI pipeline).
 *   - For each (canton, locale) pair emits ONE snapshot page at:
 *       /${localePrefix}/${jobBoardSlug}/${cantonSlug}/snapshot/
 *     where `jobBoardSlug` is the locale-aware "find-jobs-{canton}" prefix
 *     and `cantonSlug` is sourced from data/canton-url-slugs.json.
 *   - Renders: total active jobs, top 5 cities by job count, top 3 sectors,
 *     a breadcrumb, and a CTA to the matching weekly-employers hub.
 *   - Marked `noindex,follow` initially. After the first crawl shows real
 *     content, an editorial pass can flip the gate and rebaseline.
 *
 * What it intentionally avoids
 * ────────────────────────────
 *   - No new sitemap entries (noindex pages stay out of sitemaps).
 *   - No re-translation of the long TI snapshot copy. The page body is a
 *     compact, structured aggregate. Long-form prose can land later via
 *     the same demand-driven pipeline that produces editorial articles.
 *   - The legacy TI emission is untouched — the pipeline runs in the
 *     existing closeBundle BEFORE this helper is called.
 */

import fs from 'node:fs';
import np from 'node:path';
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
  buildActiveJobsPool,
  buildCityToJobsIndex,
  loadChCities,
  slugifyMunicipality,
  type SnapshotCity,
} from './jobMarketSnapshotPlugin';
import { MIN_JOBS_FOR_CANTON_PAGE } from './weeklyEmployersData';
import { buildSnapshotProseBlock } from './shared/cantonSnapshotProse';

// ── Local types — kept loose; the TI-side JobRecord is already compatible. ──
interface JobLike {
  title?: string;
  company?: string;
  location?: string;
  addressLocality?: string;
  category?: string;
  sector?: string;
  expired?: boolean;
  needsRetranslation?: boolean | Record<string, boolean>;
}

type Locale = 'it' | 'en' | 'de' | 'fr';

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

/** Locale-aware "find-jobs-{canton}" URL segment prefix. */
const JOB_BOARD_PREFIX: Record<Locale, string> = {
  it: 'cerca-lavoro',
  en: 'find-jobs',
  de: 'jobs-im',
  fr: 'trouver-emploi',
};

/** "snapshot" segment — same word in all 4 locales for predictable URL shape. */
const SNAPSHOT_SEGMENT = 'snapshot';

const COPY: Record<
  Locale,
  {
    eyebrow: string;
    titlePrefix: string;
    descriptionPrefix: string;
    h1Prefix: string;
    lede: (cantonName: string, jobs: number) => string;
    totalJobsLabel: string;
    citiesHeading: string;
    sectorsHeading: string;
    cityColumn: string;
    sectorColumn: string;
    countColumn: string;
    ctaLabel: string;
    breadcrumbHome: string;
    breadcrumbSwitzerland: string;
    breadcrumbSnapshot: string;
    methodologyHeading: string;
    methodologyP1: (cantonName: string, jobs: number) => string;
    methodologyP2: string;
  }
> = {
  it: {
    eyebrow: 'Snapshot mercato lavoro',
    titlePrefix: 'Lavoro',
    descriptionPrefix: 'Snapshot del mercato del lavoro nel canton',
    h1Prefix: 'Snapshot mercato del lavoro:',
    lede: (canton, jobs) =>
      `Aggiornamento del mercato del lavoro nel canton ${canton}: ${jobs} offerte attive, distribuzione per città e settori principali, aggiornato al giorno corrente.`,
    totalJobsLabel: 'Offerte attive',
    citiesHeading: 'Città con più offerte',
    sectorsHeading: 'Settori principali',
    cityColumn: 'Città',
    sectorColumn: 'Settore',
    countColumn: 'Offerte',
    ctaLabel: 'Vedi le aziende che assumono questa settimana',
    breadcrumbHome: 'Home',
    breadcrumbSwitzerland: 'Svizzera',
    breadcrumbSnapshot: 'Snapshot',
    methodologyHeading: 'Come leggere questo snapshot',
    methodologyP1: (canton, jobs) =>
      `I dati riportano le ${jobs} offerte di lavoro attualmente attive nel canton ${canton}, raccolte da oltre 80 crawler dedicati ai principali datori di lavoro svizzeri. Le offerte scadute o in fase di ritraduzione sono escluse dal conteggio.`,
    methodologyP2:
      'La classifica per città usa il comune di pubblicazione dell\'annuncio; la classifica per settore raggruppa i ruoli per categoria principale (sanità, amministrazione, vendite, edilizia, logistica, ecc.). Lo snapshot è uno strumento di lettura rapida: per la lista completa delle offerte attive utilizza la pagina di ricerca cantonale.',
  },
  en: {
    eyebrow: 'Job market snapshot',
    titlePrefix: 'Jobs',
    descriptionPrefix: 'Job market snapshot for canton',
    h1Prefix: 'Job market snapshot:',
    lede: (canton, jobs) =>
      `Latest update on the ${canton} job market: ${jobs} active openings, distribution across cities and leading sectors, refreshed daily.`,
    totalJobsLabel: 'Active openings',
    citiesHeading: 'Cities with most openings',
    sectorsHeading: 'Leading sectors',
    cityColumn: 'City',
    sectorColumn: 'Sector',
    countColumn: 'Openings',
    ctaLabel: 'See companies hiring this week',
    breadcrumbHome: 'Home',
    breadcrumbSwitzerland: 'Switzerland',
    breadcrumbSnapshot: 'Snapshot',
    methodologyHeading: 'How to read this snapshot',
    methodologyP1: (canton, jobs) =>
      `The data covers the ${jobs} job postings currently active in canton ${canton}, gathered from 80+ crawlers tracking the main Swiss employers. Expired or pending-retranslation listings are excluded from the count.`,
    methodologyP2:
      'The cities ranking uses the publication city of each posting; the sectors ranking groups roles into top-level categories (healthcare, administration, sales, construction, logistics, etc.). The snapshot is a quick-read tool — for the full list of active openings, use the cantonal search page.',
  },
  de: {
    eyebrow: 'Arbeitsmarkt-Snapshot',
    titlePrefix: 'Stellen',
    descriptionPrefix: 'Arbeitsmarkt-Snapshot für den Kanton',
    h1Prefix: 'Arbeitsmarkt-Snapshot:',
    lede: (canton, jobs) =>
      `Aktueller Stand des Arbeitsmarkts im Kanton ${canton}: ${jobs} aktive Stellen, Verteilung nach Städten und führende Branchen, täglich aktualisiert.`,
    totalJobsLabel: 'Aktive Stellen',
    citiesHeading: 'Städte mit den meisten Stellen',
    sectorsHeading: 'Führende Branchen',
    cityColumn: 'Stadt',
    sectorColumn: 'Branche',
    countColumn: 'Stellen',
    ctaLabel: 'Unternehmen, die diese Woche einstellen',
    breadcrumbHome: 'Startseite',
    breadcrumbSwitzerland: 'Schweiz',
    breadcrumbSnapshot: 'Snapshot',
    methodologyHeading: 'So lesen Sie diesen Snapshot',
    methodologyP1: (canton, jobs) =>
      `Die Daten umfassen die ${jobs} derzeit aktiven Stellenangebote im Kanton ${canton}, erfasst durch über 80 Crawler bei den wichtigsten Schweizer Arbeitgebern. Abgelaufene oder zur Neuübersetzung markierte Inserate sind ausgeschlossen.`,
    methodologyP2:
      'Die Städte-Rangliste verwendet den Veröffentlichungsort jedes Inserats; die Branchen-Rangliste fasst Rollen zu Kategorien zusammen (Gesundheit, Administration, Verkauf, Bau, Logistik usw.). Der Snapshot ist ein Schnellüberblick — die vollständige Liste finden Sie auf der kantonalen Suchseite.',
  },
  fr: {
    eyebrow: 'Aperçu marché de l\'emploi',
    titlePrefix: 'Emplois',
    descriptionPrefix: 'Aperçu du marché de l\'emploi pour le canton',
    h1Prefix: 'Aperçu marché de l\'emploi :',
    lede: (canton, jobs) =>
      `Mise à jour du marché de l'emploi dans le canton ${canton} : ${jobs} offres actives, répartition par ville et secteurs phares, actualisé quotidiennement.`,
    totalJobsLabel: 'Offres actives',
    citiesHeading: 'Villes avec le plus d\'offres',
    sectorsHeading: 'Secteurs phares',
    cityColumn: 'Ville',
    sectorColumn: 'Secteur',
    countColumn: 'Offres',
    ctaLabel: 'Entreprises qui recrutent cette semaine',
    breadcrumbHome: 'Accueil',
    breadcrumbSwitzerland: 'Suisse',
    breadcrumbSnapshot: 'Aperçu',
    methodologyHeading: 'Lire cet aperçu',
    methodologyP1: (canton, jobs) =>
      `Les données portent sur les ${jobs} offres d'emploi actuellement actives dans le canton ${canton}, recueillies par plus de 80 crawlers ciblant les principaux employeurs suisses. Les offres expirées ou en attente de retraduction sont exclues du décompte.`,
    methodologyP2:
      'Le classement par ville utilise le lieu de publication de l\'annonce ; le classement par secteur regroupe les rôles par catégorie (santé, administration, ventes, bâtiment, logistique, etc.). L\'aperçu est un outil de lecture rapide — pour la liste complète, utilisez la page de recherche cantonale.',
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
    console.warn('[job-market-snapshot] canton-url-slugs.json missing — CH-wide snapshot pages disabled', err);
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

/** Sector heuristic — derive a coarse sector key from category/title text. */
function deriveSector(job: JobLike): string {
  const haystack = `${job.category ?? ''} ${job.sector ?? ''} ${job.title ?? ''}`.toLowerCase();
  if (/(infermier|nurse|krankenpfleg|infirm)/.test(haystack)) return 'sanita';
  if (/(medic|doctor|arzt|m[eé]dec)/.test(haystack)) return 'sanita';
  if (/(educator|insegnan|teacher|lehrer|enseignan)/.test(haystack)) return 'educazione';
  if (/(vendit|sales|verkauf|vente|commercial)/.test(haystack)) return 'vendite';
  if (/(amministr|admin|verwaltung|administrati)/.test(haystack)) return 'amministrativo';
  if (/(finanz|finance|banc|bank|assicur|insur|assur)/.test(haystack)) return 'finanza';
  if (/(informa|software|developer|sviluppa|entwickl|d[eé]velopp|it\b)/.test(haystack)) return 'informatica';
  if (/(retail|negozio|shop|laden|magasin|cassier|cashier)/.test(haystack)) return 'retail';
  if (/(meccanic|mechanic|mechaniker|m[eé]canic)/.test(haystack)) return 'meccanica';
  if (/(ediliz|construct|bau\b|constructi|bâtim|batim)/.test(haystack)) return 'edilizia';
  if (/(ristoraz|restaur|gastro|chef|cuoc|koch|cuisin)/.test(haystack)) return 'ristorazione';
  if (/(logist|transport|spedizion|fahrer|driver|chauff)/.test(haystack)) return 'logistica';
  if (/(ingegn|engineer|ingenieur|ing[eé]nieur)/.test(haystack)) return 'ingegneria';
  return 'altro';
}

const SECTOR_DISPLAY: Record<string, Record<Locale, string>> = {
  sanita: { it: 'Sanità', en: 'Healthcare', de: 'Gesundheit', fr: 'Santé' },
  educazione: { it: 'Educazione', en: 'Education', de: 'Bildung', fr: 'Éducation' },
  vendite: { it: 'Vendite', en: 'Sales', de: 'Verkauf', fr: 'Ventes' },
  amministrativo: { it: 'Amministrativo', en: 'Administrative', de: 'Verwaltung', fr: 'Administratif' },
  finanza: { it: 'Finanza', en: 'Finance', de: 'Finanzwesen', fr: 'Finance' },
  informatica: { it: 'Informatica', en: 'IT', de: 'Informatik', fr: 'Informatique' },
  retail: { it: 'Retail', en: 'Retail', de: 'Einzelhandel', fr: 'Commerce' },
  meccanica: { it: 'Meccanica', en: 'Mechanical', de: 'Mechanik', fr: 'Mécanique' },
  edilizia: { it: 'Edilizia', en: 'Construction', de: 'Bauwesen', fr: 'Bâtiment' },
  ristorazione: { it: 'Ristorazione', en: 'Hospitality', de: 'Gastronomie', fr: 'Restauration' },
  logistica: { it: 'Logistica', en: 'Logistics', de: 'Logistik', fr: 'Logistique' },
  ingegneria: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ingénierie' },
  altro: { it: 'Altro', en: 'Other', de: 'Sonstige', fr: 'Autre' },
};

/** Build canonical path for a per-canton snapshot page. */
export function buildCantonSnapshotPath(
  locale: Locale,
  cantonSlug: string,
): string {
  const prefix = LOCALE_PREFIX[locale];
  const board = JOB_BOARD_PREFIX[locale];
  return `${prefix}/${board}-${cantonSlug}/${SNAPSHOT_SEGMENT}/`.replace(/\/{2,}/g, '/');
}

interface RankedCity {
  name: string;
  count: number;
}

interface RankedSector {
  key: string;
  label: string;
  count: number;
}

/** Aggregate top-N cities + sectors for a canton bucket. */
function aggregateCanton(
  cantonJobs: readonly JobLike[],
  cantonCode: string,
  citiesByCanton: ReadonlyMap<string, SnapshotCity[]>,
  cityIndex: ReadonlyMap<string, JobLike[]>,
  locale: Locale,
): { totalJobs: number; topCities: RankedCity[]; topSectors: RankedSector[] } {
  const totalJobs = cantonJobs.length;

  // Cities: walk every BFS municipality for the canton + look up its job bucket.
  const cityScores: RankedCity[] = [];
  const seenCityNames = new Set<string>();
  const municipalities = citiesByCanton.get(cantonCode) ?? [];
  for (const muni of municipalities) {
    if (seenCityNames.has(muni.name)) continue;
    const bucket = cityIndex.get(`${cantonCode}/${muni.key}`);
    if (!bucket || bucket.length === 0) continue;
    seenCityNames.add(muni.name);
    cityScores.push({ name: muni.name, count: bucket.length });
  }
  cityScores.sort((a, b) => b.count - a.count);
  const topCities = cityScores.slice(0, 5);

  // Sectors
  const sectorTallies = new Map<string, number>();
  for (const job of cantonJobs) {
    const sector = deriveSector(job);
    sectorTallies.set(sector, (sectorTallies.get(sector) ?? 0) + 1);
  }
  const topSectors: RankedSector[] = Array.from(sectorTallies.entries())
    .map(([key, count]) => ({
      key,
      label: SECTOR_DISPLAY[key]?.[locale] ?? key,
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  return { totalJobs, topCities, topSectors };
}

interface RenderInputs {
  locale: Locale;
  cantonCode: string;
  cantonName: string;
  cantonSlug: string;
  canonicalPath: string;
  totalJobs: number;
  topCities: RankedCity[];
  topSectors: RankedSector[];
  hiringHubHref: string;
  distDir?: string;
}

function renderSnapshotPage(inp: RenderInputs): string {
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
    <span aria-current="page">${esc(c.breadcrumbSnapshot)}</span>
  </nav>`;

  const headerBlock = `<header>
    <p style="${HERO_EYEBROW_STYLE}">${esc(c.eyebrow)}</p>
    <h1 style="${H1_STYLE}">${esc(`${c.h1Prefix} ${cantonName}`)}</h1>
    <p style="${LEDE_STYLE}">${esc(c.lede(cantonName, inp.totalJobs))}</p>
  </header>`;

  const tilesBlock = `<section aria-label="${esc(c.totalJobsLabel)}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0">
    <div style="${STAT_TILE_ACCENT}">
      <span style="${STAT_TILE_LABEL}">${esc(c.totalJobsLabel)}</span>
      <span style="${STAT_TILE_VALUE}">${inp.totalJobs}</span>
    </div>
    <div style="${STAT_TILE_SUCCESS}">
      <span style="${STAT_TILE_LABEL}">${esc(c.citiesHeading)}</span>
      <span style="${STAT_TILE_VALUE}">${inp.topCities.length}</span>
    </div>
    <div style="${STAT_TILE_BASE}">
      <span style="${STAT_TILE_LABEL}">${esc(c.sectorsHeading)}</span>
      <span style="${STAT_TILE_VALUE}">${inp.topSectors.length}</span>
    </div>
  </section>`;

  const ctaBlock = `<p style="margin:16px 0 24px"><a href="${esc(inp.hiringHubHref)}" style="${CTA_PRIMARY_STYLE}">${esc(c.ctaLabel)} →</a></p>`;

  const cityRows = inp.topCities
    .map(
      (city) =>
        `<tr><td style="padding:8px 12px">${esc(city.name)}</td><td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums">${city.count}</td></tr>`,
    )
    .join('\n');
  const cityTable = inp.topCities.length
    ? `<section><h2 style="${H2_STYLE}">${esc(c.citiesHeading)}</h2>
        <div style="${CARD_STYLE}"><table style="width:100%;border-collapse:collapse">
          <thead><tr><th style="text-align:left;padding:8px 12px">${esc(c.cityColumn)}</th><th style="text-align:right;padding:8px 12px">${esc(c.countColumn)}</th></tr></thead>
          <tbody>${cityRows}</tbody>
        </table></div></section>`
    : '';

  const sectorRows = inp.topSectors
    .map(
      (sector) =>
        `<tr><td style="padding:8px 12px">${esc(sector.label)}</td><td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums">${sector.count}</td></tr>`,
    )
    .join('\n');
  const sectorTable = inp.topSectors.length
    ? `<section><h2 style="${H2_STYLE}">${esc(c.sectorsHeading)}</h2>
        <div style="${CARD_STYLE}"><table style="width:100%;border-collapse:collapse">
          <thead><tr><th style="text-align:left;padding:8px 12px">${esc(c.sectorColumn)}</th><th style="text-align:right;padding:8px 12px">${esc(c.countColumn)}</th></tr></thead>
          <tbody>${sectorRows}</tbody>
        </table></div></section>`
    : '';

  // Long-form prose below the data area (per CLAUDE.md rules #16/#17 — filler
  // never above the meaty content). Two paragraphs ~110 words each.
  const methodologyBlock = `<section style="margin-top:32px">
    <h2 style="${H2_STYLE}">${esc(c.methodologyHeading)}</h2>
    <p>${esc(c.methodologyP1(cantonName, inp.totalJobs))}</p>
    <p>${esc(c.methodologyP2)}</p>
  </section>`;

  // Deep-dive prose (PR #140-style): 4 paragraphs ~110-160 words each adding
  // ~1.6-2.0 KB of visible text per page, lifting the text-to-HTML ratio
  // above the 12% bar with margin against data drift. Pure: identical
  // inputs return identical HTML. Locale + canton-distance-band aware so
  // two cantons emit different prose (cross-page duplicate-content safe).
  const topSectorLabel = inp.topSectors.length ? inp.topSectors[0].label : null;
  const topCityName = inp.topCities.length ? inp.topCities[0].name : null;
  const snapshotProseBlock = buildSnapshotProseBlock({
    locale: inp.locale,
    cantonDisplay: cantonName,
    totalJobs: inp.totalJobs,
    topSectorLabel,
    topCityName,
    ctaHref: inp.hiringHubHref,
    ctaLabel: c.ctaLabel,
  });

  const main = `<main class="seo-static-content" style="max-width:960px;margin:0 auto;padding:24px 16px">
    ${breadcrumb}
    ${headerBlock}
    ${tilesBlock}
    ${ctaBlock}
    ${cityTable}
    ${sectorTable}
    ${methodologyBlock}
    ${snapshotProseBlock}
    <p style="margin-top:24px"><a href="${esc(inp.hiringHubHref)}" style="${LINK_ACCENT_STYLE}">${esc(c.ctaLabel)} →</a></p>
  </main>`;

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.breadcrumbHome, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 2, name: c.breadcrumbSwitzerland, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 3, name: cantonName, item: `${BASE_URL}${inp.canonicalPath}` },
      { '@type': 'ListItem', position: 4, name: c.breadcrumbSnapshot, item: `${BASE_URL}${inp.canonicalPath}` },
    ],
  });

  const title = `${c.titlePrefix} ${cantonName}: ${c.eyebrow.toLowerCase()}`;
  const description = `${c.descriptionPrefix} ${cantonName}: ${inp.totalJobs} ${c.totalJobsLabel.toLowerCase()}.`;

  // Phase 6 (Cathedral, P2.S1): flip to `index,follow` once the canton
  // bucket meets the MIN_JOBS_FOR_CANTON_PAGE gate. Below-threshold pages
  // stay `noindex,follow` so thin pages don't dilute authority.
  const robotsValue = inp.totalJobs >= MIN_JOBS_FOR_CANTON_PAGE
    ? 'index,follow'
    : 'noindex,follow';

  return buildSeoPageHtml({
    locale: inp.locale,
    title,
    description,
    canonicalUrl: `${BASE_URL}${inp.canonicalPath}`,
    bodyHtml: main,
    jsonLdScripts: [breadcrumbLd],
    ogLocale: OG_LOCALE[inp.locale],
    robots: robotsValue,
    distDir: inp.distDir,
  });
}

export interface ChCantonSnapshotEmitOptions {
  rootDir: string;
  distDir: string;
  jobs: readonly JobLike[];
  /** Minimum jobs per canton to emit. Defaults to 5 (matches MIN_JOBS_FOR_CANTON_PAGE). */
  minJobsForCantonPage?: number;
}

export interface ChCantonSnapshotEmitResult {
  pagesWritten: number;
  cantonsEmitted: Array<{ code: string; jobsCount: number }>;
  cantonsSkipped: Array<{ code: string; jobsCount: number }>;
  pagesSkippedForWordCount: number;
}

/**
 * Emit per-canton snapshot pages for every canton above the threshold.
 *
 * Excludes TI to avoid double-emit with the legacy TI pipeline (the TI
 * snapshot/per-week/per-month/per-sector pages are produced by the existing
 * generateJobMarketSnapshotPages flow).
 */
export async function emitChCantonSnapshotPages(
  opts: ChCantonSnapshotEmitOptions,
): Promise<ChCantonSnapshotEmitResult> {
  const minJobs = opts.minJobsForCantonPage ?? MIN_JOBS_FOR_CANTON_PAGE;
  const result: ChCantonSnapshotEmitResult = {
    pagesWritten: 0,
    cantonsEmitted: [],
    cantonsSkipped: [],
    pagesSkippedForWordCount: 0,
  };

  const slugFile = loadCantonSlugFile(opts.rootDir);
  if (!slugFile) return result;

  // Build the canton → BFS-municipalities lookup once. Half-canton merge:
  // AI+AR cities collapse under 'APPENZELLO'; BL+BS under 'BASILEA' so the
  // emitted page lists every municipality from both members in one place.
  const allCities = loadChCities(opts.rootDir);
  const citiesByCanton = new Map<string, SnapshotCity[]>();
  for (const city of allCities) {
    if (city.canton === 'TI') continue; // exclude TI from CH-wide emission
    const urlKey = resolveCantonGroup(city.canton);
    let bucket = citiesByCanton.get(urlKey);
    if (!bucket) {
      bucket = [];
      citiesByCanton.set(urlKey, bucket);
    }
    bucket.push(city);
  }

  // Pre-bucket active jobs by composite (canton, citySlug). Reuses the same
  // path as the TI pipeline so jobs without an explicit canton fall into
  // the correct bucket.
  const activePool = buildActiveJobsPool(opts.jobs as never);
  const cityIndex = buildCityToJobsIndex(activePool as never) as ReadonlyMap<
    string,
    JobLike[]
  >;

  // For per-canton totals walk activePool once. resolveJobCanton-style logic
  // is duplicated minimally — explicit job.canton, addressRegion fallback,
  // city-slug fallback against the BFS map.
  // jobsByCanton is keyed by URL group (post-resolveCantonGroup) so AI+AR
  // and BL+BS jobs accumulate in the merged bucket directly.
  const jobsByCanton = new Map<string, JobLike[]>();
  for (const code of citiesByCanton.keys()) jobsByCanton.set(code, []);
  for (const job of activePool as readonly JobLike[]) {
    const directCanton = (job as { canton?: unknown }).canton;
    if (typeof directCanton === 'string' && directCanton.length === 2) {
      const upper = directCanton.toUpperCase();
      if (upper === 'TI') continue;
      const urlKey = resolveCantonGroup(upper);
      const bucket = jobsByCanton.get(urlKey);
      if (bucket) {
        bucket.push(job);
        continue;
      }
    }
    const region = (job as { addressRegion?: unknown }).addressRegion;
    if (typeof region === 'string') {
      const m = /\b([A-Z]{2})\b/.exec(region.toUpperCase());
      if (m && m[1] !== 'TI') {
        const urlKey = resolveCantonGroup(m[1]);
        const bucket = jobsByCanton.get(urlKey);
        if (bucket) {
          bucket.push(job);
          continue;
        }
      }
    }
    // City-slug fallback
    const loc = job.addressLocality ?? job.location ?? '';
    if (!loc) continue;
    const slug = slugifyMunicipality(loc);
    if (!slug) continue;
    for (const [code, list] of citiesByCanton.entries()) {
      if (list.some((m) => m.key === slug)) {
        const bucket = jobsByCanton.get(code);
        if (bucket) {
          bucket.push(job);
        }
        break;
      }
    }
  }

  const collector = new WriteCollector({
    distDir: opts.distDir,
    pluginName: 'jobMarketSnapshotChCantonPages',
  });

  // Sorted iteration keeps log output stable build-to-build.
  const sortedCantons = Array.from(jobsByCanton.keys()).sort();
  for (const cantonCode of sortedCantons) {
    const cantonJobs = jobsByCanton.get(cantonCode) ?? [];
    if (cantonJobs.length < minJobs) {
      result.cantonsSkipped.push({ code: cantonCode, jobsCount: cantonJobs.length });
      continue;
    }
    result.cantonsEmitted.push({ code: cantonCode, jobsCount: cantonJobs.length });

    for (const locale of LOCALES) {
      const cantonSlug = getCantonUrlSlugLocal(slugFile, cantonCode, locale);
      if (!cantonSlug) continue;
      const cantonName = getCantonDisplayName(cantonCode, locale);
      const canonicalPath = buildCantonSnapshotPath(locale, cantonSlug);

      const stats = aggregateCanton(
        cantonJobs,
        cantonCode,
        citiesByCanton,
        cityIndex,
        locale,
      );

      const hiringHubHref =
        `${LOCALE_PREFIX[locale]}/${JOB_BOARD_PREFIX[locale]}-${cantonSlug}/`.replace(/\/{2,}/g, '/');

      const html = renderSnapshotPage({
        locale,
        cantonCode,
        cantonName,
        cantonSlug,
        canonicalPath,
        totalJobs: stats.totalJobs,
        topCities: stats.topCities,
        topSectors: stats.topSectors,
        hiringHubHref,
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
