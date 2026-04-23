/**
 * Comparisons Hub (AE-7) — Vite build plugin.
 *
 * Emits one static HTML landing per locale (4 total) under the routes:
 *   IT:  /confronti-frontalieri/
 *   EN:  /en/cross-border-comparisons/
 *   DE:  /de/grenzgaenger-vergleich/
 *   FR:  /fr/comparaisons-frontaliers/
 *
 * Page body: intro (TL;DR) + 5 dense comparison tables (salary / tax /
 * healthcare / social benefits / cost of living) + 5-Q FAQ + related links.
 *
 * Structured data: Article + FAQPage + BreadcrumbList + DataDownload (for the
 * salary-aggregate CSV the annual-report plugin emits at
 * `/data/jobs-salary-aggregate.csv`). SpeakableSpecification points at the
 * TL;DR + the 5 table captions.
 *
 * Hub chrome: `confronti` hub with `health` active sub-tab (placeholder — the
 * page itself is the comparisons hub; any confronti sub-tab works for the
 * sub-nav bar; `health` keeps it semantically close to the content).
 *
 * Sitemap: writes `dist/sitemap-comparisons.xml` — `sitemapAliasPlugin`
 * auto-discovers any `sitemap-*.xml` and wires it into `sitemap.xml`.
 *
 * Routing: paths are registered as `staticOverlay` in `services/router.ts`
 * (see `COMPARISONS_HUB_ROUTES` + `parseComparisonsHubPath`). The SPA
 * suppresses its generic hub view on these paths so the static HTML body
 * (living outside `#root` via `seoContentOutsideRoot: true`) stays visible.
 *
 * Gate: SKIP_COMPARISONS_HUB=1 fast-exits the plugin for local builds only.
 * CI must always exercise it — exit 0 required.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
  LINK_ACCENT_STYLE,
} from './shared/seoContentTokens';
import { WriteCollector } from './batchWrite';
import {
  COMPARISONS_LOCALES,
  COMPARISONS_LOCALE_PREFIX,
  buildComparisonsHubPath,
  type ComparisonsLocale,
} from './comparisonsHubData';
import {
  aggregateSalaryBySector,
  aggregateLamalCantonMedians,
  type SalarySectorRow,
  type LamalCantonRow,
} from './comparisonsHubAggregate';
import { COMPARISONS_HUB_COPY, type ComparisonsHubCopy } from './comparisonsHubCopy';

// ── Helpers ──────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Preserve basic inline markup from citation strings like `[fonte: AFC](url)`. */
function mdLinks(s: string): string {
  return esc(s).replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, href) =>
      `<a href="${String(href).replace(/"/g, '&quot;')}" rel="nofollow" style="${LINK_ACCENT_STYLE};text-decoration:underline">${label}</a>`,
  );
}

const OG_LOCALE: Record<ComparisonsLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

