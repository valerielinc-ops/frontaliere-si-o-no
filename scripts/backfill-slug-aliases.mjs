#!/usr/bin/env node
/**
 * Backfill: match known 404 job slugs to active jobs and populate
 * previousSlugs / previousSlugsByLocale for alias resolution.
 *
 * Two passes:
 * 1. 404-compat pass: Extract slugs from seo-404-compat-paths.json,
 *    match to active jobs via company+location heuristics, add to previousSlugs.
 * 2. Registry pass: Scan slug-registry.json (immutable snapshot of original slugs),
 *    match to active jobs via URL fingerprint, and recover historically lost slugs
 *    that were overwritten during early pipeline development.
 *
 * Run: node scripts/backfill-slug-aliases.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintJob, loadSlugRegistry } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const BY_CRAWLER_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');
const COMPAT_PATHS = path.resolve(ROOT, 'data', 'seo-404-compat-paths.json');

const JOB_PATH_PREFIX = '/cerca-lavoro-ticino/';

function normalize(s = '') {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function extractSlugFromPath(p = '') {
  let slug = String(p || '').trim();
  // Remove locale prefixes
  slug = slug.replace(/^\/(en|de|fr)\/(find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\//, '/cerca-lavoro-ticino/');
  if (!slug.startsWith(JOB_PATH_PREFIX)) return '';
  slug = slug.slice(JOB_PATH_PREFIX.length).replace(/\/+$/, '').trim();
  return slug || '';
}

function allCurrentSlugs(job) {
  const slugs = new Set();
  if (job.slug) slugs.add(normalize(job.slug));
  if (job.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const s of Object.values(job.slugByLocale)) {
      if (s) slugs.add(normalize(s));
    }
  }
  if (Array.isArray(job.previousSlugs)) {
    for (const s of job.previousSlugs) {
      if (s) slugs.add(normalize(s));
    }
  }
  return slugs;
}

/**
 * Extract company-like tokens from a slug.
 * e.g., "bi-specialist-relewant-bellinzona" → ["relewant"]
 */
function extractCompanyToken(slug, companyKey) {
  // Normalize company key to slug form
  const keyParts = normalize(companyKey).replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean);
  // Check which company tokens appear in the slug
  return keyParts.filter((part) => part.length > 3 && slug.includes(part));
}

/**
 * Load jobs from per-crawler files (primary) or assembled jobs.json (fallback).
 * Returns { jobs, sources } where sources maps each job to its origin file for saving.
 */
