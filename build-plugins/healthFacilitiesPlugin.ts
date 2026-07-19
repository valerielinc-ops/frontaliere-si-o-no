/**
 * healthFacilitiesPlugin.ts — Vite build plugin for the health-facilities hub
 * (epic #4455 / sub #4457).
 *
 * For every committed facility (build-plugins/healthFacilitiesData.ts) it emits,
 * at the facility's canonical path in all 4 locales:
 *
 *   - a FULL indexable page  when the live job count ≥ HEALTH_FACILITY_MIN_JOBS
 *   - a noindex,follow BRIDGE when it dips below the floor this build
 *
 * Both live at the SAME URL, so the searchConsoleCompat self-map
 * (isHealthFacilityPath) always points at a real 200 target. Full pages carry
 * complete JobPosting structured data for the featured live jobs (all 9
 * mandatory fields per CLAUDE.md Non-Negotiable #3, in every locale) via the
 * canonical buildJobPostingSchema builder.
 *
 * Contract: apply:'build', enforce:'post', emit in closeBundle, pass distDir
 * through buildSeoPageHtml. Sitemap covers indexable pages only (bridges are
 * noindex). After flush it resolves `healthFacilitiesFlushed` with the emitted
 * above-floor facilities so healthFacilitiesLinksPlugin can wire the nursing
 * landings to them.
 */

import * as fs from 'node:fs';
import * as np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { WriteCollector } from './batchWrite';
import { formatUpdatedDate } from './shared/humanDate';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import { getCantonDisplayName, type CantonDisplayLocale } from './shared/cantonDisplay';
import { resolveCantonSection, type CantonLocale } from './shared/cantonSection';
import {
  H1_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  renderStatGrid,
  pickStatTileTone,
} from './shared/seoContentTokens';
import {
  renderJobCardListHtml,
  type JobCardJob,
} from './shared/jobCardHtml';
import { buildJobPostingSchema, type JobInput } from './shared/jobPostingSchema';
import {
  HEALTH_FACILITIES,
  HEALTH_FACILITY_LOCALES,
  HEALTH_FACILITY_MIN_JOBS,
  buildHealthFacilityPath,
  buildHealthFacilitySectionPath,
  type HealthFacilityLocale,
  type HealthFacilityRecord,
} from './healthFacilitiesData';
import {
  aggregateHealthFacilityJobs,
  type FacilitySnapshot,
  type FacilityFeaturedJob,
} from './healthFacilitiesJobsAggregate';
import {
  buildFacilityCopy,
  buildBridgeCopy,
  BREADCRUMB_HOME,
  SECTION_LABEL,
  ROLE_LABEL,
  CATEGORY_LABEL,
} from './healthFacilitiesCopy';
import type { HealthcareRole } from './healthFacilitiesMatch';
import {
  buildNursingLandingPath,
  type NursingLocale,
} from './nursingLandingsData';
import { resolveHealthFacilitiesFlushed, type EmittedFacility } from './shared/buildSignals';

const SITEMAP_FILE = 'sitemap-health-facilities.xml';

/** Italian province code → display name (from commuterOrigins). */
const PROVINCE_NAME: Record<string, string> = {
  CO: 'Como', VA: 'Varese', VB: 'Verbano-Cusio-Ossola', SO: 'Sondrio', BS: 'Brescia', VC: 'Vercelli',
};

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function commuterLabel(origins: readonly string[]): string {
  const names = origins.map((p) => PROVINCE_NAME[p]).filter(Boolean).slice(0, 2);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names[0]} e ${names[1]}`;
}

/** Absolute-prefixed canton job-board root path for a locale (trailing slash). */
function cantonJobBoardPath(locale: HealthFacilityLocale, canton: string): string {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/${resolveCantonSection(locale as CantonLocale, canton)}/`.replace(/\/{2,}/g, '/');
}

/** Detail URL for a featured job (canton-aware, locale slug fallback). */
function featuredJobPath(job: FacilityFeaturedJob, locale: HealthFacilityLocale): string {
  const canton = job.canton || 'TI';
  const slug = job.slugByLocale[locale] ?? job.slug;
  return `${cantonJobBoardPath(locale, canton)}${slug}/`.replace(/\/{2,}/g, '/');
}

