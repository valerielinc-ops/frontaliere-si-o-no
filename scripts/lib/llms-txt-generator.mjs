/**
 * llms-txt-generator.mjs — shared llms.txt / llms-full.txt family generator.
 *
 * Extracted from build-plugins/llmsTxtPlugin.ts (issue #4881 Fase 3,
 * pushable-origin fast-publish): llms.txt is NOT a static file — it is
 * regenerated at build time (current date, article count, job-board stats,
 * a page index parsed from the sitemaps) by that Vite plugin's
 * `closeBundle` hook. The fast-publish pipeline needs the SAME regeneration
 * runnable OUTSIDE a full Vite build, so the logic lives HERE and both
 * callers share one implementation:
 *   - build-plugins/llmsTxtPlugin.ts   (full build, writes into dist/)
 *   - scripts/generate-llms-txt.mjs    (fast-publish CLI, writes into a
 *                                        scratch --out dir it seeds itself)
 *
 * Contract: `distDir` is an OUTPUT directory that must already contain
 * `llms.txt` / `llms-full.txt` seeded from `public/` before this runs (Vite
 * does that seeding implicitly via its publicDir-copy-before-closeBundle
 * step; the standalone CLI replicates it explicitly). This module NEVER
 * reads from or writes to `public/llms.txt` directly — the placeholder
 * substitutions below (date, counts) are only idempotent if the input is
 * always the pristine seed, never a previously-patched output. Patching the
 * seed file in place would compound substitutions on every run.
 */
import path from 'node:path';
import { isJobBoardSectionPath } from './jobBoardSections.mjs';
import { discoverSitemapFiles } from '../../build-plugins/sitemapAliasPlugin.ts';

export const BASE_URL = 'https://frontaliereticino.ch';

// Guaranteed-minimum floor — never drop below this even if dynamic
// discovery (below) runs before every feature plugin has emitted its own
// sitemap-*.xml into dist/. The real, complete file list is discovered at
// build time via `discoverSitemapFiles(distDir)` (same source of truth
// sitemapAliasPlugin.ts uses to regenerate dist/sitemap.xml — issue #4413's
// sibling: this hardcoded array used to be the ONLY source, silently
// missing dozens of newer template families' sub-sitemaps from the
// llms.txt page index).
export const SITEMAP_FILES = [
  'sitemap-pages.xml', 'sitemap-blog.xml', 'sitemap-blog-ch.xml', 'sitemap-glossario.xml',
  'sitemap-news.xml', 'sitemap-jobs.xml',
  // AE-5 — 100-Q&A FAQ hub (emitted by faqHubPlugin; lives in dist/ only,
  // parser falls back silently if the file is absent in publicDir).
  'sitemap-faq-hub.xml',
];

/**
 * Union of the static floor above with every `sitemap-*.xml` actually
 * present in `distDir` (mirrors sitemapAliasPlugin's own discovery — same
 * pattern/exclusions). Falls back to the static list alone when `distDir`
 * is unavailable (e.g. a caller running outside a full build, or the
 * fast-publish scratch dir simply not containing build-time-only sitemaps).
 * @param {string} [distDir]
 * @returns {Promise<string[]>}
 */
export async function resolveSitemapFileList(distDir) {
  if (!distDir) return SITEMAP_FILES;
  try {
    const discovered = await discoverSitemapFiles(distDir);
    return [...new Set([...SITEMAP_FILES, ...discovered.map((d) => d.file)])];
  } catch {
    return SITEMAP_FILES;
  }
}

/**
 * Parse sub-sitemaps and return URLs for a specific locale.
 * locale='it' returns Italian-only (no prefix); 'en'/'de'/'fr' returns those prefixed URLs.
 * @param {string} publicDir
 * @param {typeof import('node:fs')} fs
 * @param {'it'|'en'|'de'|'fr'} [locale]
 * @param {string} [distDir]
 * @param {readonly string[]} [sitemapFiles]
 * @returns {string[]}
 */
