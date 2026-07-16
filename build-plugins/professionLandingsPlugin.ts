/**
 * Profession landings (AE-3) — Vite build plugin, template B.
 *
 * Emits 40 static HTML pages (10 professions × 4 locales). The 2026-05 redesign
 * inverts the previous layout: live signal first (stat tiles + featured live
 * jobs + employer grid), long-form SEO prose at the bottom under an
 * "Approfondisci" heading. Designed mobile-first per CLAUDE.md regola #17 —
 * 75 % of traffic is mobile and the meaty content (offerte, stipendio) must
 * sit above the fold at ≤414 px.
 *
 *   IT canonical                             EN / DE / FR variants
 *   /lavoro-ticino-infermiere/               /en/jobs-ticino-nurse/ …
 *   /lavoro-ticino-operaio/                  /en/jobs-ticino-worker/ …
 *   … etc.
 *
 * Body order (template B, mobile-first):
 *   1. breadcrumb
 *   2. header (eyebrow · H1 · dense lede with 3 numbers)
 *   3. 3 stat tiles (open positions · median salary · fresh in 30 days)
 *   4. primary CTA → salary calculator (the killer-hook conversion path)
 *   5. featured live jobs (3 cards) + "see all" CTA
 *   6. employer grid (top 6, compact 2-col)
 *   7. ─── "Approfondisci" divider ───
 *   8. long-form prose H2 sections (existing 7 blocks)
 *   9. employers table (curated, with historical-employers framing note)
 *  10. sources · FAQ · related · final CTAs
 *
 * Live signal comes from professionJobsAggregate (build-time read of
 * data/jobs.json). PROFESSION_FACTS stays as the editorial authority for
 * typicalSalaryRange / CCL / recognition.
 *
 * Hub chrome: `hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' }`.
 * Sitemap: writes `dist/sitemap-professions.xml` (IT canonicals; EN/DE/FR
 * surface via hreflang). `sitemapAliasPlugin` auto-discovers the file.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { resolveProfessionLandingsFlushed } from './shared/buildSignals';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import {
  LINK_ACCENT_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  SMALL_HEADING_STYLE,
  renderStatGrid,
  pickStatTileTone,
} from './shared/seoContentTokens';
import { buildTitleWithBrand } from './shared/titleSuffix';
import { renderLandingHero } from './shared/landingHeroPersonality';
import { formatUpdatedDate } from './shared/humanDate';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import {
  PROFESSION_LOCALES,
  PROFESSION_IDS,
  buildProfessionLandingPath,
  PROFESSION_FACTS,
  type ProfessionLocale,
  type ProfessionId,
} from './professionLandingsData';
import {
  buildProfessionLandingCopy,
  buildProfessionLandingSections,
  buildProfessionLandingFaqs,
} from './professionLandingsCopy';
import {
  aggregateProfessionJobs,
  buildFeaturedJobUrl,
  buildJobBoardUrl,
  type FeaturedJob,
  type ProfessionJobsSnapshot,
} from './professionJobsAggregate';
import {
  renderJobCardListHtml,
  type JobCardJob,
} from './shared/jobCardHtml';
import {
  pickEmptyState,
  pickCtaAllJobs,
} from './shared/landingMicroCopy';
import {
  renderEmployerCardListHtml,
  type EmployerCardEmployer,
} from './shared/employerCardHtml';
import {
  buildSectorHubPath,
  type SectorHubKey,
} from './jobSectorLanding';

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Maps each profession landing to the job-board sector hub that lists its
 * openings (e.g. /lavoro-ticino-autista/ → /cerca-lavoro-ticino/autisti/).
 * The "see all N offers" CTA deep-links here instead of the generic job-board
 * root, so the visitor lands on a search already filtered to the profession.
 *
 * Every target is a crawlable, indexed sector-hub PATH (emitted unconditionally
 * by jobSectorPagesPlugin) — NOT a robots-disallowed `?q=` query URL — so it
 * stays internal-link/crawl safe (no rel="nofollow"; see no-internal-nofollow
 * test). A profession without a sound sector match falls back to the root.
 */