function topRoles(snapshot: FacilitySnapshot): { role: HealthcareRole; count: number }[] {
  return (Object.entries(snapshot.roleCounts) as [HealthcareRole, number][])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => ({ role, count }));
}

/** Funnel + related links for a facility page (≥2 nursing/profession landings). */
function funnelLinks(
  locale: HealthFacilityLocale,
  facility: HealthFacilityRecord,
  cantonName: string,
): Array<{ href: string; label: string }> {
  const nl = locale as NursingLocale;
  const links: Array<{ href: string; label: string }> = [];
  if (facility.canton === 'TI') {
    links.push({ href: buildNursingLandingPath(nl, 'healthcare-ticino'), label: nursingLabel(locale, 'ticino') });
  }
  links.push({ href: buildNursingLandingPath(nl, 'nurses'), label: nursingLabel(locale, 'nurses') });
  links.push({ href: buildNursingLandingPath(nl, 'oss'), label: nursingLabel(locale, 'oss') });
  links.push({ href: cantonJobBoardPath(locale, facility.canton), label: boardLabel(locale, cantonName) });
  return links;
}

function nursingLabel(locale: HealthFacilityLocale, kind: 'ticino' | 'nurses' | 'oss'): string {
  const M = {
    it: { ticino: 'Lavoro sanitario in Ticino', nurses: 'Offerte per infermieri in Svizzera', oss: 'Offerte per OSS in Svizzera' },
    en: { ticino: 'Healthcare jobs in Ticino', nurses: 'Nursing jobs in Switzerland', oss: 'Care assistant jobs in Switzerland' },
    de: { ticino: 'Gesundheitsjobs im Tessin', nurses: 'Pflegejobs in der Schweiz', oss: 'Betreuungsjobs in der Schweiz' },
    fr: { ticino: 'Emplois santé au Tessin', nurses: 'Emplois infirmiers en Suisse', oss: 'Emplois assistants en soins en Suisse' },
  } as const;
  return M[locale][kind];
}

function boardLabel(locale: HealthFacilityLocale, cantonName: string): string {
  switch (locale) {
    case 'en': return `All jobs in ${cantonName}`;
    case 'de': return `Alle Stellen im Kanton ${cantonName}`;
    case 'fr': return `Tous les emplois au canton ${cantonName}`;
    case 'it':
    default: return `Tutte le offerte nel Cantone ${cantonName}`;
  }
}

function toJobCard(job: FacilityFeaturedJob): JobCardJob {
  return {
    title: job.title,
    titleByLocale: job.titleByLocale,
    company: job.company,
    companyKey: job.companyKey ?? undefined,
    companyDomain: job.companyDomain ?? undefined,
    addressLocality: job.addressLocality ?? undefined,
    canton: job.canton ?? undefined,
    contract: job.contract ?? undefined,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    postedDate: job.postedDate ?? undefined,
    url: job.url ?? undefined,
  };
}

function toJobPostingInput(job: FacilityFeaturedJob): JobInput {
  return {
    id: job.id,
    slug: job.slug,
    title: job.title,
    titleByLocale: job.titleByLocale,
    description: job.description,
    descriptionByLocale: job.descriptionByLocale,
    company: job.company,
    companyKey: job.companyKey,
    companyDomain: job.companyDomain,
    addressLocality: job.addressLocality,
    canton: job.canton,
    streetAddress: job.streetAddress,
    postalCode: job.postalCode,
    postedDate: job.postedDate,
    datePosted: job.datePosted,
    crawledAt: job.crawledAt,
    validThrough: job.validThrough,
    contract: job.contract,
    employmentType: job.employmentType,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.currency,
    sector: job.sector,
    category: job.category,
    url: job.url,
  };
}

interface RenderResult {
  html: string;
  wordCount: number;
}

