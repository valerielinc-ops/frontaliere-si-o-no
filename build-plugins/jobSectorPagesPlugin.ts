/**
 * Vite build plugin that emits static HTML for the 3 sector-based job hubs
 * (Infermieri / Case Anziani / Educatori) in all 4 locales — 12 pages total.
 *
 * Filters `data/jobs.json` by sector keyword pattern (title/description/
 * category/tags) and emits a dedicated landing that consolidates the signal
 * for high-intent GSC queries that currently land on random job detail pages.
 *
 * Writes `sitemap-sector.xml` and patches `sitemap.xml`.
 *
 * Kept standalone so it doesn't touch the much larger `jobsSeoPagesPlugin.ts`
 * (lower merge-conflict risk with parallel SEO work).
 */

import type { Plugin } from 'vite';
import {
  BASE_URL,
  FAVICON_LINKS,
  GTAG_SNIPPET,
  ADSENSE_SNIPPET,
} from './constants';
import {
  STAT_TILE_ACCENT,
  STAT_TILE_WARNING,
  STAT_TILE_LABEL,
  STAT_TILE_VALUE,
  CARD_STYLE,
  BREADCRUMB_STYLE,
  BREADCRUMB_LINK_STYLE,
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  LINK_ACCENT_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
} from './shared/seoContentTokens';
import type { JobBoardLocale } from './jobBoardSeo';
import {
  SECTOR_HUB_KEYS,
  SECTOR_HUB_SLUG,
  SECTOR_HUB_SECTION,
  SECTOR_HUB_LOCALE_PREFIX,
  SECTOR_HUB_DISPLAY,
  buildSectorHubPath,
  buildSectorHubSeo,
  buildSectorProse,
  loadSectorProseData,
  filterSectorJobs,
  countSectorJobsByLocale,
  type SectorCountableJob,
  type SectorHubKey,
} from './jobSectorLanding';

const LOCALES: ReadonlyArray<JobBoardLocale> = ['it', 'en', 'de', 'fr'];

const LOCALE_OG: Record<JobBoardLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

const SECTION_NAME: Record<JobBoardLocale, string> = {
  it: 'Cerca lavoro in Ticino',
  en: 'Find jobs in Ticino',
  de: 'Jobs im Tessin',
  fr: 'Trouver un emploi au Tessin',
};

function esc(s: unknown): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function withSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

