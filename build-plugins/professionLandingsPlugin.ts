/**
 * Profession landings (AE-3) — Vite build plugin.
 *
 * Emits 40 static HTML pages (10 professions × 4 locales):
 *
 *   IT canonical                             EN / DE / FR variants
 *   /lavoro-ticino-infermiere/               /en/jobs-ticino-nurse/ …
 *   /lavoro-ticino-operaio/                  /en/jobs-ticino-worker/ …
 *   … etc.
 *
 * Each page carries:
 *   - 7 H2 sections composed from PROFESSION_FACTS (authority URLs, CCL,
 *     salary, employers, permits, application) — 600-750 IT words,
 *     420-520 other locales.
 *   - Employer top-5 table + salary band table (visible markup).
 *   - FAQ block — 5 Q/A per locale, profession-keyed to stay unique
 *     against nursingLandings, hub FAQs, pillars, etc.
 *   - JSON-LD: BreadcrumbList + FAQPage + Article + ItemList (top-5 employers).
 *   - Hreflang × 4 locales + x-default → IT canonical.
 *
 * Hub chrome: `hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' }`
 * matches the parity pattern used by AE-2 / nursingLandings — keeps the
 * sub-nav visible on the first paint even though React suspends via the
 * `staticOverlay: true` route in services/router.ts.
 *
 * Sitemap: writes `dist/sitemap-professions.xml` (IT canonicals only; EN/DE/FR
 * are surfaced via hreflang). `sitemapAliasPlugin` auto-discovers the file.
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { resolveProfessionLandingsFlushed } from './shared/buildSignals';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CTA_PRIMARY_STYLE,
  CARD_STYLE,
  LINK_ACCENT_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
} from './shared/seoContentTokens';
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
  // Escape first, then re-introduce controlled tags (<strong>, <a>).
  const escaped = esc(s);
  // Bold: **text** -> <strong>text</strong>
  const bolded = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Inline links [text](url). URL has been &-escaped; restore naked & in URLs
  // (the attribute is already safe because the quote-escape happened before).
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

// ── Rendering ─────────────────────────────────────────────────────

interface RenderResult {
  urlPath: string;
  html: string;
  wordCount: number;
}

function renderSection(title: string, paragraphs: string[]): string {
  const ps = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${inlineFormat(p)}</p>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="margin:0 0 12px;font-size:24px;color:var(--color-body)">${esc(title)}</h2>${ps}</section>`;
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
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-body)">${esc(title)}</h2>
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
    <h2 style="margin:0 0 12px;font-size:22px;color:var(--color-body)">${esc(title)}</h2>
    <div style="${CARD_STYLE};padding:16px 18px">
      <p style="margin:0 0 6px;color:var(--color-subtle);font-size:13px">${esc(salaryLabel)}</p>
      <p style="margin:0;font-size:22px;font-weight:700;color:var(--color-body)">CHF ${min.toLocaleString('en-CH')} &ndash; ${max.toLocaleString('en-CH')}</p>
      <p style="margin:6px 0 0;color:var(--color-subtle);font-size:12px">Mediana: CHF ${facts.medianSalaryChf.toLocaleString('en-CH')} &middot; dataset Frontaliere Ticino, ${facts.jobsCount} campioni</p>
    </div>
  </section>`;
}

function renderFaqBlock(faqs: Array<{ question: string; answer: string }>): string {
  return faqs
    .map(
      (f) => `
      <details style="margin:0 0 10px;padding:14px 16px;border:1px solid var(--color-edge);border-radius:12px;background:var(--color-surface)">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-body);line-height:1.45">${esc(f.question)}</summary>
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
  return `<section style="margin:0 0 24px;padding:14px 18px;border-left:4px solid var(--color-accent);background:var(--color-surface);max-width:860px">
    <h2 style="margin:0 0 8px;font-size:18px;color:var(--color-body)">${esc(label)}</h2>
    <ul style="margin:0 0 0 20px;padding:0;color:var(--color-body);line-height:1.55;font-size:14px">${lis}</ul>
  </section>`;
}

function renderRelatedLinks(locale: ProfessionLocale, label: string): string {
  const items = RELATED_LINKS[locale]
    .map(
      (l) =>
        `<li style="margin:0 0 8px"><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE}">${esc(l.label)}</a></li>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h2 style="margin:0 0 12px;font-size:22px;color:var(--color-body)">${esc(label)}</h2><ul style="margin:0 0 0 20px;padding:0;color:var(--color-body);line-height:1.55;max-width:860px">${items}</ul></section>`;
}

function renderPage(opts: {
  locale: ProfessionLocale;
  id: ProfessionId;
  dateStamp: string;
  distDir?: string;
}): RenderResult {
  const { locale, id, dateStamp, distDir } = opts;
  const copy = buildProfessionLandingCopy(locale, id);
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
  const jobBoardUrl = `${BASE_URL}${
    locale === 'it'
      ? '/cerca-lavoro-ticino/'
      : locale === 'en'
        ? '/en/find-jobs-ticino/'
        : locale === 'de'
          ? '/de/jobs-im-tessin/'
          : '/fr/trouver-emploi-tessin/'
  }`;

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
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/icons/icon-512x512.png`,
        width: 512,
        height: 512,
      },
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
    <header style="margin-bottom:24px">
      <p style="margin:0 0 8px;color:var(--color-accent);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em">${esc(copy.updatedLabel)} · ${esc(dateStamp)}</p>
      <h1 style="margin:0 0 16px;font-size:clamp(1.9rem,4vw,2.8rem);line-height:1.15">${esc(copy.h1)}</h1>
      <p style="margin:0;color:var(--color-body);font-size:17px;line-height:1.65;max-width:860px">${inlineFormat(copy.lede)}</p>
    </header>
    ${salaryTable}
    ${sectionsHtml}
    ${employersTable}
    ${sourcesHtml}
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:24px;color:var(--color-body)">${esc(copy.faqTitle)}</h2>
      ${faqHtml}
    </section>
    ${relatedHtml}
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(jobBoardUrl)}" style="${CTA_PRIMARY_STYLE}">${esc(copy.ctaJobs)}</a>
      <a href="${esc(homeUrl)}" style="padding:12px 18px;border-radius:12px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-weight:700">${esc(copy.ctaSimulator)}</a>
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
    title: copy.title,
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

      const collector = new WriteCollector({ distDir });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];

      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const id of PROFESSION_IDS) {
        const alternates = PROFESSION_LOCALES.map(
          (alt) => `${alt}|${BASE_URL}${buildProfessionLandingPath(alt, id)}`,
        );
        alternates.push(`x-default|${BASE_URL}${buildProfessionLandingPath('it', id)}`);

        for (const locale of PROFESSION_LOCALES) {
          const rendered = renderPage({ locale, id, dateStamp, distDir });

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
          fs.writeFileSync(np.join(distDir, 'sitemap-professions.xml'), xml, 'utf-8');
          patchSitemapIndex(distDir, dateStamp);
        } catch (err) {
          console.warn('\x1b[33m[profession-landings]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[profession-landings]\x1b[0m Generated ${pagesWritten} pages (${thinSkipped} skipped as thin) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      // Signal the linker (professionLandingsLinksPlugin) that the 40 landings
      // have landed on disk. Combined with the staticPagesFlushed signal, this
      // removes the closeBundle race entirely — no more mtime polling.
      resolveProfessionLandingsFlushed();
    },
  };
}
