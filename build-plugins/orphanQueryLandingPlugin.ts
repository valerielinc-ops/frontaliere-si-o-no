/**
 * Orphan-query cluster landings — Vite build plugin.
 *
 * Reads `data/gsc-orphan-queries-clusters.json` (produced by
 * `scripts/cluster-orphan-queries.mjs`) and emits one indexable
 * static HTML page per (cluster) at
 *   IT: /ricerca/{slug}/
 *   EN: /en/search/{slug}/
 *   DE: /de/suche/{slug}/
 *   FR: /fr/recherche/{slug}/
 *
 * Each page carries:
 *   - H1 = canonical query
 *   - Editorial context (role-aware, ≥250 words)
 *   - ItemList JSON-LD of 5-15 matching JobPosting stubs
 *   - "Similar searches" internal-link section
 *   - BreadcrumbList + WebPage + ItemList structured data
 *   - Self-referent canonical, hreflang to other locales when the slug is
 *     present in the clusters file.
 *
 * Anti-doorway mitigations:
 *   - Clusters with <3 matching jobs at build time emit
 *     <meta name="robots" content="noindex,follow"> and are NOT added to
 *     the sitemap.
 *   - Role-aware editorial (tech / healthcare / retail / hospitality /
 *     office / logistics / generic) ensures pages are NOT templated copies.
 *
 * Gates:
 *   - SKIP_ORPHAN_LANDINGS=1 → fast-path exit, no files generated.
 *   - MAX_ORPHAN_LANDINGS (default 500) caps total pages per build.
 *
 * The plugin DEGRADES GRACEFULLY when the clusters file is missing —
 * it logs a warning and returns without failing the build.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import {
  BASE_URL,
  countHtmlBodyWords,
  MIN_INDEXABLE_WORDS,
} from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CTA_PRIMARY_STYLE,
  CARD_STYLE,
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_VALUE,
  LINK_ACCENT_STYLE,
  clampSiteSuffix,
} from './shared/seoContentTokens';
import {
  renderJobCardListHtml,
  type JobCardJob,
  type JobCardListItem,
} from './shared/jobCardHtml';
import {
  ORPHAN_LANDING_LOCALES,
  ORPHAN_LANDING_SECTION,
  ORPHAN_LANDING_LOCALE_PREFIX,
  ORPHAN_LANDING_OG_LOCALE,
  buildOrphanLandingPath,
  filterMatchingJobs,
  median,
  topCounts,
  type OrphanLandingLocale,
  type OrphanQueryCluster,
  type OrphanQueryClustersFile,
  type OrphanCountableJob,
  type OrphanLandingRoute,
} from './orphanQueryData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';
import { adSlotHtml } from './lib/adSlotHtml';

const MIN_MATCHING_JOBS = 3;
const DEFAULT_MAX_LANDINGS = 500;

/** Load and merge all jobs from main jobs.json + per-crawler slices. */
function loadAllJobs(rootDir: string): OrphanCountableJob[] {
  const dataDir = path.join(rootDir, 'data');
  const out: OrphanCountableJob[] = [];
  const seen = new Set<string>();

  const mainPath = path.join(dataDir, 'jobs.json');
  if (fs.existsSync(mainPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const j of raw) {
          const key = String(j?.slug || j?.id || '');
          if (key && !seen.has(key)) {
            seen.add(key);
            out.push(j as OrphanCountableJob);
          }
        }
      }
    } catch (err) {
      console.warn('[orphan-query-landings] failed to parse jobs.json:', err);
    }
  }

  const sliceDir = path.join(dataDir, 'jobs', 'by-crawler');
  if (fs.existsSync(sliceDir)) {
    for (const file of fs.readdirSync(sliceDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(sliceDir, file), 'utf-8'));
        const jobs: unknown = Array.isArray(raw) ? raw : raw?.jobs;
        if (!Array.isArray(jobs)) continue;
        for (const j of jobs as OrphanCountableJob[]) {
          const key = String(j?.slug || (j as { id?: string })?.id || '');
          if (key && !seen.has(key)) {
            seen.add(key);
            out.push(j);
          }
        }
      } catch {
        /* slice parse failure — skip */
      }
    }
  }

  return out;
}

