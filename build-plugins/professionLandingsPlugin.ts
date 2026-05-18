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
 *   9. salary band table + employers table
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
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CTA_PRIMARY_STYLE,
  CARD_STYLE,
  CARD_BODY_STYLE,
  CARD_PADDING_STYLE,
  LINK_ACCENT_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  SMALL_HEADING_STYLE,
  renderStatGrid,
  ICON_BUILDING_SVG,
} from './shared/seoContentTokens';
import { buildTitleWithBrand } from './shared/titleSuffix';
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

// ── Helpers ──────────────────────────────────────────────────────

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
    return `<a href="${esc(safeUrl)}" rel="noopener" style="color:var(--color-link);text-decoration:underline">${text}</a>`;
  });
  return linked;
}

const OG_LOCALE: Record<ProfessionLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
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

function pickJobTitle(job: FeaturedJob, locale: ProfessionLocale): string {
  return job.titleByLocale[locale] ?? job.title;
}

function renderFeaturedJobCard(
  job: FeaturedJob,
  locale: ProfessionLocale,
  copy: CopyView,
): string {
  const href = buildFeaturedJobUrl(job, locale);
  const title = pickJobTitle(job, locale);
  const subtitleParts: string[] = [];
  if (job.company) subtitleParts.push(job.company);
  if (job.city) subtitleParts.push(job.city);
  const subtitle = subtitleParts.join(' · ');
  const salary = copy.formatJobSalary(job.salaryMin, job.salaryMax);
  const posted = copy.formatJobPosted(job.daysAgo);

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
  locale: ProfessionLocale,
  snapshot: ProfessionJobsSnapshot,
  copy: CopyView,
): string {
  if (snapshot.featured.length === 0) {
    return `<section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(copy.featuredJobsTitle)}</h2>
      <p style="${CARD_STYLE};color:var(--color-subtle);font-size:14px;margin:0">${esc(copy.featuredJobsEmpty)}</p>
    </section>`;
  }
  const cards = snapshot.featured
    .map((j) => renderFeaturedJobCard(j, locale, copy))
    .join('');
  const ctaHref = buildJobBoardUrl(locale);
  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(copy.featuredJobsTitle)}</h2>
    <div style="display:grid;gap:12px;margin-bottom:14px">${cards}</div>
    <a href="${esc(ctaHref)}" style="${LINK_ACCENT_STYLE};font-weight:700;font-size:15px">${esc(copy.featuredJobsCtaAllLabel)}</a>
  </section>`;
}

function renderEmployerGrid(
  snapshot: ProfessionJobsSnapshot,
  id: ProfessionId,
  copy: CopyView,
): string {
  // Prefer live aggregate employers; fall back to PROFESSION_FACTS curated list
  // when the aggregate found < 3 (sparse profession in the dataset).
  const useAggregate = snapshot.topEmployers.length >= 3;
  const items: Array<{ name: string; count: number | null }> = useAggregate
    ? snapshot.topEmployers.map((e) => ({ name: e.name, count: e.count }))
    : PROFESSION_FACTS[id].topEmployers.slice(0, 6).map((n) => ({ name: n, count: null }));

  if (items.length === 0) return '';

  const cells = items
    .map(
      (e) => `<div style="display:flex;align-items:center;gap:10px;${CARD_PADDING_STYLE};${CARD_BODY_STYLE}">
        <span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:var(--color-surface-alt);color:var(--color-subtle);flex-shrink:0">${ICON_BUILDING_SVG}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;color:var(--color-heading);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.name)}</div>
        </div>
        ${e.count !== null ? `<div style="flex-shrink:0;font-weight:700;color:var(--color-accent);font-variant-numeric:tabular-nums">${e.count}</div>` : ''}
      </div>`,
    )
    .join('');

  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:700">${esc(copy.employerGridTitle)}</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${cells}</div>
  </section>`;
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
        `<p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:62ch">${inlineFormat(p)}</p>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="margin:0 0 12px;font-size:24px;color:var(--color-heading);font-weight:600">${esc(title)}</h2>${ps}</section>`;
}

