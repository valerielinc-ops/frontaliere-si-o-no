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

// Stop words filtered from slug tokens (IT/EN/DE/FR connectives)
const SLUG_STOP_WORDS = new Set(
  'del,dei,della,delle,degli,nel,nella,per,con,una,uno,che,tra,fra,sur,les,des,une,pour,avec,dans,par,the,and,for,with,from,die,der,das,den,dem,des,und,fur,mit,von,bei,ein,eine,einer,einem,einen'.split(','),
);

function slugTokenSet(slug) {
  return new Set(
    String(slug || '').split('-').filter((w) => w.length >= 3 && !SLUG_STOP_WORDS.has(w)),
  );
}

/**
 * Jaccard similarity between two slugified strings based on their meaningful tokens.
 * Returns a value in [0, 1]: 1 = identical token sets, 0 = disjoint.
 */
function slugJaccard(a, b) {
  const setA = slugTokenSet(a);
  const setB = slugTokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Check if a locale title is likely untranslated (still in the source language).
 * Uses Jaccard token similarity on slugified versions — threshold 0.5 catches
 * exact copies AND partial heuristic translations that changed only 1-2 words.
 */
function isLikelyUntranslated(localeTitle, sourceTitle) {
  if (!localeTitle || !sourceTitle) return false;
  const a = slugify(localeTitle);
  const b = slugify(sourceTitle);
  if (a === b) return true;
  return slugJaccard(a, b) > 0.5;
}

/**
 * Check if a slug roughly corresponds to a title+company+location (Jaccard-based).
 * Compares the full derived slug (with company+location) to avoid false negatives
 * when the existing slug contains company/location tokens that dilute Jaccard
 * against a title-only slugified string.
 */
function slugMatchesTitle(slug, title, company, location) {
  if (!slug || !title) return false;
  const fullSlug = buildSlug(title, company, location);
  if (!fullSlug) return false;
  return slugJaccard(slug, fullSlug) >= 0.5;
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

        // If title is a source copy or partial heuristic translation, skip slug
        // regeneration. Uses Jaccard similarity (>0.5) on slugified tokens to catch
        // both exact copies and partial translations that changed only 1-2 words.
        // Without this, an Italian title in the EN slot would overwrite a properly
        // translated English slug with an Italian-derived one.
        const sourceTitle = (tbl[sourceLang] || '').trim();
        if (sourceTitle && isLikelyUntranslated(title, sourceTitle)) continue;

        // If slug already matches title+company+location, skip
        if (currentSlug && slugMatchesTitle(currentSlug, title, company, location)) continue;

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

      // Safety net: strip any previousSlug that matches an active slug.
      // Multiple locale changes per job can leave stale entries.
      for (const job of jobs) {
        if (!Array.isArray(job.previousSlugs) || job.previousSlugs.length === 0) continue;
        const active = new Set();
        if (job.slug) active.add(String(job.slug).trim());
        if (job.slugByLocale && typeof job.slugByLocale === 'object') {
          for (const v of Object.values(job.slugByLocale)) {
            if (v) active.add(String(v).trim());
          }
        }
        const cleaned = job.previousSlugs.filter(s => !active.has(String(s).trim()));
        if (cleaned.length === 0) delete job.previousSlugs;
        else job.previousSlugs = cleaned;
      }

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
