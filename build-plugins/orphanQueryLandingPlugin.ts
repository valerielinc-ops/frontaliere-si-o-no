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
  // in the clusters set (avoids fake hreflang).
  const alternates = ORPHAN_LANDING_LOCALES.map((alt) => {
    if (alt === locale) {
      return `    <link rel="alternate" hreflang="${alt}" href="${canonicalUrl}">`;
    }
    const set = knownSlugsByLocale.get(alt);
    if (!set || !set.has(cluster.canonicalSlug)) return '';
    const altPath = buildOrphanLandingPath(alt, cluster.canonicalSlug);
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}">`;
  }).filter(Boolean).join('\n');

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

  // Job cards
  const jobCards = matchingJobs.slice(0, 15).map((j) => {
    const title = jobLocalizedTitle(j, locale) || t('orphanLanding.openPosition', 'Posizione aperta');
    const company = String(j.company || '');
    const city = String(j.addressLocality || j.location || '');
    const href = jobLocalizedUrl(j, locale);
    const posted = String(j.postedDate || j.datePosted || '').slice(0, 10);
    return `<li style="padding:14px 16px;border:1px solid var(--surface-border,#e2e8f0);border-radius:14px;background:var(--surface,#ffffff);margin-bottom:10px;list-style:none">
  <a href="${esc(href)}" style="color:var(--text-base,#0f172a);text-decoration:none;display:block">
    <div style="font-weight:700;font-size:16px;line-height:1.35">${esc(title)}</div>
    <div style="margin-top:4px;color:var(--text-muted,#475569);font-size:14px">${esc(company)}${company && city ? ' · ' : ''}${esc(city)}</div>
    ${posted ? `<div style="margin-top:4px"><time datetime="${esc(posted)}" style="color:var(--text-subtle,#64748b);font-size:13px">${esc(posted)}</time></div>` : ''}
  </a>
</li>`;
  }).join('');

  const similarList = similar.map((q) => `<li style="margin:4px 0"><a href="${esc(jobBoardRoot[locale])}" style="color:var(--link,#1d4ed8);text-decoration:none">${esc(q.query)}</a> <span style="color:var(--text-muted,#475569);font-size:12px">(${q.impressions})</span></li>`).join('');

  const employerList = topEmployers.length > 0
    ? topEmployers.map((e) => `<li>${esc(e.name)} (${e.count})</li>`).join('')
    : '';
  const cityList = topCities.length > 0
    ? topCities.map((c) => `<li>${esc(c.name)}</li>`).join('')
    : '';

  const itemListLd = matchingJobs.length > 0 ? JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    inLanguage: locale,
    name: cluster.canonicalQuery,
    numberOfItems: matchingJobs.length,
    itemListElement: matchingJobs.slice(0, 15).map((j, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: jobLocalizedTitle(j, locale),
      url: jobLocalizedUrl(j, locale),
    })),
  }) : '';

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('orphanLanding.breadcrumbHome', 'Home'), item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: cluster.canonicalQuery, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: cluster.canonicalQuery,
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
    <nav style="margin:0 0 14px;font-size:13px;color:var(--text-muted,#475569)">
      <a href="${BASE_URL}/" style="color:var(--link,#1d4ed8);text-decoration:none">${esc(t('orphanLanding.breadcrumbHome', 'Home'))}</a>
      <span> / </span>
      <span>${esc(cluster.canonicalQuery)}</span>
    </nav>
    <header style="margin-bottom:20px">
      <p style="margin:0 0 8px;color:var(--accent,#4f46e5);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em">${esc(t('orphanLanding.updatedLabel', 'Updated'))} · ${esc(dateStamp)}</p>
      <h1 style="margin:0 0 14px;font-size:clamp(1.8rem,4vw,2.6rem);line-height:1.15">${esc(cluster.canonicalQuery)}</h1>
      <p style="margin:0 0 14px;color:var(--text-base,#0f172a);font-size:17px;line-height:1.6;max-width:860px">${esc(editorialBody)}</p>
      <p style="margin:0;color:var(--text-muted,#475569);line-height:1.65;max-width:860px">${esc(genericBody)}</p>
    </header>
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 24px">
      <div style="padding:16px;border-radius:16px;border:1px solid var(--surface-border,#e2e8f0);background:var(--surface,#ffffff)">
        <div style="font-size:12px;color:var(--text-muted,#475569);text-transform:uppercase;font-weight:700">${esc(t('orphanLanding.medianSalary', 'Median salary'))}</div>
        <div style="margin-top:6px;font-size:22px;font-weight:800;color:var(--text-base,#0f172a)">${medianSalary > 0 ? `CHF ${medianSalary.toLocaleString('de-CH')}` : esc(t('orphanLanding.medianSalaryNA', 'N/A'))}</div>
      </div>
      ${topEmployers.length > 0 ? `<div style="padding:16px;border-radius:16px;border:1px solid var(--surface-border,#e2e8f0);background:var(--surface,#ffffff)">
        <div style="font-size:12px;color:var(--text-muted,#475569);text-transform:uppercase;font-weight:700">${esc(t('orphanLanding.topEmployers', 'Top employers'))}</div>
        <ul style="margin:8px 0 0;padding:0 0 0 18px;line-height:1.5;font-size:14px;color:var(--text-base,#0f172a)">${employerList}</ul>
      </div>` : ''}
      ${topCities.length > 0 ? `<div style="padding:16px;border-radius:16px;border:1px solid var(--surface-border,#e2e8f0);background:var(--surface,#ffffff)">
        <div style="font-size:12px;color:var(--text-muted,#475569);text-transform:uppercase;font-weight:700">${esc(t('orphanLanding.topCities', 'Top cities'))}</div>
        <ul style="margin:8px 0 0;padding:0 0 0 18px;line-height:1.5;font-size:14px;color:var(--text-base,#0f172a)">${cityList}</ul>
      </div>` : ''}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px">${esc(t('orphanLanding.resultsLabel', 'Openings'))}</h2>
      ${matchingJobs.length > 0
        ? `<ul style="margin:0;padding:0">${jobCards}</ul>`
        : `<p style="margin:0;padding:16px;border-radius:12px;background:var(--surface-warn,#fef3c7);color:var(--text-warn,#78350f)">${esc(t('orphanLanding.noResults', 'No openings.'))}</p>`}
    </section>
    ${similar.length > 1 ? `<section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px">${esc(t('orphanLanding.similarQueries', 'Similar searches'))}</h2>
      <ul style="margin:0;padding:0 0 0 18px">${similarList}</ul>
    </section>` : ''}
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px">${esc(t('orphanLanding.faqH2', 'FAQ'))}</h2>
      <details style="padding:12px 14px;border:1px solid var(--surface-border,#e2e8f0);border-radius:12px;margin-bottom:8px;background:var(--surface,#ffffff)">
        <summary style="font-weight:700;cursor:pointer">${esc(t('orphanLanding.faqQ1', ''))}</summary>
        <p style="margin:8px 0 0;color:var(--text-base,#0f172a);line-height:1.65">${esc(t('orphanLanding.faqA1', ''))}</p>
      </details>
      <details style="padding:12px 14px;border:1px solid var(--surface-border,#e2e8f0);border-radius:12px;margin-bottom:8px;background:var(--surface,#ffffff)">
        <summary style="font-weight:700;cursor:pointer">${esc(t('orphanLanding.faqQ2', ''))}</summary>
        <p style="margin:8px 0 0;color:var(--text-base,#0f172a);line-height:1.65">${esc(t('orphanLanding.faqA2', ''))}</p>
      </details>
    </section>
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(jobBoardRoot[locale])}" style="padding:12px 18px;border-radius:12px;background:var(--accent,#4f46e5);color:#ffffff;text-decoration:none;font-weight:700">${esc(t('orphanLanding.ctaAllJobs', 'All jobs'))}</a>
      <a href="${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}" style="padding:12px 18px;border-radius:12px;background:var(--surface,#ffffff);border:1px solid var(--surface-border,#e2e8f0);color:var(--text-base,#0f172a);text-decoration:none;font-weight:700">${esc(t('orphanLanding.ctaCalculator', 'Calculate net salary'))}</a>
    </section>
    ${generateRelatedLinksBlock(locale, 'orphan_landing', { city: topCities[0]?.name })}
  `;

  const wordCount = countHtmlBodyWords(body);
  const robots = (indexable && wordCount >= MIN_INDEXABLE_WORDS)
    ? 'index,follow'
    : 'noindex,follow';

  const description = editorialBody.slice(0, 155);
  // Extra <head> tags (OG image + Twitter card) that buildSimplePage doesn't
  // emit by default — keeps the social-share preview identical to the
  // pre-shell-wrap HTML.
  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(cluster.canonicalQuery)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  const jsonLdScripts = [breadcrumbLd, webPageLd];
  if (itemListLd) jsonLdScripts.push(itemListLd);

  // Keep the existing inline-styled `<main>` so the static shell still renders
  // something readable before React hydrates. buildSimplePage wraps this in
  // `<div id="root">` with `skipMainWrap: true` to avoid nested <main>.
  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--text-base,#0f172a);background:var(--bg,#f8fafc)">
        ${body}
      </main>`;

  const html = buildSeoPageHtml({
    locale,
    title: `${cluster.canonicalQuery} | Frontaliere Ticino`,
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
