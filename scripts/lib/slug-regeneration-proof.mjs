import fs from 'node:fs';
import path from 'node:path';

import { digestDocument } from './canonical-json-digest.mjs';
import { isCrawlerGenerationToken } from './crawler-generation-token.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'];

function normalizedSlug(value) {
  return String(value ?? '').trim();
}

function ensureSet(map, key) {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
}

function relativePath(filePath, root) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function publicSnapshot(snapshot) {
  return {
    digest: snapshot.digest,
    fileCount: snapshot.fileCount,
    jobCount: snapshot.jobCount,
    activeSlugCount: snapshot.activeSlugCount,
    bridgeCount: snapshot.bridgeCount,
    selfBridgeCount: snapshot.selfBridgeCount,
    missingCanonicalCount: snapshot.missingCanonicalCount,
    files: snapshot.files,
  };
}

/**
 * Capture a compact, digest-bound view of the active slug corpus.
 *
 * The route sets stay in memory for the before/after comparison and are not
 * serialized into the receipt. This keeps the artifact small without losing
 * evidence that every pre-run bridge is still either live or preserved.
 */
export function snapshotSlugCorpus(filePaths, { root = process.cwd(), read = readJson } = {}) {
  const activeByLocale = new Map(LOCALES.map((locale) => [locale, new Set()]));
  const bridgeByLocale = new Map(LOCALES.map((locale) => [locale, new Set()]));
  const flatHistory = new Set();
  const bridgeRefs = [];
  const files = [];
  let jobCount = 0;
  let activeSlugCount = 0;
  let bridgeCount = 0;
  let selfBridgeCount = 0;
  let missingCanonicalCount = 0;

  for (const filePath of [...filePaths].sort()) {
    const payload = read(filePath);
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    files.push({
      path: relativePath(filePath, root),
      digest: digestDocument(payload),
      jobs: jobs.length,
    });

    for (const job of jobs) {
      if (!job || typeof job !== 'object') continue;
      jobCount++;
      const slugByLocale = job.slugByLocale && typeof job.slugByLocale === 'object'
        ? job.slugByLocale
        : {};
      const masterSlug = normalizedSlug(job.slug);
      const activeForJob = new Set();
      for (const locale of LOCALES) {
        const activeSlug = normalizedSlug(slugByLocale[locale]);
        if (!activeSlug) continue;
        activeForJob.add(activeSlug);
        if (ensureSet(activeByLocale, locale).has(activeSlug) === false) {
          activeSlugCount++;
        }
        ensureSet(activeByLocale, locale).add(activeSlug);
      }
      if (masterSlug) {
        activeForJob.add(masterSlug);
        if (!ensureSet(activeByLocale, 'it').has(masterSlug)) activeSlugCount++;
        ensureSet(activeByLocale, 'it').add(masterSlug);
      }

      let jobBridgeCount = 0;
      for (const [locale, slugs] of Object.entries(job.previousSlugsByLocale || {})) {
        if (!LOCALES.includes(locale) || !Array.isArray(slugs)) continue;
        const activeLocale = normalizedSlug(slugByLocale[locale]);
        for (const slugValue of slugs) {
          const slug = normalizedSlug(slugValue);
          if (!slug) continue;
          bridgeCount++;
          jobBridgeCount++;
          ensureSet(bridgeByLocale, locale).add(slug);
          bridgeRefs.push({ kind: 'locale', locale, slug });
          if (slug === activeLocale || slug === masterSlug) selfBridgeCount++;
        }
      }

      if (Array.isArray(job.previousSlugs)) {
        const localeAwareHistory = new Set(
          Object.values(job.previousSlugsByLocale || {})
            .flatMap((slugs) => (Array.isArray(slugs) ? slugs : []))
            .map(normalizedSlug)
            .filter(Boolean),
        );
        for (const slugValue of job.previousSlugs) {
          const slug = normalizedSlug(slugValue);
          if (!slug) continue;
          bridgeCount++;
          jobBridgeCount++;
          flatHistory.add(slug);
          bridgeRefs.push({ kind: 'flat', slug });
          // The flat array is a legacy union of locale-aware history. A slug
          // that is active in another locale but still has locale provenance
          // is a valid cross-locale bridge; only a flat-only active slug is a
          // self-bridge.
          if (activeForJob.has(slug) && !localeAwareHistory.has(slug)) selfBridgeCount++;
        }
      }

      if (jobBridgeCount > 0 && activeForJob.size === 0) missingCanonicalCount++;
    }
  }

  return {
    ...publicSnapshot({
      digest: digestDocument(files),
      fileCount: files.length,
      jobCount,
      activeSlugCount,
      bridgeCount,
      selfBridgeCount,
      missingCanonicalCount,
      files,
    }),
    activeByLocale,
    bridgeByLocale,
    flatHistory,
    bridgeRefs,
  };
}

function bridgeIsCovered(reference, after) {
  if (reference.kind === 'flat') {
    return [...after.activeByLocale.values()].some((slugs) => slugs.has(reference.slug))
      || [...after.bridgeByLocale.values()].some((slugs) => slugs.has(reference.slug))
      || after.flatHistory.has(reference.slug);
  }
  return after.activeByLocale.get(reference.locale)?.has(reference.slug)
    || after.bridgeByLocale.get(reference.locale)?.has(reference.slug)
    || after.flatHistory.has(reference.slug);
}

export function compareSlugBridgeCoverage(before, after) {
  const missing = before.bridgeRefs.filter((reference) => !bridgeIsCovered(reference, after));
  return {
    beforeBridgeRefs: before.bridgeRefs.length,
    missingBridgeCount: missing.length,
    missingBridgeSamples: missing.slice(0, 10),
  };
}

export function assertSlugRegenerationPostRun({ before, after, ownership }) {
  const bridgeCoverage = compareSlugBridgeCoverage(before, after);
  const ownershipResiduals = {
    moved: Number(ownership?.moved || 0),
    emptyLocaleBucketsPruned: Number(ownership?.emptyLocaleBucketsPruned || 0),
  };
  const failures = [];
  if (after.selfBridgeCount > 0) failures.push(`self_bridge_count=${after.selfBridgeCount}`);
  if (after.missingCanonicalCount > 0) failures.push(`missing_canonical_count=${after.missingCanonicalCount}`);
  if (bridgeCoverage.missingBridgeCount > 0) {
    failures.push(`missing_bridge_count=${bridgeCoverage.missingBridgeCount}`);
  }
  if (ownershipResiduals.moved > 0) failures.push(`ownership_moved=${ownershipResiduals.moved}`);
  if (ownershipResiduals.emptyLocaleBucketsPruned > 0) {
    failures.push(`ownership_empty_locale_buckets=${ownershipResiduals.emptyLocaleBucketsPruned}`);
  }
  if (failures.length > 0) {
    throw new Error(`Slug regeneration post-run proof failed: ${failures.join(', ')}`);
  }
  return {
    pass: true,
    selfBridgeCount: after.selfBridgeCount,
    missingCanonicalCount: after.missingCanonicalCount,
    ...bridgeCoverage,
    ownershipResiduals,
  };
}

export function createSlugRegenerationProof({ generationToken, before, after, verification }) {
  if (!isCrawlerGenerationToken(generationToken)) {
    throw new TypeError('Slug regeneration proof requires a valid generation token');
  }
  return {
    schemaVersion: 1,
    kind: 'slug-regeneration-post-run-proof',
    generationToken,
    before: publicSnapshot(before),
    after: publicSnapshot(after),
    verification,
  };
}