const RELATED_LINKS: Record<ComparisonsLocale, Array<{ href: string; label: string }>> = {
  it: [
    { href: '/calcola-stipendio/', label: 'Calcolatore stipendio frontaliero' },
    { href: '/statistiche/confronta-stipendi/', label: 'Confronto stipendi Svizzera vs Italia' },
    { href: '/compara-servizi/confronta-casse-malati/', label: 'Confronto casse malati LAMal' },
    { href: '/compara-servizi/costo-della-vita/', label: 'Costo della vita Svizzera vs Italia' },
    { href: '/guida-frontaliere/nuova-legge-frontalieri-2026/', label: 'Nuova legge frontalieri 2026' },
    { href: '/tasse-svizzere-guida-frontaliere/', label: 'Guida tasse svizzere per frontalieri' },
  ],
  en: [
    { href: '/en/calculate-salary/', label: 'Cross-border salary calculator' },
    { href: '/en/statistics/compare-salaries/', label: 'Switzerland vs Italy salary comparison' },
    { href: '/en/service-comparison/compare-health-insurance/', label: 'LAMal health insurance comparison' },
    { href: '/en/service-comparison/cost-of-living/', label: 'Cost of living Switzerland vs Italy' },
    { href: '/en/cross-border-guide/new-frontalieri-law-2026/', label: '2026 cross-border workers law' },
  ],
  de: [
    { href: '/de/gehalt-berechnen/', label: 'Grenzgänger-Gehaltsrechner' },
    { href: '/de/statistiken/gehaelter-vergleichen/', label: 'Lohnvergleich Schweiz vs Italien' },
    { href: '/de/service-vergleich/krankenkassen-vergleichen/', label: 'KVG-Krankenkassen-Vergleich' },
    { href: '/de/service-vergleich/lebenshaltungskosten/', label: 'Lebenshaltungskosten CH vs IT' },
    { href: '/de/grenzgaenger-ratgeber/neues-grenzgaengergesetz-2026/', label: 'Neues Grenzgängergesetz 2026' },
  ],
  fr: [
    { href: '/fr/calculer-salaire/', label: 'Calculateur salaire frontalier' },
    { href: '/fr/statistiques/comparer-salaires/', label: 'Comparaison salaires Suisse vs Italie' },
    { href: '/fr/comparaison-services/comparer-caisses-maladie/', label: 'Comparaison caisses-maladie LAMal' },
    { href: '/fr/comparaison-services/cout-de-la-vie/', label: 'Coût de la vie Suisse vs Italie' },
    { href: '/fr/guide-frontalier/nouvelle-loi-frontaliers-2026/', label: 'Nouvelle loi frontaliers 2026' },
  ],
};

// ── Number formatting (locale-aware, deterministic) ──────────────

