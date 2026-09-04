/**
 * Vite build plugin that emits static HTML for the recency-filtered
 * job hubs (last-3-days + since-yesterday) in all 4 locales. Also writes
 * a dedicated sitemap-recency.xml and patches it into the master
 * sitemap.xml index.
 *
 * Kept as a standalone plugin so the much larger jobsSeoPagesPlugin.ts
 * (shared with other SEO landings) stays untouched — lower merge-conflict
 * risk when parallel agents are shipping neighbouring SEO work.
 */

// Import statici, NON `await import()` dentro closeBundle (#5001): closeBundle e'
// un hook Rollup async/parallelo, quindi quell'await sospende il plugin e un
// altro plugin `enforce:'post'` puo' girare per intero prima che questo
// riprenda. E' gia' costato due bug silenziosi (pdfWhitepapersPlugin,
// staticPagesPlugin): le hero card venivano drenate prima di essere registrate.
import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { clampMetaDescription } from './shared/titleSuffix';
import { railGutters } from './shared/railGutters';
import {
  BASE_URL,
  FAVICON_LINKS,
  GTAG_SNIPPET,
  PARTNERIZE_TAG_SNIPPET,
  ADSENSE_SNIPPET,
  CDN_PRECONNECT_HINT,
  robotsMetaEnhancedForContent,
} from './constants';
import { asyncCssHeadBlock, rootShell } from './htmlTemplate';
import {
  JOB_RECENCY_LANDING_SLUGS,
  type JobRecencyVariant,
  buildJobRecencyLandingModel,
} from './jobRecencyLanding';
import type { JobLandingLocale } from './jobEditorialLanding';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { formatUpdatedSentence } from './shared/humanDate';
import {
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  LINK_ACCENT_STYLE,
  HERO_EYEBROW_STYLE,
} from './shared/seoContentTokens';
import {
  renderJobCardListHtml,
  type JobCardJob,
  type JobCardListItem,
} from './shared/jobCardHtml';
import { renderRecencyHubProse } from './shared/jobListingProse';
import { renderJobBoardCommuterContext } from './shared/jobBoardCommuterContext';
import { windowDaysForVariant } from './jobRecencyLanding';
import { buildDayStampIso } from './shared/buildDayStamp';

const LOCALES: ReadonlyArray<JobLandingLocale> = ['it', 'en', 'de', 'fr'];

const SECTION_BY_LOCALE: Record<JobLandingLocale, string> = {
  it: 'cerca-lavoro-ticino', // cathedral-allow: TI legacy section fallback (per-plugin SECTION_SLUG table)
  en: 'find-jobs-ticino', // cathedral-allow: TI legacy section fallback (per-plugin SECTION_SLUG table)
  de: 'jobs-im-tessin', // cathedral-allow: TI legacy section fallback (per-plugin SECTION_SLUG table)
  fr: 'trouver-emploi-tessin', // cathedral-allow: TI legacy section fallback (per-plugin SECTION_SLUG table)
};

const LOCALE_PREFIX: Record<JobLandingLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

const LOCALE_OG: Record<JobLandingLocale, string> = {
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
};

const SECTION_NAME: Record<JobLandingLocale, string> = {
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
    .slice(0, 200);
}

