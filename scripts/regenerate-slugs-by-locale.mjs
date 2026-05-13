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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
const MAX_SLUG_LENGTH = 120;

// Import locale-aware previousSlugs helpers
import { addPreviousSlugForLocale, cleanPreviousSlugsPerLocale } from './lib/dedicated-crawler-common.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

/**
 * Slugify a string: lowercase, replace non-alphanumeric with dashes, trim.
 * Trims at word boundary when the cap would split a token.
 */
function slugify(text) {
  const base = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateSlugAtWordBoundary(base, MAX_SLUG_LENGTH);
}

/**
 * Derive a 6-char hex tail from a job identifier \u2014 used as a deterministic
 * disambiguating suffix when a generated slug already belongs to another job.
 *
 * Why 6 chars: 16^6 \u2248 16 M slots \u2192 birthday-paradox collision probability
 * with the ~3000 active jobs in the feed is well below 0.001 %, while
 * keeping URLs short. The hash is stable for a given `job.id` (which is
 * itself content-addressed by the crawler), so the suffix doesn't churn
 * across builds \u2014 Google's link equity stays glued to one URL per job.
 */
function shortJobHash(jobId) {
  return crypto.createHash('sha1').update(String(jobId || '')).digest('hex').slice(0, 6);
}

/**
 * Append a hex disambiguator tail to a slug, respecting MAX_SLUG_LENGTH.
 * Returns the original slug if it's empty (no point disambiguating nothing).
 */
function appendDisambiguatorTail(slug, tail) {
  const t = String(tail || '').trim();
  if (!t) return slug;
  const maxBase = Math.max(0, MAX_SLUG_LENGTH - t.length - 1);
  const trimmed = truncateSlugAtWordBoundary(String(slug || ''), maxBase).replace(/-+$/, '');
  return trimmed ? `${trimmed}-${t}` : t;
}

/**
 * Build a slug from title + company + location (same format as the crawler).
 * When disambiguator is provided, appends it as a stable suffix.
 */