function renderFacilityPage(
  locale: HealthFacilityLocale,
  facility: HealthFacilityRecord,
  snapshot: FacilitySnapshot,
  dateStamp: string,
  distDir: string,
): RenderResult {
  const cantonName = getCantonDisplayName(facility.canton, locale as CantonDisplayLocale);
  const roles = topRoles(snapshot);
  const copy = buildFacilityCopy(locale, {
    name: facility.name,
    category: facility.category,
    canton: facility.canton,
    cantonName,
    city: facility.city,
    liveCount: snapshot.liveCount,
    healthcareCount: snapshot.healthcareCount,
    fresh30Count: snapshot.fresh30Count,
    medianSalaryChf: snapshot.medianSalaryChf,
    siteCount: facility.sites.length,
    topRoles: roles,
    commuterLabel: commuterLabel(facility.commuterOrigins),
  });

  const canonicalPath = buildHealthFacilityPath(locale, facility.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const homeUrl = `${BASE_URL}/${locale === 'it' ? '' : `${locale}/`}`;
  const sectionUrl = `${BASE_URL}${buildHealthFacilitySectionPath(locale)}`;

  // Stat tiles.
  const medianStr = snapshot.medianSalaryChf
    ? `CHF ${new Intl.NumberFormat(locale === 'it' ? 'it-CH' : `${locale}-CH`, { maximumFractionDigits: 0 }).format(snapshot.medianSalaryChf)}`
    : copy.noSalary;
  const tiles = renderStatGrid([
    { label: copy.tileOpenings, value: String(snapshot.liveCount), tone: pickStatTileTone('openings', snapshot.liveCount) },
    { label: copy.tileMedian, value: medianStr, tone: 'accent' },
    { label: copy.tileFresh, value: String(snapshot.fresh30Count), tone: pickStatTileTone('fresh', snapshot.fresh30Count) },
  ]);

  // Featured jobs.
  const cardItems = snapshot.featured.map((j) => ({ job: toJobCard(j), href: featuredJobPath(j, locale) }));
  const emptyHtml = `<p class="s-card" style="color:var(--color-subtle);font-size:14px;margin:0">${esc(copy.featuredEmpty)}</p>`;
  const listHtml = renderJobCardListHtml(cardItems, { locale, emptyStateHtml: emptyHtml });
  const boardHref = cantonJobBoardPath(locale, facility.canton);
  const featuredSection = `<section class="mt-6"><h2 style="${headingStyle()}">${esc(copy.featuredTitle)}</h2>${listHtml}<p class="mt-3"><a href="${esc(boardHref)}" style="${LINK_ACCENT_STYLE};font-weight:700">${esc(copy.ctaJobsLabel)} →</a></p></section>`;

  // Roles list.
  const rolesSection = roles.length > 0
    ? `<section class="mt-6"><h2 style="${headingStyle()}">${esc(copy.rolesTitle)}</h2><ul class="list-none p-0 m-0 flex flex-wrap gap-2">${roles
        .map((r) => `<li class="s-card" style="padding:6px 12px;font-size:14px">${esc(ROLE_LABEL[locale][r.role])}: <strong>${r.count}</strong></li>`)
        .join('')}</ul></section>`
    : '';

  // Facility info.
  const sitesHtml = facility.sites.length > 1
    ? `<div class="mt-1 text-sm" style="color:var(--color-subtle)">${esc(copy.infoSites)}: ${esc(facility.sites.slice(0, 8).map(cleanSite).join(' · '))}</div>`
    : '';
  const infoSection = `<section class="mt-6"><h2 style="${headingStyle()}">${esc(copy.infoTitle)}</h2>
    <dl class="grid gap-1 text-sm">
      <div><dt class="inline font-semibold">${esc(copy.infoCategory)}:</dt> <dd class="inline">${esc(CATEGORY(locale, facility))}</dd></div>
      <div><dt class="inline font-semibold">${esc(copy.infoCanton)}:</dt> <dd class="inline">${esc(cantonName)}</dd></div>
      ${facility.city ? `<div><dt class="inline font-semibold">${esc(copy.infoCity)}:</dt> <dd class="inline">${esc(facility.city)}</dd></div>` : ''}
    </dl>${sitesHtml}
    ${copy.commuterSentence ? `<p class="mt-2 text-sm" style="color:var(--color-subtle)">${esc(copy.commuterSentence)}</p>` : ''}
  </section>`;

  // Funnel links (#4458 facility → funnel).
  const links = funnelLinks(locale, facility, cantonName);
  const funnelSection = `<section class="mt-6"><h2 style="${headingStyle()}">${esc(copy.funnelTitle)}</h2><ul class="list-none p-0 m-0 grid gap-1">${links
    .map((l) => `<li><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`)
    .join('')}</ul></section>`;

  // Prose + FAQ.
  const proseSection = copy.prose
    .map((s) => `<section class="mt-6"><h2 style="${headingStyle()}">${esc(s.title)}</h2>${s.paragraphs.map((p) => `<p class="mt-2" style="${LEDE_STYLE}">${esc(p)}</p>`).join('')}</section>`)
    .join('');
  const faqSection = `<section class="mt-6"><h2 style="${headingStyle()}">${esc(copy.faqTitle)}</h2>${copy.faqs
    .map((f) => `<details class="mt-2"><summary class="font-semibold cursor-pointer">${esc(f.question)}</summary><p class="mt-1" style="color:var(--color-body)">${esc(f.answer)}</p></details>`)
    .join('')}</section>`;

  const breadcrumb = `<nav aria-label="breadcrumb" class="text-sm" style="color:var(--color-subtle)">
    <a href="${esc(homeUrl)}" style="${LINK_ACCENT_STYLE}">${esc(BREADCRUMB_HOME[locale])}</a>
    <span aria-hidden="true"> › </span>
    <a href="${esc(sectionUrl)}" style="${LINK_ACCENT_STYLE}">${esc(SECTION_LABEL[locale])}</a>
    <span aria-hidden="true"> › </span>
    <span aria-current="page">${esc(facility.name)}</span>
  </nav>`;

  const header = `<header class="mt-3">
    <p style="${HERO_EYEBROW_STYLE}">${esc(copy.eyebrow)}</p>
    <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(copy.lede)}</p>
    <p class="text-sm font-medium mt-1" style="color:var(--color-accent)">${esc(updatedLabel(locale))} ${esc(formatUpdatedDate(dateStamp, locale))}</p>
  </header>`;

  const body = `<div class="max-w-3xl mx-auto px-4 py-6">
    ${breadcrumb}
    ${header}
    ${tiles}
    ${featuredSection}
    ${rolesSection}
    ${infoSection}
    ${funnelSection}
    ${proseSection}
    ${faqSection}
    ${endOfContentMultiplexHtml({ indexable: true })}
  </div>`;

  // ── JSON-LD ──
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: BREADCRUMB_HOME[locale], item: homeUrl },
      { '@type': 'ListItem', position: 2, name: SECTION_LABEL[locale], item: sectionUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  };
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: copy.faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: copy.h1,
    description: guardArticleJsonLdDescription(copy.metaDesc),
    inLanguage: locale,
    url: canonicalUrl,
    dateModified: dateStamp,
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: `${BASE_URL}/`,
      logo: imageObjectLd({ url: `${BASE_URL}/icons/icon-512x512.png`, width: 512, height: 512 }),
    },
  };
  // Non-Negotiable #3: full JobPosting per featured live job, every locale.
  const jobPostingLds = snapshot.featured.map((j) =>
    JSON.stringify(
      buildJobPostingSchema(toJobPostingInput(j), {
        locale,
        url: `${BASE_URL}${featuredJobPath(j, locale)}`,
        baseUrl: BASE_URL,
      }),
    ),
  );

  const hreflangPaths: HreflangPaths = {
    it: buildHealthFacilityPath('it', facility.slug),
    en: buildHealthFacilityPath('en', facility.slug),
    de: buildHealthFacilityPath('de', facility.slug),
    fr: buildHealthFacilityPath('fr', facility.slug),
  };

  const html = buildSeoPageHtml({
    locale,
    title: copy.metaTitle,
    description: copy.metaDesc,
    canonicalUrl,
    hreflangHtml: renderHreflangTags(hreflangPaths),
    bodyHtml: body,
    jsonLdScripts: [
      inlineScriptJson(breadcrumbLd),
      inlineScriptJson(faqLd),
      inlineScriptJson(articleLd),
      ...jobPostingLds,
    ],
    robots: 'index,follow',
    distDir,
  });

  return { html, wordCount: countHtmlBodyWords(html) };
}