const PROFESSION_SECTOR_HUB: Partial<Record<ProfessionId, SectorHubKey>> = {
  infermiere: 'infermieri',
  operaio: 'industria',
  impiegato: 'commercio',
  ingegnere: 'ingegneri',
  educatore: 'educatori',
  autista: 'autisti',
  muratore: 'edilizia',
  cuoco: 'cuochi',
  cameriere: 'camerieri',
  elettricista: 'elettricisti',
  fisioterapista: 'fisioterapisti',
  farmacista: 'farmacisti',
  oss: 'oss',
  contabile: 'contabili',
  'assistente-sociale': 'educatori',
  macellaio: 'food',
  saldatore: 'industria',
  architetto: 'architetti',
  // psicologo / logopedista / ostetrica / assistente-dentale /
  // tecnico-radiologia / ottico-optometrista have no dedicated sector hub
  // yet → CTA falls back to the job-board root by design.
};

/**
 * CTA target for the "see all offers" link on a profession landing: the
 * profession's sector hub when mapped, else the generic job-board root.
 */
function buildProfessionAllJobsUrl(id: ProfessionId, locale: ProfessionLocale): string {
  const sector = PROFESSION_SECTOR_HUB[id];
  return sector ? buildSectorHubPath(locale, sector) : buildJobBoardUrl(locale);
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Convert inline markdown-style bold (**…**) to <strong> in copy paragraphs.
function inlineFormat(s: string): string {
  const escaped = esc(s);
  const bolded = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const linked = bolded.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    const safeUrl = url.replace(/&amp;/g, '&');
    return `<a class="s-6L_4jt" href="${esc(safeUrl)}" rel="noopener">${text}</a>`;
  });
  return linked;
}

const OG_LOCALE: Record<ProfessionLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const RELATED_LINKS: Record<ProfessionLocale, Array<{ href: string; label: string }>> = {
  it: [
    { href: '/cerca-lavoro-ticino/', label: 'Tutte le offerte lavoro in Ticino' },
    { href: '/calcola-stipendio/', label: 'Calcolatore stipendio frontaliero' },
    { href: '/statistiche/confronta-stipendi/', label: 'Confronto stipendi Italia vs Svizzera' },
    { href: '/guida-frontaliere/permessi-di-lavoro/', label: 'Guida al permesso G' },
    { href: '/guida-frontaliere/', label: 'Nuova legge frontalieri 2026' },
  ],
  en: [
    { href: '/en/find-jobs-ticino/', label: 'All Ticino job openings' },
    { href: '/en/calculate-salary/', label: 'Cross-border salary calculator' },
    { href: '/en/statistics/compare-salaries/', label: 'Italy vs Switzerland salary comparison' },
    { href: '/en/cross-border-guide/compare-permit-g-vs-b/', label: 'Permit G guide' },
    { href: '/en/new-cross-border-agreement-2026/', label: '2026 new cross-border tax agreement' },
  ],
  de: [
    { href: '/de/jobs-im-tessin/', label: 'Alle Tessin-Stellenangebote' },
    { href: '/de/gehalt-berechnen/', label: 'Grenzgänger-Gehaltsrechner' },
    { href: '/de/statistiken/gehaelter-vergleichen/', label: 'Lohnvergleich Italien vs Schweiz' },
    { href: '/de/grenzgaenger-ratgeber/arbeitsbewilligungen/', label: 'G-Bewilligungs-Leitfaden' },
    { href: '/de/grenzgaenger-ratgeber/', label: 'Neues Grenzgänger-Gesetz 2026' },
  ],
  fr: [
    { href: '/fr/trouver-emploi-tessin/', label: 'Toutes les offres Tessin' },
    { href: '/fr/calculer-salaire/', label: 'Calculateur salaire frontalier' },
    { href: '/fr/statistiques/comparer-salaires/', label: 'Comparaison salaires Italie vs Suisse' },
    { href: '/fr/guide-frontalier/comparer-permis-g-vs-b/', label: 'Guide du permis G' },
    { href: '/fr/guide-frontalier/', label: 'Nouvel accord frontalier 2026' },
  ],
};

