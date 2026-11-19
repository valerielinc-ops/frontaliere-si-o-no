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
 *   2. Generates slugByLocale[locale] = slugify(title-company-location) for a
 *      locale whose slug is missing, was never served, or no longer carries
 *      the job's company/location (published-slug stability, 2026-11-13)
 *   3. Preserves old slugs in previousSlugs for SEO bridge pages
 *
 * It NEVER:
 *   - Modifies titleByLocale or descriptionByLocale
 *   - Sets needsRetranslation
 *   - Changes the master slug independently of the Italian route
 *   - Touches sourceLang or any other job field
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { resolveCrawlerGenerationToken } from './lib/crawler-generation-token.mjs';
import {
  assertSlugRegenerationPostRun,
  createSlugRegenerationProof,
  snapshotSlugCorpus,
} from './lib/slug-regeneration-proof.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
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
  slugNeedsBrandRefresh,
} from './lib/regenerate-slugs-helpers.mjs';
import { applyDeclaredBrandRelabel, declaredBrandLabels } from './lib/crawler-brand-relabel.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { hasUsableJobId } from './lib/job-match-key.mjs';
import { decontaminateSliceDirectory } from './decontaminate-prev-slugs.mjs';
import { localeTitleDropsSourceWords, losslessSlugTitle } from './lib/job-title-identity.mjs';
import {
  loadServedSlugLedger,
  mayReplacePublishedSlug,
  slugFirstServedAt,
} from './lib/published-slug-stability.mjs';
import { jobTitleSourceLang } from './lib/job-locale-utils.mjs';

function servedSlugClaimKey(locale, slug) {
  return `${locale}\u0000${String(slug || '').trim()}`;
}

/**
 * Source-backed candidates for a locale slot. Flat `previousSlugs` are
 * deliberately excluded because they do not prove which locale owned a URL.
 */
export function servedSlugCandidates(job, locale) {
  if (!job || typeof job !== 'object' || !LOCALES.includes(locale)) return [];
  const candidates = new Map();
  const add = (slug, origin) => {
    const clean = String(slug || '').trim();
    if (clean && !candidates.has(clean)) candidates.set(clean, origin);
  };

  const localeSlugs = job.slugByLocale || {};
  const currentSlug = String(localeSlugs[locale] || (locale === 'it' ? job.slug : '') || '').trim();
  add(currentSlug, 'active');
  for (const slug of job.previousSlugsByLocale?.[locale] || []) add(slug, 'locale-history');

  const sourceLang = jobTitleSourceLang(job, job.sourceLang || 'it');
  const sourceTitle = String(job.title || job.titleByLocale?.[sourceLang] || '').trim();
  const title = locale === sourceLang
    ? String(job.titleByLocale?.[locale] || '').trim()
    : losslessSlugTitle(String(job.titleByLocale?.[locale] || '').trim(), sourceTitle).trim();
  const company = String(job.company || '');
  // Mirror hardenJobLocaleFields: losslessSlugTitle substitutes the source
  // title for a truncated translation and addressLocality wins over location.
  const location = String(job.addressLocality || job.location || '');
  const disambiguator = String(job.slugDisambiguator || '').trim();
  if (title.length >= 3) {
    add(buildSlug(title, company, location, disambiguator), 'title-derived');
  }

  return [...candidates].map(([slug, origin]) => ({ slug, origin }));
}

/**
 * Index every source-backed claim so a historical slug shared by two jobs is
 * never promoted by guesswork. The active-owner map remains a second guard.
 */
export function indexServedSlugCandidateClaims(job, claimsByLocale) {
  if (!hasUsableJobId(job)) return;
  for (const locale of LOCALES) {
    const localeClaims = claimsByLocale.get(locale);
    for (const candidate of servedSlugCandidates(job, locale)) {
      const key = servedSlugClaimKey(locale, candidate.slug);
      const owners = localeClaims.get(key) || new Set();
      owners.add(job.id);
      localeClaims.set(key, owners);
    }
  }
}

/**
 * Move one locale slot to an exact URL already present in the served ledger.
 *
 * By default this only aligns a never-served slice slug to a served candidate
 * (FU-007). `allowFirstServedRestore` enables the separately reviewed one-shot
 * repair that restores an earlier locale-history URL over a later served slug
 * (FU-005). The function mutates only after provenance and ownership pass.
 */
