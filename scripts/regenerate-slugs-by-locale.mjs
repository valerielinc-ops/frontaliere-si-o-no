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
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];

import {
  addPreviousSlugForLocale,
  cleanPreviousSlugsPerLocale,
  getRegisteredSlug,
  loadSlugRegistry,
  registryPinnedLocaleSlug,
} from './lib/dedicated-crawler-common.mjs';
import {
  appendDisambiguatorTail,
  buildSlug,
  isLikelyUntranslated,
  shortJobHash,
  slugMatchesTitle,
} from './lib/regenerate-slugs-helpers.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { hasUsableJobId } from './lib/job-match-key.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function main() {
  const files = listSliceFileNames(BY_CRAWLER_DIR).sort();
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
      if (!hasUsableJobId(job)) continue;
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

  // Immutable slug-registry: a job already registered with a real per-locale
  // translation must keep that slug even if its title was re-translated into a
  // different form on a later crawl. Without this pin, a non-deterministic AI
  // re-translation here mints a brand-new slug (old URL only survives via the
  // previousSlugs bridge) — the exact instability this script otherwise feeds.
  const slugRegistry = loadSlugRegistry();

  let totalFixed = 0;
  let totalJobs = 0;
  let totalDisambiguated = 0;
  let totalPinned = 0;
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

        // ── Registry pin ────────────────────────────────────────────────────
        // If this job is registered with a real translation for this locale,
        // the immutable registry slug wins over anything derived from the
        // (possibly re-translated) title below. Restore it when the current
        // slice drifted, preserving the drifted slug as a previousSlug bridge,
        // then skip title-based regeneration for this locale entirely.
        const pinnedSlug = registryPinnedLocaleSlug(getRegisteredSlug(job, slugRegistry), locale, sourceLang);
        if (pinnedSlug) {
          // Defense-in-depth: the registry pin bypasses the cross-job
          // disambiguator the title-derivation path applies below, so surface a
          // pre-existing registry collision (two job ids registered to the same
          // per-locale slug) instead of silently minting two identical URLs.
          const slugMap = usedSlugs.get(locale);
          const owner = slugMap.get(pinnedSlug);
          if (owner && owner !== job.id) {
            console.warn(`[registry-pin] ${locale} slug "${pinnedSlug}" registered to ${job.id} also owned by ${owner} — canonical split (pre-existing registry collision)`);
          }
          if (currentSlug && currentSlug !== pinnedSlug) {
            addPreviousSlugForLocale(job, locale, currentSlug, 20);
            if (slugMap.get(currentSlug) === job.id) slugMap.delete(currentSlug);
            slugMap.set(pinnedSlug, job.id);
            sbl[locale] = pinnedSlug;
            job.slugByLocale = sbl;
            sliceChanged = true;
            totalPinned++;
          } else if (!currentSlug) {
            sbl[locale] = pinnedSlug;
            job.slugByLocale = sbl;
            slugMap.set(pinnedSlug, job.id);
            sliceChanged = true;
            totalPinned++;
          }
          continue;
        }

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
        if (hasUsableJobId(job)) {
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
        if (hasUsableJobId(job)) {
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
  if (totalPinned > 0) {
    console.log(`🔒 Registry pin: ${totalPinned} locale slug(s) restored to the immutable registry value (drift demoted to previousSlugs)`);
  }
  if (totalDisambiguated > 0) {
    console.log(`🔠 Cross-job uniqueness: ${totalDisambiguated} slug(s) acquired a -<hash> tail to avoid colliding with another job's slug for the same locale`);
  }
}

main().catch(err => {
  console.error('❌ Slug regeneration failed:', err?.message || err);
  process.exit(1);
});
