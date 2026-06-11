/**
 * publisherAdPagesPlugin — static SSG detail page per PUBLISHER ad at
 * `/lavoro/<slug>/` (+ /en, /de, /fr locale variants).
 *
 * WHY a dedicated page (unlike crawled jobs): a crawled job lives on the
 * employer's own career site, so we list it and link OUT. A publisher ad is
 * ORIGINAL content the publisher PAID to host on our site — it deserves its own
 * indexable page with full JobPosting structured data, exactly like the
 * `/cerca-lavoro-…/` SEO pages. The publisher projection already mints the
 * canonical `/lavoro/<slug>` URL (services/lib/publisherJobProjection.mjs); this
 * plugin emits the real static HTML behind it (previously a soft-404 SPA route).
 *
 * Source of truth: the assembled publisher slice
 * `data/jobs/by-crawler/publisher-submitted.json` (one record per ad × location,
 * each with its own slug/url). Every record gets a page in all 4 locales.
 *
 * Contract: apply:'build', emit in closeBundle(), pass distDir. JSON-LD via the
 * shared buildJobPostingSchema (guarantees AGENTS #3 fields: baseSalary,
 * postalCode, streetAddress, title, description, datePosted,
 * hiringOrganization.name, jobLocation, employmentType). Sitemap is written as
 * `dist/sitemap-publisher-ads.xml`; sitemapAliasPlugin auto-discovers it.
 *
 * Gate: SKIP_PUBLISHER_AD_PAGES=1 fast-exits for local builds.
 */
import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { buildJobPostingSchema } from './shared/jobPostingSchema';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { WriteCollector } from './batchWrite';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type AdLocale = (typeof LOCALES)[number];

const OG_LOCALE: Record<AdLocale, string> = { it: 'it_IT', en: 'en_US', de: 'de_DE', fr: 'fr_FR' };

// Locale URL prefix (IT is unprefixed — site convention).
const localePrefix = (locale: AdLocale): string => (locale === 'it' ? '' : `/${locale}`);
// Canonical detail path for a slug in a given locale (trailing slash — site rule).
const detailPath = (locale: AdLocale, slug: string): string => `${localePrefix(locale)}/lavoro/${slug}/`;

// Per-locale job-listing root for the breadcrumb parent.
const JOBS_ROOT: Record<AdLocale, { path: string; label: string }> = {
  it: { path: '/cerca-lavoro-ticino/', label: 'Offerte di lavoro' },
  en: { path: '/en/find-jobs-ticino/', label: 'Job offers' },
  de: { path: '/de/jobs-im-ticino/', label: 'Stellenangebote' },
  fr: { path: '/fr/trouver-emploi-ticino/', label: 'Offres d’emploi' },
};