/** Salary-calculator URL per locale (RELATED_LINKS index 1). */
const CALCULATOR_URL: Record<ProfessionLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
};

// ── Template B renderers ─────────────────────────────────────────────────────

interface CopyView {
  formatJobPosted: (daysAgo: number) => string;
  formatJobSalary: (min: number | null, max: number | null) => string;
  featuredJobsEmpty: string;
  featuredJobsTitle: string;
  featuredJobsCtaAllLabel: string;
  employerGridTitle: string;
}

function renderFeaturedJobs(
  id: ProfessionId,
  locale: ProfessionLocale,
  snapshot: ProfessionJobsSnapshot,
  copy: CopyView,
): string {
  const items = snapshot.featured.map((j) => ({
    job: {
      title: j.title,
      titleByLocale: j.titleByLocale,
      company: j.company,
      companyKey: j.companyKey ?? undefined,
      companyDomain: j.companyDomain ?? undefined,
      addressLocality: j.addressLocality ?? j.city,
      canton: j.canton ?? undefined,
      contract: j.contract ?? undefined,
      salaryMin: j.salaryMin,
      salaryMax: j.salaryMax,
      postedDate: j.postedDate,
      url: j.url ?? undefined,
    } satisfies JobCardJob,
    href: buildFeaturedJobUrl(j, locale),
  }));
  const emptyHtml = `<p class="s-card" style="color:var(--color-subtle);font-size:14px;margin:0">${esc(pickEmptyState(id, locale))}</p>`;
  const listHtml = renderJobCardListHtml(items, {
    locale,
    emptyStateHtml: emptyHtml,
  });
  // Link the "see all N offers" CTA to the profession's sector hub
  // (e.g. /cerca-lavoro-ticino/autisti/) so the visitor lands on a job-board
  // search already filtered to the profession, not the generic root. The hub
  // is a crawlable, indexed PATH — NOT a `?q=` keyword deep-link: robots.txt
  // disallows `/*?q=*`, so an internal `?q=` link is a "disallowed outlink"
  // (SearchAtlas/GSC) and rel="nofollow" is banned on internal links
  // (tests/no-internal-nofollow.test.tsx). Falls back to root when the
  // profession has no mapped sector.
  const ctaHref = buildProfessionAllJobsUrl(id, locale);
  const ctaLabel = snapshot.featured.length > 0 && snapshot.liveCount > 0
    ? pickCtaAllJobs(id, locale, snapshot.liveCount)
    : (copy.featuredJobsCtaAllLabel ?? 'Vedi tutti gli annunci →');
  return `<section class="s-KZc0LQ">
    <h2 class="s-8dKmAe">${esc(copy.featuredJobsTitle)}</h2>
    ${listHtml}
    ${snapshot.featured.length > 0 ? `<a href="${esc(ctaHref)}" style="${LINK_ACCENT_STYLE};font-weight:700;font-size:15px;display:inline-block;margin-top:14px">${esc(ctaLabel)}</a>` : ''}
  </section>`;
}

function renderEmployerGrid(
  snapshot: ProfessionJobsSnapshot,
  id: ProfessionId,
  copy: CopyView,
  locale: ProfessionLocale,
): string {
  // Prefer live aggregate employers; fall back to PROFESSION_FACTS curated list
  // when the aggregate found < 3 (sparse profession in the dataset).
  const useAggregate = snapshot.topEmployers.length >= 3;
  const rows: ReadonlyArray<{ name: string; count: number | null }> = useAggregate
    ? snapshot.topEmployers.map((e) => ({ name: e.name, count: e.count }))
    : PROFESSION_FACTS[id].topEmployers.slice(0, 6).map((n) => ({ name: n, count: null }));

  if (rows.length === 0) return '';

  const items = rows.map((r) => ({
    employer: {
      name: r.name,
      openings: r.count ?? undefined,
    } satisfies EmployerCardEmployer,
    // Crawlable job-board root, never a robots-disallowed `?q=` URL
    // (rel="nofollow" banned on internal links — see no-internal-nofollow test).
    href: buildJobBoardUrl(locale),
  }));

  const listHtml = renderEmployerCardListHtml(items, {
    locale,
    variant: 'compact',
  });

  return `<section class="s-KZc0LQ">
    <h2 class="s-8dKmAe">${esc(copy.employerGridTitle)}</h2>
    ${listHtml}
  </section>`;
}

