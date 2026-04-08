#!/usr/bin/env node

/**
 * Pipeline validation: ensures all sitemap URLs have static files
 * with minimum content quality. Blocks deploy if sitemap URLs
 * reference pages that don't exist or have critically thin content.
 *
 * "Crawled - currently not indexed" prevention:
 *  - Every sitemap URL must have a corresponding index.html in dist/
 *  - Every sitemap page must have >50 words of visible text (BLOCKING)
 *  - Every job page in sitemap must have JobPosting schema
 *  - No noindex pages in sitemaps
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, extname } from 'path';

const DIST = 'dist';
const DOMAIN = 'https://frontaliereticino.ch/';
const MIN_WORDS = 50;

function extractSitemapUrls() {
  const sitemaps = readdirSync(DIST).filter(f =>
    f.startsWith('sitemap') && f.endsWith('.xml')
  );
  const urls = [];

  for (const sm of sitemaps) {
    const content = readFileSync(join(DIST, sm), 'utf-8');
    const locMatches = [...content.matchAll(/<loc>([^<]+)<\/loc>/g)];
    for (const m of locMatches) {
      const url = m[1];
      if (!url.startsWith(DOMAIN)) continue;
      const path = url.slice(DOMAIN.length).replace(/\/$/, '') || '';
      if (!path) continue; // skip homepage
      if (path.endsWith('.xml')) continue; // skip sub-sitemap references
      urls.push({ sitemap: sm, url, path });
    }
  }
  return urls;
}

function countWords(html) {
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.split(' ').filter(w => w.length > 0).length;
}

function hasJobPostingSchema(html) {
  return html.includes('"JobPosting"') || html.includes("'JobPosting'");
}

function isJobPage(path) {
  return /\/(cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//.test('/' + path);
}

function isIndividualJobPage(path) {
  if (!isJobPage(path)) return false;
  const slug = path.split('/').pop() || '';
  // Company pages (azienda-*, company-*, unternehmen-*, entreprise-*)
  if (/^(azienda|company|unternehmen|entreprise)-/.test(slug)) return false;
  // Search/filter pages (ricerca-*, search-*, suche-*, recherche-*)
  if (/^(ricerca|search|suche|recherche)-/.test(slug)) return false;
  // Category listing pages (categoria-*, category-*, kategorie-*, categorie-*)
  if (/^(categoria|category|kategorie|categorie)-/.test(slug)) return false;
  // Pagination pages (pagina-N, page-N, seite-N)
  if (/^(pagina|page|seite)-\d+$/.test(slug)) return false;
  // Filter combo pages (lavoro-part-time, part-time-jobs, teilzeit-jobs, emploi-partiel, etc.)
  if (/^(lavoro|jobs?|stellen|emploi|offerte)-(part-time|full-time|tempo-pieno|teilzeit|vollzeit|temps-partiel|temps-plein)/.test(slug)) return false;
  // Editorial hub pages (offerte-oggi, foglio-ufficiale, nurses hub, care clusters)
  const editorialSlugs = [
    'offerte-di-lavoro-ticino-oggi', 'ticino-jobs-today', 'jobs-tessin-heute', 'offres-emploi-tessin-aujourdhui',
    'foglio-ufficiale-offerte-di-lavoro-ticino', 'official-gazette-ticino-jobs', 'amtsblatt-stellen-tessin', 'feuille-officielle-emplois-tessin',
    'infermieri-in-ticino', 'nurses-in-ticino', 'pflege-jobs-im-tessin', 'infirmiers-au-tessin',
    'cliniche-ticino', 'clinics-ticino-jobs', 'kliniken-tessin-jobs', 'cliniques-tessin',
    'case-anziani-ticino', 'care-homes-ticino-jobs', 'altersheime-tessin-jobs', 'maisons-retraite-tessin',
    'oss-ticino', 'healthcare-assistants-ticino', 'pflegeassistenz-tessin', 'oss-tessin',
    'educatori-ticino', 'educators-ticino', 'paedagogen-tessin', 'educateurs-tessin',
  ];
  if (editorialSlugs.includes(slug)) return false;
  return true;
}

function hasNoindex(html) {
  return /<meta[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
}

function main() {
  const urls = extractSitemapUrls();
  console.log(`[validate-content] Checking ${urls.length} sitemap URLs...\n`);

  const missing = [];
  const thinContent = [];
  const jobsNoSchema = [];
  const noindexInSitemap = [];
  let errors = 0;

  for (const { sitemap, url, path } of urls) {
    // URLs with file extensions (e.g. .pdf) resolve directly, others get /index.html
    const hasExt = extname(path).length > 0;
    const filePath = hasExt ? join(DIST, path) : join(DIST, path, 'index.html');

    if (!existsSync(filePath)) {
      missing.push({ sitemap, path });
      errors++;
      continue;
    }

    // Skip content checks for non-HTML files (PDFs, etc.)
    if (hasExt && !path.endsWith('.html')) continue;

    const html = readFileSync(filePath, 'utf-8');

    // Skip previousSlug bridge pages — these are thin redirect pages by design.
    // Full-content bridges have __BRIDGE_TARGET_SLUG__, legacy bridges from
    // buildCanonicalBridgePage have "Apri la pagina" + non-self canonical.
    if (html.includes('__BRIDGE_TARGET_SLUG__')) {
      continue;
    }

    // Noindex pages in sitemaps is a conflict — BLOCKING
    if (hasNoindex(html)) {
      noindexInSitemap.push({ sitemap, path });
      errors++;
      continue;
    }

    const words = countWords(html);

    // Legacy bridge pages (buildCanonicalBridgePage output) are thin by design.
    // They have a canonical pointing to a different job page and simple redirect content.
    // Skip them from thin content checks.
    if (words < MIN_WORDS && isIndividualJobPage(path) && html.includes('Apri la pagina')) {
      continue;
    }

    if (words < MIN_WORDS) {
      thinContent.push({ sitemap, path, words });
      errors++; // Thin content in sitemaps is now BLOCKING
    }

    if (isIndividualJobPage(path) && !hasJobPostingSchema(html) && words >= MIN_WORDS) {
      jobsNoSchema.push({ sitemap, path, words });
      // Missing schema is a warning for non-archive jobs
    }
  }

  // Report missing files (BLOCKING)
  if (missing.length > 0) {
    console.log(`❌ ${missing.length} sitemap URL(s) have NO file in dist/ (BLOCKING):`);
    for (const { sitemap, path } of missing.slice(0, 20)) {
      console.log(`   [${sitemap}] /${path}`);
    }
    if (missing.length > 20) console.log(`   ... and ${missing.length - 20} more`);
    console.log();
  }

  // Report noindex in sitemaps (BLOCKING)
  if (noindexInSitemap.length > 0) {
    console.log(`❌ ${noindexInSitemap.length} sitemap URL(s) have noindex tag (BLOCKING):`);
    console.log(`   Pages with noindex must NOT be in sitemaps — wastes crawl budget.`);
    for (const { sitemap, path } of noindexInSitemap.slice(0, 20)) {
      console.log(`   [${sitemap}] /${path}`);
    }
    if (noindexInSitemap.length > 20) console.log(`   ... and ${noindexInSitemap.length - 20} more`);
    console.log();
  }

  // Report thin content (BLOCKING)
  if (thinContent.length > 0) {
    console.log(`❌ ${thinContent.length} sitemap URL(s) have thin content (<${MIN_WORDS} words) (BLOCKING):`);
    for (const { sitemap, path, words } of thinContent.slice(0, 15)) {
      console.log(`   [${words}w] [${sitemap}] /${path}`);
    }
    if (thinContent.length > 15) console.log(`   ... and ${thinContent.length - 15} more`);
    console.log();
  }

  // Report jobs without schema (WARNING)
  if (jobsNoSchema.length > 0) {
    console.log(`⚠️  ${jobsNoSchema.length} job page(s) in sitemaps without JobPosting schema:`);
    for (const { sitemap, path, words } of jobsNoSchema.slice(0, 10)) {
      console.log(`   [${words}w] [${sitemap}] /${path}`);
    }
    if (jobsNoSchema.length > 10) console.log(`   ... and ${jobsNoSchema.length - 10} more`);
    console.log();
  }

  // Summary
  if (errors > 0) {
    console.log(`\n❌ BLOCKING: ${errors} error(s) found. Fix before deploying.`);
    process.exit(1);
  }

  const warnings = jobsNoSchema.length;
  if (warnings > 0) {
    console.log(`✅ No blocking errors. ${warnings} warning(s).`);
  } else {
    console.log(`✅ All ${urls.length} sitemap URLs have files with adequate content (>=${MIN_WORDS} words).`);
  }
}

main();