function fmtInt(n: number, locale: ComparisonsLocale): string {
  // Use the Swiss-German thousands separator (apostrophe) for CHF and
  // European dot/space for EUR — one common convention across locales.
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(Math.round(n));
  const s = abs.toString();
  // Thousand separator: apostrophe in IT/DE (Swiss convention), comma in EN,
  // space in FR.
  const sep = locale === 'en' ? ',' : locale === 'fr' ? ' ' : "'";
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function fmtRatio(r: number, locale: ComparisonsLocale): string {
  if (!Number.isFinite(r) || r <= 0) return '–';
  const rounded = Math.round(r * 100) / 100;
  return locale === 'en' ? rounded.toFixed(2) : rounded.toFixed(2).replace('.', ',');
}

// ── Table renderers ──────────────────────────────────────────────

function renderSalaryTable(copy: ComparisonsHubCopy, rows: readonly SalarySectorRow[], locale: ComparisonsLocale): string {
  const tbody = rows.length > 0
    ? rows
        .map(
          (r) =>
            `<tr>
              <td>${esc(r.sector)}</td>
              <td style="text-align:right">${fmtInt(r.count, locale)}</td>
              <td style="text-align:right">${fmtInt(r.medianCHF, locale)}</td>
              <td style="text-align:right">${fmtInt(r.estimatedItalyEUR, locale)}</td>
              <td style="text-align:right">${fmtRatio(r.ratio, locale)}</td>
            </tr>`,
        )
        .join('')
    : `<tr><td colspan="5" style="text-align:center;color:var(--color-subtle);padding:18px">—</td></tr>`;
  return `<figure style="margin:0 0 28px" data-speakable>
  <figcaption style="font-weight:700;margin:0 0 8px;color:var(--color-heading)">${esc(copy.tSalaryCaption)}</figcaption>
  <div style="overflow-x:auto;border:1px solid var(--color-edge);border-radius:12px">
    <table style="width:100%;border-collapse:collapse;min-width:640px;font-size:14px">
      <thead style="background:var(--color-surface-alt)">
        <tr>
          <th style="${TABLE_HEAD_STYLE};text-align:left">${esc(copy.tSalaryColSector)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tSalaryColObservations)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tSalaryColCh)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tSalaryColIt)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tSalaryColRatio)}</th>
        </tr>
      </thead>
      <tbody style="color:var(--color-body)">
        ${tbody.replace(/<td>/g, `<td style="${TABLE_CELL_STYLE}">`).replace(/<td style="text-align:right">/g, `<td style="${TABLE_CELL_STYLE};text-align:right">`)}
      </tbody>
    </table>
  </div>
  <p style="margin:10px 0 0;font-size:12px;color:var(--color-subtle);line-height:1.5">${mdLinks(copy.tSalaryFooter)}</p>
</figure>`;
}

function renderTaxTable(copy: ComparisonsHubCopy): string {
  const rows = copy.tTaxScenarios
    .map(
      (s) => `<tr>
        <td style="${TABLE_CELL_STYLE}">${esc(s.label)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right">${esc(s.chPct)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right">${esc(s.itPct)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right;font-weight:600">${esc(s.delta)}</td>
      </tr>`,
    )
    .join('');
  return `<figure style="margin:0 0 28px" data-speakable>
  <figcaption style="font-weight:700;margin:0 0 8px;color:var(--color-heading)">${esc(copy.tTaxCaption)}</figcaption>
  <div style="overflow-x:auto;border:1px solid var(--color-edge);border-radius:12px">
    <table style="width:100%;border-collapse:collapse;min-width:640px;font-size:14px">
      <thead style="background:var(--color-surface-alt)">
        <tr>
          <th style="${TABLE_HEAD_STYLE};text-align:left">${esc(copy.tTaxColScenario)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tTaxColChTotal)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tTaxColItTotal)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tTaxColNetDelta)}</th>
        </tr>
      </thead>
      <tbody style="color:var(--color-body)">${rows}</tbody>
    </table>
  </div>
  <p style="margin:10px 0 0;font-size:12px;color:var(--color-subtle);line-height:1.5">${mdLinks(copy.tTaxFooter)}</p>
</figure>`;
}

function renderHealthTable(copy: ComparisonsHubCopy, rows: readonly LamalCantonRow[], locale: ComparisonsLocale): string {
  const tbody = rows
    .map(
      (r) => `<tr>
        <td style="${TABLE_CELL_STYLE}">${esc(r.canton)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right">${fmtInt(r.medianMonthlyCHF, locale)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right">${fmtInt(r.annualCHF, locale)}</td>
      </tr>`,
    )
    .join('');
  return `<figure style="margin:0 0 28px" data-speakable>
  <figcaption style="font-weight:700;margin:0 0 8px;color:var(--color-heading)">${esc(copy.tHealthCaption)}</figcaption>
  <div style="overflow-x:auto;border:1px solid var(--color-edge);border-radius:12px">
    <table style="width:100%;border-collapse:collapse;min-width:520px;font-size:14px">
      <thead style="background:var(--color-surface-alt)">
        <tr>
          <th style="${TABLE_HEAD_STYLE};text-align:left">${esc(copy.tHealthColCanton)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tHealthColMonthly)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tHealthColAnnual)}</th>
        </tr>
      </thead>
      <tbody style="color:var(--color-body)">${tbody}</tbody>
    </table>
  </div>
  <p style="margin:10px 0 0;font-size:12px;color:var(--color-subtle);line-height:1.5">${mdLinks(copy.tHealthFooter)}</p>
  <p style="margin:8px 0 0;font-size:13px;color:var(--color-body);line-height:1.6">${mdLinks(copy.tHealthContext)}</p>
</figure>`;
}

function renderBenefitsTable(copy: ComparisonsHubCopy): string {
  const rows = copy.tBenefitsRows
    .map(
      (r) => `<tr>
        <td style="${TABLE_CELL_STYLE};font-weight:600;vertical-align:top">${esc(r.area)}</td>
        <td style="${TABLE_CELL_STYLE};vertical-align:top">${esc(r.ch)}</td>
        <td style="${TABLE_CELL_STYLE};vertical-align:top">${esc(r.it)}</td>
      </tr>`,
    )
    .join('');
  return `<figure style="margin:0 0 28px" data-speakable>
  <figcaption style="font-weight:700;margin:0 0 8px;color:var(--color-heading)">${esc(copy.tBenefitsCaption)}</figcaption>
  <div style="overflow-x:auto;border:1px solid var(--color-edge);border-radius:12px">
    <table style="width:100%;border-collapse:collapse;min-width:720px;font-size:14px">
      <thead style="background:var(--color-surface-alt)">
        <tr>
          <th style="${TABLE_HEAD_STYLE};text-align:left">${esc(copy.tBenefitsColArea)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:left">${esc(copy.tBenefitsColCh)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:left">${esc(copy.tBenefitsColIt)}</th>
        </tr>
      </thead>
      <tbody style="color:var(--color-body)">${rows}</tbody>
    </table>
  </div>
  <p style="margin:10px 0 0;font-size:12px;color:var(--color-subtle);line-height:1.5">${mdLinks(copy.tBenefitsFooter)}</p>
</figure>`;
}

function renderCostTable(copy: ComparisonsHubCopy): string {
  const rows = copy.tCostRows
    .map(
      (r) => `<tr>
        <td style="${TABLE_CELL_STYLE};vertical-align:top">${esc(r.item)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right;vertical-align:top">${esc(r.ch)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right;vertical-align:top">${esc(r.it)}</td>
      </tr>`,
    )
    .join('');
  return `<figure style="margin:0 0 28px" data-speakable>
  <figcaption style="font-weight:700;margin:0 0 8px;color:var(--color-heading)">${esc(copy.tCostCaption)}</figcaption>
  <div style="overflow-x:auto;border:1px solid var(--color-edge);border-radius:12px">
    <table style="width:100%;border-collapse:collapse;min-width:560px;font-size:14px">
      <thead style="background:var(--color-surface-alt)">
        <tr>
          <th style="${TABLE_HEAD_STYLE};text-align:left">${esc(copy.tCostColItem)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tCostColCh)}</th>
          <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tCostColIt)}</th>
        </tr>
      </thead>
      <tbody style="color:var(--color-body)">${rows}</tbody>
    </table>
  </div>
  <p style="margin:10px 0 0;font-size:12px;color:var(--color-subtle);line-height:1.5">${mdLinks(copy.tCostFooter)}</p>
</figure>`;
}

function renderFaqBlock(faqs: ComparisonsHubCopy['faqs']): string {
  return faqs
    .map(
      (f) => `
      <details style="margin:0 0 10px;padding:14px 16px;border:1px solid var(--color-edge);border-radius:12px;background:var(--color-surface)">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading);line-height:1.45">${esc(f.question)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.65">${mdLinks(f.answer)}</p>
      </details>`,
    )
    .join('');
}

function renderRelatedLinks(locale: ComparisonsLocale, label: string): string {
  const items = RELATED_LINKS[locale]
    .map(
      (l) =>
        `<li style="margin:0 0 8px"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="margin:0 0 12px;font-size:22px;color:var(--color-heading)">${esc(label)}</h2><ul style="margin:0 0 0 20px;padding:0;color:var(--color-body);line-height:1.55;max-width:860px">${items}</ul></section>`;
}

// ── Page rendering ───────────────────────────────────────────────

interface RenderResult {
  urlPath: string;
  html: string;
  wordCount: number;
}

function renderPage(opts: {
  locale: ComparisonsLocale;
  salaryRows: readonly SalarySectorRow[];
  lamalRows: readonly LamalCantonRow[];
  dateStamp: string;
  distDir?: string;
}): RenderResult {
  const { locale, salaryRows, lamalRows, dateStamp, distDir } = opts;
  const copy = COMPARISONS_HUB_COPY[locale];
  const urlPath = buildComparisonsHubPath(locale);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  // Hreflang
  const hreflangLines = COMPARISONS_LOCALES.map((alt) => {
    const altPath = buildComparisonsHubPath(alt);
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}">`;
  });
  hreflangLines.push(
    `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${buildComparisonsHubPath('it')}">`,
  );
  const alternates = hreflangLines.join('\n');

  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  // Parent hub for breadcrumb — the SPA "Confronti" tab.
  const confrontiSlug: Record<ComparisonsLocale, string> = {
    it: 'compara-servizi',
    en: 'service-comparison',
    de: 'service-vergleich',
    fr: 'comparaison-services',
  };
  const confrontiPrefix = COMPARISONS_LOCALE_PREFIX[locale];
  const hubParentUrl = `${BASE_URL}${confrontiPrefix}/${confrontiSlug[locale]}/`;

  // Tables
  const salaryTable = renderSalaryTable(copy, salaryRows, locale);
  const taxTable = renderTaxTable(copy);
  const healthTable = renderHealthTable(copy, lamalRows, locale);
  const benefitsTable = renderBenefitsTable(copy);
  const costTable = renderCostTable(copy);

  const tldrParas = copy.tldrParagraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(p)}</p>`,
    )
    .join('');

  const faqHtml = renderFaqBlock(copy.faqs);
  const relatedHtml = renderRelatedLinks(locale, copy.relatedTitle);

  const body = `
    <nav style="margin:0 0 14px;font-size:13px;color:var(--color-subtle)" aria-label="Breadcrumb">
      <a href="${esc(homeUrl)}" style="${LINK_ACCENT_STYLE}">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(hubParentUrl)}" style="${LINK_ACCENT_STYLE}">${esc(copy.breadcrumbHub)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    <header style="margin-bottom:24px">
      <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em">${esc(copy.updatedLabel)} · ${esc(dateStamp)}</p>
      <h1 style="margin:0 0 16px;font-size:clamp(1.9rem,4vw,2.8rem);line-height:1.15">${esc(copy.h1)}</h1>
    </header>
    <section style="margin:0 0 28px" data-speakable aria-label="TL;DR">
      <h2 style="margin:0 0 12px;font-size:24px;color:var(--color-heading)">${esc(copy.tldrTitle)}</h2>
      ${tldrParas}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 10px;font-size:22px;color:var(--color-heading)">${esc(copy.tSalaryCaption)}</h2>
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.salaryIntro)}</p>
      ${salaryTable}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 10px;font-size:22px;color:var(--color-heading)">${esc(copy.tTaxCaption)}</h2>
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.taxIntro)}</p>
      ${taxTable}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 10px;font-size:22px;color:var(--color-heading)">${esc(copy.tHealthCaption)}</h2>
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.healthIntro)}</p>
      ${healthTable}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 10px;font-size:22px;color:var(--color-heading)">${esc(copy.tBenefitsCaption)}</h2>
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.benefitsIntro)}</p>
      ${benefitsTable}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 10px;font-size:22px;color:var(--color-heading)">${esc(copy.tCostCaption)}</h2>
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.costIntro)}</p>
      ${costTable}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:24px;color:var(--color-heading)">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    <p style="margin:0 0 20px;color:var(--color-subtle);font-size:13px;line-height:1.55;max-width:860px">${esc(copy.disclaimer)}</p>
    ${relatedHtml}`;

  const bodyHtml = `<main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body);background:var(--color-surface-alt)">${body}</main>`;

  // ── Structured data ────────────────────────────────────────────
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    inLanguage: locale,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbHub, item: hubParentUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: copy.faqs.map((f) => ({
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
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
    abstract: copy.tldrParagraphs[0],
    speakable: {
      '@type': 'SpeakableSpecification',
      cssSelector: ['h1', '[data-speakable]', 'figcaption'],
    },
  });

  // DataDownload — links to the public salary CSV emitted by annualReportPlugin
  // (docs/SEO-FEATURES.md + annualReportPlugin.ts → /data/jobs-salary-aggregate.csv).
  const datasetLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: locale === 'it'
      ? 'Stipendi frontalieri Ticino — aggregato pubblico'
      : locale === 'en'
      ? 'Ticino cross-border salaries — public aggregate'
      : locale === 'de'
      ? 'Tessin Grenzgänger-Löhne — öffentlicher Aggregat'
      : 'Salaires frontaliers Tessin — agrégat public',
    description: copy.tSalaryFooter,
    url: canonicalUrl,
    inLanguage: locale,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    creator: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL },
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'text/csv',
        contentUrl: `${BASE_URL}/data/jobs-salary-aggregate.csv`,
      },
    ],
  });

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(copy.h1)}">
    <meta name="twitter:description" content="${esc(copy.description)}">`;

  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title: copy.title,
    description: copy.description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: alternates,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, faqLd, articleLd, datasetLd],
    bodyHtml,
    distDir,
    hubChrome: {
      hubKey: 'confronti',
      activeSubTab: 'health',
      hero: {
        title: copy.heroTitle,
        subtitle: copy.heroSubtitle,
        variant: 'green',
      },
    },
  });

  return { urlPath, html, wordCount };
}

// ── Sitemap ──────────────────────────────────────────────────────

function buildSitemapXml(entries: Array<{ canonical: string; alternates: string[] }>, today: string): string {
  const urls = entries
    .map(({ canonical, alternates }) => {
      const alts = alternates
        .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.split('|')[0]}" href="${a.split('|').slice(1).join('|')}" />`)
        .join('\n');
      return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

