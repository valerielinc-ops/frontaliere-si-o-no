#!/usr/bin/env node
/**
 * Regenerate slugByLocale from titleByLocale — SLUG-ONLY, never touches titles.
 *
 * This is the safe replacement for hardenJobLocaleFields (Phase 3).
 * hardenJobLocaleFields was destructive: it re-translated titles, put Italian
 * in EN/DE/FR slots, and set needsRetranslation=true — creating infinite loops.
 *
 * This script ONLY:
 *   1. Reads titleByLocale[locale] + company + location
 *   2. Generates slugByLocale[locale] = slugify(title-company-location)
 *   3. Preserves old slugs in previousSlugs for SEO bridge pages
 *
 * It NEVER:
 *   - Modifies titleByLocale or descriptionByLocale
 *   - Sets needsRetranslation
 *   - Changes the master slug (job.slug)
 *   - Touches sourceLang or any other job field
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
const MAX_SLUG_LENGTH = 120;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

/**
 * Slugify a string: lowercase, replace non-alphanumeric with dashes, trim.
 */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

/**
 * Build a slug from title + company + location (same format as the crawler).
 */
function buildSlug(title, company, location) {
  const parts = [title, company, location].filter(Boolean);
  return slugify(parts.join(' '));
}

/**
 * Check if a slug roughly corresponds to a title.
 * Returns true if the slug contains the first meaningful word of the title.
 */
function slugMatchesTitle(slug, title) {
  if (!slug || !title) return false;
  const titleSlug = slugify(title);
  // Compare first 15 chars of slugified title against slug
  const prefix = titleSlug.slice(0, Math.min(15, titleSlug.indexOf('-', 8) || 15));
  if (prefix.length < 4) return true; // too short to compare meaningfully
  return slug.includes(prefix);
}

async function main() {
  const files = fs.readdirSync(BY_CRAWLER_DIR).filter(f => f.endsWith('.json')).sort();
  console.log(`🔗 Regenerating slugByLocale across ${files.length} per-crawler slices...\n`);

  let totalFixed = 0;
  let totalJobs = 0;
  let slicesChanged = 0;

  for (const file of files) {
    const slicePath = path.join(BY_CRAWLER_DIR, file);
    const sliceData = readJson(slicePath);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : [];
    if (jobs.length === 0) continue;

    let sliceChanged = false;

    for (const job of jobs) {
      const sourceLang = job.sourceLang || 'it';
      const tbl = job.titleByLocale || {};
      const sbl = job.slugByLocale || {};
      const company = job.company || '';
      const location = job.location || job.addressLocality || '';

      totalJobs++;

      for (const locale of LOCALES) {
        // Never touch the source-lang slug or the master slug
        if (locale === sourceLang) continue;

        const title = (tbl[locale] || '').trim();
        const currentSlug = (sbl[locale] || '').trim();

        // No title → can't generate slug
        if (!title || title.length < 3) continue;

        // If slug already matches title, skip
        if (currentSlug && slugMatchesTitle(currentSlug, title)) continue;

        // Generate new slug from locale title
        const newSlug = buildSlug(title, company, location);
        if (!newSlug || newSlug === currentSlug) continue;

        // Don't replace if slug is the same as another locale's slug (avoid collisions)
        const otherSlugs = new Set(
          LOCALES.filter(l => l !== locale).map(l => (sbl[l] || '').trim()).filter(Boolean)
        );
        if (otherSlugs.has(newSlug)) continue;

        // Preserve old slug in previousSlugs for SEO bridge pages
        if (currentSlug && currentSlug !== newSlug) {
          if (!job.previousSlugs) job.previousSlugs = [];
          if (!job.previousSlugs.includes(currentSlug)) {
            // Don't add if it's still an active slug in another locale
            const activeSlugs = new Set([
              job.slug,
              ...LOCALES.map(l => (sbl[l] || '').trim()).filter(Boolean),
            ]);
            activeSlugs.delete(currentSlug); // remove the one we're replacing
            if (!activeSlugs.has(currentSlug)) {
              job.previousSlugs.push(currentSlug);
            }
          }
          // Cap previousSlugs at 20
          if (job.previousSlugs.length > 20) {
            job.previousSlugs = job.previousSlugs.slice(-20);
          }
        }

        sbl[locale] = newSlug;
        job.slugByLocale = sbl;
        sliceChanged = true;
        totalFixed++;
      }
    }

    if (sliceChanged) {
      slicesChanged++;
      const crawlerKey = file.replace('.json', '');
      const fixedInSlice = jobs.filter(j => {
        // Count how many were actually changed (approximate)
        return true;
      }).length;
      console.log(`  ✅ ${crawlerKey}`);
      writeJson(slicePath, sliceData);
    }
  }

  console.log(`\n📊 Slug regeneration complete: ${totalFixed} locale slugs fixed across ${slicesChanged} slices (${totalJobs} total jobs)`);
}

main().catch(err => {
  console.error('❌ Slug regeneration failed:', err?.message || err);
  process.exit(1);
});