/** Pick a role-family editorial block (tech/healthcare/retail/hospitality/office/logistics/generic). */
function pickEditorialFamily(cluster: OrphanQueryCluster): 'tech' | 'healthcare' | 'retail' | 'hospitality' | 'office' | 'logistics' | 'generic' {
  const joined = [
    cluster.canonicalQuery.toLowerCase(),
    ...cluster.roleTokens,
  ].join(' ');
  const has = (patterns: string[]) => patterns.some((p) => joined.includes(p));

  if (has(['nurs', 'infermier', 'pfleg', 'care', 'caregiver', 'krankensch', 'sanita', 'sanità', 'medic', 'arzt', 'doctor', 'hospit', 'clinic', 'klinik', 'anzian'])) return 'healthcare';
  if (has(['dev', 'develop', 'engineer', 'ingegner', 'entwickl', 'programm', 'software', 'it-', ' it ', 'tech', 'data', 'cloud', 'devops', 'analyst', 'analist'])) return 'tech';
  if (has(['retail', 'vendit', 'sales', 'verkauf', 'boutique', 'outlet', 'store', 'cashier', 'cass', 'prada', 'commerc'])) return 'retail';
  if (has(['hotel', 'hotell', 'gastro', 'restaur', 'kitchen', 'kuechen', 'küch', 'service', 'receptionist', 'ristor'])) return 'hospitality';
  if (has(['chauffeur', 'driver', 'fahrer', 'autist', 'logisti', 'transport', 'warehouse', 'magazz', 'kurier'])) return 'logistics';
  if (has(['bank', 'assicur', 'insurance', 'versicher', 'compliance', 'legal', 'hr', 'administ', 'amminist', 'buchhalt', 'contabil', 'secretari', 'accountant', 'assistant', 'assist', 'segret', 'office'])) return 'office';
  return 'generic';
}