function buildSlug(title, company, location, disambiguator = '') {
  const parts = [title, company, location].filter(Boolean);
  const base = slugify(parts.join(' '));
  const d = String(disambiguator || '').trim();
  if (!d || !base) return base;
  const maxBase = Math.max(0, MAX_SLUG_LENGTH - d.length - 1);
  const trimmed = truncateSlugAtWordBoundary(base, maxBase).replace(/-+$/, '');
  return trimmed ? `${trimmed}-${d}` : d;
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
function slugMatchesTitle(slug, title, company, location, disambiguator = '') {
  if (!slug || !title) return false;
  const fullSlug = buildSlug(title, company, location, disambiguator);
  if (!fullSlug) return false;
  return slugJaccard(slug, fullSlug) >= 0.5;
}

async function main() {
  const files = fs.readdirSync(BY_CRAWLER_DIR).filter(f => f.endsWith('.json')).sort();
  console.log(`🔗 Regenerating slugByLocale across ${files.length} per-crawler slices...\n`);

  // ── Pre-pass: cross-job slug uniqueness map ────────────────────────────
  // Walks every slice and records the CURRENT mapping `slug → owning jobId`
  // per locale. The generation pass below uses this map to detect when a
  // newly-derived slug would steal another job's slug (Phase 4 case 5 —
  // prevent "shared slugs" that cause downstream emit collisions like
  // Projektleiter/Projektingenieur sharing `project-manager-...-chur`).
  // When a collision is detected, the new job gets `-${shortJobHash(id)}`
  // appended so the slug stays stable across builds (job.id is
  // content-addressed by the crawler) without flipping who owns the bare
  // form.
  const usedSlugs = new Map(); // locale → Map<slug, jobId>
  for (const locale of LOCALES) usedSlugs.set(locale, new Map());
  let preScanJobs = 0;
  let preScanMappings = 0;
  for (const file of files) {
    const slicePath = path.join(BY_CRAWLER_DIR, file);
    const sliceData = readJson(slicePath);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : [];
    for (const job of jobs) {
      preScanJobs++;
      if (!job?.id) continue;
      const sbl = job.slugByLocale || {};
      for (const locale of LOCALES) {
        const slug = (sbl[locale] || '').trim();
        if (!slug) continue;
        const slugMap = usedSlugs.get(locale);
        // First-write wins for the pre-scan: if two jobs in CURRENT data
        // already share a slug (legacy collision), the first one we see
        // owns it from this build's perspective. The second one will
        // detect the conflict during the generation pass and acquire a
        // disambiguator on its next regen.
        if (!slugMap.has(slug)) {
          slugMap.set(slug, job.id);
          preScanMappings++;
        }
      }
    }
  }
  console.log(`🗺️  Pre-scan: ${preScanJobs} jobs, ${preScanMappings} unique (locale, slug) mappings indexed`);

  let totalFixed = 0;
  let totalJobs = 0;
  let totalDisambiguated = 0;
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
      const disambiguator = String(job.slugDisambiguator || '').trim();

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

        // If slug already matches title+company+location (+ disambiguator), skip
        if (currentSlug && slugMatchesTitle(currentSlug, title, company, location, disambiguator)) continue;

        // Generate new slug from locale title, re-appending disambiguator
        let newSlug = buildSlug(title, company, location, disambiguator);
        if (!newSlug || newSlug === currentSlug) continue;

        // Don't replace if slug is the same as another locale's slug (avoid collisions)
        const otherSlugs = new Set(
          LOCALES.filter(l => l !== locale).map(l => (sbl[l] || '').trim()).filter(Boolean)
        );
        if (otherSlugs.has(newSlug)) continue;

        // Cross-job uniqueness check (Phase 4 case 5).
        // If another active job already owns `newSlug` for this locale,
        // append a deterministic short hash of THIS job's id so the slug
        // is unique across the feed. The hash is stable for a given
        // job.id (content-addressed by the crawler), so once a job
        // acquires a disambiguator it keeps it across rebuilds — Google's
        // link equity stays glued to one URL per job. This prevents the
        // downstream emit collisions documented in Phase 4 cases 1 and 4
        // (Convit, Projektleiter/Projektingenieur, etc).
        if (job.id) {
          const slugMap = usedSlugs.get(locale);
          const owner = slugMap.get(newSlug);
          if (owner && owner !== job.id) {
            const tail = shortJobHash(job.id);
            const disambig = appendDisambiguatorTail(newSlug, tail);
            // Pathological: even the disambiguated form is taken (extremely
            // unlikely with a 6-hex tail, but possible if two jobs share
            // the bare slug AND collide on hash). Skip rather than
            // overwrite a wrong owner.
            const ownerAfter = slugMap.get(disambig);
            if (ownerAfter && ownerAfter !== job.id) {
              console.warn(`[slug-uniqueness] could not derive unique ${locale} slug for ${job.id}: ${newSlug} taken by ${owner}, ${disambig} taken by ${ownerAfter} — keeping current`);
              continue;
            }
            newSlug = disambig;
            totalDisambiguated++;
          }
        }

        // Preserve old slug in previousSlugsByLocale for SEO bridge pages
        // Uses locale-aware storage so bridge page is generated under correct locale prefix
        if (currentSlug && currentSlug !== newSlug) {
          addPreviousSlugForLocale(job, locale, currentSlug, 20);
        }

        // Update the cross-job uniqueness map: this job now owns newSlug
        // for this locale, and (if changing from currentSlug) releases
        // currentSlug back to the pool.
        if (job.id) {
          const slugMap = usedSlugs.get(locale);
          if (currentSlug && slugMap.get(currentSlug) === job.id) {
            slugMap.delete(currentSlug);
          }
          slugMap.set(newSlug, job.id);
        }

        sbl[locale] = newSlug;
        job.slugByLocale = sbl;

        // Keep master slug in sync with IT slug (master serves the IT path)
        if (locale === 'it' && job.slug && job.slug !== newSlug) {
          // Capture old master as IT previousSlug before overwriting
          if (job.slug !== currentSlug) {
            addPreviousSlugForLocale(job, 'it', job.slug, 20);
          }
          job.slug = newSlug;
        }

        sliceChanged = true;
        totalFixed++;
      }
    }

    if (sliceChanged) {
      slicesChanged++;
      const crawlerKey = file.replace('.json', '');

      // Per-locale safety net: only strip a previousSlug if it matches the
      // SAME locale's active slug. Cross-locale matches are preserved.
      for (const job of jobs) {
        cleanPreviousSlugsPerLocale(job);
      }

      console.log(`  ✅ ${crawlerKey}`);
      writeJson(slicePath, sliceData);
    }
  }

  console.log(`\n📊 Slug regeneration complete: ${totalFixed} locale slugs fixed across ${slicesChanged} slices (${totalJobs} total jobs)`);
  if (totalDisambiguated > 0) {
    console.log(`🔠 Cross-job uniqueness: ${totalDisambiguated} slug(s) acquired a -<hash> tail to avoid colliding with another job's slug for the same locale`);
  }
}

main().catch(err => {
  console.error('❌ Slug regeneration failed:', err?.message || err);
  process.exit(1);
});