const HOME_LABEL: Record<AdLocale, string> = { it: 'Home', en: 'Home', de: 'Startseite', fr: 'Accueil' };
const APPLY_LABEL: Record<AdLocale, string> = {
  it: 'Candidati ora', en: 'Apply now', de: 'Jetzt bewerben', fr: 'Postuler',
};
const POSTED_LABEL: Record<AdLocale, string> = {
  it: 'Pubblicato il', en: 'Posted on', de: 'Veröffentlicht am', fr: 'Publié le',
};
const SALARY_LABEL: Record<AdLocale, string> = {
  it: 'Retribuzione', en: 'Salary', de: 'Gehalt', fr: 'Salaire',
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

interface AdRecord {
  title?: string;
  slug?: string;
  url?: string;
  company?: string;
  location?: string;
  addressLocality?: string;
  canton?: string;
  postedDate?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string;
  description?: string;
  descriptionByLocale?: Partial<Record<string, string>>;
  titleByLocale?: Partial<Record<string, string>>;
  applyMode?: string;
  applyUrl?: string;
  employmentType?: string;
  [k: string]: unknown;
}

function localizedTitle(rec: AdRecord, locale: AdLocale): string {
  return String(rec.titleByLocale?.[locale] || rec.title || '').trim();
}
// Use the translated description when available, else the (≥50-word, validated)
// source text. Never thinner than the source — translate-pending fills the rest.
function localizedDescription(rec: AdRecord, locale: AdLocale): string {
  return String(rec.descriptionByLocale?.[locale] || rec.description || '').trim();
}

function renderBody(rec: AdRecord, locale: AdLocale): string {
  const title = localizedTitle(rec, locale);
  const company = String(rec.company || '').trim();
  const place = String(rec.location || rec.addressLocality || '').trim();
  const desc = localizedDescription(rec, locale);
  const jobs = JOBS_ROOT[locale];
  const applyHref = rec.applyMode === 'external_url' && rec.applyUrl ? rec.applyUrl : detailPath(locale, String(rec.slug || ''));
  const salary = Number.isFinite(rec.salaryMin) && Number(rec.salaryMin) > 0
    ? `${esc(rec.currency || 'CHF')} ${Number(rec.salaryMin).toLocaleString('de-CH')}${Number.isFinite(rec.salaryMax) && Number(rec.salaryMax) ? `–${Number(rec.salaryMax).toLocaleString('de-CH')}` : ''}`
    : null;
  const postedHuman = rec.postedDate ? String(rec.postedDate).slice(0, 10) : null;
  // Description as paragraphs (split on blank lines / newlines).
  const descHtml = desc
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');

  return `<main class="seo-static-content" style="max-width:760px;margin:0 auto;padding:24px 20px 56px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6;color:var(--color-body)">
<nav aria-label="breadcrumb" style="font-size:13px;color:var(--color-subtle);margin-bottom:16px">
<a href="${esc(localePrefix(locale) || '/')}" style="color:inherit">${esc(HOME_LABEL[locale])}</a> ·
<a href="${esc(jobs.path)}" style="color:inherit">${esc(jobs.label)}</a> ·
<span>${esc(title)}</span>
</nav>
<h1 style="font-size:26px;font-weight:700;color:var(--color-heading);margin:0 0 8px">${esc(title)}</h1>
<p style="font-size:15px;color:var(--color-subtle);margin:0 0 18px">${esc(company)}${company && place ? ' · ' : ''}${esc(place)}</p>
<div style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px">
${salary ? `<span style="background:var(--color-surface-alt);border-radius:10px;padding:8px 12px;font-size:14px"><strong>${esc(SALARY_LABEL[locale])}:</strong> ${salary}</span>` : ''}
${postedHuman ? `<span style="background:var(--color-surface-alt);border-radius:10px;padding:8px 12px;font-size:14px">${esc(POSTED_LABEL[locale])} <time datetime="${esc(postedHuman)}">${esc(postedHuman)}</time></span>` : ''}
</div>
<section style="margin:0 0 28px">${descHtml}</section>
<a href="${esc(applyHref)}" rel="nofollow"${rec.applyMode === 'external_url' ? ' target="_blank"' : ''} style="display:inline-flex;align-items:center;gap:8px;background:var(--color-accent,#2563eb);color:#fff;font-weight:600;padding:12px 22px;border-radius:12px;text-decoration:none">${esc(APPLY_LABEL[locale])}</a>
</main>`;
}

export function publisherAdPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'publisher-ad-pages',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_PUBLISHER_AD_PAGES === '1') {
        console.log('\x1b[33m[publisher-ad-pages]\x1b[0m Skipped (SKIP_PUBLISHER_AD_PAGES=1)');
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const slicePath = np.resolve(rootDir, 'data/jobs/by-crawler/publisher-submitted.json');
      if (!fs.existsSync(slicePath)) {
        console.log('\x1b[33m[publisher-ad-pages]\x1b[0m no publisher-submitted.json — nothing to emit.');
        return;
      }
      let records: AdRecord[] = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
        records = Array.isArray(parsed) ? parsed : (parsed.jobs || parsed.records || []);
      } catch (err) {
        console.warn('\x1b[33m[publisher-ad-pages]\x1b[0m slice parse failed:', err);
        return;
      }
      if (!records.length) {
        console.log('\x1b[33m[publisher-ad-pages]\x1b[0m 0 publisher ads — nothing to emit.');
        return;
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'publisherAdPagesPlugin' });
      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];
      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const rec of records) {
        const slug = String(rec.slug || '').trim();
        if (!slug) continue;

        const alternates = LOCALES.map((alt) => `${alt}|${BASE_URL}${detailPath(alt, slug)}`);
        alternates.push(`x-default|${BASE_URL}${detailPath('it', slug)}`);
        const hreflangHtml = [
          ...LOCALES.map((alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${detailPath(alt, slug)}">`),
          `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${detailPath('it', slug)}">`,
        ].join('\n');

        for (const locale of LOCALES) {
          const urlPath = detailPath(locale, slug);
          const canonicalUrl = `${BASE_URL}${urlPath}`;
          const title = localizedTitle(rec, locale);
          if (!title) continue;

          const bodyHtml = renderBody(rec, locale);
          const wordCount = countHtmlBodyWords(bodyHtml);

          const jobPostingLd = inlineScriptJson(buildJobPostingSchema(rec, { locale, url: canonicalUrl }));
          const breadcrumbLd = inlineScriptJson({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: HOME_LABEL[locale], item: `${BASE_URL}${localePrefix(locale)}/` },
              { '@type': 'ListItem', position: 2, name: JOBS_ROOT[locale].label, item: `${BASE_URL}${JOBS_ROOT[locale].path}` },
              { '@type': 'ListItem', position: 3, name: title, item: canonicalUrl },
            ],
          });

          const company = String(rec.company || '').trim();
          const place = String(rec.location || rec.addressLocality || '').trim();
          const metaTitle = `${title}${company ? ` — ${company}` : ''}${place ? `, ${place}` : ''} | Frontaliere Ticino`;
          const metaDesc = localizedDescription(rec, locale).replace(/\s+/g, ' ').slice(0, 160);

          const html = buildSeoPageHtml({
            locale,
            title: metaTitle,
            description: metaDesc,
            canonicalUrl,
            robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
            ogType: 'article',
            ogLocale: OG_LOCALE[locale],
            hreflangHtml,
            jsonLdScripts: [jobPostingLd, breadcrumbLd],
            bodyHtml,
            distDir,
            skipMainWrap: true,
          });

          if (wordCount < MIN_INDEXABLE_WORDS) thinSkipped++;
          collector.add(np.join(distDir, urlPath, 'index.html'), html);
          collector.add(np.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          pagesWritten++;

          // Sitemap: only the IT canonical, and only when that page was actually
          // emitted (title present → not `continue`d above) AND is indexable
          // (wordCount ≥ MIN → index,follow, not noindex/thin). Pushing in the
          // outer loop would submit noindex or skipped-IT (404) URLs to Search
          // Console. Mirrors careerLandingsPlugin's gated push.
          if (locale === 'it' && wordCount >= MIN_INDEXABLE_WORDS) {
            sitemapEntries.push({ canonical: urlPath, alternates });
          }
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          const urls = sitemapEntries
            .map(({ canonical, alternates }) => {
              const alts = alternates
                .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.split('|')[0]}" href="${a.split('|').slice(1).join('|')}" />`)
                .join('\n');
              return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`;
            })
            .join('\n');
          const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
          fs.writeFileSync(np.join(distDir, 'sitemap-publisher-ads.xml'), xml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[publisher-ad-pages]\x1b[0m sitemap write failed:', err);
        }
      }

      const written = await collector.flush();
      console.log(
        `\x1b[36m[publisher-ad-pages]\x1b[0m ${records.length} ad record(s) → ${pagesWritten} pages (${thinSkipped} noindex-thin) — flushed ${written} files.`,
      );
    },
  };
}