// ── Plugin entry ─────────────────────────────────────────────────

export function comparisonsHubPlugin(rootDir: string): Plugin {
  return {
    name: 'comparisons-hub',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_COMPARISONS_HUB === '1') {
        console.log('\x1b[33m[comparisons-hub]\x1b[0m Skipped (SKIP_COMPARISONS_HUB=1)');
        return;
      }

      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const collector = new WriteCollector({ distDir });
      const dateStamp = new Date().toISOString().slice(0, 10);

      // Aggregations — computed once, reused for every locale.
      const salaryRows = aggregateSalaryBySector(rootDir, 10);
      const year = new Date().getFullYear();
      const lamalRows = aggregateLamalCantonMedians(rootDir, year);

      // Hreflang alt list — same 4 locales for every page.
      const alternates = COMPARISONS_LOCALES.map(
        (alt) => `${alt}|${BASE_URL}${buildComparisonsHubPath(alt)}`,
      );
      alternates.push(`x-default|${BASE_URL}${buildComparisonsHubPath('it')}`);

      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];
      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const locale of COMPARISONS_LOCALES) {
        const rendered = renderPage({ locale, salaryRows, lamalRows, dateStamp, distDir });

        if (rendered.wordCount < MIN_INDEXABLE_WORDS) {
          thinSkipped++;
          console.warn(
            `\x1b[33m[comparisons-hub]\x1b[0m ${locale} below MIN_INDEXABLE_WORDS (${rendered.wordCount}) — skipping`,
          );
          continue;
        }

        const indexPath = np.join(distDir, rendered.urlPath, 'index.html');
        const flatPath = np.join(distDir, rendered.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, rendered.html);
        collector.add(flatPath, rendered.html);

        // Only emit IT canonical in the sitemap; EN/DE/FR are expressed through
        // the hreflang alternates on that entry (same pattern as nursing).
        if (locale === 'it') {
          sitemapEntries.push({ canonical: rendered.urlPath, alternates });
        }
        pagesWritten++;
      }

      if (sitemapEntries.length > 0) {
        try {
          const xml = buildSitemapXml(sitemapEntries, dateStamp);
          fs.mkdirSync(distDir, { recursive: true });
          fs.writeFileSync(np.join(distDir, 'sitemap-comparisons.xml'), xml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[comparisons-hub]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[comparisons-hub]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} skipped as thin) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s · salary rows: ${salaryRows.length}, LAMal cantons: ${lamalRows.length}`,
      );
    },
  };
}