function editorialKey(fam: ReturnType<typeof pickEditorialFamily>): string {
  switch (fam) {
    case 'tech': return 'orphanLanding.editorialTech';
    case 'healthcare': return 'orphanLanding.editorialHealthcare';
    case 'retail': return 'orphanLanding.editorialRetail';
    case 'hospitality': return 'orphanLanding.editorialHospitality';
    case 'office': return 'orphanLanding.editorialOffice';
    case 'logistics': return 'orphanLanding.editorialLogistics';
    default: return 'orphanLanding.editorialGeneric';
  }
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Capitalize only the first letter of a string (no title-case). */
function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Build an editorialized H1 from the canonical query per locale. */
function buildEditorialH1(query: string, locale: OrphanLandingLocale): string {
  const q = cap(query);
  switch (locale) {
    case 'it': return `${q} — offerte e informazioni per frontalieri`;
    case 'en': return `${q} — answers for cross-border workers`;
    case 'de': return `${q} — Antworten für Grenzgänger`;
    case 'fr': return `${q} — réponses pour les frontaliers`;
  }
}

/**
 * Build an editorialised page title per locale, clamped to ≤60 chars.
 *
 * Phase 3A — only append the brand suffix when it still fits the SERP budget.
 * The bare canonical query alone always wins over a truncated brand suffix.
 */
function buildEditorialTitle(query: string, locale: OrphanLandingLocale): string {
  const q = cap(query);
  const brand =
    locale === 'it' ? 'Frontaliere Ticino'
    : locale === 'en' ? 'Cross-border Workers Ticino'
    : locale === 'de' ? 'Grenzgänger Tessin'
    : 'Frontaliers Tessin';
  return clampSiteSuffix(q, brand);
}

/**
 * Build a cluster-specific "signals" paragraph that injects per-entity data
 * (role tokens, region tokens, top variant queries, impression volume) so the
 * body is unique even when the matching-jobs list is empty and the family
 * editorial block collapses to the generic fallback. Keeps the page indexable
 * by making body content unambiguously about the searched query, not about
 * "the Swiss labour market in general".
 *
 * IMPORTANT: all 4 locales return an editorial sentence — never an empty
 * string — so this paragraph is always a distinguishing signal regardless of
 * how sparse the cluster is.
 */
function buildClusterSignalsParagraph(
  cluster: OrphanQueryCluster,
  locale: OrphanLandingLocale,
): string {
  const q = cap(cluster.canonicalQuery);
  const roleTokens = cluster.roleTokens.slice(0, 5).filter(Boolean);
  const regionTokens = cluster.regionTokens.slice(0, 3).filter(Boolean);
  const variantQueries = cluster.queries
    .filter((v) => v.query && v.query !== cluster.canonicalQuery)
    .slice(0, 4)
    .map((v) => v.query);
  const variantCount = cluster.queries.length;
  const impressions = cluster.totalImpressions;
  const clicks = cluster.totalClicks;

  // Cross-border commuter context that varies by the FIRST region token.
  const region = regionTokens[0] || '';

  const formatList = (xs: string[], conj: string): string => {
    if (xs.length === 0) return '';
    if (xs.length === 1) return xs[0];
    return `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`;
  };

  if (locale === 'it') {
    const rolesPart = roleTokens.length > 0
      ? `Le varianti con cui gli utenti cercano questa posizione includono ${formatList(roleTokens, 'e')}.`
      : `Il cluster non contiene sinonimi consolidati.`;
    const regionPart = region
      ? ` Il volume principale di queste ricerche proviene dall'area di ${cap(region)}, un bacino rilevante per frontalieri italiani.`
      : '';
    const variantPart = variantQueries.length > 0
      ? ` Fra le ${variantCount} query raggruppate in questa pagina segnaliamo in particolare: "${variantQueries.join('", "')}".`
      : ` Questa pagina raggruppa ${variantCount} query affini.`;
    const volumePart = impressions > 0
      ? ` Secondo i dati Google Search Console, il cluster ha generato ${impressions.toLocaleString('it-CH')} impression e ${clicks.toLocaleString('it-CH')} clic nell'ultimo snapshot.`
      : '';
    return `Segnali specifici per ${q}. ${rolesPart}${regionPart}${variantPart}${volumePart}`;
  }
  if (locale === 'en') {
    const rolesPart = roleTokens.length > 0
      ? `People searching for this role often phrase it as ${formatList(roleTokens, 'or')}.`
      : `The cluster does not contain consolidated synonyms.`;
    const regionPart = region
      ? ` Most of this search volume comes from the ${cap(region)} area, an important catchment for Italian cross-border workers.`
      : '';
    const variantPart = variantQueries.length > 0
      ? ` Among the ${variantCount} grouped queries, the most typical variants are: "${variantQueries.join('", "')}".`
      : ` This page consolidates ${variantCount} related queries.`;
    const volumePart = impressions > 0
      ? ` According to Google Search Console, the cluster delivered ${impressions.toLocaleString('en-US')} impressions and ${clicks.toLocaleString('en-US')} clicks in the latest snapshot.`
      : '';
    return `Specific signals for ${q}. ${rolesPart}${regionPart}${variantPart}${volumePart}`;
  }
  if (locale === 'de') {
    const rolesPart = roleTokens.length > 0
      ? `Nutzer suchen diese Rolle häufig als ${formatList(roleTokens, 'oder')}.`
      : `Dieses Cluster enthält keine etablierten Synonyme.`;
    const regionPart = region
      ? ` Das Suchvolumen stammt hauptsächlich aus dem Raum ${cap(region)}, einem wichtigen Einzugsgebiet für italienische Grenzgänger.`
      : '';
    const variantPart = variantQueries.length > 0
      ? ` Unter den ${variantCount} gebündelten Suchanfragen fallen besonders auf: "${variantQueries.join('", "')}".`
      : ` Diese Seite bündelt ${variantCount} verwandte Suchanfragen.`;
    const volumePart = impressions > 0
      ? ` Laut Google Search Console generierte dieses Cluster im letzten Snapshot ${impressions.toLocaleString('de-CH')} Impressions und ${clicks.toLocaleString('de-CH')} Klicks.`
      : '';
    return `Spezifische Signale zu ${q}. ${rolesPart}${regionPart}${variantPart}${volumePart}`;
  }
  // fr
  const rolesPart = roleTokens.length > 0
    ? `Les internautes formulent cette recherche sous différentes variantes : ${formatList(roleTokens, 'ou')}.`
    : `Ce cluster ne contient pas de synonymes consolidés.`;
  const regionPart = region
    ? ` Le volume principal provient de la zone de ${cap(region)}, bassin de référence pour les frontaliers italiens.`
    : '';
  const variantPart = variantQueries.length > 0
    ? ` Parmi les ${variantCount} requêtes regroupées, les variantes les plus typiques sont : « ${variantQueries.join(' », « ')} ».`
    : ` Cette page regroupe ${variantCount} requêtes apparentées.`;
  const volumePart = impressions > 0
    ? ` D'après Google Search Console, le cluster a enregistré ${impressions.toLocaleString('fr-CH')} impressions et ${clicks.toLocaleString('fr-CH')} clics dans le dernier instantané.`
    : '';
  return `Signaux propres à ${q}. ${rolesPart}${regionPart}${variantPart}${volumePart}`;
}

/** Build an editorialized meta description per locale. */
function buildEditorialDescription(query: string, locale: OrphanLandingLocale, editorial: string): string {
  const q = cap(query);
  const prefix: Record<OrphanLandingLocale, string> = {
    it: `${q} — `,
    en: `${q} — `,
    de: `${q} — `,
    fr: `${q} — `,
  };
  return (prefix[locale] + editorial).slice(0, 155);
}

async function loadLocaleStrings(rootDir: string, locale: OrphanLandingLocale): Promise<Record<string, string>> {
  const modPath = path.join(rootDir, 'services', 'locales', `${locale}-orphan-landings.ts`);
  // Plain regex parse — avoid bundling TS at build time.
  if (!fs.existsSync(modPath)) return {};
  const src = fs.readFileSync(modPath, 'utf-8');
  const entries: Record<string, string> = {};
  // Very conservative: matches  'key': "value" or 'key': 'value' lines.
  const re = /'([^']+)':\s*'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    entries[m[1]] = m[2].replace(/\\'/g, "'").replace(/\\n/g, '\n');
  }
  return entries;
}