function loadJobs() {
  const jobs = [];
  const sources = new Map(); // job → { file, crawlerData }

  if (fs.existsSync(BY_CRAWLER_DIR)) {
    for (const file of fs.readdirSync(BY_CRAWLER_DIR).filter(f => f.endsWith('.json'))) {
      const filePath = path.join(BY_CRAWLER_DIR, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const crawlerJobs = data.jobs || [];
      for (const job of crawlerJobs) {
        jobs.push(job);
        sources.set(job, { file: filePath, crawlerData: data });
      }
    }
    if (jobs.length > 0) {
      console.log(`Loaded ${jobs.length} jobs from ${fs.readdirSync(BY_CRAWLER_DIR).filter(f => f.endsWith('.json')).length} crawler files.`);
      return { jobs, sources };
    }
  }

  // Fallback to assembled jobs.json
  if (fs.existsSync(DATA_JOBS)) {
    const assembled = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf8'));
    const assembledJobs = Array.isArray(assembled) ? assembled : [];
    for (const job of assembledJobs) jobs.push(job);
    console.log(`Loaded ${jobs.length} jobs from assembled jobs.json.`);
  }
  return { jobs, sources };
}

/**
 * Save modified crawler files back to disk.
 */
function saveCrawlerFiles(modifiedFiles) {
  for (const [filePath, data] of modifiedFiles) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
}

function main() {
  const { jobs, sources } = loadJobs();
  if (jobs.length === 0) {
    console.log('No jobs found.');
    return;
  }

  const compat = fs.existsSync(COMPAT_PATHS)
    ? JSON.parse(fs.readFileSync(COMPAT_PATHS, 'utf8'))
    : { paths: [] };
  const paths = Array.isArray(compat.paths) ? compat.paths : [];

  // Build index: companyKey → jobs
  const byCompany = new Map();
  for (const job of jobs) {
    const key = normalize(job.companyKey || '');
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(job);
  }

  // Extract job slugs from 404 paths
  const orphanSlugs = [];
  for (const p of paths) {
    const slug = extractSlugFromPath(p);
    if (!slug) continue;
    // Skip editorial/company/search pages
    if (/^(azienda-|company-|unternehmen-|entreprise-|ricerca-|search-|suche-|recherche-|cuochi)/.test(slug)) continue;
    orphanSlugs.push(slug);
  }

  console.log(`Found ${orphanSlugs.length} job slugs from 404 compat paths.`);

  let matched = 0;
  let added = 0;

  for (const slug of orphanSlugs) {
    const normalizedSlug = normalize(slug);

    // Try to match to a company by checking if any company key tokens appear in the slug
    let bestMatch = null;
    let bestOverlap = 0;

    for (const [companyKey, companyJobs] of byCompany) {
      const tokens = extractCompanyToken(normalizedSlug, companyKey);
      if (tokens.length === 0) continue;

      // Found company match — now find the best job match within this company
      for (const job of companyJobs) {
        const currentSlugs = allCurrentSlugs(job);
        // Already known slug — skip
        if (currentSlugs.has(normalizedSlug)) {
          bestMatch = null;
          bestOverlap = Infinity; // Signal: already matched, don't add
          break;
        }

        // Check word overlap between the orphan slug and current slugs
        // Require location match (last word of slug is typically the location)
        const orphanWords = normalizedSlug.split('-').filter((w) => w.length > 2);
        const orphanLocation = normalizedSlug.split('-').pop() || '';
        const jobLocation = normalize(job.addressLocality || job.location || '').replace(/[^a-z0-9]+/g, '-');

        // Location must match (prevents cross-location false positives)
        const locationMatches = orphanLocation && jobLocation &&
          (jobLocation.includes(orphanLocation) || orphanLocation.includes(jobLocation));
        if (!locationMatches) continue;

        const orphanWordSet = new Set(orphanWords);
        let maxOverlap = 0;
        for (const cs of currentSlugs) {
          const currentWords = new Set(cs.split('-').filter((w) => w.length > 2));
          let common = 0;
          for (const w of orphanWordSet) {
            if (currentWords.has(w)) common++;
          }
          const overlap = common / Math.max(orphanWordSet.size, currentWords.size);
          if (overlap > maxOverlap) maxOverlap = overlap;
        }

        // For long company names (VF International, etc.), require higher overlap
        // to avoid matching completely different roles
        const threshold = orphanWordSet.size > 12 ? 0.85 : orphanWordSet.size > 8 ? 0.7 : 0.55;
        if (maxOverlap > bestOverlap && maxOverlap >= threshold) {
          bestOverlap = maxOverlap;
          bestMatch = job;
        }
      }

      if (bestOverlap === Infinity) break; // Already matched, skip
    }

    if (bestMatch && bestOverlap !== Infinity) {
      matched++;
      if (!Array.isArray(bestMatch.previousSlugs)) bestMatch.previousSlugs = [];
      if (!bestMatch.previousSlugs.includes(slug)) {
        bestMatch.previousSlugs.push(slug);
        added++;
        console.log(`  ✅ "${slug}" → "${bestMatch.slug}" (${bestMatch.company}, overlap: ${(bestOverlap * 100).toFixed(0)}%)`);
      }
    }
  }

  console.log(`\nMatched ${matched} orphan slugs to active jobs (${added} new aliases added).`);

  // ── Pass 2: Registry reconciliation ──────────────────────────
  // The slug-registry.json is an immutable snapshot of each job's original slugs
  // at creation time. Some of these original slugs were lost during early pipeline
  // development (e.g., Italian slug written into EN slot, destroying the original
  // EN slug). This pass recovers them by comparing registry snapshots against
  // current job data and adding any missing slugs to previousSlugsByLocale.
  const registry = loadSlugRegistry();
  const registryEntries = Object.entries(registry);
  let registryRecovered = 0;

  console.log(`\n── Registry reconciliation (${registryEntries.length} entries) ──`);

  for (const job of jobs) {
    const fp = fingerprintJob(job);
    if (!fp || !registry[fp]) continue;

    const registryEntry = registry[fp];
    const registrySlugs = registryEntry.slugByLocale || {};

    // Collect locale-specific slugs the job currently knows about.
    // Intentionally excludes flat previousSlugs — those are locale-agnostic and
    // should not prevent locale-specific recovery into previousSlugsByLocale.
    const knownByLocale = {};
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const known = new Set();
      if (job.slug) known.add(normalize(job.slug));
      if (job.slugByLocale?.[locale]) known.add(normalize(job.slugByLocale[locale]));
      if (job.previousSlugsByLocale?.[locale]) {
        for (const s of job.previousSlugsByLocale[locale]) known.add(normalize(s));
      }
      knownByLocale[locale] = known;
    }

    // Check each registry locale slug — if unknown, recover it
    for (const [locale, regSlug] of Object.entries(registrySlugs)) {
      if (!regSlug) continue;
      const normalizedRegSlug = normalize(regSlug);
      if (knownByLocale[locale]?.has(normalizedRegSlug)) continue;

      // This registry slug is lost — recover it
      if (!job.previousSlugsByLocale) job.previousSlugsByLocale = {};
      if (!Array.isArray(job.previousSlugsByLocale[locale])) job.previousSlugsByLocale[locale] = [];
      if (!job.previousSlugsByLocale[locale].includes(regSlug)) {
        job.previousSlugsByLocale[locale].push(regSlug);
        registryRecovered++;
        console.log(`  🔄 [${locale}] "${regSlug}" → "${job.slugByLocale?.[locale] || job.slug}" (${job.company})`);
      }

      // Also add to flat previousSlugs for backwards compatibility
      if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
      if (!job.previousSlugs.includes(regSlug)) {
        job.previousSlugs.push(regSlug);
      }
    }

    // Also check the registry's canonicalSlug
    const regCanonical = registryEntry.canonicalSlug;
    if (regCanonical) {
      const allKnown = new Set();
      for (const s of Object.values(knownByLocale)) {
        for (const v of s) allKnown.add(v);
      }
      if (!allKnown.has(normalize(regCanonical))) {
        if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
        if (!job.previousSlugs.includes(regCanonical)) {
          job.previousSlugs.push(regCanonical);
          registryRecovered++;
          console.log(`  🔄 [canonical] "${regCanonical}" → "${job.slug}" (${job.company})`);
        }
      }
    }
  }

  console.log(`Registry reconciliation: ${registryRecovered} historically lost slugs recovered.`);

  const totalAdded = added + registryRecovered;
  if (totalAdded > 0) {
    // Save to per-crawler files if that's where we loaded from
    if (sources.size > 0) {
      const modifiedFiles = new Map();
      for (const job of jobs) {
        const src = sources.get(job);
        if (src) modifiedFiles.set(src.file, src.crawlerData);
      }
      saveCrawlerFiles(modifiedFiles);
      console.log(`\n💾 Saved ${modifiedFiles.size} crawler files (${added} from 404 paths + ${registryRecovered} from registry).`);
    } else {
      // Fallback: save to assembled jobs.json
      const payload = `${JSON.stringify(jobs, null, 2)}\n`;
      fs.writeFileSync(DATA_JOBS, payload, 'utf8');
      if (fs.existsSync(PUBLIC_JOBS)) {
        fs.writeFileSync(PUBLIC_JOBS, payload, 'utf8');
      }
      console.log(`\n💾 Saved updated jobs.json (${added} from 404 paths + ${registryRecovered} from registry).`);
    }
  }
}

main();
