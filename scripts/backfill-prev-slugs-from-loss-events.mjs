#!/usr/bin/env node
/**
 * One-shot recovery for previousSlugs entries dropped by past crawler runs.
 *
 * Background: a writer bug (shared-jobs-crawler.ensureLocaleFields wrote to
 * the flat `previousSlugs` array only, never to `previousSlugsByLocale`) plus
 * the absence of a slice-level safety net caused 1,289 historical slugs to
 * be silently removed from 43 per-crawler slice files over 60 days. After
 * the fix landed (commit: this PR's predecessor), the bleeding stopped — but
 * 336 distinct URLs are still missing from current slices and would 404 on
 * the next deploy unless we backfill them from git history.
 *
 * Input: a JSON file listing { jobId, file, slugs[] } produced by the scan
 *        scripts/scan-prev-slug-losses.mjs (or the /tmp/recoverable-slugs.json
 *        artifact from the audit). Pass via --input <path>; defaults to
 *        /tmp/recoverable-slugs.json.
 *
 * Per slug we determine the original locale by replaying git history of the
 * slice file: for each commit before the loss, look up the job by id and
 * inspect previousSlugsByLocale + slugByLocale to attribute the lost slug
 * to its source locale. If the slug never appeared with a locale attribution
 * (legacy flat-only entries), fall back to language detection on the slug
 * tokens.
 *
 * Usage:
 *   node scripts/backfill-prev-slugs-from-loss-events.mjs [--input /tmp/recoverable-slugs.json] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const inputIdx = args.indexOf('--input');
const INPUT = inputIdx !== -1 ? args[inputIdx + 1] : '/tmp/recoverable-slugs.json';
const CAP = 20;

if (!fs.existsSync(INPUT)) {
  console.error(`❌ Input not found: ${INPUT}`);
  console.error('Run scripts/scan-prev-slug-losses-fast.mjs first to generate it.');
  process.exit(2);
}

/** Detect language of a slug by counting known per-locale tokens. */
const LANG_TOKENS = {
  it: new Set(['responsabile', 'tecnico', 'tecnica', 'ingegnere', 'manutenzione', 'magazzino', 'produzione', 'logistica', 'vendita', 'pulizia', 'operaio', 'addetto', 'addetta', 'apprendista', 'collaboratore', 'specialista', 'tornitore', 'fresatore', 'verniciatore', 'falegname', 'muratore', 'idraulico', 'autista', 'magazziniere', 'cuoco', 'cameriere', 'infermiere', 'fisioterapista', 'caporeparto', 'ricercatore', 'architetto', 'meccanico', 'elettricista', 'segretario', 'amministrazione', 'gestione', 'direttore', 'capo', 'reparto', 'qualita', 'controllo']),
  de: new Set(['mitarbeiter', 'mitarbeitende', 'fachfrau', 'fachmann', 'pflegefach', 'pflegefachfrau', 'pflegefachmann', 'systemgastronomie', 'diatkoch', 'lernender', 'lehrjahr', 'detailhandel', 'filiale', 'leiter', 'leiterin', 'schichtleiter', 'dreher', 'schleifer', 'qualifikationsverfahren', 'lebensmittel']),
  fr: new Set(['responsable', 'candidature', 'auxiliaire', 'gestionnaire', 'collaborateur', 'collaboratrice', 'tourneur', 'meulage', 'polissage', 'chef', 'equipe', 'soignant', 'soignante', 'infirmier', 'infirmiere', 'aide']),
  en: new Set(['manager', 'engineer', 'specialist', 'developer', 'analyst', 'consultant', 'assistant', 'coordinator', 'supervisor', 'leader', 'turner', 'lathe', 'operator', 'grinding', 'polishing', 'shift', 'shifts', 'thesis', 'orthopedics', 'orthopaedics', 'designer', 'designers', 'measuring', 'instruments', 'audit', 'banking', 'finance', 'planner', 'demand', 'maintenance']),
};

function detectLocaleFromSlug(slug) {
  const tokens = String(slug || '').toLowerCase().split('-').filter(t => t.length > 3);
  const scores = { it: 0, de: 0, fr: 0, en: 0 };
  for (const t of tokens) {
    for (const [lang, set] of Object.entries(LANG_TOKENS)) {
      if (set.has(t)) scores[lang]++;
    }
  }
  // Pick highest score; tie → 'it' (Italian is the default canonical locale).
  let best = 'it';
  let bestScore = scores.it;
  for (const lang of ['en', 'de', 'fr']) {
    if (scores[lang] > bestScore) {
      best = lang;
      bestScore = scores[lang];
    }
  }
  return best;
}

// One-shot cache of (file → jobId → Map<slug, locale>) built lazily
// when the first job in a file is processed. Subsequent jobs in the
// same file reuse the cached index → 1 git-log + N git-show per FILE
// instead of per JOB, which collapses 10–100× of git invocations.
const _fileLocaleCache = new Map();

/**
 * Build an index for ALL jobs in one slice file in a single pass over
 * the file's git history. Per-job lookup becomes O(1) afterwards.
 *
 * @param {string} file absolute path to the slice file
 * @param {number} [maxCommits=400] cap on history walked (newest first)
 * @returns {Map<string, Map<string, string>>} jobId → slug → locale
 */