export function parseSitemapUrls(publicDir, fs, locale = 'it', distDir, sitemapFiles = SITEMAP_FILES) {
  const urls = [];
  const readSitemap = (file) => {
    // Prefer publicDir (committed sitemaps), fall back to distDir for
    // build-time generated sitemaps (e.g. sitemap-faq-hub.xml emitted by
    // faqHubPlugin into dist/ only).
    try { return fs.readFileSync(path.join(publicDir, file), 'utf-8'); } catch { /* fall through */ }
    if (distDir) {
      try { return fs.readFileSync(path.join(distDir, file), 'utf-8'); } catch { /* skip */ }
    }
    return null;
  };
  for (const file of sitemapFiles) {
    const content = readSitemap(file);
    if (content === null) continue;
    try {
      if (locale === 'it') {
        // <loc> tags hold Italian URLs
        const locRx = /<loc>([^<]+)<\/loc>/g;
        let m;
        while ((m = locRx.exec(content)) !== null) {
          const loc = m[1];
          if (!loc.startsWith(BASE_URL)) continue;
          const urlPath = loc.replace(BASE_URL, '') || '/';
          if (/^\/(en|de|fr)(\/|$)/.test(urlPath)) continue;
          urls.push(urlPath.replace(/\/+$/, '') || '/');
        }
      } else {
        // hreflang alternate links for this locale
        const hrefRx = new RegExp(`hreflang="${locale}"\\s+href="([^"]+)"`, 'g');
        let m;
        while ((m = hrefRx.exec(content)) !== null) {
          const href = m[1];
          if (!href.startsWith(BASE_URL)) continue;
          const urlPath = href.replace(BASE_URL, '') || '/';
          urls.push(urlPath.replace(/\/+$/, '') || `/${locale}`);
        }
      }
    } catch { /* skip missing sitemap */ }
  }
  return [...new Set(urls)].sort();
}

/**
 * Extract SEO titles/descriptions from seoService source files for page index.
 * @param {string} rootDir
 * @param {typeof import('node:fs')} fs
 * @returns {Map<string, { title: string; desc: string }>}
 */