function renderBelowFloorBridge(
  locale: HealthFacilityLocale,
  facility: HealthFacilityRecord,
  distDir: string,
): string {
  const cantonName = getCantonDisplayName(facility.canton, locale as CantonDisplayLocale);
  const copy = buildBridgeCopy(locale, facility.name, cantonName);
  const canonicalPath = buildHealthFacilityPath(locale, facility.slug);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const nursingHref = buildNursingLandingPath(locale as NursingLocale, facility.canton === 'TI' ? 'healthcare-ticino' : 'nurses');
  const boardHref = cantonJobBoardPath(locale, facility.canton);

  const body = `<div class="max-w-3xl mx-auto px-4 py-6">
    <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
    <p class="mt-3" style="${LEDE_STYLE}">${esc(copy.body)}</p>
    <p class="mt-4"><a href="${esc(nursingHref)}" style="${LINK_ACCENT_STYLE};font-weight:700">${esc(copy.ctaLabel)} →</a></p>
    <p class="mt-2"><a href="${esc(boardHref)}" style="${LINK_ACCENT_STYLE}">${esc(boardLabel(locale, cantonName))} →</a></p>
  </div>`;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: BREADCRUMB_HOME[locale], item: `${BASE_URL}/${locale === 'it' ? '' : `${locale}/`}` },
      { '@type': 'ListItem', position: 2, name: SECTION_LABEL[locale], item: `${BASE_URL}${buildHealthFacilitySectionPath(locale)}` },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  };

  const hreflangPaths: HreflangPaths = {
    it: buildHealthFacilityPath('it', facility.slug),
    en: buildHealthFacilityPath('en', facility.slug),
    de: buildHealthFacilityPath('de', facility.slug),
    fr: buildHealthFacilityPath('fr', facility.slug),
  };

  return buildSeoPageHtml({
    locale,
    title: copy.metaTitle,
    description: copy.metaDesc,
    canonicalUrl,
    hreflangHtml: renderHreflangTags(hreflangPaths),
    bodyHtml: body,
    jsonLdScripts: [inlineScriptJson(breadcrumbLd)],
    robots: 'noindex,follow',
    distDir,
  });
}