function jobLocalizedUrl(job: OrphanCountableJob, locale: OrphanLandingLocale): string {
  const section: Record<OrphanLandingLocale, string> = {
    it: 'cerca-lavoro-ticino',
    en: 'find-jobs-ticino',
    de: 'jobs-im-tessin',
    fr: 'trouver-emploi-tessin',
  };
  const prefix = ORPHAN_LANDING_LOCALE_PREFIX[locale];
  const slug = job.slugByLocale?.[locale] || job.slug || '';
  const rel = `${prefix}/${section[locale]}/${slug}/`.replace(/\/+/g, '/');
  return `${BASE_URL}${rel}`;
}

function jobLocalizedTitle(job: OrphanCountableJob, locale: OrphanLandingLocale): string {
  return job.titleByLocale?.[locale] || job.title || '';
}

interface RenderedPageResult {
  /** Canonical URL path (trailing slash). */
  urlPath: string;
  /** Full HTML document. */
  html: string;
  /** Word count of body content (excluding tags). */
  wordCount: number;
  /** Number of matching jobs rendered. */
  matchingJobsCount: number;
  /** Whether this page should be indexed. */
  indexable: boolean;
}

function renderPage(opts: {
  cluster: OrphanQueryCluster;
  matchingJobs: OrphanCountableJob[];
  strings: Record<string, string>;
  dateStamp: string;
  knownSlugsByLocale: Map<OrphanLandingLocale, Set<string>>;
  /** dist directory for entry-asset resolution. Omit in tests. */
  distDir?: string;
}): RenderedPageResult {
  const { cluster, matchingJobs, strings, dateStamp, knownSlugsByLocale, distDir } = opts;
  const locale = cluster.locale;
  const urlPath = buildOrphanLandingPath(locale, cluster.canonicalSlug);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  const t = (key: string, fallback = ''): string => strings[key] || fallback;

  // Alternates: only link to other locales that actually have the same slug
  // in the clusters set (avoids fake hreflang). audit-hreflang requires
  // either ZERO entries or the full 4-locale cluster + x-default. If some
  // locales are missing a translation, skip hreflang entirely and rely on
  // <link rel="canonical"> to tell Google this is a single-locale page.
  const itSet = knownSlugsByLocale.get('it');
  const itHasSlug = Boolean(itSet && itSet.has(cluster.canonicalSlug));
  const availableAlts = ORPHAN_LANDING_LOCALES.filter((alt) => {
    if (alt === locale) return true;
    const set = knownSlugsByLocale.get(alt);
    return Boolean(set && set.has(cluster.canonicalSlug));
  });
  const hasFullCluster = ORPHAN_LANDING_LOCALES.every((alt) => availableAlts.includes(alt));
  const xDefaultHref = itHasSlug
    ? `${BASE_URL}${buildOrphanLandingPath('it', cluster.canonicalSlug)}`
    : canonicalUrl;
  const alternates = hasFullCluster
    ? [
      ...ORPHAN_LANDING_LOCALES.map((alt) => {
        if (alt === locale) {
          return `    <link rel="alternate" hreflang="${alt}" href="${canonicalUrl}">`;
        }
        const altPath = buildOrphanLandingPath(alt, cluster.canonicalSlug);
        return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}">`;
      }),
      `    <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`,
    ].join('\n')
    : '';

  const jobBoardRoot: Record<OrphanLandingLocale, string> = {
    it: '/cerca-lavoro-ticino/',
    en: '/en/find-jobs-ticino/',
    de: '/de/jobs-im-tessin/',
    fr: '/fr/trouver-emploi-tessin/',
  };

  const editorialFam = pickEditorialFamily(cluster);
  const editorialBody = t(editorialKey(editorialFam),
    'Swiss cross-border job market: competitive wages, withholding tax, mandatory health insurance, and 13th-month pay. The 2026 Cross-Border Workers Agreement applies within 20 km of the border.',
  );
  const genericBody = t('orphanLanding.editorialGeneric',
    'The Swiss labour market offers attractive economic and legal conditions for Italian cross-border workers.',
  );

  // Stats for the editorial block
  const salaries: number[] = matchingJobs
    .map((j) => Number(j.salaryMin || 0))
    .filter((n) => n >= 20000 && n <= 300000);
  const medianSalary = median(salaries);
  const topEmployers = topCounts(matchingJobs.map((j) => j.company), 5);
  const topCities = topCounts(matchingJobs.map((j) => j.addressLocality || j.location), 3);

  // Similar queries
  const similar = cluster.queries.slice(0, 15);

  // Job cards — SPA-matching markup via shared renderer
  const cardItems: JobCardListItem[] = matchingJobs.slice(0, 15).map((j) => {
    // Force a localized title onto a shallow copy so the shared renderer
    // (which prefers titleByLocale[locale] then job.title) picks up the
    // orphan-landing fallback ("Posizione aperta") when both are empty.
    const localizedTitle =
      jobLocalizedTitle(j, locale) || t('orphanLanding.openPosition', 'Posizione aperta');
    const enrichedJob: JobCardJob = {
      ...(j as unknown as JobCardJob),
      title: localizedTitle,
      titleByLocale: { ...(j as JobCardJob).titleByLocale, [locale]: localizedTitle },
    };
    return {
      job: enrichedJob,
      href: jobLocalizedUrl(j, locale),
    };
  });
  const jobCards = renderJobCardListHtml(cardItems, { locale });

  const similarList = similar.map((q) => `<li style="margin:4px 0"><a href="${esc(jobBoardRoot[locale])}" style="${LINK_ACCENT_STYLE}">${esc(q.query)}</a> <span style="color:var(--color-subtle);font-size:12px">(${q.impressions})</span></li>`).join('');

  const employerList = topEmployers.length > 0
    ? topEmployers.map((e) => `<li>${esc(e.name)} (${e.count})</li>`).join('')
    : '';
  const cityList = topCities.length > 0
    ? topCities.map((c) => `<li>${esc(c.name)}</li>`).join('')
    : '';

  const itemListLd = matchingJobs.length > 0 ? JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: cluster.canonicalQuery,
    numberOfItems: matchingJobs.length,
    itemListElement: matchingJobs.slice(0, 15).map((j, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: jobLocalizedTitle(j, locale),
      url: jobLocalizedUrl(j, locale),
    })),
  }) : '';

  const h1ForLd = buildEditorialH1(cluster.canonicalQuery, locale);

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('orphanLanding.breadcrumbHome', 'Home'), item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: h1ForLd, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1ForLd,
    url: canonicalUrl,
    description: editorialBody.slice(0, 200),
    inLanguage: locale,
    isPartOf: { '@type': 'WebSite', url: BASE_URL, name: 'Frontaliere Ticino' },
    datePublished: dateStamp,
    dateModified: dateStamp,
  });

  // Decide indexability — <MIN_MATCHING_JOBS jobs → noindex (anti-doorway).
  const indexable = matchingJobs.length >= MIN_MATCHING_JOBS;

  const body = `
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(t('orphanLanding.breadcrumbHome', 'Home'))}</a>
      <span> / </span>
      <span>${esc(cluster.canonicalQuery)}</span>
    </nav>
    <header style="margin-bottom:20px">
      <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em">${esc(t('orphanLanding.updatedLabel', 'Updated'))} · ${esc(dateStamp)}</p>
      <h1 style="margin:0 0 14px;font-size:clamp(1.8rem,4vw,2.6rem);line-height:1.15">${esc(buildEditorialH1(cluster.canonicalQuery, locale))}</h1>
      <p style="margin:0 0 14px;color:var(--color-body);font-size:17px;line-height:1.6;max-width:860px">${esc(editorialBody)}</p>
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.65;max-width:860px">${esc(buildClusterSignalsParagraph(cluster, locale))}</p>
      <p style="margin:0;color:var(--color-subtle);line-height:1.65;max-width:860px">${esc(genericBody)}</p>
    </header>
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 24px">
      <div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(t('orphanLanding.medianSalary', 'Median salary'))}</div>
        <div style="${STAT_TILE_VALUE}">${medianSalary > 0 ? `CHF ${medianSalary.toLocaleString('de-CH')}` : esc(t('orphanLanding.medianSalaryNA', 'N/A'))}</div>
      </div>
      ${topEmployers.length > 0 ? `<div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(t('orphanLanding.topEmployers', 'Top employers'))}</div>
        <ul style="margin:8px 0 0;padding:0 0 0 18px;line-height:1.5;font-size:14px;color:var(--color-body)">${employerList}</ul>
      </div>` : ''}
      ${topCities.length > 0 ? `<div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(t('orphanLanding.topCities', 'Top cities'))}</div>
        <ul style="margin:8px 0 0;padding:0 0 0 18px;line-height:1.5;font-size:14px;color:var(--color-body)">${cityList}</ul>
      </div>` : ''}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px">${esc(t('orphanLanding.resultsLabel', 'Openings'))}</h2>
      ${matchingJobs.length > 0
        ? jobCards
        : `<p style="margin:0;padding:16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-heading)">${esc(t('orphanLanding.noResults', 'No openings.'))}</p>`}
    </section>
    ${similar.length > 1 ? `<section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px">${esc(t('orphanLanding.similarQueries', 'Similar searches'))}</h2>
      <ul style="margin:0;padding:0 0 0 18px">${similarList}</ul>
    </section>` : ''}
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px">${esc(t('orphanLanding.faqH2', 'FAQ'))}</h2>
      <details style="padding:12px 14px;border:1px solid var(--color-edge);border-radius:12px;margin-bottom:8px;background:var(--color-surface)">
        <summary style="font-weight:700;cursor:pointer">${esc(t('orphanLanding.faqQ1', ''))}</summary>
        <p style="margin:8px 0 0;color:var(--color-body);line-height:1.65">${esc(t('orphanLanding.faqA1', ''))}</p>
      </details>
      <details style="padding:12px 14px;border:1px solid var(--color-edge);border-radius:12px;margin-bottom:8px;background:var(--color-surface)">
        <summary style="font-weight:700;cursor:pointer">${esc(t('orphanLanding.faqQ2', ''))}</summary>
        <p style="margin:8px 0 0;color:var(--color-body);line-height:1.65">${esc(t('orphanLanding.faqA2', ''))}</p>
      </details>
    </section>
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(jobBoardRoot[locale])}" style="${CTA_PRIMARY_STYLE}">${esc(t('orphanLanding.ctaAllJobs', 'All jobs'))}</a>
      <a href="${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}" style="padding:12px 18px;border-radius:12px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-weight:700">${esc(t('orphanLanding.ctaCalculator', 'Calculate net salary'))}</a>
    </section>
    ${generateRelatedLinksBlock(locale, 'orphan_landing', { city: topCities[0]?.name })}
  `;

  const wordCount = countHtmlBodyWords(body);
  const robots = (indexable && wordCount >= MIN_INDEXABLE_WORDS)
    ? 'index,follow'
    : 'noindex,follow';

  const editorialH1 = buildEditorialH1(cluster.canonicalQuery, locale);
  const editorialPageTitle = buildEditorialTitle(cluster.canonicalQuery, locale);
  const description = buildEditorialDescription(cluster.canonicalQuery, locale, editorialBody);
  // Extra <head> tags (OG image + Twitter card) that buildSimplePage doesn't
  // emit by default — keeps the social-share preview identical to the
  // pre-shell-wrap HTML.
  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(editorialH1)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  const jsonLdScripts = [breadcrumbLd, webPageLd];
  if (itemListLd) jsonLdScripts.push(itemListLd);

  // Keep the existing inline-styled `<main>` so the static shell still renders
  // something readable before React hydrates. buildSimplePage wraps this in
  // `<div id="root">` with `skipMainWrap: true` to avoid nested <main>.
  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">
        ${body}
        <section style="margin-top:32px" aria-label="advertisement">
          ${adSlotHtml('JOBLIST_END_MULTIPLEX')}
        </section>
      </article>`;

  const html = buildSeoPageHtml({
    locale,
    title: editorialPageTitle,
    description,
    canonicalUrl,
    robots,
    ogType: 'website',
    ogLocale: ORPHAN_LANDING_OG_LOCALE[locale],
    hreflangHtml: alternates,
    extraHeadHtml: extraHead,
    jsonLdScripts,
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
  });

  return {
    urlPath,
    html,
    wordCount,
    matchingJobsCount: matchingJobs.length,
    indexable: indexable && wordCount >= MIN_INDEXABLE_WORDS,
  };
}

export interface OrphanLandingBuildSummary {
  clustersConsidered: number;
  pagesGenerated: number;
  pagesIndexable: number;
  routes: OrphanLandingRoute[];
}

export function orphanQueryLandingPlugin(rootDir: string): Plugin {
  return {
    name: 'orphan-query-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_ORPHAN_LANDINGS === '1') {
        console.log('\x1b[36m[orphan-query-landings]\x1b[0m skipped (SKIP_ORPHAN_LANDINGS=1)');
        return;
      }

      const distDir = path.resolve(rootDir, 'dist');
      const clustersPath = path.join(rootDir, 'data', 'gsc-orphan-queries-clusters.json');

      if (!fs.existsSync(clustersPath)) {
        console.warn(
          '\x1b[33m[orphan-query-landings]\x1b[0m clusters file missing at data/gsc-orphan-queries-clusters.json — run scripts/cluster-orphan-queries.mjs first. Skipping (soft).',
        );
        return;
      }

      let parsed: OrphanQueryClustersFile | null = null;
      try {
        parsed = JSON.parse(fs.readFileSync(clustersPath, 'utf-8')) as OrphanQueryClustersFile;
      } catch (err) {
        console.warn('\x1b[33m[orphan-query-landings]\x1b[0m failed to parse clusters file:', err);
        return;
      }
      if (!parsed || !Array.isArray(parsed.clusters) || parsed.clusters.length === 0) {
        console.log('\x1b[36m[orphan-query-landings]\x1b[0m 0 clusters in file — nothing to generate');
        return;
      }

      const maxEnv = Number(process.env.MAX_ORPHAN_LANDINGS || '');
      const maxLandings = Number.isFinite(maxEnv) && maxEnv > 0 ? Math.floor(maxEnv) : DEFAULT_MAX_LANDINGS;

      const jobs = loadAllJobs(rootDir);
      console.log(`\x1b[36m[orphan-query-landings]\x1b[0m loaded ${jobs.length} jobs, ${parsed.clusters.length} clusters (cap ${maxLandings})`);

      const clusters = parsed.clusters.slice(0, maxLandings);

      // Build locale → set-of-slugs map for hreflang decisions.
      const knownSlugsByLocale = new Map<OrphanLandingLocale, Set<string>>();
      for (const loc of ORPHAN_LANDING_LOCALES) knownSlugsByLocale.set(loc, new Set<string>());
      for (const c of clusters) {
        const set = knownSlugsByLocale.get(c.locale);
        if (set) set.add(c.canonicalSlug);
      }

      const localeStrings: Record<OrphanLandingLocale, Record<string, string>> = {
        it: await loadLocaleStrings(rootDir, 'it'),
        en: await loadLocaleStrings(rootDir, 'en'),
        de: await loadLocaleStrings(rootDir, 'de'),
        fr: await loadLocaleStrings(rootDir, 'fr'),
      };

      const collector = new WriteCollector({ distDir });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapEntries: string[] = [];
      const routes: OrphanLandingRoute[] = [];
      let pagesGenerated = 0;
      let pagesIndexable = 0;

      for (const cluster of clusters) {
        const matching = filterMatchingJobs(jobs, cluster, 15);
        const render = renderPage({
          cluster,
          matchingJobs: matching,
          strings: localeStrings[cluster.locale] || {},
          dateStamp,
          knownSlugsByLocale,
          distDir,
        });

        // Enforce quality gates. We still WRITE the page (so existing
        // crawled URLs get something back) but we mark it noindex and
        // keep it out of the sitemap when it fails either gate.
        const indexPath = path.join(distDir, render.urlPath, 'index.html');
        const flatPath = path.join(distDir, render.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, render.html);
        collector.add(flatPath, render.html);

        routes.push({
          locale: cluster.locale,
          slug: cluster.canonicalSlug,
          path: render.urlPath,
        });
        pagesGenerated++;

        if (render.indexable) {
          pagesIndexable++;
          sitemapEntries.push(
            `  <url>\n    <loc>${BASE_URL}${render.urlPath}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
          );
        }
      }

      // Write dedicated sitemap + patch master sitemap index.
      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
        try {
          fs.mkdirSync(distDir, { recursive: true });
          fs.writeFileSync(path.join(distDir, 'sitemap-orphan-landings.xml'), sitemapXml, 'utf-8');

          const masterSitemap = path.join(distDir, 'sitemap.xml');
          if (fs.existsSync(masterSitemap)) {
            let idx = fs.readFileSync(masterSitemap, 'utf-8');
            if (!idx.includes('sitemap-orphan-landings.xml')) {
              idx = idx.replace(
                '</sitemapindex>',
                `  <sitemap>\n    <loc>${BASE_URL}/sitemap-orphan-landings.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
              );
            } else {
              idx = idx.replace(
                /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-orphan-landings\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
                `$1${dateStamp}$2`,
              );
            }
            fs.writeFileSync(masterSitemap, idx, 'utf-8');
          }
        } catch (err) {
          console.warn('\x1b[33m[orphan-query-landings]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[orphan-query-landings]\x1b[0m Generated ${pagesGenerated} pages (${pagesIndexable} indexable, ${pagesGenerated - pagesIndexable} noindex) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    },
  };
}

/** Re-export routing data shape for the router. */
export type { OrphanLandingRoute, OrphanLandingLocale };

/**
 * Exported for duplicate-body tests — exercises the per-cluster distinguishing
 * content injected into the page body so that sparse clusters (few matching
 * jobs, `generic` editorial family) cannot collide on body hash.
 */
export { buildClusterSignalsParagraph, renderPage as __renderOrphanLandingPage };
