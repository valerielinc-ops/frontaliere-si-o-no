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
import { assertCompatFloor } from './lib/compat-paths-floor-guard.mjs';
import { readCompatPaths, writeCompatPaths } from './lib/compat-paths-store.mjs';
import { JOB_BOARD_SEGMENT_RX } from './lib/jobBoardSections.mjs';
import { createCantonResolvers } from '../build-plugins/shared/cantonResolvers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const cantonSlugFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-url-slugs.json'), 'utf8'));
const municipalitiesFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-municipalities.json'), 'utf8'));
const { resolveCantonSection, resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

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
  // A real job slug is a single path segment — anything containing a slash
  // is a multi-segment URL tail (e.g. hub-pagination `<hub>/page-N`), not a
  // job slug. Rejecting here closes every mining source in one place.
  if (slug.includes('/')) return false;
  if (NON_JOB_SLUG_PREFIXES.some((p) => slug.startsWith(p))) return false;
  // Filter out clearly corrupted slugs
  if (slug.includes('undefined') || slug.includes('null')) return false;
  if (slug.length > 250) return false; // filesystem limit safety
  return true;
}

// Canton-aware: GSC/compat paths live under every canton's job-board section
// (`cerca-lavoro-{slug}`, `find-jobs-{slug}`, …), not just the legacy TI board
// — see scripts/lib/jobBoardSections.mjs.
function extractSlugFromPath(urlPath) {
  if (!urlPath || typeof urlPath !== 'string') return null;
  // Match case-insensitively (GSC may index a locale segment with drifted
  // casing, e.g. `/EN/find-jobs-ticino/...`) — mirrors inferLocale() in
  // build-plugins/searchConsoleCompat.ts.
  const pathname = urlPath.toLowerCase().replace(/^\/(en|de|fr)\//, '/');
  const parts = pathname.split('/').filter(Boolean);
  const boardIdx = parts.findIndex((part) => JOB_BOARD_SEGMENT_RX.test(part));
  if (boardIdx === -1) return null;
  const slug = parts[boardIdx + 1]?.replace(/\/$/, '');
  return slug && !slug.includes('/') ? slug : null;
}

// `cantonCode` defaults to the legacy TI board when unknown/unresolvable —
// same default resolveCantonSection() itself applies for a falsy/absent code.
function buildLocalePathsForCanton(cantonCode, slug) {
  const paths = {};
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const section = resolveCantonSection(locale, cantonCode);
    paths[locale] = locale === 'it' ? `/${section}/${slug}` : `/${locale}/${section}/${slug}`;
  }
  return paths;
}

function buildLocalePathsForJob(job, slug) {
  const cantonCode = resolveJobCanton({ canton: job?.canton, location: job?.location });
  return buildLocalePathsForCanton(cantonCode, slug);
}

