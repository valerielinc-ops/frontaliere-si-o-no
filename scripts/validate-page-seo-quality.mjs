#!/usr/bin/env node

/**
 * Deploy validation: checks generated HTML pages in dist/ for SEO issues
 * that Bing/Google would flag. Runs AFTER `npx vite build` in deploy.yml.
 *
 * Checks:
 *  1. H1 tag: every page must have exactly 1 non-empty <h1>, not inside <noscript>
 *  2. Schema markup: all ld+json blocks must be valid JSON with no conflicting primary schemas
 *  3. HTML lang attribute: <html> must have correct lang for the page locale
 *  4. Meta viewport: must be present
 *  5. Title tag: must be present and non-empty
 *  6. Meta description: must be present and non-empty
 *  7. Meta robots: must NOT contain "noindex" (except 404.html)
 *  8. Meta refresh: must NOT exist (indicates redirect shell, not real content)
 *
 * Sampling strategy (16K+ pages):
 *  - ALL pages in key SEO directories (FAQ, jobs, articles, glossary)
 *  - Random sample of 500 pages from all other directories
 *  - Always checks root index.html
 *
 * Exit code 1 if ANY errors found (deploy-blocking).
 * Exit code 0 if only warnings or all pass.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const DIST = 'dist';
const SAMPLE_SIZE = 500;

// Directories where ALL pages are checked (key SEO content)
const FULL_CHECK_DIRS = [
  'domande-frequenti-frontalieri',
  'cerca-lavoro-ticino',
  'articoli-frontaliere',
  'glossario-frontaliere',
  // EN equivalents
  'frequently-asked-questions-cross-border',
  'find-jobs-ticino',
  'cross-border-articles',
  'cross-border-glossary',
  // DE equivalents
  'haeufig-gestellte-fragen-grenzgaenger',
  'jobs-im-tessin',
  'grenzgaenger-artikel',
  'grenzgaenger-glossar',
  // FR equivalents
  'questions-frequentes-frontalier',
  'trouver-emploi-tessin',
  'articles-frontalier',
  'glossaire-frontalier',
];

// Primary schema types that conflict with each other on the same object
const PRIMARY_SCHEMAS = new Set([
  'Article',
  'NewsArticle',
  'BlogPosting',
  'WebPage',
  'WebApplication',
  'FAQPage',
  'JobPosting',
  'Event',
  'DefinedTerm',
  'Organization',
  'Dataset',
  'CollectionPage',
  'AboutPage',
  'ContactPage',
  'ItemPage',
  'ProfilePage',
  'SearchResultsPage',
]);

// Supplementary schemas that can coexist with any primary schema
const SUPPLEMENTARY_SCHEMAS = new Set([
  'BreadcrumbList',
  'SiteNavigationElement',
  'Person',
  'ImageObject',
  'VideoObject',
  'ListItem',
  'HowTo',
  'SpeakableSpecification',
]);

// Locale detection from path
function detectLocale(pagePath) {
  if (pagePath.startsWith('en/')) return 'en';
  if (pagePath.startsWith('de/')) return 'de';
  if (pagePath.startsWith('fr/')) return 'fr';
  return 'it';
}

// Recursively collect all index.html files
function collectHtmlFiles(dir, basePath = '') {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      results.push(...collectHtmlFiles(fullPath, join(basePath, entry)));
    } else if (entry === 'index.html') {
      results.push({
        filePath: fullPath,
        pagePath: basePath,
      });
    }
  }
  return results;
}

// Extract H1 tags, ignoring those inside <noscript>
function extractH1Tags(html) {
  // Remove <noscript> blocks first
  const withoutNoscript = html.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  // Remove elements with hidden/display:none style
  const withoutHidden = withoutNoscript.replace(
    /<[^>]+(?:style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["']|hidden)[^>]*>[\s\S]*?<\/[^>]+>/gi,
    ''
  );
  const h1Matches = [...withoutHidden.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)];
  return h1Matches.map(m => {
    // Strip inner tags to get text content
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    return text;
  });
}

// Extract and validate ld+json blocks
function validateSchemas(html) {
  const issues = [];
  const ldJsonMatches = [...html.matchAll(/<script\s+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  const primaryTypes = [];

  for (let i = 0; i < ldJsonMatches.length; i++) {
    const raw = ldJsonMatches[i][1].trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      issues.push({ type: 'invalid-json', detail: `ld+json block #${i + 1}: ${e.message}` });
      continue;
    }

    // Collect @type from this block (handle @graph arrays too)
    const types = extractTypes(parsed);
    for (const t of types) {
      if (PRIMARY_SCHEMAS.has(t)) {
        primaryTypes.push(t);
      }
    }
  }

  // Check for duplicate same-type primary schemas (e.g., two FAQPage blocks)
  // Google flags "campo duplicato" when it sees the same @type twice on one page.
  const typeCounts = {};
  for (const t of primaryTypes) {
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  for (const [type, count] of Object.entries(typeCounts)) {
    if (count > 1 && type !== 'BreadcrumbList' && type !== 'SpeakableSpecification') {
      issues.push({
        type: 'conflicting-schemas',
        detail: `Duplicate "${type}" schema (found ${count}× in JSON-LD)`,
      });
    }
  }

  // Check for conflicting primary schemas
  const uniquePrimary = [...new Set(primaryTypes)];
  if (uniquePrimary.length > 1) {
    // WebPage + another primary type is common and acceptable in @graph
    // Only flag if there are truly conflicting content types
    const contentTypes = uniquePrimary.filter(t => t !== 'WebPage' && t !== 'Organization');
    if (contentTypes.length > 1) {
      issues.push({
        type: 'conflicting-schemas',
        detail: `Multiple primary schemas: ${uniquePrimary.join(', ')}`,
      });
    }
  }

  // Check for FAQPage microdata alongside JSON-LD FAQPage (causes Google "campo duplicato")
  if (primaryTypes.includes('FAQPage')) {
    const hasMicrodataFaq = html.includes('itemType="https://schema.org/FAQPage"') ||
                            html.includes("itemType='https://schema.org/FAQPage'");
    if (hasMicrodataFaq) {
      issues.push({
        type: 'conflicting-schemas',
        detail: 'FAQPage defined in both JSON-LD and microdata — Google sees duplicates',
      });
    }
  }

  return issues;
}

// Recursively extract @type values from JSON-LD
function extractTypes(obj) {
  const types = [];
  if (!obj || typeof obj !== 'object') return types;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      types.push(...extractTypes(item));
    }
    return types;
  }

  if (obj['@type']) {
    const t = obj['@type'];
    if (Array.isArray(t)) {
      types.push(...t);
    } else {
      types.push(t);
    }
  }

  // Check @graph
  if (obj['@graph'] && Array.isArray(obj['@graph'])) {
    for (const item of obj['@graph']) {
      types.push(...extractTypes(item));
    }
  }

  return types;
}

// Check HTML lang attribute
function checkLangAttribute(html, expectedLocale) {
  const langMatch = html.match(/<html[^>]*\slang\s*=\s*["']([^"']+)["']/i);
  if (!langMatch) {
    return { error: 'missing-lang', detail: 'No lang attribute on <html> tag' };
  }
  const lang = langMatch[1].split('-')[0].toLowerCase();
  if (lang !== expectedLocale) {
    return { error: 'wrong-lang', detail: `Expected lang="${expectedLocale}", found lang="${langMatch[1]}"` };
  }
  return null;
}

// Check meta viewport
function hasMetaViewport(html) {
  return /<meta[^>]*name\s*=\s*["']viewport["']/i.test(html);
}

// Extract <title> tag content
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : '';
}

// Extract <meta name="description"> content
function extractMetaDescription(html) {
  const match = html.match(/<meta[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i)
    || html.match(/<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i);
  return match ? match[1].trim() : '';
}

// Check if <meta name="robots"> contains "noindex"
function hasNoindex(html) {
  const match = html.match(/<meta[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["']([^"']*)["']/i)
    || html.match(/<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']robots["']/i);
  if (!match) return false;
  return match[1].toLowerCase().includes('noindex');
}

// Check for <meta http-equiv="refresh"> (not inside <noscript>)
function hasMetaRefresh(html) {
  const withoutNoscript = html.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  return /<meta[^>]*http-equiv\s*=\s*["']refresh["']/i.test(withoutNoscript);
}

function main() {
  if (!existsSync(DIST)) {
    console.error(`[validate-page-seo] dist/ directory not found. Run 'npx vite build' first.`);
    process.exit(1);
  }

  // Collect all HTML files
  const allPages = collectHtmlFiles(DIST);
  console.log(`[validate-page-seo] Found ${allPages.length} HTML pages in dist/\n`);

  // Determine which pages to check
  const fullCheckPages = [];
  const otherPages = [];

  for (const page of allPages) {
    const inFullCheck = FULL_CHECK_DIRS.some(dir => page.pagePath.startsWith(dir) || page.pagePath.startsWith(`en/${dir}`) || page.pagePath.startsWith(`de/${dir}`) || page.pagePath.startsWith(`fr/${dir}`));
    // Root index.html always checked
    if (page.pagePath === '' || inFullCheck) {
      fullCheckPages.push(page);
    } else {
      otherPages.push(page);
    }
  }

  // Random sample from other pages
  const shuffled = otherPages.sort(() => Math.random() - 0.5);
  const sampled = shuffled.slice(0, SAMPLE_SIZE);

  const pagesToCheck = [...fullCheckPages, ...sampled];
  console.log(`[validate-page-seo] Checking ${fullCheckPages.length} key pages + ${sampled.length} sampled = ${pagesToCheck.length} total\n`);

  // Error and warning tracking
  const errors = {
    missingH1: [],
    duplicateH1: [],
    emptyH1: [],
    invalidJson: [],
    conflictingSchemas: [],
    missingLang: [],
    wrongLang: [],
    missingViewport: [],
    missingTitle: [],
    missingDescription: [],
    hasNoindex: [],
    hasMetaRefresh: [],
  };
  let warningCount = 0;
  let errorCount = 0;

  for (const page of pagesToCheck) {
    const html = readFileSync(page.filePath, 'utf-8');
    const locale = detectLocale(page.pagePath);

    // 1. H1 validation
    const h1Tags = extractH1Tags(html);
    if (h1Tags.length === 0) {
      errors.missingH1.push(page.pagePath || '/');
      errorCount++;
    } else if (h1Tags.length > 1) {
      errors.duplicateH1.push({ path: page.pagePath || '/', count: h1Tags.length });
      errorCount++;
    } else if (h1Tags[0] === '') {
      errors.emptyH1.push(page.pagePath || '/');
      errorCount++;
    }

    // 2. Schema validation
    const schemaIssues = validateSchemas(html);
    for (const issue of schemaIssues) {
      if (issue.type === 'invalid-json') {
        errors.invalidJson.push({ path: page.pagePath || '/', detail: issue.detail });
        errorCount++;
      } else if (issue.type === 'conflicting-schemas') {
        errors.conflictingSchemas.push({ path: page.pagePath || '/', detail: issue.detail });
        errorCount++;
      }
    }

    // 3. Lang attribute
    const langIssue = checkLangAttribute(html, locale);
    if (langIssue) {
      if (langIssue.error === 'missing-lang') {
        errors.missingLang.push(page.pagePath || '/');
        errorCount++;
      } else if (langIssue.error === 'wrong-lang') {
        errors.wrongLang.push({ path: page.pagePath || '/', detail: langIssue.detail });
        errorCount++;
      }
    }

    // 4. Meta viewport
    if (!hasMetaViewport(html)) {
      errors.missingViewport.push(page.pagePath || '/');
      errorCount++;
    }

    // 5. Title tag
    if (!extractTitle(html)) {
      errors.missingTitle.push(page.pagePath || '/');
      errorCount++;
    }

    // 6. Meta description
    if (!extractMetaDescription(html)) {
      errors.missingDescription.push(page.pagePath || '/');
      errorCount++;
    }

    // 7. Meta robots noindex (skip 404.html and search/combo landing pages which are intentionally noindex)
    const isSearchPage = /\/(ricerca-|suche-|search-|recherche-)/.test('/' + page.pagePath);
    if (page.pagePath !== '404.html' && !isSearchPage && hasNoindex(html)) {
      errors.hasNoindex.push(page.pagePath || '/');
      errorCount++;
    }

    // 8. Meta refresh (outside noscript)
    if (hasMetaRefresh(html)) {
      errors.hasMetaRefresh.push(page.pagePath || '/');
      errorCount++;
    }
  }

  // Print results
  const passedCount = pagesToCheck.length - new Set([
    ...errors.missingH1,
    ...errors.duplicateH1.map(e => e.path),
    ...errors.emptyH1,
    ...errors.invalidJson.map(e => e.path),
    ...errors.conflictingSchemas.map(e => e.path),
    ...errors.missingLang,
    ...errors.wrongLang.map(e => e.path),
    ...errors.missingViewport,
    ...errors.missingTitle,
    ...errors.missingDescription,
    ...errors.hasNoindex,
    ...errors.hasMetaRefresh,
  ]).size;

  console.log('='.repeat(60));
  console.log(`PAGES CHECKED: ${pagesToCheck.length}`);
  console.log(`  PASSED: ${passedCount}`);
  console.log(`  WITH ERRORS: ${pagesToCheck.length - passedCount}`);
  console.log(`  TOTAL ISSUES: ${errorCount}`);
  console.log('='.repeat(60));
  console.log();

  // Group errors by type
  if (errors.missingH1.length > 0) {
    printErrorGroup('Missing H1 tag', errors.missingH1, 20);
  }
  if (errors.duplicateH1.length > 0) {
    console.log(`\u274C ${errors.duplicateH1.length} page(s) have MULTIPLE H1 tags (BLOCKING):`);
    for (const { path, count } of errors.duplicateH1.slice(0, 20)) {
      console.log(`   [${count} h1s] /${path}`);
    }
    if (errors.duplicateH1.length > 20) console.log(`   ... and ${errors.duplicateH1.length - 20} more`);
    console.log();
  }
  if (errors.emptyH1.length > 0) {
    printErrorGroup('Empty H1 tag', errors.emptyH1, 20);
  }
  if (errors.invalidJson.length > 0) {
    console.log(`\u274C ${errors.invalidJson.length} page(s) have INVALID ld+json (BLOCKING):`);
    for (const { path, detail } of errors.invalidJson.slice(0, 20)) {
      console.log(`   /${path}: ${detail}`);
    }
    if (errors.invalidJson.length > 20) console.log(`   ... and ${errors.invalidJson.length - 20} more`);
    console.log();
  }
  if (errors.conflictingSchemas.length > 0) {
    console.log(`\u274C ${errors.conflictingSchemas.length} page(s) have CONFLICTING primary schemas (BLOCKING):`);
    for (const { path, detail } of errors.conflictingSchemas.slice(0, 20)) {
      console.log(`   /${path}: ${detail}`);
    }
    if (errors.conflictingSchemas.length > 20) console.log(`   ... and ${errors.conflictingSchemas.length - 20} more`);
    console.log();
  }
  if (errors.missingLang.length > 0) {
    printErrorGroup('Missing lang attribute on <html>', errors.missingLang, 20);
  }
  if (errors.wrongLang.length > 0) {
    console.log(`\u274C ${errors.wrongLang.length} page(s) have WRONG lang attribute (BLOCKING):`);
    for (const { path, detail } of errors.wrongLang.slice(0, 20)) {
      console.log(`   /${path}: ${detail}`);
    }
    if (errors.wrongLang.length > 20) console.log(`   ... and ${errors.wrongLang.length - 20} more`);
    console.log();
  }
  if (errors.missingViewport.length > 0) {
    printErrorGroup('Missing meta viewport', errors.missingViewport, 20);
  }
  if (errors.missingTitle.length > 0) {
    printErrorGroup('Missing <title> tag', errors.missingTitle, 20);
  }
  if (errors.missingDescription.length > 0) {
    printErrorGroup('Missing <meta name="description">', errors.missingDescription, 20);
  }
  if (errors.hasNoindex.length > 0) {
    printErrorGroup('Contains noindex robots directive', errors.hasNoindex, 20);
  }
  if (errors.hasMetaRefresh.length > 0) {
    printErrorGroup('Contains <meta http-equiv="refresh"> (redirect shell)', errors.hasMetaRefresh, 20);
  }

  if (errorCount > 0) {
    console.log(`\n\u274C DEPLOY BLOCKED: ${errorCount} SEO issue(s) found across ${pagesToCheck.length - passedCount} page(s).`);
    process.exit(1);
  } else {
    console.log(`\n\u2705 All ${pagesToCheck.length} checked pages pass SEO quality validation.`);
    process.exit(0);
  }
}

function printErrorGroup(label, paths, limit) {
  console.log(`\u274C ${paths.length} page(s) with ${label} (BLOCKING):`);
  for (const p of paths.slice(0, limit)) {
    console.log(`   /${p}`);
  }
  if (paths.length > limit) console.log(`   ... and ${paths.length - limit} more`);
  console.log();
}

main();