// ── small style/label helpers ──
function headingStyle(): string {
  return 'font-size:20px;font-weight:800;color:var(--color-heading);margin:0 0 4px';
}
function updatedLabel(locale: HealthFacilityLocale): string {
  return { it: 'Aggiornato il', en: 'Updated', de: 'Aktualisiert am', fr: 'Mis à jour le' }[locale];
}
function CATEGORY(locale: HealthFacilityLocale, f: HealthFacilityRecord): string {
  return CATEGORY_LABEL[locale][f.category];
}
function cleanSite(site: string): string {
  // Drop a shared brand prefix's parenthetical for a compact site chip.
  const m = site.match(/\(([^)]+)\)/);
  return m ? m[1] : site;
}

// ── Sitemap ──
function buildSitemap(paths: readonly string[], dateStamp: string): string {
  const urls = paths
    .map((p) => `  <url><loc>${BASE_URL}${p}</loc><lastmod>${dateStamp}</lastmod><changefreq>daily</changefreq></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  const idx = fs.readFileSync(indexPath, 'utf-8');
  if (idx.includes(SITEMAP_FILE)) {
    const patched = idx.replace(
      new RegExp(`(<loc>[^<]*${SITEMAP_FILE}</loc>\\s*<lastmod>)[^<]*(</lastmod>)`),
      `$1${dateStamp}$2`,
    );
    fs.writeFileSync(indexPath, patched, 'utf-8');
    return;
  }
  const entry = `  <sitemap><loc>${BASE_URL}/${SITEMAP_FILE}</loc><lastmod>${dateStamp}</lastmod></sitemap>\n`;
  const patched = idx.replace(/<\/sitemapindex>/, `${entry}</sitemapindex>`);
  fs.writeFileSync(indexPath, patched, 'utf-8');
}

export async function emitHealthFacilityPages(opts: {
  rootDir: string;
  distDir: string;
}): Promise<{ pagesWritten: number; bridgesWritten: number; emitted: EmittedFacility[] }> {
  const { rootDir, distDir } = opts;
  const dateStamp = new Date().toISOString().slice(0, 10);
  const snapshots = aggregateHealthFacilityJobs(rootDir);
  const collector = new WriteCollector({ distDir, pluginName: 'healthFacilitiesPlugin' });

  const sitemapPaths: string[] = [];
  const emitted: EmittedFacility[] = [];
  let pagesWritten = 0;
  let bridgesWritten = 0;

  for (const facility of HEALTH_FACILITIES) {
    const snapshot = snapshots.get(facility.slug);
    const liveCount = snapshot?.liveCount ?? 0;
    const aboveFloor = !!snapshot && liveCount >= HEALTH_FACILITY_MIN_JOBS;

    // All-or-nothing per facility across the 4 locales (mirrors the sibling
    // guard in professionCantonLandings.ts): render every locale FIRST, and
    // only ship the full pages when ALL of them clear the word gate. A single
    // locale dropping below MIN_INDEXABLE_WORDS while the others ship would
    // (1) dangle hreflang alternates pointing at a noindex bridge and
    // (2) let healthFacilitiesLinksPlugin (fed by `emitted`) link a URL that
    // is a bridge in that locale — violating the #4458 "never link
    // below-floor" invariant. Demoting the whole facility keeps hreflang,
    // sitemap and the emitted list mutually consistent.
    let renders: Array<{ locale: HealthFacilityLocale; html: string }> | null = null;
    if (aboveFloor && snapshot) {
      const rendered = HEALTH_FACILITY_LOCALES.map((locale) => ({
        locale,
        ...renderFacilityPage(locale, facility, snapshot, dateStamp, distDir),
      }));
      if (rendered.every((r) => r.wordCount >= MIN_INDEXABLE_WORDS)) {
        renders = rendered;
      }
    }

    if (renders && snapshot) {
      emitted.push({ slug: facility.slug, canton: facility.canton, name: facility.name, liveCount });
      for (const { locale, html } of renders) {
        const outDir = np.join(distDir, buildHealthFacilityPath(locale, facility.slug).replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        pagesWritten++;
        sitemapPaths.push(buildHealthFacilityPath(locale, facility.slug));
      }
    } else {
      for (const locale of HEALTH_FACILITY_LOCALES) {
        const outDir = np.join(distDir, buildHealthFacilityPath(locale, facility.slug).replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), renderBelowFloorBridge(locale, facility, distDir));
        bridgesWritten++;
      }
    }
  }

  await collector.flush();

  if (sitemapPaths.length > 0) {
    fs.writeFileSync(np.join(distDir, SITEMAP_FILE), buildSitemap(sitemapPaths, dateStamp), 'utf-8');
    patchSitemapIndex(distDir, dateStamp);
  }

  return { pagesWritten, bridgesWritten, emitted };
}

export function healthFacilitiesPlugin(rootDir: string): Plugin {
  return {
    name: 'health-facilities',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_HEALTH_FACILITIES === '1') {
        resolveHealthFacilitiesFlushed([]);
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        resolveHealthFacilitiesFlushed([]);
        return;
      }
      try {
        const res = await emitHealthFacilityPages({ rootDir, distDir });
        // eslint-disable-next-line no-console
        console.log(
          `\x1b[36m[health-facilities]\x1b[0m Emitted ${res.pagesWritten} pages, ${res.bridgesWritten} below-floor bridges (${res.emitted.length} facilities above floor).`,
        );
        resolveHealthFacilitiesFlushed(res.emitted);
      } catch (err) {
        resolveHealthFacilitiesFlushed([]);
        throw err;
      }
    },
  };
}