function buildFileLocaleIndex(file, maxCommits = 400) {
  if (_fileLocaleCache.has(file)) return _fileLocaleCache.get(file);
  const rel = path.relative(ROOT, file);
  let commits;
  try {
    commits = execSync(
      `git log --pretty=format:%H -n ${maxCommits} -- ${rel}`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, cwd: ROOT },
    ).trim().split('\n').filter(Boolean);
  } catch {
    const empty = new Map();
    _fileLocaleCache.set(file, empty);
    return empty;
  }
  /** @type {Map<string, Map<string,string>>} */
  const byJob = new Map();
  for (const commit of commits) {
    let content;
    try {
      content = execSync(`git show ${commit}:${rel}`, {
        encoding: 'utf8', maxBuffer: 100 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'], cwd: ROOT,
      });
    } catch { continue; }
    let parsed;
    try { parsed = JSON.parse(content); } catch { continue; }
    if (!Array.isArray(parsed?.jobs)) continue;
    for (const job of parsed.jobs) {
      if (!job?.id) continue;
      let m = byJob.get(job.id);
      if (!m) { m = new Map(); byJob.set(job.id, m); }
      if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
        for (const [loc, arr] of Object.entries(job.previousSlugsByLocale)) {
          for (const s of (arr || [])) {
            if (s && !m.has(s)) m.set(s, loc);
          }
        }
      }
      if (job.slugByLocale && typeof job.slugByLocale === 'object') {
        for (const [loc, s] of Object.entries(job.slugByLocale)) {
          if (s && !m.has(s)) m.set(s, loc);
        }
      }
    }
  }
  _fileLocaleCache.set(file, byJob);
  return byJob;
}

const recoverList = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
console.log(`📥 Loaded ${recoverList.length} jobs with recoverable slugs from ${INPUT}\n`);

const stats = {
  filesUpdated: 0,
  jobsUpdated: 0,
  slugsRestoredByLocale: 0,
  slugsRestoredFromHistory: 0,
  slugsRestoredFromDetection: 0,
  jobsMissing: 0,
};
const filesByName = new Map();
for (const entry of recoverList) {
  if (!filesByName.has(entry.file)) filesByName.set(entry.file, []);
  filesByName.get(entry.file).push(entry);
}

let fileCount = 0;
for (const [file, entries] of filesByName) {
  fileCount++;
  const filePath = path.join(BY_CRAWLER_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.warn(`  ⚠️  Skip ${file} (not in slices dir)`);
    continue;
  }
  process.stderr.write(`  [${fileCount}/${filesByName.size}] ${file} (${entries.length} jobs)\n`);
  const slice = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const byId = new Map(slice.jobs.map(j => [j.id, j]));
  let fileChanged = false;

  // Build the per-file locale index ONCE; per-job lookup is O(1) below.
  const fileIndex = buildFileLocaleIndex(filePath);
  for (const { jobId, slugs } of entries) {
    const job = byId.get(jobId);
    if (!job) { stats.jobsMissing++; continue; }
    const slugLocaleIndex = fileIndex.get(jobId) || new Map();
    let jobChanged = false;
    for (const slug of slugs) {
      let locale = slugLocaleIndex.get(slug);
      let source;
      if (locale) {
        source = 'history';
        stats.slugsRestoredFromHistory++;
      } else {
        locale = detectLocaleFromSlug(slug);
        source = 'detection';
        stats.slugsRestoredFromDetection++;
      }
      // Write to previousSlugsByLocale[locale]
      if (!job.previousSlugsByLocale || typeof job.previousSlugsByLocale !== 'object') {
        job.previousSlugsByLocale = {};
      }
      if (!Array.isArray(job.previousSlugsByLocale[locale])) {
        job.previousSlugsByLocale[locale] = [];
      }
      if (!job.previousSlugsByLocale[locale].includes(slug)) {
        job.previousSlugsByLocale[locale].push(slug);
        if (job.previousSlugsByLocale[locale].length > CAP) {
          job.previousSlugsByLocale[locale] = job.previousSlugsByLocale[locale].slice(-CAP);
        }
        jobChanged = true;
        stats.slugsRestoredByLocale++;
      }
      // Also sync flat previousSlugs for legacy consumers
      if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
      if (!job.previousSlugs.includes(slug)) {
        job.previousSlugs.push(slug);
        if (job.previousSlugs.length > CAP) {
          job.previousSlugs = job.previousSlugs.slice(-CAP);
        }
      }
    }
    if (jobChanged) stats.jobsUpdated++;
    fileChanged = fileChanged || jobChanged;
  }

  if (fileChanged) {
    if (!DRY_RUN) {
      writeJsonAtomic(filePath, slice);
    }
    stats.filesUpdated++;
  }
}

console.log('\n📊 Backfill complete:');
console.log(`  files updated:               ${stats.filesUpdated}${DRY_RUN ? ' (dry-run, no writes)' : ''}`);
console.log(`  jobs updated:                ${stats.jobsUpdated}`);
console.log(`  slugs restored (byLocale):   ${stats.slugsRestoredByLocale}`);
console.log(`  ├─ from git history:        ${stats.slugsRestoredFromHistory}`);
console.log(`  └─ from language detection: ${stats.slugsRestoredFromDetection}`);
console.log(`  jobs missing in current:     ${stats.jobsMissing}`);