/** Exported for unit tests — builds minimal copy and delegates to renderEmployerGrid. */
export function renderProfessionEmployerGridForTest(
  id: ProfessionId,
  locale: ProfessionLocale,
  snapshot: { topEmployers: ReadonlyArray<{ name: string; count: number }> },
): string {
  const copy: CopyView = {
    formatJobPosted: () => '',
    formatJobSalary: () => '',
    featuredJobsEmpty: '',
    featuredJobsTitle: '',
    featuredJobsCtaAllLabel: '',
    employerGridTitle: 'Chi assume in Ticino',
  };
  return renderEmployerGrid(snapshot as ProfessionJobsSnapshot, id, copy, locale);
}

// ── Long-form (legacy below-the-fold) renderers ──────────────────────────────

interface RenderResult {
  urlPath: string;
  html: string;
  wordCount: number;
}

function renderSection(title: string, paragraphs: string[]): string {
  const ps = paragraphs
    .map(
      (p) =>
        `<p class="s-Poj6T0">${inlineFormat(p)}</p>`,
    )
    .join('');
  return `<section class="s-KZc0LQ"><h2 class="s-BEjFo9">${esc(title)}</h2>${ps}</section>`;
}

function renderEmployersTable(
  locale: ProfessionLocale,
  id: ProfessionId,
  headings: { employer: string; city: string; typicalRoles: string; salaryLabel: string },
  title: string,
  note: string,
): string {
  const facts = PROFESSION_FACTS[id];
  const rows = facts.topEmployers
    .map(
      (emp, i) => `
        <tr>
          <td class="s-tcl">${esc(emp)}</td>
          <td class="s-tcl">${esc(facts.topCities[i % facts.topCities.length])}</td>
        </tr>`,
    )
    .join('');
  return `<section class="s-KZc0LQ">
    <h2 class="s-zlWKhs">${esc(title)}</h2>
    <p class="text-sm text-subtle mt-1 mb-3">${esc(note)}</p>
    <div class="s-qS9-Q-">
      <table class="s-QbQwZ0">
        <thead>
          <tr>
            <th class="s-thd">${esc(headings.employer)}</th>
            <th class="s-thd">${esc(headings.city)}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderFaqBlock(faqs: Array<{ question: string; answer: string }>): string {
  return faqs
    .map(
      (f) => `
      <details class="s-RTovxW">
        <summary class="s-ZAbW3N">${esc(f.question)}</summary>
        <p class="s-XXXebZ">${inlineFormat(f.answer)}</p>
      </details>`,
    )
    .join('');
}

function renderSourcesBlock(id: ProfessionId, label: string): string {
  const facts = PROFESSION_FACTS[id];
  const items: Array<{ url: string; label: string }> = [
    { url: facts.recognitionAuthorityUrl, label: `${facts.recognitionAuthority}` },
    { url: facts.cclUrl, label: `${facts.cclReference} (SECO)` },
    {
      url: 'https://www.estv.admin.ch/it/imposta-alla-fonte',
      label: 'AFC — Imposta alla fonte',
    },
    { url: 'https://www.sem.admin.ch', label: 'SEM — Permessi di lavoro' },
  ];
  const lis = items
    .map(
      (it) =>
        `<li class="s-FakRZl"><a href="${esc(it.url)}" rel="noopener" style="${LINK_ACCENT_STYLE}">${esc(it.label)}</a></li>`,
    )
    .join('');
  // Replaces the previous border-left:4px accent stripe (banned pattern).
  return `<section class="s-card" style="margin:0 0 24px;max-width:860px">
    <p style="${SMALL_HEADING_STYLE};margin:0 0 10px">${esc(label)}</p>
    <ul class="s-KjHm8e">${lis}</ul>
  </section>`;
}

function renderRelatedLinks(locale: ProfessionLocale, label: string): string {
  const items = RELATED_LINKS[locale]
    .map(
      (l) =>
        `<li class="s-Pkexk_"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section class="s-KZc0LQ"><h2 class="s-zlWKhs">${esc(label)}</h2><ul class="s-Bidr8Y">${items}</ul></section>`;
}

function renderApprofondisciDivider(label: string): string {
  return `<div class="s-7V0OIo" role="separator" aria-label="${esc(label)}">
    <span class="s-EIg6N7" aria-hidden="true"></span>
    <span style="${SMALL_HEADING_STYLE};margin:0">${esc(label)}</span>
    <span class="s-EIg6N7" aria-hidden="true"></span>
  </div>`;
}

// ── Page assembly ────────────────────────────────────────────────────────────

function renderPage(opts: {
  locale: ProfessionLocale;
  id: ProfessionId;
  dateStamp: string;
  distDir?: string;
  snapshot: ProfessionJobsSnapshot;
}): RenderResult {
  const { locale, id, dateStamp, distDir, snapshot } = opts;
  const copy = buildProfessionLandingCopy(locale, id, {
    liveCount: snapshot.liveCount,
    fresh30Count: snapshot.fresh30Count,
  });
  const sections = buildProfessionLandingSections(locale, id);
  const faqs = buildProfessionLandingFaqs(locale, id);
  const facts = PROFESSION_FACTS[id];
  const urlPath = buildProfessionLandingPath(locale, id);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  // Hreflang
  const hreflangLines = PROFESSION_LOCALES.map((alt) => {
    const altPath = buildProfessionLandingPath(alt, id);
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}">`;
  });
  hreflangLines.push(
    `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildProfessionLandingPath('it', id)}">`,
  );
  const alternates = hreflangLines.join('\n');

  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const jobBoardUrl = `${BASE_URL}${buildJobBoardUrl(locale)}`;
  // Bottom primary CTA deep-links to the profession's sector hub (filtered
  // job-board search), same as the featured-jobs CTA — never the generic root.
  // The breadcrumb below intentionally keeps the root job board as parent
  // (position 2). Falls back to root when the profession has no mapped sector.
  const ctaJobsUrl = `${BASE_URL}${buildProfessionAllJobsUrl(id, locale)}`;
  const calculatorUrl = `${BASE_URL}${CALCULATOR_URL[locale]}`;

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbJobs, item: jobBoardUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  });

  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  });

  const articleLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: copy.h1,
    description: guardArticleJsonLdDescription(copy.description),
    image: `${BASE_URL}/og-image.png`,
    inLanguage: locale,
    url: canonicalUrl,
    datePublished: dateStamp,
    dateModified: dateStamp,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: `${BASE_URL}/` },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: `${BASE_URL}/`,
      logo: imageObjectLd({
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      }),
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  });

  // ItemList of the featured live openings (each with an absolute URL) —
  // richer than the previous curated-employer list and coherent with the
  // visible "Offerte in evidenza" section. Omitted entirely when empty.
  const featuredForLd = snapshot.featured.slice(0, 3);
  const itemListLd = featuredForLd.length > 0
    ? inlineScriptJson({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: copy.featuredJobsTitle,
        itemListOrder: 'https://schema.org/ItemListOrderAscending',
        numberOfItems: featuredForLd.length,
        itemListElement: featuredForLd.map((j, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `${BASE_URL}${buildFeaturedJobUrl(j, locale)}`,
        })),
      })
    : '';

  // ── Template B body ────────────────────────────────────────────────────
  const copyView: CopyView = {
    formatJobPosted: copy.formatJobPosted,
    formatJobSalary: copy.formatJobSalary,
    featuredJobsEmpty: copy.featuredJobsEmpty,
    featuredJobsTitle: copy.featuredJobsTitle,
    featuredJobsCtaAllLabel: copy.featuredJobsCtaAllLabel,
    employerGridTitle: copy.employerGridTitle,
  };

  const statTilesHtml = `<div class="seo-fade-in">${renderStatGrid([
    { label: copy.statTileLiveLabel, value: copy.statLiveValue, tone: pickStatTileTone('openings', snapshot.liveCount) },
    { label: copy.statTileSalaryLabel, value: copy.statSalaryValue, tone: pickStatTileTone('salary', facts.medianSalaryChf) },
    { label: copy.statTileFreshLabel, value: copy.statFreshValue, tone: pickStatTileTone('fresh', snapshot.fresh30Count) },
  ])}</div>`;

  const primaryCtaHtml = `<div class="s-KZc0LQ"><a href="${esc(calculatorUrl)}" class="s-cta">${esc(copy.primaryCtaLabel)} →</a></div>`;

  const featuredHtml = renderFeaturedJobs(id, locale, snapshot, copyView);
  const employerGridHtml = renderEmployerGrid(snapshot, id, copyView, locale);
  const dividerHtml = renderApprofondisciDivider(copy.approfondisciHeading);

  const sectionsHtml = sections.map((s) => renderSection(s.title, s.paragraphs)).join('');
  const employersTable = renderEmployersTable(
    locale,
    id,
    copy.tableHeadings,
    copy.employersTableTitle,
    copy.employersTableNote,
  );
  const faqHtml = renderFaqBlock(faqs);
  const relatedHtml = renderRelatedLinks(locale, copy.relatedLabel);
  const sourcesHtml = renderSourcesBlock(id, copy.sourcesLabel);

  const body = `
    <nav class="s-bcr">
      <a href="${esc(homeUrl)}" class="s-bcl">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(jobBoardUrl)}" class="s-bcl">${esc(copy.breadcrumbJobs)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    ${renderLandingHero(id, locale, {
      openings: snapshot.liveCount,
      // Same curated source as the salary stat tile (statSalaryValue), so the
      // hero lede and the tile agree by construction — the live aggregate
      // median is polluted by default-estimated salaries.
      medianSalary: facts.medianSalaryChf,
    }, copy.h1, copy.denseLede)}
    <p class="text-sm font-medium text-accent mt-1">${esc(copy.updatedLabel)} ${esc(formatUpdatedDate(dateStamp, locale))}</p>
    ${statTilesHtml}
    ${primaryCtaHtml}
    ${featuredHtml}
    ${employerGridHtml}
    ${dividerHtml}
    ${sectionsHtml}
    ${employersTable}
    ${sourcesHtml}
    <section class="s-KZc0LQ">
      <h2 class="s-BEjFo9">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    ${relatedHtml}
    <section class="s-p1QaOi">
      <a href="${esc(ctaJobsUrl)}" class="s-cta">${esc(copy.ctaJobs)}</a>
      <a class="s-eXgANZ" href="${esc(calculatorUrl)}">${esc(copy.ctaSimulator)}</a>
    </section>
    <section class="s-GCEyQg" aria-label="${esc(copy.h1)}">
      <p class="s-y8VKoI">${inlineFormat(copy.lede)}</p>
    </section>`;

  const bodyHtml = `<main class="s-it71Rt">${body}</main>`;

  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title: buildTitleWithBrand(copy.title),
    description: copy.description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: alternates,
    jsonLdScripts: [breadcrumbLd, faqLd, articleLd, ...(itemListLd ? [itemListLd] : [])],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
  });

  return { urlPath, html, wordCount };
}

