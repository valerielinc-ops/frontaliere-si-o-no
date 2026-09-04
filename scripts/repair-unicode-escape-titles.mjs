#!/usr/bin/env node
/**
 * One-shot repair for jobs whose titles leaked literal `\uXXXX` escapes.
 *
 * Root cause (fixed in the same PR, scripts/lib/refline-common.mjs →
 * extractReflineDetailTitle): Refline detail pages embed a JSON-LD JobPosting
 * whose escaped `description` string starts with `<h1>…ä…</h1>`; on
 * tenants with no real <h1> in the body the title regex matched INSIDE the
 * script block and stored JSON-escaped text ("Arztsekretär/in für…")
 * as the job title. Slugify then turned each escape into a literal `-u00e4-`
 * slug token, and the AI translation step propagated the escapes into every
 * locale (affected: spital-limmattal, caritas-schweiz, zkb).
 *
 * What this script does:
 * - ALL slices (active + expired): decode literal `\uXXXX` sequences in
 *   `title`, `titleByLocale[*]`, `description`, `descriptionByLocale[*]`.
 * - ACTIVE slices only: re-derive every slug that carries a `u00xx` artifact
 *   from the decoded locale title via the canonical slug-only recipe
 *   (`buildSlug`, cap 120, word-boundary truncation), demote the old slug via
 *   `addPreviousSlugForLocale` (bridge redirects keep the indexed URL alive),
 *   keep the master slug in sync with the IT slug, and set
 *   `needsRetranslation` so the translate-pending workflow re-cleans the
 *   hybrid-language locale titles.
 * - data/slug-registry.json: overwrite corrupt `canonicalSlug` /
 *   `slugByLocale` pins for the repaired jobs — registry entries are
 *   otherwise immutable and would re-pin (resurrect) the corrupt slug on the
 *   next crawl (the #4071 garbage-pin guard does NOT fire here: corrupt slugs
 *   still share clean title tokens, so their pins look valid).
 * - EXPIRED slices: titles/descriptions only. Slugs and
 *   previousSlugs/previousSlugsByLocale are URL history — decoding them would
 *   break the bridge redirects they exist for. Never touched.
 *
 * Usage:
 *   node scripts/repair-unicode-escape-titles.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSlug, shortJobHash, appendDisambiguatorTail } from './lib/regenerate-slugs-helpers.mjs';
import {
  fingerprintJob,
  getRegisteredSlug,
  loadSlugRegistry,
  saveSlugRegistry,
  addPreviousSlugForLocale,
  cleanPreviousSlugsPerLocale,
} from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { listSliceFilePaths } from './lib/crawler-slice-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ACTIVE_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
const DRY_RUN = process.argv.includes('--dry-run');

// Literal backslash-u sequence in the in-memory string (double-escaped in the
// JSON file on disk).
const ESCAPE_RE = /\\u([0-9a-fA-F]{4})/g;
// Slugified leftover of an escaped char ("für" → "f-u00fcr").
const SLUG_ARTIFACT_RE = /u00[0-9a-f]{2}/;

function decodeEscapes(s) {
  if (typeof s !== 'string' || !ESCAPE_RE.test(s)) return s;
  ESCAPE_RE.lastIndex = 0;
  return s.replace(ESCAPE_RE, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeJobTexts(job) {
  let changed = false;
  for (const key of ['title', 'description']) {
    const next = decodeEscapes(job[key]);
    if (next !== job[key]) { job[key] = next; changed = true; }
  }
  for (const key of ['titleByLocale', 'descriptionByLocale']) {
    const map = job[key];
    if (!map || typeof map !== 'object') continue;
    for (const [locale, value] of Object.entries(map)) {
      const next = decodeEscapes(value);
      if (next !== value) { map[locale] = next; changed = true; }
    }
  }
  return changed;
}

// Repair a slug artifact in place: "f-u00fcr" (slugify of the literal
// "für" — the backslash became a hyphen) → "fur" (slugify of "für").
// Used only for registry entries with no live job to copy clean slugs from.
// Deliberately NOT buildSlug: an orphaned pin has no title to rebuild from,
// so we edit the existing (already-capped) slug in place — substitutions only
// shorten it, so the 120 cap and any disambiguator tail stay intact. If the
// job ever resurfaces, the pin (authoritative by design) may differ by a few
// bytes from a fresh buildSlug derivation, which is fine: the registry's only
// contract is stability, and previousSlugs bridge any old URL.
function decodeSlugArtifacts(slug) {
  return String(slug || '').replace(/-?u00([0-9a-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ''));
}

function readSlice(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { raw, jobs: Array.isArray(raw) ? raw : (raw.jobs || []) };
}

function main() {
  const registry = loadSlugRegistry();
  let registryChanged = false;

  // Cross-job uniqueness map (same contract as regenerate-slugs-by-locale):
  // locale → slug → owning job id, seeded from EVERY active job so a repaired
  // slug can never collide with a URL another job already owns.
  const usedSlugs = new Map(LOCALES.map((l) => [l, new Map()]));
  const activeSlices = listSliceFilePaths(ACTIVE_DIR);
  for (const file of activeSlices) {
    for (const job of readSlice(file).jobs) {
      for (const locale of LOCALES) {
        const s = (job.slugByLocale?.[locale] || '').trim();
        if (s && !usedSlugs.get(locale).has(s)) usedSlugs.get(locale).set(s, job.id);
      }
    }
  }

  let titlesFixed = 0;
  let slugsFixed = 0;
  let registryPinsFixed = 0;
  let expiredTitlesFixed = 0;

  for (const file of activeSlices) {
    const { raw, jobs } = readSlice(file);
    let sliceChanged = false;

    for (const job of jobs) {
      const decoded = decodeJobTexts(job);
      if (decoded) titlesFixed++;

      const sbl = job.slugByLocale || {};
      const corruptLocales = LOCALES.filter((l) => SLUG_ARTIFACT_RE.test(sbl[l] || ''));
      if (!decoded && !corruptLocales.length && !SLUG_ARTIFACT_RE.test(job.slug || '')) continue;
      sliceChanged = true;

      const company = job.company || '';
      const location = job.location || job.addressLocality || '';
      const disambiguator = String(job.slugDisambiguator || '').trim();
      const registered = getRegisteredSlug(job, registry);

      for (const locale of corruptLocales) {
        const title = decodeEscapes((job.titleByLocale?.[locale] || '').trim());
        if (title.length < 3) continue;
        const currentSlug = (sbl[locale] || '').trim();

        let newSlug = buildSlug(title, company, location, disambiguator);
        if (!newSlug || newSlug === currentSlug) continue;

        // Same-job cross-locale + cross-job collision guards.
        const otherSlugs = new Set(
          LOCALES.filter((l) => l !== locale).map((l) => (sbl[l] || '').trim()).filter(Boolean),
        );
        const slugMap = usedSlugs.get(locale);
        const owner = slugMap.get(newSlug);
        if (otherSlugs.has(newSlug) || (owner && owner !== job.id)) {
          const disambiguated = appendDisambiguatorTail(newSlug, shortJobHash(job.id || currentSlug));
          const dOwner = slugMap.get(disambiguated);
          if (otherSlugs.has(disambiguated) || (dOwner && dOwner !== job.id)) {
            console.warn(`  ⚠️ collision even after disambiguation, skipping ${job.id} [${locale}]`);
            continue;
          }
          newSlug = disambiguated;
        }

        addPreviousSlugForLocale(job, locale, currentSlug, 20);
        if (slugMap.get(currentSlug) === job.id) slugMap.delete(currentSlug);
        slugMap.set(newSlug, job.id);
        sbl[locale] = newSlug;
        job.slugByLocale = sbl;
        slugsFixed++;

        // Master slug serves the IT path — keep it in sync.
        if (locale === 'it' && job.slug && job.slug !== newSlug) {
          if (job.slug !== currentSlug) addPreviousSlugForLocale(job, 'it', job.slug, 20);
          job.slug = newSlug;
        }

        // Registry pins are immutable via the normal write paths; a corrupt
        // pin left in place re-pins the old slug on the next crawl.
        if (registered?.slugByLocale && SLUG_ARTIFACT_RE.test(registered.slugByLocale[locale] || '')) {
          registered.slugByLocale[locale] = newSlug;
          registryChanged = true;
          registryPinsFixed++;
        }
      }

      if (registered && SLUG_ARTIFACT_RE.test(registered.canonicalSlug || '') && job.slug
        && !SLUG_ARTIFACT_RE.test(job.slug)) {
        registered.canonicalSlug = job.slug;
        registryChanged = true;
        registryPinsFixed++;
      }

      cleanPreviousSlugsPerLocale(job);
      // Locale titles decoded from a corrupted source are hybrids ("Infermiera
      // HF/FH für Oncologia…") — let the translate-pending workflow redo them.
      if (decoded) job.needsRetranslation = true;
    }

    if (sliceChanged) {
      console.log(`  ✏️ ${path.relative(ROOT, file)}`);
      if (!DRY_RUN) writeJsonAtomic(file, raw);
    }
  }

  for (const file of listSliceFilePaths(EXPIRED_DIR)) {
    const { raw, jobs } = readSlice(file);
    let sliceChanged = false;
    for (const job of jobs) {
      if (decodeJobTexts(job)) { expiredTitlesFixed++; sliceChanged = true; }
    }
    if (sliceChanged) {
      console.log(`  ✏️ ${path.relative(ROOT, file)} (expired: titles only)`);
      if (!DRY_RUN) writeJsonAtomic(file, raw);
    }
  }

  // Registry-wide sweep: entries can carry corrupt pins even when every live
  // job is already clean (e.g. a crawl on main re-registered corrupt slugs
  // before the parser fix merged, then the data merged back in). A corrupt
  // pin re-pins (re-corrupts) a clean job's slug on the next crawl, so none
  // may survive. Prefer copying the matching live job's clean slugs; fall
  // back to in-place artifact decoding for entries with no live job.
  const jobByFingerprint = new Map();
  for (const file of activeSlices) {
    for (const job of readSlice(file).jobs) {
      const fp = fingerprintJob(job);
      if (fp && !jobByFingerprint.has(fp)) jobByFingerprint.set(fp, job);
    }
  }
  let registryPinsSwept = 0;
  for (const [fp, entry] of Object.entries(registry)) {
    if (!entry || typeof entry !== 'object') continue;
    const liveJob = jobByFingerprint.get(fp);
    if (SLUG_ARTIFACT_RE.test(entry.canonicalSlug || '')) {
      const clean = (liveJob?.slug && !SLUG_ARTIFACT_RE.test(liveJob.slug))
        ? liveJob.slug
        : decodeSlugArtifacts(entry.canonicalSlug);
      if (clean && clean !== entry.canonicalSlug) {
        entry.canonicalSlug = clean;
        registryChanged = true;
        registryPinsSwept++;
      }
    }
    for (const [locale, pinned] of Object.entries(entry.slugByLocale || {})) {
      if (!SLUG_ARTIFACT_RE.test(pinned || '')) continue;
      const liveSlug = liveJob?.slugByLocale?.[locale];
      const clean = (liveSlug && !SLUG_ARTIFACT_RE.test(liveSlug))
        ? liveSlug
        : decodeSlugArtifacts(pinned);
      if (clean && clean !== pinned) {
        entry.slugByLocale[locale] = clean;
        registryChanged = true;
        registryPinsSwept++;
      }
    }
  }
  if (registryPinsSwept) console.log(`  🧹 registry sweep: ${registryPinsSwept} corrupt pins rewritten`);

  if (registryChanged && !DRY_RUN) saveSlugRegistry(registry);

  console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}active jobs re-titled: ${titlesFixed}, slugs re-derived: ${slugsFixed}, registry pins rewritten: ${registryPinsFixed}, expired jobs re-titled: ${expiredTitlesFixed}`);
}

main();