function localizedJobSlug(job: Record<string, unknown>, locale: JobLandingLocale): string {
  const slugByLocale = job.slugByLocale as Record<string, string> | undefined;
  const explicit = String(slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  const canonical = String(job.slug || '').trim();
  if (canonical) return canonical;
  const titleByLocale = job.titleByLocale as Record<string, string> | undefined;
  const localizedTitle = String(titleByLocale?.[locale] || job.title || '');
  return slugify(`${localizedTitle}-${job.company || ''}-${job.location || ''}`) || slugify(localizedTitle);
}

const VARIANTS: ReadonlyArray<JobRecencyVariant> = ['last-3-days', 'since-yesterday'];

export function jobRecencyPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'job-recency-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = np.resolve(rootDir, 'dist');
      const jobsPath = np.resolve(rootDir, 'data/jobs.json');

      // `dateStamp` is fixed once per build and baked into JSON-LD/sitemap.
      const dateStamp = new Date().toISOString().slice(0, 10);

      // Read jobs.json (gitignored in dev; present in CI). Missing file is
      // a soft failure — empty-state pages are still generated.
      let jobs: Array<Record<string, unknown>> = [];
      try {
        if (fs.existsSync(jobsPath)) {
          const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
          if (Array.isArray(raw)) jobs = raw as Array<Record<string, unknown>>;
        }
      } catch (err) {
        console.warn('[job-recency-pages] failed to read data/jobs.json', err);
      }

      // Filter to valid, non-expired jobs. needsRetranslation is checked
      // per-locale below (once per locale is known) — a job flagged
      // needsRetranslation=true still belongs on its own source-locale
      // page; the flag only means OTHER-locale translations are stale (#4715).
      const validJobsBase = jobs.filter((j) => {
        if (!j || typeof j !== 'object') return false;
        if ((j as { expired?: boolean }).expired) return false;
        return !!(j.title && j.company && j.location);
      });
      const validJobsForLocale = (locale: JobLandingLocale): Array<Record<string, unknown>> =>
        validJobsBase.filter((j) => {
          const nr = (j as { needsRetranslation?: unknown }).needsRetranslation;
          const sourceLang = (j as { sourceLang?: string }).sourceLang || 'it';
          if (nr === true && locale !== sourceLang) return false;
          if (nr && typeof nr === 'object' && (nr as Record<string, boolean>)[locale]) return false;
          return true;
        });

      // Race-free SPA bundle hash extraction. See spaBundleResolver.ts.
      const { resolveSpaBundle } = await import('./spaBundleResolver');
      const spaBundle = resolveSpaBundle(distDir);
      const entryJs = spaBundle.entryJs;
      const entryCss = spaBundle.entryCss;
      const hasSpaBundle = spaBundle.hasSpaBundle;

      const sitemapEntries: string[] = [];

      const ensuredDirs = new Set<string>();
      const ensureDir = (dir: string): void => {
        if (ensuredDirs.has(dir)) return;
        fs.mkdirSync(dir, { recursive: true });
        ensuredDirs.add(dir);
      };

      for (const variant of VARIANTS) {
        for (const locale of LOCALES) {
          const validJobs = validJobsForLocale(locale);
          const model = buildJobRecencyLandingModel({
            jobs: validJobs,
            locale,
            variant,
            now: new Date(),
            localizedSlug: localizedJobSlug,
            baseUrl: BASE_URL,
            sectionSlug: SECTION_BY_LOCALE[locale],
            localePrefix: LOCALE_PREFIX[locale],
            // 50 SPA cards × ~3 KB per card put the page over the 200 KB
            // CI page-weight gate (207-210 KB measured). Capping at 30 keeps
            // the page under 180 KB while still covering the most relevant
            // recency window. Users searching for "lavoro Ticino da ieri"
            // typically scan the top 20-30 results — the rest fall off the
            // recency window quickly anyway.
            maxJobs: 30,
          });

          const canonicalPath = withSlash(
            `${LOCALE_PREFIX[locale]}/${SECTION_BY_LOCALE[locale]}/${model.slug}`.replace(/\/+/g, '/'),
          );
          const canonicalUrl = `${BASE_URL}${canonicalPath}`;

          const alternates = LOCALES.map((altLocale) => {
            const altSlug = JOB_RECENCY_LANDING_SLUGS[variant][altLocale];
            const altPath = withSlash(
              `${LOCALE_PREFIX[altLocale]}/${SECTION_BY_LOCALE[altLocale]}/${altSlug}`.replace(/\/+/g, '/'),
            );
            return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${altPath}">`;
          }).join('\n');

          const cardItems: JobCardListItem[] = model.jobs.map((job) => ({
            // RecencyJobLink already includes title/company/location/href/date
            // plus the SPA-card enrichment fields (companyKey, salary, contract,
            // canton, featured, titleByLocale).
            job: job as JobCardJob,
            href: job.href,
          }));
          const jobsHtml = renderJobCardListHtml(cardItems, {
            locale,
            emptyStateHtml: `<p class="s-twrn" style="margin:0;padding:16px;border-radius:12px">${esc(model.noResultsLabel)}</p>`,
          });

          const faqHtml = model.faq.length > 0
            ? `<section class="s-m_ILbB">
    <h2 style="${H2_STYLE}">FAQ</h2>
    ${model.faq.map((f) => `<details class="s-card" style="border-radius:12px;margin-bottom:8px"><summary class="s-HBR0NM">${esc(f.question)}</summary><p class="s-bOIp6r">${esc(f.answer)}</p></details>`).join('')}
  </section>`
            : '';

          // SEO content gate (text-to-HTML ratio): the recency hubs were
          // flagged as <10 % visible text in the Apr 2026 audit because the
          // body is mostly job-card markup. Append a methodology + extended
          // FAQ block built from the shared frontaliere-relevant prose pool.
          // Different `windowDays` values pick different variants so the
          // 3-day and 1-day hubs aren't textually identical.
          const proseHtml = renderRecencyHubProse(
            locale,
            windowDaysForVariant(variant),
          );

          // JSON-LD — BreadcrumbList + ItemList + (when jobs present) JobPosting array + FAQPage
          const sectionRootUrl = `${BASE_URL}${withSlash(
            `${LOCALE_PREFIX[locale]}/${SECTION_BY_LOCALE[locale]}`.replace(/\/+/g, '/'),
          )}`;
          const breadcrumbLd = inlineScriptJson({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
              { '@type': 'ListItem', position: 2, name: SECTION_NAME[locale], item: sectionRootUrl },
              { '@type': 'ListItem', position: 3, name: model.heading, item: canonicalUrl },
            ],
          });

          const itemListLd = model.jobs.length > 0
            ? inlineScriptJson({
                '@context': 'https://schema.org',
                '@type': 'ItemList',
                name: model.heading,
                numberOfItems: model.jobs.length,
                itemListElement: model.jobs.slice(0, 50).map((j, idx) => ({
                  '@type': 'ListItem',
                  position: idx + 1,
                  name: j.title,
                  url: j.href,
                })),
              })
            : '';

          const collectionLd = inlineScriptJson({
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: model.heading,
            url: canonicalUrl,
            description: model.description,
            inLanguage: locale,
            isPartOf: sectionRootUrl,
            // Day-granularity, not a full build timestamp — see
            // build-plugins/shared/buildDayStamp.ts (per-build churn fix).
            dateModified: buildDayStampIso(),
          });

          const faqLd = model.faq.length > 0
            ? inlineScriptJson({
                '@context': 'https://schema.org',
                '@type': 'FAQPage',
                mainEntity: model.faq.map((f) => ({
                  '@type': 'Question',
                  name: f.question,
                  acceptedAnswer: { '@type': 'Answer', text: f.answer },
                })),
              })
            : '';

          const openAllHref = sectionRootUrl;

          // Extracted (not inlined) so its text can feed the body word count
          // below -- this accordion is what keeps low-inventory windows past
          // the text-to-HTML ratio floor (see comment above proseHtml).
          const commuterContextSummary = ({
            it: 'Guida frontalieri: salario, permesso G, fisco, rientro',
            en: 'Cross-border guide: salary, G permit, tax, weekly return',
            de: 'Grenzgänger-Leitfaden: Lohn, G-Bewilligung, Steuer, Rückkehr',
            fr: 'Guide frontaliers : salaire, permis G, fiscalité, retour',
          } as Record<JobLandingLocale, string>)[locale];
          const commuterContextInner = renderJobBoardCommuterContext({ locale, location: 'Ticino', omitCommute: true });
          const commuterContextHtml = `<details class="hub-seo-context s-mxdIN0">
          <summary class="s-1yn7b_">${commuterContextSummary}</summary>
          <div class="s-yZU6bn">
            <section class="s-p_RJwm">
              ${commuterContextInner}
            </section>
          </div>
        </details>`;

          // No upstream inventory floor gates this page (unlike the
          // canton/city editorial hubs in jobsSeoPagesPlugin.ts) -- every
          // variant x locale combo emits regardless of job count, so the
          // robots tag must be computed per-render from the actual assembled
          // body content instead of assumed indexable.
          const recencyBodyHtml = `${jobsHtml}${proseHtml}${faqHtml}${commuterContextHtml}`;
          const recencyRobotsTag = robotsMetaEnhancedForContent(recencyBodyHtml);

          const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${CDN_PRECONNECT_HINT ? `${CDN_PRECONNECT_HINT}\n    ` : ''}${FAVICON_LINKS}
    <title>${esc(model.title)}</title>
    <meta name="description" content="${esc(clampMetaDescription(model.description))}">${recencyRobotsTag}
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[locale]}">
    <meta property="og:title" content="${esc(model.title)}">
    <meta property="og:description" content="${esc(clampMetaDescription(model.description))}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:alt" content="${esc(model.title)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withSlash(
            `/${SECTION_BY_LOCALE.it}/${JOB_RECENCY_LANDING_SLUGS[variant].it}`.replace(/\/+/g, '/'),
          )}">
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}${faqLd ? `\n    <script type="application/ld+json">${faqLd}</script>` : ''}
    ${asyncCssHeadBlock(hasSpaBundle ? entryCss : undefined)}
    ${GTAG_SNIPPET}
    ${ADSENSE_SNIPPET}
    ${PARTNERIZE_TAG_SNIPPET}
  </head>
  <body class="bg-surface-alt text-heading overflow-x-hidden">
    ${rootShell(hasSpaBundle)}
    ${railGutters(true).open}
    <main class="seo-static-content s-xzWvwM">
      <nav class="s-bcr">
        <a href="/" class="s-bcl">Home</a>
        <span> / </span>
        <a href="${sectionRootUrl}" class="s-bcl">${esc(SECTION_NAME[locale])}</a>
        <span> / </span>
        <span>${esc(model.timeframeLabel)}</span>
      </nav>
      <header class="s-sy52lX">
        <p style="${HERO_EYEBROW_STYLE}">${esc(formatUpdatedSentence(dateStamp, locale))}</p>
        <h1 style="${H1_STYLE}">${esc(model.heading)}</h1>
        <p style="${LEDE_STYLE};max-width:860px">${esc(model.description)}</p>
        <p style="${BODY_STYLE};max-width:860px">${esc(model.intro)}</p>
      </header>
      <section class="s-uhqVU-">
        <div class="s-tacc" style="border-radius:20px">
          <div class="s-tlbl">${esc(model.countsLabel)}</div>
          <div class="s-tval" style="font-size:32px;font-weight:800">${model.totalJobs}</div>
        </div>
        <div class="s-tok" style="border-radius:20px">
          <div class="s-tlbl">${esc(model.timeframeLabel)}</div>
          <div class="s-_c4-r2">${esc(dateStamp)}</div>
        </div>
        <a href="${esc(model.sisterLinkHref)}" class="s-twrn" style="border-radius:20px;text-decoration:none;font-weight:700;display:flex;align-items:center">${esc(model.sisterLinkLabel)} →</a>
      </section>
      <section class="s-ziawP1">
        <div class="s-r2QmTP">
          <h2 style="${H2_STYLE};margin:0">${esc(model.jobsLabel)}</h2>
          <a href="${openAllHref}" style="${LINK_ACCENT_STYLE};font-weight:700">${esc(model.openAllLabel)} →</a>
        </div>
        ${jobsHtml}
      </section>
      ${proseHtml}
      ${faqHtml}
      ${commuterContextHtml}
    </main>${railGutters(true).close}
    <div id="footer-root"></div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;

          // Write both /path/index.html and /path.html to match existing pattern
          const outDir = np.join(distDir, canonicalPath.slice(1));
          ensureDir(outDir);
          const indexFile = np.join(outDir, 'index.html');
          fs.writeFileSync(indexFile, html, 'utf-8');
          const flatPath = canonicalPath.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
            ensureDir(np.dirname(flatFile));
            fs.writeFileSync(flatFile, html, 'utf-8');
          }

          // Every locale gets its own reciprocal <loc> entry (all 4 carry the
          // same alternate set) — an IT-only push here would leave en/de/fr
          // as one-sided alternates, stripped by sanitizeSitemapHreflangReciprocity.
          const altLinks = LOCALES.map((altLocale) => {
            const altSlug = JOB_RECENCY_LANDING_SLUGS[variant][altLocale];
            const altPath = withSlash(
              `${LOCALE_PREFIX[altLocale]}/${SECTION_BY_LOCALE[altLocale]}/${altSlug}`.replace(/\/+/g, '/'),
            );
            return `    <xhtml:link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${altPath}" />`;
          }).join('\n');
          // x-default always anchors to the IT canonical, regardless of which
          // locale this <url> block itself represents.
          const itSlug = JOB_RECENCY_LANDING_SLUGS[variant].it;
          const itUrl = `${BASE_URL}${withSlash(
            `${LOCALE_PREFIX.it}/${SECTION_BY_LOCALE.it}/${itSlug}`.replace(/\/+/g, '/'),
          )}`;
          const priority = variant === 'last-3-days' ? '0.9' : '0.8';
          sitemapEntries.push(
            `  <url>\n    <loc>${canonicalUrl}</loc>\n${altLinks}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${itUrl}" />\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>hourly</changefreq>\n    <priority>${priority}</priority>\n  </url>`,
          );
        }
      }

      // Write sitemap-recency.xml.
      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemapEntries.join('\n')}