export function parseSeoEntries(rootDir, fs) {
  // Auto-discover all seo-blog-N.ts chunks (seo-blog.ts, seo-blog-2.ts, …, up to seo-blog-20.ts)
  const blogChunkFiles = [path.resolve(rootDir, 'services/seo/seo-blog.ts')];
  for (let n = 2; n <= 20; n++) {
    const p = path.resolve(rootDir, `services/seo/seo-blog-${n}.ts`);
    try { fs.accessSync(p); blogChunkFiles.push(p); } catch { break; }
  }
  const seoFiles = [
    path.resolve(rootDir, 'services/seoService.ts'),
    path.resolve(rootDir, 'services/seo/seo-pages.ts'),
    ...blogChunkFiles,
    path.resolve(rootDir, 'services/seo/seo-landing.ts'),
  ];
  let seoSrc = '';
  for (const sf of seoFiles) {
    try { seoSrc += fs.readFileSync(sf, 'utf-8') + '\n'; } catch { /* skip */ }
  }

  const map = new Map();

  // Find all canonicalPath positions, then for each one extract title/desc
  // from only the text between this entry and the previous/next canonicalPath
  // to avoid cross-contamination between adjacent entries
  const cpRx = /canonicalPath:\s*'([^']+)'/g;
  const matches = [];
  let cm;
  while ((cm = cpRx.exec(seoSrc)) !== null) {
    matches.push({ cp: cm[1], idx: cm.index });
  }

  for (let i = 0; i < matches.length; i++) {
    const { cp, idx } = matches[i];
    // Block boundaries: from the previous entry's canonicalPath (or 1500 chars before)
    // to the next entry's canonicalPath (or 1500 chars after)
    const blockStart = i > 0 ? matches[i - 1].idx : Math.max(0, idx - 1500);
    const blockEnd = i < matches.length - 1 ? matches[i + 1].idx : Math.min(seoSrc.length, idx + 1500);
    const block = seoSrc.substring(blockStart, blockEnd);

    // Find the title closest to our canonicalPath within this block
    const localOffset = idx - blockStart;
    const beforeCp = block.substring(0, localOffset);

    // Look for title:/description: before our canonicalPath (same entry),
    // accepting BOTH single- and double-quoted values. seo-pages.ts mixes styles
    // (metodologia + author entries use `description: "…"`); a single-quote-only
    // regex left those curated pages with an EMPTY llms.txt description (#2996,
    // sibling of the staticPagesPlugin matchStr fix).
    const lastQuoted = (key) => {
      const single = [...beforeCp.matchAll(new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))];
      const pool = single.length > 0
        ? single
        : [...beforeCp.matchAll(new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g'))];
      return pool.length > 0 ? pool[pool.length - 1][1] : '';
    };
    const title = lastQuoted('title').replace(/\\'/g, "'").replace(/\s*\|\s*Frontaliere Ticino$/, '').trim();
    const desc = lastQuoted('description').replace(/\\'/g, "'").trim().slice(0, 160);

    // Key form must match parseSitemapUrls output, which strips trailing
    // slashes — hand-written canonicalPath values are stored WITH a trailing
    // slash, so keying the raw cp made every curated entry miss at lookup
    // (same slash-divergence class fixed in staticPagesPlugin's seoMap).
    if (title) map.set(cp.replace(/\/+$/, '') || '/', { title, desc });
  }
  return map;
}

/**
 * Group URLs into categories for the page index.
 * @param {string[]} urls
 * @param {'it'|'en'|'de'|'fr'} [locale]
 * @returns {Map<string, string[]>}
 */
export function categorizeUrls(urls, locale = 'it') {
  const categories = new Map();
  const order = [
    'Tax & Salary Calculators',
    'Service Comparators',
    'Tax & Pension',
    'Practical Guides',
    'Life in Ticino',
    'Statistics',
    'Job Board',
    'Blog Articles',
    'Glossary',
    'Other Pages',
  ];
  for (const cat of order) categories.set(cat, []);

  // Locale-specific path prefixes (Italian has no locale prefix)
  const prefixMap = {
    it: { calc: '/calcola-stipendio', comp: '/compara-servizi', tax: '/tasse-e-pensione', guide: '/guida-frontaliere', life: '/vivere-in-ticino', stats: '/statistiche', jobOffer: '/offerta-lavoro', blog: '/articoli-frontaliere', gloss: '/glossario-frontaliere' },
    en: { calc: '/en/calculate-salary', comp: '/en/service-comparison', tax: '/en/taxes-and-pension', guide: '/en/cross-border-guide', life: '/en/living-in-ticino', stats: '/en/statistics', jobOffer: '/en/job-offer', blog: '/en/cross-border-articles', gloss: '/en/cross-border-glossary' },
    de: { calc: '/de/gehalt-berechnen', comp: '/de/service-vergleich', tax: '/de/grenzgaenger-besteuerung-leitfaden-2026', guide: '/de/grenzgaenger-ratgeber', life: '/de/leben-im-tessin', stats: '/de/statistiken', jobOffer: '/de/stellenangebot', blog: '/de/grenzgaenger-artikel', gloss: '/de/grenzgaenger-glossar' },
    fr: { calc: '/fr/calculer-salaire', comp: '/fr/comparaison-services', tax: '/fr/impots-et-retraite', guide: '/fr/guide-frontalier', life: '/fr/vivre-au-tessin', stats: '/fr/statistiques', jobOffer: '/fr/offre-emploi', blog: '/fr/articles-frontalier', gloss: '/fr/glossaire-frontalier' },
  };
  const p = prefixMap[locale];

  for (const url of urls) {
    if (url === '/' || url === `/${locale}`) { categories.get('Other Pages').push(url); continue; }
    if (url.startsWith(p.calc)) categories.get('Tax & Salary Calculators').push(url);
    else if (url.startsWith(p.comp)) categories.get('Service Comparators').push(url);
    else if (url.startsWith(p.tax)) categories.get('Tax & Pension').push(url);
    else if (url.startsWith(p.guide)) categories.get('Practical Guides').push(url);
    else if (url.startsWith(p.life)) categories.get('Life in Ticino').push(url);
    else if (url.startsWith(p.stats)) categories.get('Statistics').push(url);
    else if (isJobBoardSectionPath(url) || url.startsWith(p.jobOffer)) categories.get('Job Board').push(url);
    else if (url.startsWith(p.blog)) categories.get('Blog Articles').push(url);
    else if (url.startsWith(p.gloss)) categories.get('Glossary').push(url);
    else categories.get('Other Pages').push(url);
  }
  return categories;
}

/**
 * Generate/patch the llms.txt family in `distDir` (in place). `distDir` must
 * already contain `llms.txt` / `llms-full.txt` (seeded from `publicDir` by
 * the caller before invoking this — see module doc). Mirrors
 * build-plugins/llmsTxtPlugin.ts's former closeBundle body exactly; the only
 * behavioural difference is that paths are caller-supplied instead of
 * derived from `rootDir` internally, so a non-Vite caller can point
 * `distDir` at a scratch directory instead of a real `dist/`.
 * @param {{ rootDir: string; publicDir: string; distDir: string }} options
 * @returns {Promise<void>}
 */
export async function generateLlmsTxtFamily({ rootDir, publicDir, distDir }) {
  const fs = await import('node:fs');

  const now = new Date();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const monthYear = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
  const isoDate = now.toISOString().slice(0, 10);

  // Count blog articles from dist
  let articleCount = 0;
  try {
    const blogDir = path.join(distDir, 'articoli-frontaliere');
    if (fs.existsSync(blogDir)) {
      articleCount = fs.readdirSync(blogDir, { withFileTypes: true })
        .filter((d) => d.isDirectory()).length;
    }
  } catch { /* fallback: keep original text */ }

  // Parse all sitemap URLs and SEO metadata for auto-generated page index.
  // sitemapFiles = static floor UNION whatever sitemap-*.xml plugins have
  // actually emitted into dist/ by this point (#4413 sibling fix).
  const sitemapFiles = await resolveSitemapFileList(distDir);
  const allUrls = parseSitemapUrls(publicDir, fs, 'it', distDir, sitemapFiles);
  const seoMap = parseSeoEntries(rootDir, fs);
  const categorized = categorizeUrls(allUrls);
  void categorized; // kept for parity with the original body (unused beyond this point there too)

  /** Build a page index section for a given locale's URLs. */
  function buildPageIndex(urls, locale) {
    const cats = categorizeUrls(urls, locale);
    const lines = [
      '',
      '---',
      '',
      '## Complete Page Index (Auto-Generated)',
      '',
      `> This index is automatically generated at build time from all sitemaps. Total: ${urls.length} pages.`,
      '',
    ];
    for (const [category, catUrls] of cats) {
      if (catUrls.length === 0) continue;
      lines.push(`### ${category} (${catUrls.length} pages)`);
      lines.push('');
      for (const url of catUrls) {
        const seo = seoMap.get(url);
        // Emit with trailing slash: the internal form is slash-stripped (seoMap
        // key contract), but every canonical page URL is slash-terminated and
        // no-slash links now 301 at the edge (#3525).
        const fullUrl = url === '/' ? `${BASE_URL}/` : `${BASE_URL}${url}/`;
        if (seo) {
          lines.push(`- [${seo.title}](${fullUrl}) — ${seo.desc || 'No description available'}`);
        } else {
          const slug = url.split('/').filter(Boolean).pop() || 'Home';
          const readable = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          lines.push(`- [${readable}](${fullUrl})`);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  // Concise summary for llms.txt (#3527): the full per-URL index made
  // llms.txt ~915KB (97% of llms-full.txt), defeating the concise/full
  // two-file contract. llms.txt gets category counts + a pointer; the
  // complete index lives only in llms-full.txt.
  function buildPageIndexSummary(urls) {
    const cats = categorizeUrls(urls, 'it');
    const lines = [
      '',
      '---',
      '',
      '## Page Index (Auto-Generated Summary)',
      '',
      `> ${urls.length} pages across the site, auto-counted at build time from all sitemaps. The complete per-URL index with titles and descriptions is in [/llms-full.txt](${BASE_URL}/llms-full.txt).`,
      '',
    ];
    for (const [category, catUrls] of cats) {
      if (catUrls.length === 0) continue;
      lines.push(`- **${category}**: ${catUrls.length} pages`);
    }
    lines.push('');
    return lines.join('\n');
  }

  const pageIndexSection = buildPageIndex(allUrls, 'it');
  const pageIndexSummarySection = buildPageIndexSummary(allUrls);

  /**
   * Inject dynamic job board stats (job count + employer count) from the
   * assembled dataset. jobs.json is nationwide (all Swiss cantons, not just
   * Ticino — see cathedral migration #1275+), so the employer count must be
   * labelled accordingly rather than hardcoded to "Ticino employers".
   */
  function injectJobBoardStats(content, dir) {
    const jobsDataPath = path.join(dir, 'data', 'jobs.json');
    if (!fs.existsSync(jobsDataPath)) return content;
    try {
      const jobsRaw = JSON.parse(fs.readFileSync(jobsDataPath, 'utf-8'));
      const activeJobs = Array.isArray(jobsRaw) ? jobsRaw : (jobsRaw.jobs ?? []);
      const jobCount = activeJobs.length;
      const companyCount = new Set(activeJobs.map((j) => j.company).filter(Boolean)).size;
      if (jobCount > 0) {
        content = content.replace(/1[,.]?500\+?\s*(?:active\s+)?(?:job\s+)?(?:listings|offerte|posizioni)/gi, `${jobCount.toLocaleString('en-US')}+ job listings`);
        content = content.replace(/100\+?\s*(?:companies|aziende|employers|Ticino employers)/gi, `${companyCount}+ Swiss employers`);
      }
    } catch { /* jobs.json not parseable, keep static counts */ }
    return content;
  }

  // Update llms.txt
  const llmsPath = path.join(distDir, 'llms.txt');
  if (fs.existsSync(llmsPath)) {
    let content = fs.readFileSync(llmsPath, 'utf-8');
    content = content.replace(
      /\*\*Last Updated\*\*:\s*.+/,
      `**Last Updated**: ${monthYear}`,
    );
    if (articleCount > 0) {
      content = content.replace(
        /\d+\+?\s*Blog Articles/,
        `${articleCount}+ Blog Articles`,
      );
    }
    // Inject dynamic job board statistics from actual data
    content = injectJobBoardStats(content, distDir);
    // Append auto-generated page-index SUMMARY (#3527) — replace an existing
    // summary or a legacy full index (old marker) if present, idempotently.
    const summaryMarker = '## Page Index (Auto-Generated Summary)';
    const legacyMarker = '## Complete Page Index (Auto-Generated)';
    const markerIdx = [content.indexOf(summaryMarker), content.indexOf(legacyMarker)]
      .filter((i) => i !== -1)
      .reduce((a, b) => Math.min(a, b), Infinity);
    if (markerIdx !== Infinity) {
      // Find the separator before the auto-generated section
      const beforeMarker = content.lastIndexOf('---', markerIdx);
      content = content.substring(0, beforeMarker !== -1 ? beforeMarker : markerIdx).trimEnd() + '\n' + pageIndexSummarySection;
    } else {
      content = content.trimEnd() + '\n' + pageIndexSummarySection;
    }
    fs.writeFileSync(llmsPath, content);
  }

  // Update llms-full.txt
  const llmsFullPath = path.join(distDir, 'llms-full.txt');
  if (fs.existsSync(llmsFullPath)) {
    let content = fs.readFileSync(llmsFullPath, 'utf-8');
    content = content.replace(
      /\*\*Last Updated\*\*:\s*.+/,
      `**Last Updated**: ${isoDate}`,
    );
    // Update trailing "last updated on <date>" text
    content = content.replace(
      /last updated on \w+ \d{1,2}, \d{4}/g,
      `last updated on ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
    );
    // Update inline "Month YYYY" source date references (e.g., "March 2026")
    content = content.replace(
      /(?<=Source:.*?)\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b(?=\))/g,
      monthYear,
    );
    // Update "verified as of Month YYYY" references
    content = content.replace(
      /verified as of \w+ \d{4}/g,
      `verified as of ${monthYear}`,
    );
    // Inject dynamic job board statistics from actual data
    content = injectJobBoardStats(content, distDir);
    // Append page index to llms-full.txt as well
    const autoGenMarker = '## Complete Page Index (Auto-Generated)';
    const markerIdx = content.indexOf(autoGenMarker);
    if (markerIdx !== -1) {
      const beforeMarker = content.lastIndexOf('---', markerIdx);
      content = content.substring(0, beforeMarker !== -1 ? beforeMarker : markerIdx).trimEnd() + '\n' + pageIndexSection;
    } else {
      content = content.trimEnd() + '\n' + pageIndexSection;
    }
    fs.writeFileSync(llmsFullPath, content);
  }

  // Copy llms.txt to .well-known/llms.txt (some AI systems look there)
  const wellKnownDir = path.join(distDir, '.well-known');
  fs.mkdirSync(wellKnownDir, { recursive: true });
  if (fs.existsSync(llmsPath)) {
    fs.copyFileSync(llmsPath, path.join(wellKnownDir, 'llms.txt'));
  }

  // Generate locale-specific llms.txt for EN, DE, FR
  const localeHeaders = {
    en: {
      lang: 'English',
      description: 'Frontaliere Ticino is a comprehensive free web application for cross-border workers ("frontalieri") commuting between Italy and Switzerland, covering Cantons Ticino, Graubünden, and Valais. It provides fiscal simulation tools, pension planning, health insurance comparison, currency exchange calculators, transport cost tools, job board, and practical guides.',
      audience: 'English-speaking cross-border workers commuting between Italy and Switzerland (Ticino, Graubünden, Valais)',
    },
    de: {
      lang: 'German',
      description: 'Frontaliere Ticino ist eine umfassende kostenlose Webanwendung für Grenzgänger, die zwischen Italien und der Schweiz pendeln, insbesondere in den Kantonen Tessin, Graubünden und Wallis. Sie bietet Steuersimulationstools, Pensionsplanung, Krankenversicherungsvergleich, Währungsumrechner, Transportkostenrechner, Jobbörse und praktische Leitfäden.',
      audience: 'Deutschsprachige Grenzgänger, die zwischen Italien und der Schweiz (Tessin, Graubünden, Wallis) pendeln',
    },
    fr: {
      lang: 'French',
      description: 'Frontaliere Ticino est une application web gratuite et complète pour les travailleurs frontaliers qui font la navette entre l\'Italie et la Suisse, couvrant les Cantons du Tessin, des Grisons et du Valais. Elle propose des outils de simulation fiscale, de planification de retraite, de comparaison d\'assurance maladie, de conversion de devises, de calcul des frais de transport, un portail emploi et des guides pratiques.',
      audience: 'Travailleurs frontaliers francophones faisant la navette entre l\'Italie et la Suisse (Tessin, Grisons, Valais)',
    },
  };

  let localeCount = 0;
  for (const [locale, header] of Object.entries(localeHeaders)) {
    const localeUrls = parseSitemapUrls(publicDir, fs, locale, distDir, sitemapFiles);
    if (localeUrls.length === 0) continue;

    const localeIndex = buildPageIndex(localeUrls, locale);
    const otherLocales = ['it', 'en', 'de', 'fr'].filter((l) => l !== locale);
    const alternateLinks = otherLocales.map((l) =>
      l === 'it'
        ? `- Italian (primary): [/llms.txt](${BASE_URL}/llms.txt)`
        : `- ${l === 'en' ? 'English' : l === 'de' ? 'German' : 'French'}: [/${l}/llms.txt](${BASE_URL}/${l}/llms.txt)`,
    ).join('\n');

    const content = `# Frontaliere Ticino (${header.lang})

> ${header.description}

## Site Identity

- **URL**: ${BASE_URL}/${locale}/
- **Name**: Frontaliere Ticino
- **Language**: ${header.lang} (this file) — also available in Italian (primary), ${otherLocales.filter((l) => l !== 'it').map((l) => l === 'en' ? 'English' : l === 'de' ? 'German' : 'French').join(', ')}
- **Type**: Free web application, no registration required
- **Last Updated**: ${monthYear}
- **Audience**: ${header.audience}
- **Content Authority**: Original, factual content based on official Swiss and Italian tax regulations, BFS/UST statistics, and UFSP/BAG health insurance data

## Alternate Language Versions

${alternateLinks}
- Full domain knowledge (Italian): [/llms-full.txt](${BASE_URL}/llms-full.txt)
- Sitemap: [/sitemap.xml](${BASE_URL}/sitemap.xml)
${localeIndex}`;

    const localeDir = path.join(distDir, locale);
    fs.mkdirSync(localeDir, { recursive: true });
    fs.writeFileSync(path.join(localeDir, 'llms.txt'), content);
    localeCount++;
  }

  // Auto-update citation_date and ai-content-declaration in dist/index.html
  // (no-op when index.html isn't present in distDir — e.g. the fast-publish
  // scratch dir, which never contains one; existsSync guard handles it).
  const distIndexPath = path.join(distDir, 'index.html');
  if (fs.existsSync(distIndexPath)) {
    let indexHtml = fs.readFileSync(distIndexPath, 'utf-8');
    // Update citation_date to today
    indexHtml = indexHtml.replace(
      /(<meta\s+name="citation_date"\s+content=")[^"]*(")/,
      `$1${isoDate}$2`,
    );
    // Update "Updated Month Year" in ai-content-declaration
    indexHtml = indexHtml.replace(
      /(Updated\s+)\w+\s+\d{4}(?=\.\s*")/,
      `$1${monthYear}`,
    );
    fs.writeFileSync(distIndexPath, indexHtml);
  }

  console.log(`\x1b[36m[llms-txt]\x1b[0m Updated llms.txt (${monthYear}) and llms-full.txt (${isoDate})${articleCount ? `, ${articleCount} articles` : ''}, page index: ${allUrls.length} URLs, .well-known/llms.txt copied${localeCount ? `, ${localeCount} locale llms.txt files` : ''}`);
}