function renderEmployersTable(
  locale: ProfessionLocale,
  id: ProfessionId,
  headings: { employer: string; city: string; typicalRoles: string; salaryLabel: string },
  title: string,
): string {
  const facts = PROFESSION_FACTS[id];
  const rows = facts.topEmployers
    .map(
      (emp, i) => `
        <tr>
          <td style="${TABLE_CELL_STYLE}">${esc(emp)}</td>
          <td style="${TABLE_CELL_STYLE}">${esc(facts.topCities[i % facts.topCities.length])}</td>
        </tr>`,
    )
    .join('');
  return `<section style="margin:0 0 28px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:600">${esc(title)}</h2>
    <div style="overflow-x:auto;max-width:860px">
      <table style="border-collapse:collapse;width:100%;background:var(--color-surface);border:1px solid var(--color-edge);border-radius:12px">
        <thead>
          <tr>
            <th style="${TABLE_HEAD_STYLE}">${esc(headings.employer)}</th>
            <th style="${TABLE_HEAD_STYLE}">${esc(headings.city)}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderSalaryBandTable(
  id: ProfessionId,
  salaryLabel: string,
  title: string,
): string {
  const facts = PROFESSION_FACTS[id];
  const [min, max] = facts.typicalSalaryRange;
  return `<section style="margin:0 0 28px;max-width:860px">
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:600">${esc(title)}</h2>
    <div style="${CARD_STYLE};padding:16px 18px">
      <p style="margin:0 0 6px;color:var(--color-subtle);font-size:13px">${esc(salaryLabel)}</p>
      <p style="margin:0;font-size:22px;font-weight:700;color:var(--color-heading)">CHF ${min.toLocaleString('en-CH')} &ndash; ${max.toLocaleString('en-CH')}</p>
      <p style="margin:6px 0 0;color:var(--color-subtle);font-size:12px">Mediana: CHF ${facts.medianSalaryChf.toLocaleString('en-CH')}</p>
    </div>
  </section>`;
}

function renderFaqBlock(faqs: Array<{ question: string; answer: string }>): string {
  return faqs
    .map(
      (f) => `
      <details style="margin:0 0 10px;padding:14px 16px;border:1px solid var(--color-edge);border-radius:12px;background:var(--color-surface)">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45">${esc(f.question)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.65">${inlineFormat(f.answer)}</p>
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
      url: 'https://www.estv.admin.ch/estv/it/home/imposta-federale-diretta/imposta-alla-fonte.html',
      label: 'AFC — Imposta alla fonte',
    },
    { url: 'https://www.sem.admin.ch', label: 'SEM — Permessi di lavoro' },
  ];
  const lis = items
    .map(
      (it) =>
        `<li style="margin:0 0 6px"><a href="${esc(it.url)}" rel="noopener" style="${LINK_ACCENT_STYLE}">${esc(it.label)}</a></li>`,
    )
    .join('');
  // Replaces the previous border-left:4px accent stripe (banned pattern).
  return `<section style="margin:0 0 24px;${CARD_STYLE};max-width:860px">
    <p style="${SMALL_HEADING_STYLE};margin:0 0 10px">${esc(label)}</p>
    <ul style="margin:0;padding:0 0 0 20px;color:var(--color-body);line-height:1.55;font-size:14px">${lis}</ul>
  </section>`;
}