// ── Sitemap ───────────────────────────────────────────────────────

function buildSitemapXml(
  entries: Array<{ canonical: string; alternates: string[] }>,
  today: string,
): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates
        .map(
          (a) =>
            `    <xhtml:link rel="alternate" hreflang="${a.split('|')[0]}" href="${a.split('|').slice(1).join('|')}" />`,
        )
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
    if (!idx.includes('sitemap-professions.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-professions.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-professions\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[profession-landings] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ──────────────────────────────────────────────────

export function professionLandingsPlugin(rootDir: string): Plugin {
  return {
    name: 'profession-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_PROFESSION_LANDINGS === '1') {
        console.log('\x1b[33m[profession-landings]\x1b[0m Skipped (SKIP_PROFESSION_LANDINGS=1)');
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      // `dateStamp` is fixed once per build and baked into JSON-LD +
      // sitemap <lastmod>.
      const dateStamp = new Date().toISOString().slice(0, 10);

      // Aggregate live jobs per profession once. Module-level cached.
      const snapshots = aggregateProfessionJobs(rootDir);

      const collector = new WriteCollector({
        distDir,
        pluginName: 'professionLandingsPlugin',
      });
      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];

      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const id of PROFESSION_IDS) {
        const alternates = PROFESSION_LOCALES.map(
          (alt) => `${alt}|${BASE_URL}${buildProfessionLandingPath(alt, id)}`,
        );
        alternates.push(`x-default|${BASE_URL}${buildProfessionLandingPath('it', id)}`);

        let itWasWritten = false;

        for (const locale of PROFESSION_LOCALES) {
          const rendered = renderPage({
            locale,
            id,
            dateStamp,
            distDir,
            snapshot: snapshots[id],
          });

          if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
            thinSkipped++;
            console.warn(
              `\x1b[33m[profession-landings]\x1b[0m ${locale}/${id} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — skipping`,
            );
            continue;
          }

          const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
          const flatPath = np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
          collector.add(indexPath, rendered.html);
          collector.add(flatPath, rendered.html);

          // Every locale gets its own reciprocal <loc> entry (all 4 carry the
          // same alternates set) — an IT-only push here would leave en/de/fr
          // as one-sided alternates, stripped by sanitizeSitemapHreflangReciprocity.
          // Non-IT pushes require the IT anchor itself to have been written
          // this run (PROFESSION_LOCALES starts with 'it', so itWasWritten is
          // settled before en/de/fr) — an unconditional push would leave a
          // dangling IT alternate when the IT render is itself thin-skipped.
          if (locale === 'it') {
            itWasWritten = true;
            sitemapEntries.push({ canonical: rendered.urlPath, alternates });
          } else if (itWasWritten) {
            sitemapEntries.push({ canonical: rendered.urlPath, alternates });
          }

          pagesWritten++;
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          const xml = buildSitemapXml(sitemapEntries, dateStamp);
          fs.mkdirSync(distDir, { recursive: true });
          const sitemapPath = np.join(distDir, 'sitemap-professions.xml');
          fs.writeFileSync(sitemapPath, xml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[profession-landings]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[profession-landings]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} skipped as thin) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );

      if (fs.existsSync(np.join(distDir, 'sitemap-professions.xml'))) {
        try {
          patchSitemapIndex(distDir, dateStamp);
        } catch (err) {
          console.warn('\x1b[33m[profession-landings]\x1b[0m sitemap-index patch failed:', err);
        }
      }

      resolveProfessionLandingsFlushed();
    },
  };
}

// Test-only export: allows tests/build-plugins/job-card-canonical-adoption.test.ts
// to verify the migrated renderer emits canonical job-card markers.
export function renderProfessionFeaturedJobsForTest(
  id: ProfessionId,
  locale: ProfessionLocale,
  snapshot: ProfessionJobsSnapshot,
): string {
  const copy = buildProfessionLandingCopy(locale, id, {
    liveCount: snapshot.liveCount,
    fresh30Count: snapshot.fresh30Count,
  });
  const copyView: CopyView = {
    formatJobPosted: copy.formatJobPosted,
    formatJobSalary: copy.formatJobSalary,
    featuredJobsEmpty: copy.featuredJobsEmpty,
    featuredJobsTitle: copy.featuredJobsTitle,
    featuredJobsCtaAllLabel: copy.featuredJobsCtaAllLabel,
    employerGridTitle: copy.employerGridTitle,
  };
  return renderFeaturedJobs(id, locale, snapshot, copyView);
}
