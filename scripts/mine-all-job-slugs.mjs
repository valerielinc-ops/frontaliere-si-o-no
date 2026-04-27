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
import { execSync } from 'node:child_process';
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
// Source 6: Git history — mine removed slugByLocale values from diffs
// ══════════════════════════════════════════════════════════

/**
 * Mine removed slug values from git diffs of by-crawler JSON files.
 * These are slugs that were replaced when jobs mutated (location change,
 * title rewording, truncation difference) — exactly the slugs Google
 * indexed but that no longer exist in current data.
 */
function mineGitRemovedSlugs() {
  const slugs = new Map();

  try {
    const diff = execSync(
      'git log --all -300 -p -- "data/jobs/by-crawler/*.json" "data/jobs/expired/by-crawler/*.json"',
      { cwd: ROOT, maxBuffer: 500 * 1024 * 1024, encoding: 'utf8', timeout: 180_000 }
    );

    let inSlugByLocale = false;
    let braceDepth = 0;
    const localeSlugRe = /"(it|en|de|fr)":\s*"([a-z0-9][a-z0-9-]{10,})"/;

    for (const line of diff.split('\n')) {
      const raw = (line.startsWith('+') || line.startsWith('-')) ? line.substring(1) : line;
      const trimmed = raw.trim();

      if (trimmed.includes('"slugByLocale"')) { inSlugByLocale = true; braceDepth = 0; }
      if (inSlugByLocale) {
        for (const ch of trimmed) {
          if (ch === '{') braceDepth++;
          if (ch === '}') { braceDepth--; if (braceDepth <= 0) inSlugByLocale = false; }
        }
      }

      if (!line.startsWith('-')) continue;

      if (inSlugByLocale || trimmed.includes('"slugByLocale"')) {
        const m = trimmed.match(localeSlugRe);
        if (m) {
          const [, locale, slug] = m;
          if (isValidJobSlug(slug) && LOCALE_PREFIXES[locale]) {
            if (!slugs.has(slug)) slugs.set(slug, { locales: {} });
            slugs.get(slug).locales[locale] = LOCALE_PREFIXES[locale] + slug;
          }
        }
      }

      const topMatch = trimmed.match(/^\s*"slug":\s*"([a-z0-9][a-z0-9-]{10,})"/);
      if (topMatch && isValidJobSlug(topMatch[1])) {
        const slug = topMatch[1];
        if (!slugs.has(slug)) slugs.set(slug, { locales: buildLocalePaths(slug) });
      }
    }
  } catch (err) {
    console.warn(`  ⚠️  Git history mining skipped: ${err.message?.substring(0, 80)}`);
  }

  return slugs;
}

// ══════════════════════════════════════════════════════════
// Fuzzy prefix reconciliation — recover truncated/changed slugs
// ══════════════════════════════════════════════════════════

/**
 * After all exact mining is done, scan GSC orphan data for slugs that
 * are "near-misses" — truncated or slightly changed versions of known slugs.
 * Uses longest-common-prefix matching (min 40 chars) to find the parent job.
 * Returns a Map of recovered slugs → locale paths.
 */
function fuzzyReconcileOrphans(knownSlugs) {
  const reconciled = new Map();
  const MIN_PREFIX = 40;

  const knownSet = new Set(knownSlugs.keys());

  // Collect unresolved slugs from all orphan/GSC sources
  const unknown = new Set();

  const orphanJobSlugs = readJson(dataPath('gsc-orphan-job-slugs.json'));
  if (Array.isArray(orphanJobSlugs)) {
    for (const s of orphanJobSlugs) {
      if (typeof s === 'string' && isValidJobSlug(s) && !knownSet.has(s)) unknown.add(s);
    }
  }

  const enriched = readJson(dataPath('orphan-enriched-data.json'));
  if (Array.isArray(enriched)) {
    for (const o of enriched) {
      if (o?.slug && isValidJobSlug(o.slug) && !knownSet.has(o.slug)) unknown.add(o.slug);
    }
  }

  if (unknown.size === 0) return reconciled;

  // Sorted known slugs for binary-search prefix matching
  const sorted = [...knownSet].sort();

  let matched = 0;
  for (const orphan of unknown) {
    if (orphan.length < MIN_PREFIX) continue;

    // Binary search: find where orphan would be inserted
    let lo = 0, hi = sorted.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; sorted[m] < orphan ? lo = m + 1 : hi = m - 1; }

    let best = null, bestLen = 0;
    // Check neighbours around insertion point
    for (let i = Math.max(0, lo - 1); i < Math.min(sorted.length, lo + 20); i++) {
      const known = sorted[i];
      // Longest common prefix
      let lcp = 0;
      const max = Math.min(orphan.length, known.length);
      while (lcp < max && orphan[lcp] === known[lcp]) lcp++;
      if (lcp >= MIN_PREFIX && lcp > bestLen) { bestLen = lcp; best = known; }
    }

    if (best) {
      matched++;
      reconciled.set(orphan, { locales: buildLocalePaths(orphan) });
    }
  }

  if (matched > 0) {
    console.log(`  🔗 Fuzzy reconciled: ${matched} of ${unknown.size} unknown orphan slugs`);
  }
  return reconciled;
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
    { name: 'Git history (removed slugs)', fn: mineGitRemovedSlugs },
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

  // Fuzzy reconciliation: recover truncated/changed orphan slugs
  const fuzzyRecovered = fuzzyReconcileOrphans(allSlugs);
  for (const [slug, data] of fuzzyRecovered) {
    if (!allSlugs.has(slug)) {
      allSlugs.set(slug, data);
    }
  }
  if (fuzzyRecovered.size > 0) {
    console.log(`  📊 After fuzzy reconciliation: ${allSlugs.size}`);
  }

  // Load current tracking
  const trackingFile = dataPath('all-known-job-slugs.json');
  const tracking = readJson(trackingFile) || {};
  const initialCount = Object.keys(tracking).length;

  // Update tracking: add missing slugs, fill missing locales
  let added = 0;
  let patched = 0;
  let reservedHubsSkipped = 0;

  // Sector + city hub slugs are owned by jobSectorPagesPlugin / cityJobsHubPlugin.
  // Registering them in the job tracker would let jobsSeoPagesPlugin emit a
  // soft-landing that overwrites the legitimate hub HTML.
  const RESERVED_HUB_SLUGS = new Set([
    'infermieri', 'nurses', 'pflegepersonal', 'infirmiers',
    'case-anziani', 'elderly-care', 'altenpflege', 'maisons-retraite',
    'educatori', 'educators', 'erzieher', 'educateurs',
    'ingegneri', 'engineers', 'ingenieure', 'ingenieurs',
    'autisti', 'drivers', 'fahrer', 'chauffeurs',
    'sviluppatori', 'developers', 'entwickler', 'developpeurs',
    'ristorazione', 'restaurants', 'gastronomie', 'restauration',
    'operatori-socio-sanitari', 'healthcare-assistants', 'pflegeassistenten', 'aides-soignants',
    'logistica', 'logistics', 'logistik', 'logistique',
    'apprendistato', 'apprenticeships', 'lehrstellen', 'apprentissages',
    'lugano', 'mendrisio', 'bellinzona', 'locarno', 'chiasso',
  ]);

  for (const [slug, data] of allSlugs) {
    if (RESERVED_HUB_SLUGS.has(slug)) {
      reservedHubsSkipped++;
      continue;
    }
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
  if (reservedHubsSkipped > 0) {
    console.log(`  🛡️  Skipped ${reservedHubsSkipped} reserved hub slug(s) (would clobber sector/city hub HTML)`);
  }

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