export function servedSlugSliceWriter(job, locale, {
  usedSlugs = null,
  candidateClaims = null,
  allowFirstServedRestore = false,
  requireCurrentServed = false,
} = {}) {
  if (!job || typeof job !== 'object' || !LOCALES.includes(locale)) {
    return { changed: false, reason: 'invalid-input' };
  }
  if (!hasUsableJobId(job)) return { changed: false, reason: 'missing-job-id' };
  if (!loadServedSlugLedger()) return { changed: false, reason: 'missing-ledger' };

  const localeSlugs = job.slugByLocale || {};
  const currentSlug = String(localeSlugs[locale] || (locale === 'it' ? job.slug : '') || '').trim();
  const currentServedAt = currentSlug ? slugFirstServedAt(locale, currentSlug, job) : null;
  if (requireCurrentServed && !currentServedAt) {
    return { changed: false, reason: 'current-unserved' };
  }
  if (currentServedAt && !allowFirstServedRestore) {
    return { changed: false, reason: 'current-served' };
  }

  const servedCandidates = servedSlugCandidates(job, locale)
    // FU-007 is specifically the title-derived URL that the deploy already
    // served while the slice retained a never-served value. Historical
    // candidates belong to the separately approved FU-005 restoration.
    .filter((candidate) => (
      currentServedAt
        ? candidate.origin !== 'title-derived'
        : candidate.origin === 'title-derived'
    ))
    .map((candidate) => ({
      ...candidate,
      firstServedAt: slugFirstServedAt(locale, candidate.slug, job),
    }))
    .filter((candidate) => candidate.firstServedAt)
    .sort((left, right) => (
      left.firstServedAt.localeCompare(right.firstServedAt)
      || left.slug.localeCompare(right.slug)
    ));
  const selected = servedCandidates[0];
  if (!selected || selected.slug === currentSlug) {
    return { changed: false, reason: selected ? 'already-first-served' : 'no-served-candidate' };
  }
  if (currentServedAt && selected.firstServedAt >= currentServedAt) {
    return { changed: false, reason: 'current-is-earliest' };
  }

  const activeOwner = usedSlugs?.get(selected.slug);
  if (activeOwner && activeOwner !== job.id) {
    return { changed: false, reason: 'active-owner-conflict', conflictingJobId: activeOwner };
  }
  const historicalOwners = candidateClaims?.get(servedSlugClaimKey(locale, selected.slug));
  if (historicalOwners && (historicalOwners.size !== 1 || !historicalOwners.has(job.id))) {
    return { changed: false, reason: 'ambiguous-history' };
  }

  if (currentSlug) {
    addPreviousSlugForLocale(job, locale, currentSlug, 20, 'servedSlugSliceWriter');
  }
  if (!job.slugByLocale || typeof job.slugByLocale !== 'object') job.slugByLocale = {};
  job.slugByLocale[locale] = selected.slug;
  if (locale === 'it') syncItalianMasterSlug(job, currentSlug, selected.slug);

  if (usedSlugs) {
    if (currentSlug && usedSlugs.get(currentSlug) === job.id) usedSlugs.delete(currentSlug);
    usedSlugs.set(selected.slug, job.id);
  }
  return {
    changed: true,
    reason: currentServedAt ? 'restore-first-served' : 'align-served-candidate',
    jobId: job.id,
    locale,
    previousSlug: currentSlug,
    nextSlug: selected.slug,
    firstServedAt: selected.firstServedAt,
    candidateOrigin: selected.origin,
  };
}

/**
 * True when `slug`, company/location/disambiguator tokens removed, only drops
 * words of the employer's title — the slug of a truncated translation.
 */
export function slugDropsTitleWords(slug, employerTitle, company, location, disambiguator = '') {
  const noise = new Set(
    `${company || ''} ${location || ''} ${disambiguator || ''}`
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/).filter(Boolean),
  );
  const titlePart = String(slug || '').split('-').filter((t) => t && !noise.has(t)).join(' ');
  return localeTitleDropsSourceWords(titlePart, employerTitle);
}

