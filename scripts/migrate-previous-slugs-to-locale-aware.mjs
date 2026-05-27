#!/usr/bin/env node
/**
 * migrate-previous-slugs-to-locale-aware.mjs
 *
 * One-shot migration:
 * 1. Recover previousSlugs lost in commit 7723f77f1 (and subsequent cleanup)
 * 2. Convert flat `previousSlugs[]` → locale-aware `previousSlugsByLocale{}`
 *
 * For each lost slug, determines locale by checking which `slugByLocale[locale]`
 * matched the removed slug at the time of removal. If no match, falls back to
 * language detection heuristic.
 *
 * Usage: node scripts/migrate-previous-slugs-to-locale-aware.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const CLEANUP_COMMIT = '7723f77f1';
const LOCALES = ['it', 'en', 'de', 'fr'];
const CAP = 20;
const DRY_RUN = process.argv.includes('--dry-run');

// ── Language detection heuristic ────────────────────────────────────────
// When we can't match a lost slug to a locale via slugByLocale, use word
// patterns to guess the language.
const LANG_MARKERS = {
  de: /\b(und|fur|oder|bei|mit|als|der|die|das|von|zur|zum|stelle|arbeit|leiter|ingenieur|techniker|schicht|betrieb|bereich|pruf|geschaft)\b/i,
  fr: /\b(pour|dans|des|les|une|avec|qui|est|sont|chef|responsable|ingenieur|technicien|directeur|poste|emploi|recherche|projet)\b/i,
  en: /\b(the|and|for|with|manager|engineer|specialist|coordinator|developer|lead|senior|junior|team|project|marketing)\b/i,
  it: /\b(per|con|del|della|delle|dei|nella|responsabile|ingegnere|tecnico|specialista|coordinatore|direttore|capo|progetto)\b/i,
};

function detectSlugLanguage(slug) {
  const words = slug.replace(/-/g, ' ');
  const scores = {};
  for (const [lang, re] of Object.entries(LANG_MARKERS)) {
    const matches = words.match(new RegExp(re, 'gi'));
    scores[lang] = matches ? matches.length : 0;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (best[0][1] > 0 && best[0][1] > (best[1]?.[1] || 0)) {
    return best[0][0];
  }
  return null; // Can't determine → assign to all locales
}

// ── Git helpers ─────────────────────────────────────────────────────────

function getFileAtCommit(commitRef, filePath) {
  try {
    const relPath = path.relative(ROOT, filePath);
    const content = execSync(`git show ${commitRef}:${relPath}`, {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── Core logic ──────────────────────────────────────────────────────────

function addSlugToLocale(job, locale, slug) {
  if (!slug || !locale) return;
  if (!job.previousSlugsByLocale) job.previousSlugsByLocale = {};
  if (!Array.isArray(job.previousSlugsByLocale[locale])) {
    job.previousSlugsByLocale[locale] = [];
  }
  if (!job.previousSlugsByLocale[locale].includes(slug)) {
    job.previousSlugsByLocale[locale].push(slug);
  }
  // Cap
  if (job.previousSlugsByLocale[locale].length > CAP) {
    job.previousSlugsByLocale[locale] = job.previousSlugsByLocale[locale].slice(-CAP);
  }
}

function syncLegacyFlat(job) {
  const all = new Set();
  if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
    for (const arr of Object.values(job.previousSlugsByLocale)) {
      if (Array.isArray(arr)) for (const s of arr) all.add(s);
    }
  }
  // Also keep any existing unattributed legacy entries
  if (Array.isArray(job.previousSlugs)) {
    for (const s of job.previousSlugs) all.add(s);
  }
  if (all.size > 0) {
    job.previousSlugs = [...all].slice(0, CAP);
  } else {
    delete job.previousSlugs;
  }
}

function isActiveSlug(job, slug) {
  if (job.slug === slug) return true;
  if (job.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const s of Object.values(job.slugByLocale)) {
      if (s === slug) return true;
    }
  }
  return false;
}

function determineLocaleForSlug(slug, job, oldJob) {
  // 1. Check if slug was a locale slug in the old version
  if (oldJob?.slugByLocale) {
    for (const locale of LOCALES) {
      if (oldJob.slugByLocale[locale] === slug) return locale;
    }
  }
  // 2. Check current job's locale slugs (unlikely match since it was removed)
  if (job?.slugByLocale) {
    for (const locale of LOCALES) {
      if (job.slugByLocale[locale] === slug) return locale;
    }
  }
  // 3. Language detection heuristic
  const detected = detectSlugLanguage(slug);
  return detected;
}

function processSliceFile(sliceFile, expiredDir) {
  const relPath = path.relative(ROOT, sliceFile);
  const basename = path.basename(sliceFile);

  // Read current data
  let currentData;
  try {
    currentData = JSON.parse(fs.readFileSync(sliceFile, 'utf-8'));
  } catch {
    return { file: basename, recovered: 0, migrated: 0 };
  }

  const jobs = currentData.jobs || (Array.isArray(currentData) ? currentData : []);
  if (jobs.length === 0) return { file: basename, recovered: 0, migrated: 0 };

  // Read pre-cleanup version
  const preCleanupData = getFileAtCommit(`${CLEANUP_COMMIT}^`, sliceFile);
  const preCleanupJobs = preCleanupData
    ? (preCleanupData.jobs || (Array.isArray(preCleanupData) ? preCleanupData : []))
    : [];

  // Index pre-cleanup jobs by slug and ID for matching
  const preCleanupBySlug = new Map();
  const preCleanupById = new Map();
  for (const j of preCleanupJobs) {
    if (j.slug) preCleanupBySlug.set(j.slug, j);
    if (j.id) preCleanupById.set(j.id, j);
    if (j.slugByLocale) {
      for (const s of Object.values(j.slugByLocale)) {
        if (s) preCleanupBySlug.set(s, j);
      }
    }
  }

  let recovered = 0;
  let migrated = 0;
  let changed = false;

  for (const job of jobs) {
    // 1. RECOVERY: Find lost previousSlugs by comparing with pre-cleanup version
    const oldJob = (job.slug && preCleanupBySlug.get(job.slug))
      || (job.id && preCleanupById.get(job.id))
      || null;

    if (oldJob && Array.isArray(oldJob.previousSlugs)) {
      const currentPrev = new Set(Array.isArray(job.previousSlugs) ? job.previousSlugs : []);
      const currentPrevByLocale = job.previousSlugsByLocale || {};
      const allCurrentPrev = new Set([...currentPrev]);
      if (typeof currentPrevByLocale === 'object') {
        for (const arr of Object.values(currentPrevByLocale)) {
          if (Array.isArray(arr)) for (const s of arr) allCurrentPrev.add(s);
        }
      }

      for (const lostSlug of oldJob.previousSlugs) {
        // Skip if already recovered or if it's a current active slug
        if (allCurrentPrev.has(lostSlug)) continue;
        if (isActiveSlug(job, lostSlug)) continue;

        // Determine locale
        const locale = determineLocaleForSlug(lostSlug, job, oldJob);
        if (locale) {
          addSlugToLocale(job, locale, lostSlug);
          recovered++;
          changed = true;
        } else {
          // Can't determine locale → add to all locales to be safe
          for (const loc of LOCALES) {
            addSlugToLocale(job, loc, lostSlug);
          }
          recovered++;
          changed = true;
        }
      }
    }

    // 2. MIGRATION: Convert existing flat previousSlugs to locale-aware
    if (Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0) {
      for (const slug of job.previousSlugs) {
        if (!slug) continue;
        if (isActiveSlug(job, slug)) continue;

        // Check if already in a locale bucket
        const alreadyBucketed = job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object'
          && Object.values(job.previousSlugsByLocale).some(arr => Array.isArray(arr) && arr.includes(slug));
        if (alreadyBucketed) continue;

        const locale = determineLocaleForSlug(slug, job, oldJob);
        if (locale) {
          addSlugToLocale(job, locale, slug);
          migrated++;
          changed = true;
        } else {
          // Can't determine → add to all locales
          for (const loc of LOCALES) {
            addSlugToLocale(job, loc, slug);
          }
          migrated++;
          changed = true;
        }
      }
    }

    // 3. Sync legacy flat array
    if (changed) {
      syncLegacyFlat(job);
    }
  }

  // Write back
  if (changed && !DRY_RUN) {
    // Preserve the original structure (jobs array inside object vs bare array)
    if (currentData.jobs) {
      currentData.jobs = jobs;
    }
    fs.writeFileSync(sliceFile, JSON.stringify(currentData, null, 2) + '\n');
  }

  return { file: basename, recovered, migrated };
}

// ── Also process expired slices ─────────────────────────────────────────

function processExpiredSlice(sliceFile) {
  const basename = path.basename(sliceFile);

  let currentData;
  try {
    currentData = JSON.parse(fs.readFileSync(sliceFile, 'utf-8'));
  } catch {
    return { file: `expired/${basename}`, recovered: 0, migrated: 0 };
  }

  const jobs = currentData.jobs || (Array.isArray(currentData) ? currentData : []);
  if (jobs.length === 0) return { file: `expired/${basename}`, recovered: 0, migrated: 0 };

  const preCleanupData = getFileAtCommit(`${CLEANUP_COMMIT}^`, sliceFile);
  const preCleanupJobs = preCleanupData
    ? (preCleanupData.jobs || (Array.isArray(preCleanupData) ? preCleanupData : []))
    : [];

  const preCleanupBySlug = new Map();
  for (const j of preCleanupJobs) {
    if (j.slug) preCleanupBySlug.set(j.slug, j);
    if (j.slugByLocale) {
      for (const s of Object.values(j.slugByLocale)) {
        if (s) preCleanupBySlug.set(s, j);
      }
    }
  }

  let recovered = 0;
  let migrated = 0;
  let changed = false;

  for (const job of jobs) {
    const oldJob = (job.slug && preCleanupBySlug.get(job.slug)) || null;

    if (oldJob && Array.isArray(oldJob.previousSlugs)) {
      const allCurrentPrev = new Set(Array.isArray(job.previousSlugs) ? job.previousSlugs : []);
      if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
        for (const arr of Object.values(job.previousSlugsByLocale)) {
          if (Array.isArray(arr)) for (const s of arr) allCurrentPrev.add(s);
        }
      }

      for (const lostSlug of oldJob.previousSlugs) {
        if (allCurrentPrev.has(lostSlug)) continue;
        if (isActiveSlug(job, lostSlug)) continue;

        const locale = determineLocaleForSlug(lostSlug, job, oldJob);
        if (locale) {
          addSlugToLocale(job, locale, lostSlug);
        } else {
          for (const loc of LOCALES) addSlugToLocale(job, loc, lostSlug);
        }
        recovered++;
        changed = true;
      }
    }

    // Migrate existing flat
    if (Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0) {
      for (const slug of job.previousSlugs) {
        if (!slug || isActiveSlug(job, slug)) continue;
        const alreadyBucketed = job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object'
          && Object.values(job.previousSlugsByLocale).some(arr => Array.isArray(arr) && arr.includes(slug));
        if (alreadyBucketed) continue;

        const locale = determineLocaleForSlug(slug, job, oldJob);
        if (locale) {
          addSlugToLocale(job, locale, slug);
        } else {
          for (const loc of LOCALES) addSlugToLocale(job, loc, slug);
        }
        migrated++;
        changed = true;
      }
    }

    if (changed) syncLegacyFlat(job);
  }

  if (changed && !DRY_RUN) {
    if (currentData.jobs) currentData.jobs = jobs;
    fs.writeFileSync(sliceFile, JSON.stringify(currentData, null, 2) + '\n');
  }

  return { file: `expired/${basename}`, recovered, migrated };
}

// ── Main ────────────────────────────────────────────────────────────────

console.log(`\n🔧 previousSlugs → previousSlugsByLocale migration`);
console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
console.log(`   Recovery base: commit ${CLEANUP_COMMIT}^\n`);

let totalRecovered = 0;
let totalMigrated = 0;
let totalFiles = 0;

// Active slices
if (fs.existsSync(SLICES_DIR)) {
  const sliceFiles = fs.readdirSync(SLICES_DIR).filter(f => f.endsWith('.json')).sort();
  for (const file of sliceFiles) {
    const result = processSliceFile(path.join(SLICES_DIR, file));
    if (result.recovered > 0 || result.migrated > 0) {
      console.log(`  📄 ${result.file}: recovered=${result.recovered} migrated=${result.migrated}`);
      totalRecovered += result.recovered;
      totalMigrated += result.migrated;
      totalFiles++;
    }
  }
}

// Expired slices
if (fs.existsSync(EXPIRED_DIR)) {
  const expiredFiles = fs.readdirSync(EXPIRED_DIR).filter(f => f.endsWith('.json')).sort();
  for (const file of expiredFiles) {
    const result = processExpiredSlice(path.join(EXPIRED_DIR, file));
    if (result.recovered > 0 || result.migrated > 0) {
      console.log(`  📄 ${result.file}: recovered=${result.recovered} migrated=${result.migrated}`);
      totalRecovered += result.recovered;
      totalMigrated += result.migrated;
      totalFiles++;
    }
  }
}

console.log(`\n✅ Migration complete:`);
console.log(`   Files modified: ${totalFiles}`);
console.log(`   Slugs recovered from pre-cleanup: ${totalRecovered}`);
console.log(`   Flat slugs migrated to locale-aware: ${totalMigrated}`);
if (DRY_RUN) console.log(`   ⚠️  DRY RUN — no files were written`);