function slugify(input: unknown): string {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function localizedJobSlug(job: SectorCountableJob, locale: JobBoardLocale): string {
  const slugByLocale = job.slugByLocale as Record<string, string> | undefined;
  const explicit = String(slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  const canonical = String(job.slug || '').trim();
  if (canonical) return canonical;
  const titleByLocale = job.titleByLocale as Record<string, string> | undefined;
  const localizedTitle = String(titleByLocale?.[locale] || job.title || '');
  return slugify(`${localizedTitle}-${job.company || ''}-${job.location || ''}`) || slugify(localizedTitle);
}

function buildJobHref(
  locale: JobBoardLocale,
  job: SectorCountableJob,
): string {
  const prefix = SECTOR_HUB_LOCALE_PREFIX[locale];
  const section = SECTOR_HUB_SECTION[locale];
  const slug = localizedJobSlug(job, locale);
  return `${BASE_URL}${prefix}/${section}/${slug}/`.replace(/([^:])\/+/g, '$1/');
}

function renderJobCard(j: {
  title: string;
  company: string;
  location: string;
  href: string;
  datePosted?: string;
}): string {
  const datePart = j.datePosted
    ? `<time datetime="${esc(j.datePosted)}" style="color:var(--color-subtle);font-size:13px">${esc(String(j.datePosted).slice(0, 10))}</time>`
    : '';
  return `<li style="${CARD_STYLE};margin-bottom:10px;list-style:none">
  <a href="${esc(j.href)}" style="color:var(--color-heading);text-decoration:none;display:block">
    <div style="font-weight:700;font-size:16px;line-height:1.35">${esc(j.title)}</div>
    <div style="margin-top:4px;color:var(--color-subtle);font-size:14px">${esc(j.company)}${j.company && j.location ? ' · ' : ''}${esc(j.location)}</div>
    ${datePart ? `<div style="margin-top:4px">${datePart}</div>` : ''}
  </a>
</li>`;
}

export function jobSectorPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'job-sector-pages',
    apply: 'build',
    async closeBundle() {
      const fs = await import('node:fs');
      const np = await import('node:path');
      const distDir = np.resolve(rootDir, 'dist');
      const jobsPath = np.resolve(rootDir, 'data/jobs.json');

      // Read jobs.json (gitignored in dev; present in CI).
      let jobs: SectorCountableJob[] = [];
      try {
        if (fs.existsSync(jobsPath)) {
          const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
          if (Array.isArray(raw)) jobs = raw as SectorCountableJob[];
        }
      } catch (err) {
        console.warn('[job-sector-pages] failed to read data/jobs.json', err);
      }

      const counts = countSectorJobsByLocale(jobs);
      const sectorProseData = loadSectorProseData(rootDir);

      // Try to discover hashed SPA entry bundle
      let entryJs = '';
      let entryCss = '';
      try {
        const builtHtml = fs.readFileSync(np.join(distDir, 'index.html'), 'utf-8');
        entryJs = builtHtml.match(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/)?.[1] ?? '';
        entryCss = builtHtml.match(/href="\/assets\/(index-[A-Za-z0-9_-]+\.css)"/)?.[1] ?? '';
      } catch {
        /* index.html missing — degrade gracefully */
      }
      const hasSpaBundle = !!(entryJs && entryCss);

      const dateStamp = new Date().toISOString().slice(0, 10);
      const year = new Date().getUTCFullYear();
      const sitemapEntries: string[] = [];

      const ensuredDirs = new Set<string>();
      const ensureDir = (dir: string): void => {
        if (ensuredDirs.has(dir)) return;
        fs.mkdirSync(dir, { recursive: true });
        ensuredDirs.add(dir);
      };

      for (const sector of SECTOR_HUB_KEYS) {
        for (const locale of LOCALES) {
          const count = counts[locale][sector];
          const seo = buildSectorHubSeo(locale, sector, count, year);
          const matchingJobs = filterSectorJobs(jobs, sector, locale, 50);
          const proseDisplayName = SECTOR_HUB_DISPLAY[locale][sector];
          const prose = buildSectorProse(sector, locale, proseDisplayName, sectorProseData);

          const canonicalPath = buildSectorHubPath(locale, sector);
          const canonicalUrl = `${BASE_URL}${canonicalPath}`;

          const alternates = LOCALES.map((altLocale) => {
            const altPath = buildSectorHubPath(altLocale, sector);
            return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${altPath}">`;
          }).join('\n');
          const xDefaultPath = buildSectorHubPath('it', sector);

          const jobCards = matchingJobs.map((job) => {
            const titleByLocale = job.titleByLocale as Record<string, string> | undefined;
            const localizedTitle = String(titleByLocale?.[locale] || job.title || 'Offerta lavoro');
            return {
              title: String(localizedTitle).replace(/\s+/g, ' ').trim(),
              company: String(job.company || '').replace(/\s+/g, ' ').trim(),
              location: String(job.location || '').replace(/\s+/g, ' ').trim(),
              href: buildJobHref(locale, job),
              datePosted: job.datePosted || job.postedDate || undefined,
            };
          });

          const noResultsLabel = {
            it: 'Nessuna offerta al momento. Torna a breve — la lista si aggiorna più volte al giorno.',
            en: 'No listings right now. Check back soon — the list refreshes multiple times per day.',
            de: 'Aktuell keine Angebote. Schauen Sie bald wieder vorbei — die Liste wird mehrmals täglich aktualisiert.',
            fr: "Aucune offre pour l'instant. Revenez bientôt — la liste est mise à jour plusieurs fois par jour.",
          }[locale];
          const jobsHtml = jobCards.length > 0
            ? `<ul style="margin:0;padding:0">${jobCards.map(renderJobCard).join('')}</ul>`
            : `<p style="margin:0;padding:16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-heading);border:1px solid var(--color-warning-border)">${esc(noResultsLabel)}</p>`;

          const faqHtml = seo.faq.length > 0
            ? `<section style="margin:28px 0 0">
    <h2 style="margin:0 0 12px;font-size:22px">FAQ</h2>
    ${seo.faq.map((f) => `<details style="${CARD_STYLE};margin-bottom:8px"><summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(f.question)}</summary><p style="margin:8px 0 0;color:var(--color-body);line-height:1.6">${esc(f.answer)}</p></details>`).join('')}
  </section>`
            : '';

          const sectionRootUrl = `${BASE_URL}${withSlash(
            `${SECTOR_HUB_LOCALE_PREFIX[locale]}/${SECTOR_HUB_SECTION[locale]}`.replace(/\/+/g, '/'),
          )}`;

          const breadcrumbLd = JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
              { '@type': 'ListItem', position: 2, name: SECTION_NAME[locale], item: sectionRootUrl },
              { '@type': 'ListItem', position: 3, name: seo.h1, item: canonicalUrl },
            ],
          });

          const itemListLd = jobCards.length > 0
            ? JSON.stringify({
                '@context': 'https://schema.org',
                '@type': 'ItemList',
                name: seo.h1,
                numberOfItems: jobCards.length,
                itemListElement: jobCards.map((j, idx) => ({
                  '@type': 'ListItem',
                  position: idx + 1,
                  name: j.title,
                  url: j.href,
                })),
              })
            : '';

          const collectionLd = JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: seo.h1,
            url: canonicalUrl,
            description: seo.desc,
            inLanguage: locale,
            isPartOf: sectionRootUrl,
            dateModified: new Date().toISOString(),
          });

          const faqLd = seo.faq.length > 0
            ? JSON.stringify({
                '@context': 'https://schema.org',
                '@type': 'FAQPage',
                mainEntity: seo.faq.map((f) => ({
                  '@type': 'Question',
                  name: f.question,
                  acceptedAnswer: { '@type': 'Answer', text: f.answer },
                })),
              })
            : '';

          const countsLabelByLocale: Record<JobBoardLocale, string> = {
            it: 'Offerte attive',
            en: 'Active jobs',
            de: 'Aktive Stellen',
            fr: 'Offres actives',
          };
          const updatedLabelByLocale: Record<JobBoardLocale, string> = {
            it: 'Aggiornato',
            en: 'Updated',
            de: 'Aktualisiert',
            fr: 'Mis à jour',
          };
          const jobsSectionLabelByLocale: Record<JobBoardLocale, string> = {
            it: 'Annunci disponibili',
            en: 'Available listings',
            de: 'Verfügbare Angebote',
            fr: 'Annonces disponibles',
          };
          const openAllByLocale: Record<JobBoardLocale, string> = {
            it: 'Vedi tutte le offerte di lavoro in Ticino',
            en: 'See all jobs in Ticino',
            de: 'Alle Stellenangebote im Tessin ansehen',
            fr: "Voir toutes les offres d'emploi au Tessin",
          };

          const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${FAVICON_LINKS}
    <title>${esc(seo.title)}</title>
    <meta name="description" content="${esc(seo.desc)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[locale]}">
    <meta property="og:title" content="${esc(seo.ogT)}">
    <meta property="og:description" content="${esc(seo.ogD)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/png">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(seo.ogT)}">
    <meta name="twitter:description" content="${esc(seo.ogD)}">
    <meta name="twitter:site" content="@frontaliereticino">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${xDefaultPath}">
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}${faqLd ? `\n    <script type="application/ld+json">${faqLd}</script>` : ''}${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
    ${GTAG_SNIPPET}
    ${ADSENSE_SNIPPET}
  </head>
  <body>
    <div id="root"></div>
    <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body);font-family:system-ui,-apple-system,sans-serif">
        <nav style="${BREADCRUMB_STYLE}">
          <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">Home</a>
          <span> / </span>
          <a href="${sectionRootUrl}" style="${BREADCRUMB_LINK_STYLE}">${esc(SECTION_NAME[locale])}</a>
          <span> / </span>
          <span>${esc(seo.h1)}</span>
        </nav>
        <header style="margin-bottom:24px">
          <p style="${HERO_EYEBROW_STYLE}">${esc(updatedLabelByLocale[locale])} · ${dateStamp}</p>
          <h1 style="${H1_STYLE}">${esc(seo.h1)}</h1>
          <p style="${LEDE_STYLE}">${esc(seo.desc)}</p>
          <p style="${BODY_STYLE}">${esc(seo.intro)}</p>
        </header>
        <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:0 0 22px">
          <div style="${STAT_TILE_ACCENT}">
            <div style="${STAT_TILE_LABEL}">${esc(countsLabelByLocale[locale])}</div>
            <div style="${STAT_TILE_VALUE};font-size:32px">${count}</div>
          </div>
          <a href="${sectionRootUrl}" style="${STAT_TILE_WARNING};text-decoration:none;font-weight:700;display:flex;align-items:center">${esc(openAllByLocale[locale])} →</a>
        </section>
        ${prose.html}
        <section style="margin:0 0 24px">
          <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
            <h2 style="margin:0;font-size:24px">${esc(jobsSectionLabelByLocale[locale])}</h2>
          </div>
          ${jobsHtml}
        </section>
        ${faqHtml}
      </main>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;

          // Write both /path/index.html and /path.html
          const outDir = np.join(distDir, canonicalPath.slice(1));
          ensureDir(outDir);
          fs.writeFileSync(np.join(outDir, 'index.html'), html, 'utf-8');
          const flatPath = canonicalPath.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
            ensureDir(np.dirname(flatFile));
            fs.writeFileSync(flatFile, html, 'utf-8');
          }

          // Build sitemap entry keyed on IT canonical
          if (locale === 'it') {
            const altLinks = LOCALES.map((altLocale) => {
              const altPath = buildSectorHubPath(altLocale, sector);
              return `    <xhtml:link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${altPath}" />`;
            }).join('\n');
            sitemapEntries.push(
              `  <url>\n    <loc>${canonicalUrl}</loc>\n${altLinks}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${canonicalUrl}" />\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`,
            );
          }
        }
      }

      // Write sitemap-sector.xml and patch sitemap.xml
      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemapEntries.join('\n')}
</urlset>
`;
        try {
          fs.writeFileSync(np.join(distDir, 'sitemap-sector.xml'), sitemapXml, 'utf-8');
          const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
          if (fs.existsSync(sitemapIndexPath)) {
            let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
            if (!idx.includes('sitemap-sector.xml')) {
              idx = idx.replace(
                '</sitemapindex>',
                `  <sitemap>\n    <loc>${BASE_URL}/sitemap-sector.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
              );
            } else {
              idx = idx.replace(
                /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-sector\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
                `$1${dateStamp}$2`,
              );
            }
            fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
          }
        } catch (err) {
          console.warn('[job-sector-pages] failed to write sitemap-sector.xml', err);
        }
      }

      const totalPages = LOCALES.length * SECTOR_HUB_KEYS.length;
      console.log(
        `\x1b[36m[job-sector-pages]\x1b[0m Generated ${totalPages} sector hubs (${jobs.length} candidate jobs)`,
      );
    },
  };
}

// Re-export for tests/consumers
export { SECTOR_HUB_SLUG, SECTOR_HUB_KEYS, buildSectorHubPath };
export type { SectorHubKey };