/**
 * Keep the master route aligned with an Italian locale replacement.
 *
 * `job.slug` is the fallback Italian route whenever `slugByLocale.it` is
 * absent, and remains a separately served legacy route after the locale slot
 * becomes explicit. Preserve that old master route before switching it so a
 * registry pin cannot make the proof lose the pre-run Italian URL.
 */
export function syncItalianMasterSlug(job, previousItalianSlug, nextItalianSlug) {
  if (!job || typeof job !== 'object') return false;
  const masterSlug = String(job.slug || '').trim();
  const nextSlug = String(nextItalianSlug || '').trim();
  const previousSlug = String(previousItalianSlug || '').trim();
  if (!masterSlug || !nextSlug || masterSlug === nextSlug) return false;

  if (masterSlug !== previousSlug) {
    addPreviousSlugForLocale(job, 'it', masterSlug, 20);
  }
  job.slug = nextSlug;
  return true;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function main() {
  const files = listSliceFileNames(BY_CRAWLER_DIR).sort();
  const slicePaths = files.map((file) => path.join(BY_CRAWLER_DIR, file));
  const beforeSnapshot = snapshotSlugCorpus(slicePaths, { root: ROOT });
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
  const candidateClaims = new Map(); // locale → Map<locale+slug, Set<jobId>>
  for (const locale of LOCALES) candidateClaims.set(locale, new Map());
  let preScanJobs = 0;
  let preScanMappings = 0;
  for (const file of files) {
    const slicePath = path.join(BY_CRAWLER_DIR, file);
    const sliceData = readJson(slicePath);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : [];
    for (const job of jobs) {
      preScanJobs++;
      if (!hasUsableJobId(job)) continue;
      indexServedSlugCandidateClaims(job, candidateClaims);
      const sbl = job.slugByLocale || {};
      for (const locale of LOCALES) {
        const slug = String(sbl[locale] || (locale === 'it' ? job.slug : '') || '').trim();
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
  let totalKeptPublished = 0;
  let totalServedAligned = 0;
  let slicesChanged = 0;
  let totalRelabelled = 0;
  let totalSourceRefreshed = 0;
  const brandLabels = declaredBrandLabels();

  for (const file of files) {
    const slicePath = path.join(BY_CRAWLER_DIR, file);
    const sliceData = readJson(slicePath);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : [];
    if (jobs.length === 0) continue;

    let sliceChanged = false;
    const brandRelabelledKey = brandLabels.has(file.replace(/\.json$/, ''));
    if (brandRelabelledKey) {
      const { relabelled } = applyDeclaredBrandRelabel(jobs, brandLabels);
      if (relabelled > 0) {
        totalRelabelled += relabelled;
        sliceChanged = true;
      }
    }

    for (const job of jobs) {
      const sourceLang = jobTitleSourceLang(job, job.sourceLang || 'it');
      const tbl = job.titleByLocale || {};
      const sbl = job.slugByLocale || {};
      const company = job.company || '';
      const location = job.location || job.addressLocality || '';
      const disambiguator = String(job.slugDisambiguator || '').trim();

      totalJobs++;

      for (const locale of LOCALES) {
        const title = (tbl[locale] || '').trim();
        const currentSlug = (sbl[locale] || '').trim();
        const brandRefresh = slugNeedsBrandRefresh({
          isBrandRelabelledKey: brandRelabelledKey,
          currentSlug,
          title,
          company,
          location,
          disambiguator,
        });
        const sourceBrandRefresh = locale === sourceLang && brandRefresh;

        // The existing regeneration intentionally leaves the source locale to
        // its crawler. FU-007 is narrower: when the deploy has already served
        // the exact title-derived source URL, persist that proven URL in the
        // slice before returning to the crawler-owned path.
        if (locale === sourceLang && !sourceBrandRefresh) {
          const sourceAlignment = servedSlugSliceWriter(job, locale, {
            usedSlugs: usedSlugs.get(locale),
            candidateClaims: candidateClaims.get(locale),
          });
          if (sourceAlignment.changed) {
            if (sbl !== job.slugByLocale) {
              Object.assign(sbl, job.slugByLocale);
              job.slugByLocale = sbl;
            }
            sliceChanged = true;
            totalServedAligned++;
          }
          continue;
        }

        // ── Registry pin ────────────────────────────────────────────────────
        // If this job is registered with a real translation for this locale,
        // the immutable registry slug wins over anything derived from the
        // (possibly re-translated) title below. Restore it when the current
        // slice drifted, preserving the drifted slug as a previousSlug bridge,
        // then skip title-based regeneration for this locale entirely.
        // Only the truncation-guard context (no titleByLocale): a registered
        // slug that dropped the employer's trade (`m1-m2-pemsa-lugano`) is not
        // pinned, while the #4071 garbage guard keeps its prior opt-out here.
        const pinnedSlug = brandRefresh
          ? null
          : registryPinnedLocaleSlug(getRegisteredSlug(job, slugRegistry), locale, sourceLang, {
            sourceTitle: String(job.title || '').trim(),
            company,
            location,
            disambiguator,
          });
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
          if (locale === 'it' && syncItalianMasterSlug(job, currentSlug, pinnedSlug)) {
            sliceChanged = true;
          }
          continue;
        }

        if (!brandRefresh) {
          const servedAlignment = servedSlugSliceWriter(job, locale, {
            usedSlugs: usedSlugs.get(locale),
            candidateClaims: candidateClaims.get(locale),
          });
          if (servedAlignment.changed) {
            if (sbl !== job.slugByLocale) {
              Object.assign(sbl, job.slugByLocale);
              job.slugByLocale = sbl;
            }
            sliceChanged = true;
            totalServedAligned++;
            continue;
          }
        }

        // No title → can't generate slug
        if (!title || title.length < 3) continue;

        // A truncated translation ("M1, M2" for "Macchinista M1, M2,M3") must
        // not feed the slug: the slug would lose the trade. Derive from the
        // employer's title instead (scripts/lib/job-title-identity.mjs — the
        // same rule hardenJobLocaleFields and ensureLocaleFields apply, so the
        // writers converge on one slug).
        const employerTitle = String(job.title || tbl[sourceLang] || '').trim();
        const truncatedTitle = Boolean(employerTitle) && localeTitleDropsSourceWords(title, employerTitle);
        const slugTitle = truncatedTitle ? employerTitle : title;

        // If title is a source copy or partial heuristic translation, skip slug
        // regeneration. Uses Jaccard similarity (>0.5) on slugified tokens to catch
        // both exact copies and partial translations that changed only 1-2 words.
        // Without this, an Italian title in the EN slot would overwrite a properly
        // translated English slug with an Italian-derived one.
        const sourceTitle = (tbl[sourceLang] || '').trim();
        const slugEncodesTitle = Boolean(currentSlug)
          && slugMatchesTitle(currentSlug, slugTitle, company, location, disambiguator)
          // slugMatchesTitle ignores tokens under 3 chars, so `m1-m2-…` would
          // "match" an empty title-token set: a truncated slot is judged by
          // whether the slug still carries the employer's words.
          && !(truncatedTitle && slugDropsTitleWords(currentSlug, employerTitle, company, location, disambiguator));
        // A declared brand refresh must update every locale, even when a
        // translated title currently looks like a source-language copy. A
        // truncation repair derives from the source title on purpose.
        const skipUntranslatedGuard = brandRefresh || truncatedTitle;
        if (!skipUntranslatedGuard && sourceTitle && isLikelyUntranslated(title, sourceTitle)) continue;

        // If slug already matches title+company+location (+ disambiguator), skip
        if (!brandRefresh && slugEncodesTitle) continue;

        // Generate new slug from locale title, re-appending disambiguator
        let newSlug = buildSlug(slugTitle, company, location, disambiguator);
        if (!newSlug || newSlug === currentSlug) continue;

        // Don't replace if slug is the same as another locale's slug (avoid collisions)
        const otherSlugs = new Set(
          LOCALES.filter(l => l !== locale).map(l => (sbl[l] || '').trim()).filter(Boolean)
        );
        // A declared brand refresh is authoritative even when a copied
        // translation currently has the same candidate. Locale prefixes keep
        // those routes distinct, and skipping one locale leaves a stale
        // source-brand slug active (#7722).
        // A truncation repair may legitimately equal the source-locale slug:
        // locale prefixes keep the routes distinct (same as a brand refresh).
        if (!brandRefresh && !truncatedTitle && otherSlugs.has(newSlug)) continue;

        // A served slug stays canonical (scripts/lib/published-slug-stability.mjs):
        // a re-translated title, a truncated translation or a slug that still
        // copies another locale only derive a slug that is missing or was never
        // served (still held for translation, or released by this run). Only a
        // change of identity (company or location no longer in the slug) or a
        // declared brand refresh may replace one that is already served.
        if (!brandRefresh && !mayReplacePublishedSlug(currentSlug, { company, location }, { job, locale, justReleased: true })) {
          totalKeptPublished++;
          continue;
        }

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
        if (locale === 'it') syncItalianMasterSlug(job, currentSlug, newSlug);

        sliceChanged = true;
        totalFixed++;
        if (sourceBrandRefresh) totalSourceRefreshed++;
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

  // This script is another direct slice writer in the canonical translation
  // workflow. Slug regeneration can capture a bridge while it changes the
  // active slug, so perform the same fleet-wide ownership pass before its
  // phase is committed.
  const ownership = decontaminateSliceDirectory(BY_CRAWLER_DIR, { apply: true });
  if (ownership.moved > 0 || ownership.emptyLocaleBucketsPruned > 0) {
    console.log(`🧭 prev-slug ownership: redirected ${ownership.moved} slug(s), pruned ${ownership.emptyLocaleBucketsPruned} empty locale bucket(s) across ${ownership.affected.length} slice(s).`);
  }

  // The ownership pass is a writer too. A second dry-run is the convergence
  // proof: if it still finds a redirect or an empty bucket, the bytes that
  // would be committed are not canonical yet and the phase must fail closed.
  const residualOwnership = decontaminateSliceDirectory(BY_CRAWLER_DIR, { apply: false });
  const afterSnapshot = snapshotSlugCorpus(slicePaths, { root: ROOT });
  const verification = assertSlugRegenerationPostRun({
    before: beforeSnapshot,
    after: afterSnapshot,
    ownership: residualOwnership,
  });

  const proofPath = process.env.SLUG_REGENERATION_PROOF_PATH
    || (process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'slug-regeneration-proof.json')
      : null);
  if (proofPath) {
    const generationToken = resolveCrawlerGenerationToken();
    if (!generationToken) {
      throw new Error('Slug regeneration proof requires CRAWLER_GENERATION_TOKEN or GitHub run coordinates');
    }
    writeJson(proofPath, createSlugRegenerationProof({
      generationToken,
      before: beforeSnapshot,
      after: afterSnapshot,
      verification,
    }));
    console.log(`🧾 Slug regeneration proof: ${path.basename(proofPath)} (${generationToken})`);
  }

  console.log(`\n📊 Slug regeneration complete: ${totalFixed} locale slugs fixed across ${slicesChanged} slices (${totalJobs} total jobs)`);
  if (totalRelabelled > 0) {
    console.log(`🏷️  Brand relabel: ${totalRelabelled} record riallineati all'etichetta dichiarata dal parser`);
  }
  if (totalSourceRefreshed > 0) {
    console.log(`🔤 Source-locale: ${totalSourceRefreshed} slug riallineati dopo la rietichettatura`);
  }
  if (totalKeptPublished > 0) {
    console.log(`🔒 Published slugs kept: ${totalKeptPublished} locale slug(s) whose title moved on a served slug with unchanged company and location`);
  }
  if (totalServedAligned > 0) {
    console.log(`🧭 Served slug alignment: ${totalServedAligned} never-served slice slug(s) replaced by an exact URL already present in the served ledger`);
  }
  if (totalPinned > 0) {
    console.log(`🔒 Registry pin: ${totalPinned} locale slug(s) restored to the immutable registry value (drift demoted to previousSlugs)`);
  }
  if (totalDisambiguated > 0) {
    console.log(`🔠 Cross-job uniqueness: ${totalDisambiguated} slug(s) acquired a -<hash> tail to avoid colliding with another job's slug for the same locale`);
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch(err => {
    console.error('❌ Slug regeneration failed:', err?.message || err);
    process.exit(1);
  });
}
