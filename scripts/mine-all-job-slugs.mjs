#!/usr/bin/env node
/**
 * mine-all-job-slugs.mjs
 *
 * Comprehensive slug mining: scans ALL local data sources to discover
 * every job slug that has ever existed, ensures they're in the tracking
 * file (all-known-job-slugs.json) with proper 4-locale paths, and
 * feeds gaps to the compat file (seo-404-compat-paths.json).
 *
 * This is the stable, automated solution to the 13.4K GSC 404 problem.
 * Run it before every build (in deploy.yml or sync-gsc-orphans.yml)
 * to ensure zero gaps between known slugs and generated pages.
 *
 * Usage:
 *   node scripts/mine-all-job-slugs.mjs
 *   node scripts/mine-all-job-slugs.mjs --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const LOCALE_PREFIXES = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
};

// Non-job slug prefixes — filter these out
const NON_JOB_SLUG_PREFIXES = [
  'ricerca-', 'search-', 'suche-', 'recherche-',
  'azienda-', 'company-', 'unternehmen-', 'entreprise-',
];

function dataPath(...segments) {
  return path.join(ROOT, 'data', ...segments);
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function isValidJobSlug(slug) {
  if (!slug || typeof slug !== 'string' || slug.length < 3) return false;
  if (NON_JOB_SLUG_PREFIXES.some((p) => slug.startsWith(p))) return false;
  // Filter out clearly corrupted slugs
  if (slug.includes('undefined') || slug.includes('null')) return false;
  if (slug.length > 250) return false; // filesystem limit safety
  return true;
}

function extractSlugFromPath(urlPath) {
  if (!urlPath || typeof urlPath !== 'string') return null;
  const allPrefixes = [
    '/cerca-lavoro-ticino/', '/en/find-jobs-ticino/', '/en/find-job-ticino/',
    '/en/job-search-ticino/', '/de/jobs-im-tessin/', '/de/jobsuche-tessin/',
    '/fr/recherche-emploi-tessin/', '/fr/trouver-emploi-tessin/',
  ];
  for (const prefix of allPrefixes) {
    if (urlPath.startsWith(prefix)) {
      return urlPath.slice(prefix.length).replace(/\/$/, '') || null;
    }
  }
  return null;
}

function buildLocalePaths(slug) {
  return {
    it: LOCALE_PREFIXES.it + slug,
    en: LOCALE_PREFIXES.en + slug,
    de: LOCALE_PREFIXES.de + slug,
    fr: LOCALE_PREFIXES.fr + slug,
  };
}

// ══════════════════════════════════════════════════════════
// Mining sources
// ══════════════════════════════════════════════════════════

function mineActiveJobs() {
  const slugs = new Map(); // slug → { locales: { it, en, de, fr } }
  const dir = dataPath('jobs', 'by-crawler');
  if (!fs.existsSync(dir)) return slugs;

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const jobs = Array.isArray(data) ? data : (data.jobs || []);
      for (const job of jobs) {
        // Main slug
        if (isValidJobSlug(job.slug)) {
          if (!slugs.has(job.slug)) slugs.set(job.slug, { locales: {} });
          slugs.get(job.slug).locales.it = LOCALE_PREFIXES.it + job.slug;
        }

        // Locale-specific slugs
        if (job.slugByLocale) {
          for (const [locale, s] of Object.entries(job.slugByLocale)) {
            if (!isValidJobSlug(s) || !LOCALE_PREFIXES[locale]) continue;
            if (!slugs.has(s)) slugs.set(s, { locales: {} });
            slugs.get(s).locales[locale] = LOCALE_PREFIXES[locale] + s;
          }
        }

        // Previous slugs (these are IT slugs used for all locale paths)
        for (const ps of (job.previousSlugs || [])) {
          if (!isValidJobSlug(ps)) continue;
          if (!slugs.has(ps)) slugs.set(ps, { locales: buildLocalePaths(ps) });
          else {
            const entry = slugs.get(ps);
            const paths = buildLocalePaths(ps);
            for (const l of ['it', 'en', 'de', 'fr']) {
              if (!entry.locales[l]) entry.locales[l] = paths[l];
            }
          }
        }
      }
    } catch {}
  }
  return slugs;
}

function mineExpiredJobs() {
  const slugs = new Map();
  const dir = dataPath('jobs', 'expired', 'by-crawler');
  if (!fs.existsSync(dir)) return slugs;

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const jobs = Array.isArray(data) ? data : (data.jobs || []);
      for (const job of jobs) {
        if (isValidJobSlug(job.slug)) {
          if (!slugs.has(job.slug)) slugs.set(job.slug, { locales: {} });
          slugs.get(job.slug).locales.it = LOCALE_PREFIXES.it + job.slug;
        }
        if (job.slugByLocale) {
          for (const [locale, s] of Object.entries(job.slugByLocale)) {
            if (!isValidJobSlug(s) || !LOCALE_PREFIXES[locale]) continue;
            if (!slugs.has(s)) slugs.set(s, { locales: {} });
            slugs.get(s).locales[locale] = LOCALE_PREFIXES[locale] + s;
          }
        }
        for (const ps of (job.previousSlugs || [])) {
          if (!isValidJobSlug(ps)) continue;
          if (!slugs.has(ps)) slugs.set(ps, { locales: buildLocalePaths(ps) });
        }
      }
    } catch {}
  }
  return slugs;
}

function mineSlugRegistry() {
  const slugs = new Map();
  const registry = readJson(dataPath('slug-registry.json'));
  if (!registry) return slugs;

  for (const entry of Object.values(registry)) {
    if (typeof entry === 'string') {
      // Simple fingerprint → slug format
      if (isValidJobSlug(entry)) slugs.set(entry, { locales: buildLocalePaths(entry) });
    } else if (typeof entry === 'object' && entry !== null) {
      // Rich format: { canonicalSlug, slugByLocale: { it, en, de, fr } }
      const canonical = entry.canonicalSlug || entry.slug;
      if (isValidJobSlug(canonical)) {
        const locales = {};
        if (entry.slugByLocale) {
          for (const [l, s] of Object.entries(entry.slugByLocale)) {
            if (isValidJobSlug(s) && LOCALE_PREFIXES[l]) {
              locales[l] = LOCALE_PREFIXES[l] + s;
              // Also register the locale-specific slug as its own entry
              if (s !== canonical && isValidJobSlug(s)) {
                if (!slugs.has(s)) slugs.set(s, { locales: {} });
                slugs.get(s).locales[l] = LOCALE_PREFIXES[l] + s;
              }
            }
          }
        }
        // Fill missing locales with canonical slug
        for (const l of ['it', 'en', 'de', 'fr']) {
          if (!locales[l]) locales[l] = LOCALE_PREFIXES[l] + canonical;
        }
        if (!slugs.has(canonical)) slugs.set(canonical, { locales });
        else {
          const existing = slugs.get(canonical);
          for (const [l, p] of Object.entries(locales)) {
            if (!existing.locales[l]) existing.locales[l] = p;
          }
        }
      }
    }
  }
  return slugs;
}

function mineOrphanData() {
  const slugs = new Map();
  const orphans = readJson(dataPath('orphan-enriched-data.json'));
  if (!Array.isArray(orphans)) return slugs;

  for (const o of orphans) {
    if (!isValidJobSlug(o.slug)) continue;
    slugs.set(o.slug, { locales: buildLocalePaths(o.slug) });
  }
  return slugs;
}

function mineCompatPaths() {
  const slugs = new Map();
  const compat = readJson(dataPath('seo-404-compat-paths.json'));
  if (!compat?.paths) return slugs;

  for (const p of compat.paths) {
    const slug = extractSlugFromPath(p);
    if (!isValidJobSlug(slug)) continue;
    if (!slugs.has(slug)) slugs.set(slug, { locales: {} });
    // Detect locale from path
    if (p.startsWith('/en/')) slugs.get(slug).locales.en = p;
    else if (p.startsWith('/de/')) slugs.get(slug).locales.de = p;
    else if (p.startsWith('/fr/')) slugs.get(slug).locales.fr = p;
    else slugs.get(slug).locales.it = p;
  }
  return slugs;
}

// ══════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════

function main() {
  console.log('⛏️  Mining all job slugs from local data sources...\n');

  // Mine all sources
  const sources = [
    { name: 'Active jobs', fn: mineActiveJobs },
    { name: 'Expired jobs', fn: mineExpiredJobs },
    { name: 'Slug registry', fn: mineSlugRegistry },
    { name: 'Orphan data', fn: mineOrphanData },
    { name: 'Compat paths', fn: mineCompatPaths },
  ];

  // Merge all mined slugs
  const allSlugs = new Map(); // slug → { locales: { it?, en?, de?, fr? } }

  for (const { name, fn } of sources) {
    const mined = fn();
    console.log(`  📦 ${name}: ${mined.size} slugs`);
    for (const [slug, data] of mined) {
      if (!allSlugs.has(slug)) {
        allSlugs.set(slug, { locales: {} });
      }
      const entry = allSlugs.get(slug);
      for (const [l, p] of Object.entries(data.locales)) {
        if (p && !entry.locales[l]) entry.locales[l] = p;
      }
    }
  }

  console.log(`\n  📊 Total unique slugs mined: ${allSlugs.size}`);

  // Load current tracking
  const trackingFile = dataPath('all-known-job-slugs.json');
  const tracking = readJson(trackingFile) || {};
  const initialCount = Object.keys(tracking).length;

  // Update tracking: add missing slugs, fill missing locales
  let added = 0;
  let patched = 0;

  for (const [slug, data] of allSlugs) {
    // Ensure slug has all 4 locale paths
    const localePaths = { ...data.locales };
    for (const l of ['it', 'en', 'de', 'fr']) {
      if (!localePaths[l]) localePaths[l] = LOCALE_PREFIXES[l] + slug;
    }

    if (!tracking[slug]) {
      tracking[slug] = localePaths;
      added++;
    } else {
      // Patch missing locales in existing entry
      let didPatch = false;
      for (const l of ['it', 'en', 'de', 'fr']) {
        if (!tracking[slug][l]) {
          tracking[slug][l] = localePaths[l];
          didPatch = true;
        }
      }
      if (didPatch) patched++;
    }
  }

  console.log(`\n  Tracking: ${added} new, ${patched} patched (${initialCount} → ${Object.keys(tracking).length})`);

  // Update compat paths: add ALL tracking paths as safety net
  const compatFile = dataPath('seo-404-compat-paths.json');
  const compat = readJson(compatFile) || { paths: [] };
  const existingCompat = new Set(compat.paths);
  let compatAdded = 0;

  for (const paths of Object.values(tracking)) {
    for (const l of ['it', 'en', 'de', 'fr']) {
      const p = paths[l];
      if (p && !existingCompat.has(p)) {
        existingCompat.add(p);
        compatAdded++;
      }
    }
  }

  console.log(`  Compat: ${compatAdded} new paths (${compat.paths.length} → ${existingCompat.size})`);

  // Write outputs
  if (!DRY_RUN) {
    fs.writeFileSync(trackingFile, JSON.stringify(tracking, null, 2) + '\n');
    const updatedCompat = {
      ...compat,
      paths: [...existingCompat].filter((p) => typeof p === 'string' && p.startsWith('/')).sort(),
      lastUpdated: new Date().toISOString().split('T')[0],
    };
    fs.writeFileSync(compatFile, JSON.stringify(updatedCompat, null, 2) + '\n');
    console.log('\n  ✅ Files written');
  } else {
    console.log('\n  🔍 Dry run — no files written');
  }

  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log('⛏️  Mining Summary');
  console.log('═'.repeat(50));
  console.log(`  Unique slugs mined:    ${allSlugs.size}`);
  console.log(`  Tracking entries:      ${Object.keys(tracking).length}`);
  console.log(`  New tracking entries:  ${added}`);
  console.log(`  Patched entries:       ${patched}`);
  console.log(`  Compat paths:          ${existingCompat.size}`);
  console.log(`  New compat paths:      ${compatAdded}`);
  console.log(`  Total URLs covered:    ${Object.keys(tracking).length * 4} (${Object.keys(tracking).length} × 4 locales)`);

  const changed = added > 0 || patched > 0 || compatAdded > 0;
  if (changed) {
    console.log('\n🚀 MINING_CHANGED=true — rebuild recommended');
  }

  return changed;
}

main();
