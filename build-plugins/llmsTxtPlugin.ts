/**
 * Auto-update llms.txt and llms-full.txt with current build date, article count,
 * and a comprehensive auto-generated page index from all sitemaps.
 * Ensures AI search engines always see fresh metadata and can discover ALL pages.
 */

import path from 'path';
import type { Plugin } from 'vite';

const BASE_URL = 'https://frontaliereticino.ch';

const SITEMAP_FILES = [
 'sitemap-pages.xml', 'sitemap-blog.xml', 'sitemap-glossario.xml',
 'sitemap-news.xml', 'sitemap-jobs.xml',
 // AE-5 — 100-Q&A FAQ hub (emitted by faqHubPlugin; lives in dist/ only,
 // parser falls back silently if the file is absent in publicDir).
 'sitemap-faq-hub.xml',
];

/**
 * Parse sub-sitemaps and return URLs for a specific locale.
 * locale='it' returns Italian-only (no prefix); 'en'/'de'/'fr' returns those prefixed URLs.
 */
function parseSitemapUrls(publicDir: string, fs: typeof import('node:fs'), locale: 'it' | 'en' | 'de' | 'fr' = 'it', distDir?: string): string[] {
 const urls: string[] = [];
 const readSitemap = (file: string): string | null => {
  // Prefer publicDir (committed sitemaps), fall back to distDir for
  // build-time generated sitemaps (e.g. sitemap-faq-hub.xml emitted by
  // faqHubPlugin into dist/ only).
  try { return fs.readFileSync(path.join(publicDir, file), 'utf-8'); } catch { /* fall through */ }
  if (distDir) {
   try { return fs.readFileSync(path.join(distDir, file), 'utf-8'); } catch { /* skip */ }
  }
  return null;
 };
 for (const file of SITEMAP_FILES) {
 const content = readSitemap(file);
 if (content === null) continue;
 try {
 if (locale === 'it') {
 // <loc> tags hold Italian URLs
 const locRx = /<loc>([^<]+)<\/loc>/g;
 let m: RegExpExecArray | null;
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
 let m: RegExpExecArray | null;
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

/** Extract SEO titles/descriptions from seoService source files for page index. */
function parseSeoEntries(rootDir: string, fs: typeof import('node:fs')): Map<string, { title: string; desc: string }> {
 const seoFiles = [
 path.resolve(rootDir, 'services/seoService.ts'),
 path.resolve(rootDir, 'services/seo/seo-pages.ts'),
 path.resolve(rootDir, 'services/seo/seo-blog.ts'),
 path.resolve(rootDir, 'services/seo/seo-blog-2.ts'),
 path.resolve(rootDir, 'services/seo/seo-landing.ts'),
 ];
 let seoSrc = '';
 for (const sf of seoFiles) {
 try { seoSrc += fs.readFileSync(sf, 'utf-8') + '\n'; } catch { /* skip */ }
 }

 const map = new Map<string, { title: string; desc: string }>();

 // Find all canonicalPath positions, then for each one extract title/desc
 // from only the text between this entry and the previous/next canonicalPath
 // to avoid cross-contamination between adjacent entries
 const cpRx = /canonicalPath:\s*'([^']+)'/g;
 const matches: { cp: string; idx: number }[] = [];
 let cm: RegExpExecArray | null;
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

 // Look for title: '...' in the text before our canonicalPath (same entry)
 const titleMatches = [...beforeCp.matchAll(/title:\s*'((?:[^'\\]|\\.)*)'/g)];
 const title = titleMatches.length > 0
 ? titleMatches[titleMatches.length - 1][1].replace(/\\'/g, "'").replace(/\s*\|\s*Frontaliere Ticino$/, '').trim()
 : '';

 const descMatches = [...beforeCp.matchAll(/description:\s*'((?:[^'\\]|\\.)*)'/g)];
 const desc = descMatches.length > 0
 ? descMatches[descMatches.length - 1][1].replace(/\\'/g, "'").trim().slice(0, 160)
 : '';

 if (title) map.set(cp, { title, desc });
 }
 return map;
}

/** Group URLs into categories for the page index. */
function categorizeUrls(urls: string[], locale: 'it' | 'en' | 'de' | 'fr' = 'it'): Map<string, string[]> {
 const categories = new Map<string, string[]>();
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
 const prefixMap: Record<string, Record<string, string>> = {
 it: { calc: '/calcola-stipendio', comp: '/compara-servizi', tax: '/tasse-e-pensione', guide: '/guida-frontaliere', life: '/vivere-in-ticino', stats: '/statistiche', job: '/cerca-lavoro', jobOffer: '/offerta-lavoro', blog: '/articoli-frontaliere', gloss: '/glossario-frontaliere' },
 en: { calc: '/en/calculate-salary', comp: '/en/compare-services', tax: '/en/taxes-and-pension', guide: '/en/cross-border-guide', life: '/en/living-in-ticino', stats: '/en/statistics', job: '/en/job-search', jobOffer: '/en/job-offer', blog: '/en/cross-border-articles', gloss: '/en/cross-border-glossary' },
 de: { calc: '/de/gehalt-berechnen', comp: '/de/dienste-vergleichen', tax: '/de/steuern-und-rente', guide: '/de/grenzgaenger-leitfaden', life: '/de/leben-im-tessin', stats: '/de/statistiken', job: '/de/jobsuche', jobOffer: '/de/stellenangebot', blog: '/de/grenzgaenger-artikel', gloss: '/de/grenzgaenger-glossar' },
 fr: { calc: '/fr/calculer-salaire', comp: '/fr/comparer-services', tax: '/fr/impots-et-retraite', guide: '/fr/guide-frontalier', life: '/fr/vivre-au-tessin', stats: '/fr/statistiques', job: '/fr/recherche-emploi', jobOffer: '/fr/offre-emploi', blog: '/fr/articles-frontaliers', gloss: '/fr/glossaire-frontalier' },
 };
 const p = prefixMap[locale];

 for (const url of urls) {
 if (url === '/' || url === `/${locale}`) { categories.get('Other Pages')!.push(url); continue; }
 if (url.startsWith(p.calc)) categories.get('Tax & Salary Calculators')!.push(url);
 else if (url.startsWith(p.comp)) categories.get('Service Comparators')!.push(url);
 else if (url.startsWith(p.tax)) categories.get('Tax & Pension')!.push(url);
 else if (url.startsWith(p.guide)) categories.get('Practical Guides')!.push(url);
 else if (url.startsWith(p.life)) categories.get('Life in Ticino')!.push(url);
 else if (url.startsWith(p.stats)) categories.get('Statistics')!.push(url);
 else if (url.startsWith(p.job) || url.startsWith(p.jobOffer)) categories.get('Job Board')!.push(url);
 else if (url.startsWith(p.blog)) categories.get('Blog Articles')!.push(url);
 else if (url.startsWith(p.gloss)) categories.get('Glossary')!.push(url);
 else categories.get('Other Pages')!.push(url);
 }
 return categories;
}

export function llmsTxtPlugin(rootDir: string): Plugin {
 return {
 name: 'llms-txt-update',
 apply: 'build',
 async closeBundle() {
 const fs = await import('node:fs');
 const distDir = path.resolve(rootDir, 'dist');
 const publicDir = path.resolve(rootDir, 'public');

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
 .filter((d: any) => d.isDirectory()).length;
 }
 } catch { /* fallback: keep original text */ }

 // Parse all sitemap URLs and SEO metadata for auto-generated page index
 const allUrls = parseSitemapUrls(publicDir, fs, 'it', distDir);
 const seoMap = parseSeoEntries(rootDir, fs);
 const categorized = categorizeUrls(allUrls);

 /** Build a page index section for a given locale's URLs. */
 function buildPageIndex(urls: string[], locale: 'it' | 'en' | 'de' | 'fr'): string {
 const cats = categorizeUrls(urls, locale);
 const lines: string[] = [
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
 const fullUrl = `${BASE_URL}${url}`;
 if (seo) {
 lines.push(`- [${seo.title}](${fullUrl}) — ${seo.desc || 'No description available'}`);
 } else {
 const slug = url.split('/').filter(Boolean).pop() || 'Home';
 const readable = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
 lines.push(`- [${readable}](${fullUrl})`);
 }
 }
 lines.push('');
 }
 return lines.join('\n');
 }

 const pageIndexSection = buildPageIndex(allUrls, 'it');

 // Update llms.txt
 const llmsPath = path.join(distDir, 'llms.txt');
 if (fs.existsSync(llmsPath)) {
 let content = fs.readFileSync(llmsPath, 'utf-8');
 content = content.replace(
 /\*\*Last Updated\*\*:\s*.+/,
 `**Last Updated**: ${monthYear}`
 );
 if (articleCount > 0) {
 content = content.replace(
 /\d+\+?\s*Blog Articles/,
 `${articleCount}+ Blog Articles`
 );
 }
 // Inject dynamic job board statistics from actual data
 const jobsDataPathForSummary = path.join(distDir, 'data', 'jobs.json');
 if (fs.existsSync(jobsDataPathForSummary)) {
 try {
 const jobsRaw = JSON.parse(fs.readFileSync(jobsDataPathForSummary, 'utf-8'));
 const activeJobs = Array.isArray(jobsRaw) ? jobsRaw : (jobsRaw.jobs ?? []);
 const jobCount = activeJobs.length;
 const companyCount = new Set(activeJobs.map((j: any) => j.company).filter(Boolean)).size;
 if (jobCount > 0) {
 content = content.replace(/1[,.]?500\+?\s*(?:active\s+)?(?:job\s+)?(?:listings|offerte|posizioni)/gi, `${jobCount.toLocaleString('en-US')}+ job listings`);
 content = content.replace(/100\+?\s*(?:companies|aziende|employers|Ticino employers)/gi, `${companyCount}+ Ticino employers`);
 }
 } catch { /* jobs.json not parseable, keep static counts */ }
 }
 // Append auto-generated page index (replace existing if present)
 const autoGenMarker = '## Complete Page Index (Auto-Generated)';
 const markerIdx = content.indexOf(autoGenMarker);
 if (markerIdx !== -1) {
 // Find the separator before the auto-generated section
 const beforeMarker = content.lastIndexOf('---', markerIdx);
 content = content.substring(0, beforeMarker !== -1 ? beforeMarker : markerIdx).trimEnd() + '\n' + pageIndexSection;
 } else {
 content = content.trimEnd() + '\n' + pageIndexSection;
 }
 fs.writeFileSync(llmsPath, content);
 }

 // Update llms-full.txt
 const llmsFullPath = path.join(distDir, 'llms-full.txt');
 if (fs.existsSync(llmsFullPath)) {
 let content = fs.readFileSync(llmsFullPath, 'utf-8');
 content = content.replace(
 /\*\*Last Updated\*\*:\s*.+/,
 `**Last Updated**: ${isoDate}`
 );
 // Update trailing "last updated on <date>" text
 content = content.replace(
 /last updated on \w+ \d{1,2}, \d{4}/g,
 `last updated on ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
 );
 // Update inline "Month YYYY" source date references (e.g., "March 2026")
 content = content.replace(
 /(?<=Source:.*?)\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b(?=\))/g,
 monthYear
 );
 // Update "verified as of Month YYYY" references
 content = content.replace(
 /verified as of \w+ \d{4}/g,
 `verified as of ${monthYear}`
 );
 // Inject dynamic job board statistics from actual data
 const jobsDataPath = path.join(distDir, 'data', 'jobs.json');
 if (fs.existsSync(jobsDataPath)) {
 try {
 const jobsRaw = JSON.parse(fs.readFileSync(jobsDataPath, 'utf-8'));
 const activeJobs = Array.isArray(jobsRaw) ? jobsRaw : (jobsRaw.jobs ?? []);
 const jobCount = activeJobs.length;
 const companyCount = new Set(activeJobs.map((j: any) => j.company).filter(Boolean)).size;
 if (jobCount > 0) {
 content = content.replace(/1[,.]?500\+?\s*(?:active\s+)?(?:job\s+)?(?:listings|offerte|posizioni)/gi, `${jobCount.toLocaleString('en-US')}+ job listings`);
 content = content.replace(/100\+?\s*(?:companies|aziende|employers|Ticino employers)/gi, `${companyCount}+ Ticino employers`);
 }
 } catch { /* jobs.json not parseable, keep static counts */ }
 }
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
 const localeHeaders: Record<string, { lang: string; description: string; audience: string }> = {
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
 const localeUrls = parseSitemapUrls(publicDir, fs, locale as 'en' | 'de' | 'fr', distDir);
 if (localeUrls.length === 0) continue;

 const localeIndex = buildPageIndex(localeUrls, locale as 'en' | 'de' | 'fr');
 const otherLocales = ['it', 'en', 'de', 'fr'].filter(l => l !== locale);
 const alternateLinks = otherLocales.map(l =>
 l === 'it'
 ? `- Italian (primary): [/llms.txt](${BASE_URL}/llms.txt)`
 : `- ${l === 'en' ? 'English' : l === 'de' ? 'German' : 'French'}: [/${l}/llms.txt](${BASE_URL}/${l}/llms.txt)`
 ).join('\n');

 const content = `# Frontaliere Ticino (${header.lang})

> ${header.description}

## Site Identity

- **URL**: ${BASE_URL}/${locale}/
- **Name**: Frontaliere Ticino
- **Language**: ${header.lang} (this file) — also available in Italian (primary), ${otherLocales.filter(l => l !== 'it').map(l => l === 'en' ? 'English' : l === 'de' ? 'German' : 'French').join(', ')}
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
 },
 };
}