function renderRelatedLinks(locale: ProfessionLocale, label: string): string {
  const items = RELATED_LINKS[locale]
    .map(
      (l) =>
        `<li style="margin:0 0 8px"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading);font-weight:600">${esc(label)}</h2><ul style="margin:0 0 0 20px;padding:0;color:var(--color-body);line-height:1.55;max-width:860px">${items}</ul></section>`;
}

function renderApprofondisciDivider(label: string): string {
  return `<div role="separator" aria-label="${esc(label)}" style="margin:36px 0 28px;display:flex;align-items:center;gap:14px;color:var(--color-subtle)">
    <span aria-hidden="true" style="flex:1;height:1px;background:var(--color-edge)"></span>
    <span style="${SMALL_HEADING_STYLE};margin:0">${esc(label)}</span>
    <span aria-hidden="true" style="flex:1;height:1px;background:var(--color-edge)"></span>
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
  const calculatorUrl = `${BASE_URL}${CALCULATOR_URL[locale]}`;

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbJobs, item: jobBoardUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  });

  const articleLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: copy.h1,
    description: copy.description,
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
  });

  const itemListLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: copy.employersTableTitle,
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    numberOfItems: facts.topEmployers.length,
    itemListElement: facts.topEmployers.map((emp, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Organization',
        name: emp,
        location: facts.topCities[i % facts.topCities.length],
      },
    })),
  });

  // ── Template B body ────────────────────────────────────────────────────
  const copyView: CopyView = {
    formatJobPosted: copy.formatJobPosted,
    formatJobSalary: copy.formatJobSalary,
    featuredJobsEmpty: copy.featuredJobsEmpty,
    featuredJobsTitle: copy.featuredJobsTitle,
    featuredJobsCtaAllLabel: copy.featuredJobsCtaAllLabel,
    employerGridTitle: copy.employerGridTitle,
  };

  const statTilesHtml = renderStatGrid([
    { label: copy.statTileLiveLabel, value: copy.statLiveValue, tone: 'success' },
    { label: copy.statTileSalaryLabel, value: copy.statSalaryValue, tone: 'accent' },
    { label: copy.statTileFreshLabel, value: copy.statFreshValue, tone: 'warning' },
  ]);

  const primaryCtaHtml = `<div style="margin:0 0 28px"><a href="${esc(calculatorUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(copy.primaryCtaLabel)} →</a></div>`;

  const featuredHtml = renderFeaturedJobs(locale, snapshot, copyView);
  const employerGridHtml = renderEmployerGrid(snapshot, id, copyView);
  const dividerHtml = renderApprofondisciDivider(copy.approfondisciHeading);

  const sectionsHtml = sections.map((s) => renderSection(s.title, s.paragraphs)).join('');
  const employersTable = renderEmployersTable(locale, id, copy.tableHeadings, copy.employersTableTitle);
  const salaryTable = renderSalaryBandTable(id, copy.tableHeadings.salaryLabel, copy.salaryTableTitle);
  const faqHtml = renderFaqBlock(faqs);
  const relatedHtml = renderRelatedLinks(locale, copy.relatedLabel);
  const sourcesHtml = renderSourcesBlock(id, copy.sourcesLabel);

  const body = `
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${esc(homeUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(jobBoardUrl)}" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbJobs)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    <header style="margin-bottom:20px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.eyebrow)} · ${esc(copy.updatedLabel)} ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(copy.h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(copy.denseLede)}</p>
    </header>
    ${statTilesHtml}
    ${primaryCtaHtml}
    ${featuredHtml}
    ${employerGridHtml}
    ${dividerHtml}
    <section style="margin:0 0 28px">
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:62ch;font-size:17px;font-style:italic">${inlineFormat(copy.lede)}</p>
    </section>
    ${sectionsHtml}
    ${salaryTable}
    ${employersTable}
    ${sourcesHtml}
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:24px;color:var(--color-heading);font-weight:600">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    ${relatedHtml}
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(jobBoardUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(copy.ctaJobs)}</a>
      <a href="${esc(calculatorUrl)}" style="padding:10px 16px;border-radius:10px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-weight:600">${esc(copy.ctaSimulator)}</a>
    </section>`;

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">${body}</main>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(copy.h1)}">
    <meta name="twitter:description" content="${esc(copy.description)}">`;

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
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, faqLd, articleLd, itemListLd],
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

          if (locale === 'it') {
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