</urlset>
`;
        try {
          const sitemapPath = np.join(distDir, 'sitemap-recency.xml');
          fs.writeFileSync(sitemapPath, sitemapXml, 'utf-8');
        } catch (err) {
          console.warn('[job-recency-pages] failed to write sitemap-recency.xml', err);
        }
      }

      console.log(
        `\x1b[36m[job-recency-pages]\x1b[0m Generated ${LOCALES.length * VARIANTS.length} recency hubs (${validJobsBase.length} candidate jobs)`,
      );

      // Always-run: patch sitemap.xml index lastmod entry. Other plugins
      // regenerate sitemap.xml every build, so our entry's <lastmod> would
      // otherwise drop out. Runs whether the cache hit or miss, but only
      // when our sitemap actually exists (freshly written or restored).
      if (fs.existsSync(np.join(distDir, 'sitemap-recency.xml'))) {
        try {
          const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
          if (fs.existsSync(sitemapIndexPath)) {
            let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
            if (!idx.includes('sitemap-recency.xml')) {
              idx = idx.replace(
                '</sitemapindex>',
                `  <sitemap>\n    <loc>${BASE_URL}/sitemap-recency.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
              );
            } else {
              idx = idx.replace(
                /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-recency\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
                `$1${dateStamp}$2`,
              );
            }
            fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
          }
        } catch (err) {
          console.warn('[job-recency-pages] sitemap-index patch failed', err);
        }
      }
    },
  };
}
