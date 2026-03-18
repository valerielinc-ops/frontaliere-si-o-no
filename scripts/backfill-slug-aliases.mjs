#!/usr/bin/env node
/**
 * One-time backfill: match known 404 job slugs to active jobs and
 * populate previousSlugs for alias resolution.
 *
 * Strategy:
 * 1. Extract job slugs from seo-404-compat-paths.json
 * 2. For each, check if it matches an active job via company+location substring matching
 * 3. If matched and the slug differs from all current slugs, add to previousSlugs
 *
 * Run: node scripts/backfill-slug-aliases.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
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

function main() {
  if (!fs.existsSync(DATA_JOBS) || !fs.existsSync(COMPAT_PATHS)) {
    console.log('Missing required files.');
    return;
  }

  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf8'));
  const compat = JSON.parse(fs.readFileSync(COMPAT_PATHS, 'utf8'));
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
      // Cap at 5 backfill aliases per job to avoid noise
      if (!bestMatch.previousSlugs.includes(slug) && bestMatch.previousSlugs.length < 5) {
        bestMatch.previousSlugs.push(slug);
        added++;
        console.log(`  ✅ "${slug}" → "${bestMatch.slug}" (${bestMatch.company}, overlap: ${(bestOverlap * 100).toFixed(0)}%)`);
      }
    }
  }

  console.log(`\nMatched ${matched} orphan slugs to active jobs (${added} new aliases added).`);

  if (added > 0) {
    const payload = `${JSON.stringify(jobs, null, 2)}\n`;
    fs.writeFileSync(DATA_JOBS, payload, 'utf8');
    if (fs.existsSync(PUBLIC_JOBS)) {
      fs.writeFileSync(PUBLIC_JOBS, payload, 'utf8');
    }
    console.log('💾 Saved updated jobs.json with previousSlugs backfill.');
  }
}

main();