// Swap the trailing slug segment of an already-resolved entry's locale paths
// — used when recovering a slug variant (fuzzy match) of a known entry, so
// the recovered slug inherits its parent's real canton section instead of
// defaulting to TI.
function reuseLocalePathsForSlug(entry, newSlug) {
  const result = {};
  for (const l of ['it', 'en', 'de', 'fr']) {
    const p = entry?.locales?.[l];
    if (!p) continue;
    result[l] = p.slice(0, p.lastIndexOf('/') + 1) + newSlug;
  }
  return result;
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
        const cantonCode = resolveJobCanton({ canton: job?.canton, location: job?.location });

        // Main slug
        if (isValidJobSlug(job.slug)) {
          if (!slugs.has(job.slug)) slugs.set(job.slug, { locales: {} });
          slugs.get(job.slug).locales.it = buildLocalePathsForCanton(cantonCode, job.slug).it;
        }

        // Locale-specific slugs
        if (job.slugByLocale) {
          for (const [locale, s] of Object.entries(job.slugByLocale)) {
            if (!isValidJobSlug(s) || !['it', 'en', 'de', 'fr'].includes(locale)) continue;
            if (!slugs.has(s)) slugs.set(s, { locales: {} });
            slugs.get(s).locales[locale] = buildLocalePathsForCanton(cantonCode, s)[locale];
          }
        }

        // Previous slugs (these are IT slugs used for all locale paths)
        for (const ps of (job.previousSlugs || [])) {
          if (!isValidJobSlug(ps)) continue;
          if (!slugs.has(ps)) slugs.set(ps, { locales: buildLocalePathsForCanton(cantonCode, ps) });
          else {
            const entry = slugs.get(ps);
            const paths = buildLocalePathsForCanton(cantonCode, ps);
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
        const cantonCode = resolveJobCanton({ canton: job?.canton, location: job?.location });
        if (isValidJobSlug(job.slug)) {
          if (!slugs.has(job.slug)) slugs.set(job.slug, { locales: {} });
          slugs.get(job.slug).locales.it = buildLocalePathsForCanton(cantonCode, job.slug).it;
        }
        if (job.slugByLocale) {
          for (const [locale, s] of Object.entries(job.slugByLocale)) {
            if (!isValidJobSlug(s) || !['it', 'en', 'de', 'fr'].includes(locale)) continue;
            if (!slugs.has(s)) slugs.set(s, { locales: {} });
            slugs.get(s).locales[locale] = buildLocalePathsForCanton(cantonCode, s)[locale];
          }
        }
        for (const ps of (job.previousSlugs || [])) {
          if (!isValidJobSlug(ps)) continue;
          if (!slugs.has(ps)) slugs.set(ps, { locales: buildLocalePathsForCanton(cantonCode, ps) });
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
      // Simple fingerprint → slug format — no canton context available for
      // this legacy shape, defaults to the legacy TI board (see
      // buildLocalePathsForCanton).
      if (isValidJobSlug(entry)) slugs.set(entry, { locales: buildLocalePathsForCanton('TI', entry) });
    } else if (typeof entry === 'object' && entry !== null) {
      // Rich format: { canonicalSlug, canton, slugByLocale: { it, en, de, fr } }
      const canonical = entry.canonicalSlug || entry.slug;
      const cantonCode = entry.canton || 'TI';
      if (isValidJobSlug(canonical)) {
        const locales = {};
        if (entry.slugByLocale) {
          for (const [l, s] of Object.entries(entry.slugByLocale)) {
            if (isValidJobSlug(s) && ['it', 'en', 'de', 'fr'].includes(l)) {
              locales[l] = buildLocalePathsForCanton(cantonCode, s)[l];
              // Also register the locale-specific slug as its own entry
              if (s !== canonical && isValidJobSlug(s)) {
                if (!slugs.has(s)) slugs.set(s, { locales: {} });
                slugs.get(s).locales[l] = locales[l];
              }
            }
          }
        }
        // Fill missing locales with canonical slug
        const canonicalPaths = buildLocalePathsForCanton(cantonCode, canonical);
        for (const l of ['it', 'en', 'de', 'fr']) {
          if (!locales[l]) locales[l] = canonicalPaths[l];
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
    // Entries carry the actual observed `path`/`locale` (real canton board
    // section GSC indexed it under) — use that instead of assuming TI.
    if (o.path && o.locale && ['it', 'en', 'de', 'fr'].includes(o.locale)) {
      if (!slugs.has(o.slug)) slugs.set(o.slug, { locales: {} });
      slugs.get(o.slug).locales[o.locale] = o.path;
    } else if (!slugs.has(o.slug)) {
      slugs.set(o.slug, { locales: buildLocalePathsForCanton('TI', o.slug) });
    }
  }
  return slugs;
}

function mineCompatPaths() {
  const slugs = new Map();
  const compat = readCompatPaths(ROOT); // sharded accumulator (issue #2988)
  if (!compat?.paths) return slugs;

  for (const p of compat.paths) {
    const slug = extractSlugFromPath(p);
    if (!isValidJobSlug(slug)) continue;
    if (!slugs.has(slug)) slugs.set(slug, { locales: {} });
    // Detect locale from path, case-insensitively (GSC may index a locale
    // segment with drifted casing, e.g. `/EN/find-jobs-ticino/...`) — mirrors
    // inferLocale() in build-plugins/searchConsoleCompat.ts.
    const lowerPath = p.toLowerCase();
    if (lowerPath.startsWith('/en/')) slugs.get(slug).locales.en = p;
    else if (lowerPath.startsWith('/de/')) slugs.get(slug).locales.de = p;
    else if (lowerPath.startsWith('/fr/')) slugs.get(slug).locales.fr = p;
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

      // Raw git diff text only exposes the slug value, never the job's canton
      // field at this parse point — defaults to the legacy TI board (same
      // default buildLocalePathsForCanton/resolveCantonSection apply for an
      // unresolvable canton).
      if (inSlugByLocale || trimmed.includes('"slugByLocale"')) {
        const m = trimmed.match(localeSlugRe);
        if (m) {
          const [, locale, slug] = m;
          if (isValidJobSlug(slug) && ['it', 'en', 'de', 'fr'].includes(locale)) {
            if (!slugs.has(slug)) slugs.set(slug, { locales: {} });
            slugs.get(slug).locales[locale] = buildLocalePathsForCanton('TI', slug)[locale];
          }
        }
      }

      const topMatch = trimmed.match(/^\s*"slug":\s*"([a-z0-9][a-z0-9-]{10,})"/);
      if (topMatch && isValidJobSlug(topMatch[1])) {
        const slug = topMatch[1];
        if (!slugs.has(slug)) slugs.set(slug, { locales: buildLocalePathsForCanton('TI', slug) });
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
      // Reuse the matched parent slug's own resolved board section rather
      // than assuming TI — the fuzzy match is a truncated/renamed variant of
      // `best`, so it lives under the same canton section.
      const bestEntry = knownSlugs.get(best);
      reconciled.set(orphan, { locales: reuseLocalePathsForSlug(bestEntry, orphan) });
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
  // Track slugs seen from any non-git source — used for size-cap pruning below.
  const nonGitSourceSlugs = new Set();

  for (const { name, fn } of sources) {
    const mined = fn();
    const isGit = name === 'Git history (removed slugs)';
    console.log(`  📦 ${name}: ${mined.size} slugs`);
    for (const [slug, data] of mined) {
      if (!isGit) nonGitSourceSlugs.add(slug);
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
    nonGitSourceSlugs.add(slug); // fuzzy-matched orphans are GSC-indexed — keep
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
    // Ensure slug has all 4 locale paths. By this point every mining source
    // has already tried to resolve the real canton section (see sources
    // above) — a locale still missing here means NO source had canton
    // context for it, so this last-resort fill defaults to the legacy TI
    // board (same default buildLocalePathsForCanton/resolveCantonSection
    // apply for an unresolvable canton).
    const localePaths = { ...data.locales };
    for (const l of ['it', 'en', 'de', 'fr']) {
      if (!localePaths[l]) localePaths[l] = buildLocalePathsForCanton('TI', slug)[l];
    }

    if (!tracking[slug]) {
      tracking[slug] = nonGitSourceSlugs.has(slug)
        ? localePaths
        : { ...localePaths, _gitOnly: true };
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
      // Upgrade: slug previously marked git-only but now visible from a non-git source.
      if (tracking[slug]._gitOnly && nonGitSourceSlugs.has(slug)) {
        delete tracking[slug]._gitOnly;
      }
    }
  }

  console.log(`\n  Tracking: ${added} new, ${patched} patched (${initialCount} → ${Object.keys(tracking).length})`);
  if (reservedHubsSkipped > 0) {
    console.log(`  🛡️  Skipped ${reservedHubsSkipped} reserved hub slug(s) (would clobber sector/city hub HTML)`);
  }

  // Update compat paths: add ALL tracking paths as safety net
  const compatFile = dataPath('seo-404-compat'); // sharded dir (issue #2988)
  const compat = readCompatPaths(ROOT) || { paths: [] };
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
    // Size guard: GitHub rejects files ≥ 100 MB. Prune tracking entries backed
    // ONLY by git-history mining (lowest signal) when the compact JSON would
    // exceed 95 MB. Compact JSON (no 2-space indent) minimises file size;
    // all consumers use JSON.parse() and are format-agnostic.
    const SIZE_CAP = 95 * 1024 * 1024; // 95 MB — 5 MB headroom under GitHub's 100 MB limit
    const preSerialized = JSON.stringify(tracking);
    if (preSerialized.length > SIZE_CAP) {
      let pruned = 0;
      for (const slug of Object.keys(tracking)) {
        if (tracking[slug]?._gitOnly === true) {
          delete tracking[slug];
          pruned++;
        }
      }
      const afterMB = (JSON.stringify(tracking).length / 1e6).toFixed(1);
      console.log(`\n  ✂️  Size cap: pruned ${pruned} git-history-only entries (${(preSerialized.length / 1e6).toFixed(1)} MB → ${afterMB} MB)`);
    }
    fs.writeFileSync(trackingFile, JSON.stringify(tracking) + '\n');
    const updatedCompat = {
      ...compat,
      paths: [...existingCompat].filter((p) => typeof p === 'string' && p.startsWith('/')).sort(),
      lastUpdated: new Date().toISOString().split('T')[0],
    };
    // Floor-guard (#1353): additive writer (same class as discover-404s/sync-gsc-orphans).
    // readCompatPaths() returns {paths:[]} on a corrupt/empty store → existingCompat
    // seeded only from tracking → this write TRUNCATES the accumulator. Re-read on-disk
    // for an authoritative prevCount and abort via the shared guard if it would shrink
    // below the floor while a large version exists.
    const prevCount = readCompatPaths(ROOT)?.paths?.length ?? 0;
    assertCompatFloor(prevCount, updatedCompat.paths.length, { label: compatFile });
    writeCompatPaths(updatedCompat, ROOT);
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
