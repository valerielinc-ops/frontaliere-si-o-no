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
import { stableSlugHash } from './lib/dedicated-crawler-common.mjs';
import { resolveJobDiffKey } from './lib/job-match-key.mjs';
import { createCatFileBatch } from './lib/git-cat-file-batch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');

const CAP = 20;

/**
 * data/prev-slug-restore-denylist.json lists {file, jobId, slug} pairs that
 * were REMOVED ON PURPOSE from slice histories by the umantis cross-tenant
 * decontamination (#4055, squash 028d6c1147) — slugs of OTHER companies that
 * the tenant-id collision had pinned onto the wrong slice, plus censused
 * garbage-title slugs. The scan (scripts/scan-prev-slug-losses.mjs) cannot
 * tell an intentional removal from an accidental loss, so without this guard
 * the backfill "recovers" the poison right back: run 29106416912 (commit
 * efed987db) re-imported kanton-aargau/GKB slugs into ksa.json that way.
 * Generated deterministically by scripts/build-prev-slug-restore-denylist.mjs.
 */
const DENYLIST_PATH = path.resolve(ROOT, 'data', 'prev-slug-restore-denylist.json');

/**
 * Canonical denylist lookup key. NUL separator cannot occur in either part.
 * @param {string} file slice basename, e.g. "ksa.json"
 * @param {string} slug
 * @returns {string}
 */
export function denylistKey(file, slug) {
  return `${file}\u0000${slug}`;
}

/**
 * Load the restore denylist as a Set keyed on `file\0slug`.
 *
 * Keyed on file+slug, NOT the full (file, jobId, slug) triple: a denylisted
 * slug is foreign to (or garbage in) its whole slice, and the recovery path
 * can re-home a slug onto a DIFFERENT job of the same file via the hash-tail
 * redirect in resolveRecoveryTarget — run 29106416912 spread one denylisted
 * ksa slug across three different jobs exactly that way. jobId in the file
 * is provenance only.
 *
 * A missing file yields an empty set (guard off — e.g. fresh checkouts of
 * forks); a present-but-unparsable file throws so the guard can never be
 * silently disabled by a corrupt commit.
 *
 * @param {string} [file]
 * @returns {Set<string>}
 */
export function loadRestoreDenylist(file = DENYLIST_PATH) {
  if (!fs.existsSync(file)) return new Set();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const set = new Set();
  for (const e of (parsed.entries || [])) {
    if (e && e.file && e.slug) set.add(denylistKey(e.file, e.slug));
  }
  return set;
}

/**
 * Drop denylisted (file, slug) pairs from a scan-produced recover list.
 * Entries whose slugs are all denylisted are removed outright.
 *
 * @param {Array<{jobId: string, file: string, slugs: string[]}>} recoverList
 * @param {Set<string>} denylist from loadRestoreDenylist()
 * @returns {{entries: Array<{jobId: string, file: string, slugs: string[]}>, skipped: number}}
 */
export function filterDenylistedSlugs(recoverList, denylist) {
  if (!denylist || denylist.size === 0) return { entries: recoverList, skipped: 0 };
  let skipped = 0;
  const entries = [];
  for (const e of recoverList) {
    const kept = (e.slugs || []).filter((s) => {
      const hit = denylist.has(denylistKey(e.file, s));
      if (hit) skipped++;
      return !hit;
    });
    if (kept.length > 0) entries.push({ ...e, slugs: kept });
  }
  return { entries, skipped };
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

const HASH_TAIL_RE = /-([a-z0-9]{6})$/;

/**
 * A recovered slug's loss event is keyed by a historical `job.id` snapshot,
 * which can be up to 400 commits stale. If that id was ever transiently
 * reused by a different real posting (e.g. across a fingerprint/hash-input
 * change), the "recovered" slug does not actually belong to today's job
 * holding that id — it belongs to whichever job's URL currently hashes to
 * the slug's own disambiguator tail. Cross-check against that before writing.
 *
 * A trailing 6-char lowercase-alnum segment is only trustworthy as a hash
 * signal when it POSITIVELY matches a real, currently-computable job hash
 * (its own, or another job's). Absence of a match is NOT evidence of
 * contamination — plenty of real slug words are coincidentally 6 lowercase
 * letters (e.g. "-campus"), so a tail with no matching owner is left
 * untouched rather than dropped.
 *
 * @param {object} job job currently resolved via the loss event's stale id
 * @param {string} slug slug being recovered
 * @param {Map<string, object>} bySuffixHash stableSlugHash(job) → unambiguous current owner in the selected scope
 * @returns {{ targetJob: object, skip: boolean, redirected: boolean }}
 */
export function resolveRecoveryTarget(job, slug, bySuffixHash) {
  const m = HASH_TAIL_RE.exec(String(slug || ''));
  if (!m) return { targetJob: job, skip: false, redirected: false };
  const tail = m[1];
  const ownHash = stableSlugHash(job);
  if (!ownHash || tail === ownHash) return { targetJob: job, skip: false, redirected: false };
  const owner = bySuffixHash.get(tail);
  if (owner && owner !== job) return { targetJob: owner, skip: false, redirected: true };
  return { targetJob: job, skip: false, redirected: false };
}

/**
 * Write a single recovered slug onto its target job, capacity-permitting.
 *
 * Recovered slugs are, by definition, the OLDEST entries a job ever had
 * (they were captured long enough ago to have since fallen off history) —
 * never the newest. Pushing them onto the tail and then cap-trimming the
 * front (the pattern addPreviousSlugForLocale uses for live, chronologically
 * -ordered captures) would silently evict whatever is CURRENTLY in the
 * bucket to make room for these stale entries, i.e. recovery would
 * manufacture brand-new losses of live slugs on every run — the exact
 * oscillation that kept this workflow's own "Recover N previousSlugs"
 * commits showing up as the top offending commits in the next scan (#3587).
 * Recovery must stay capacity-permitting and non-destructive (see
 * recover-prev-slugs.yml header: "Recovery is non-destructive — only
 * ADDS"): skip instead of evicting once a bucket is already at cap.
 *
 * @param {object} targetJob – job to mutate in place.
 * @param {string} locale – locale bucket the slug is attributed to.
 * @param {string} slug – recovered slug value.
 * @param {number} [cap=CAP] – max entries per bucket / flat array.
 * @returns {{ restored: boolean, skippedAtCap: boolean }}
 */
export function applyRecoveredSlug(targetJob, locale, slug, cap = CAP) {
  if (!targetJob.previousSlugsByLocale || typeof targetJob.previousSlugsByLocale !== 'object') {
    targetJob.previousSlugsByLocale = {};
  }
  if (!Array.isArray(targetJob.previousSlugsByLocale[locale])) {
    targetJob.previousSlugsByLocale[locale] = [];
  }

  let restored = false;
  let skippedAtCap = false;
  if (!targetJob.previousSlugsByLocale[locale].includes(slug)) {
    if (targetJob.previousSlugsByLocale[locale].length < cap) {
      targetJob.previousSlugsByLocale[locale].push(slug);
      restored = true;
    } else {
      skippedAtCap = true;
    }
  }

  // Also sync flat previousSlugs for legacy consumers — same
  // non-destructive, capacity-permitting rule as above.
  if (!Array.isArray(targetJob.previousSlugs)) targetJob.previousSlugs = [];
  if (!targetJob.previousSlugs.includes(slug) && targetJob.previousSlugs.length < cap) {
    targetJob.previousSlugs.push(slug);
  }

  return { restored, skippedAtCap };
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
 * Root cause of issue #5025: this used to spawn a fresh `execSync('git show
 * <commit>:<path>')` process per historical blob (up to `maxCommits` per
 * file) — the exact per-blob-subprocess anti-pattern already identified and
 * fixed in scripts/scan-prev-slug-losses.mjs (issue #4654) via a long-lived
 * `git cat-file --batch` process, but never carried over to this sibling
 * script. With the scan step's own bottleneck fixed, this became the new
 * dominant cost (coop-ticino.json's 352 jobs alone took 3+ minutes),
 * cancelling the scheduled job mid-run. Reuses the SAME shared batch process
 * (scripts/lib/git-cat-file-batch.mjs) across every file instead of spawning
 * one per historical blob.
 *
 * @param {string} file absolute path to the slice file
 * @param {ReturnType<typeof createCatFileBatch>} catFile shared batch process
 * @param {number} [maxCommits=400] cap on history walked (newest first)
 * @returns {Promise<Map<string, Map<string, string>>>} jobId → slug → locale
 */
async function buildFileLocaleIndex(file, catFile, maxCommits = 400) {
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
    const content = await catFile.get(`${commit}:${rel}`);
    if (content == null) continue;
    let parsed;
    try { parsed = JSON.parse(content); } catch { continue; }
    if (!Array.isArray(parsed?.jobs)) continue;
    for (const job of parsed.jobs) {
      const jobKey = resolveJobDiffKey(job);
      if (!jobKey) continue;
      let m = byJob.get(jobKey);
      if (!m) { m = new Map(); byJob.set(jobKey, m); }
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

async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes('--dry-run');
  const inputIdx = args.indexOf('--input');
  const INPUT = inputIdx !== -1 ? args[inputIdx + 1] : '/tmp/recoverable-slugs.json';

  if (!fs.existsSync(INPUT)) {
    console.error(`❌ Input not found: ${INPUT}`);
    console.error('Run scripts/scan-prev-slug-losses-fast.mjs first to generate it.');
    process.exit(2);
  }

  const rawRecoverList = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  console.log(`📥 Loaded ${rawRecoverList.length} jobs with recoverable slugs from ${INPUT}`);

  // Guard: never restore slugs that a decontamination pass removed on purpose
  // (see DENYLIST_PATH docstring — this is what re-poisoned main in run
  // 29106416912).
  const denylist = loadRestoreDenylist();
  const { entries: recoverList, skipped: denylistSkipped } = filterDenylistedSlugs(rawRecoverList, denylist);
  console.log(`⛔ skipped ${denylistSkipped} denylisted (intentional decontamination)\n`);

  const stats = {
    filesUpdated: 0,
    jobsUpdated: 0,
    slugsRestoredByLocale: 0,
    slugsRestoredFromHistory: 0,
    slugsRestoredFromDetection: 0,
    slugsSkippedAtCap: 0,
    jobsMissing: 0,
  };
  const filesByName = new Map();
  for (const entry of recoverList) {
    if (!filesByName.has(entry.file)) filesByName.set(entry.file, []);
    filesByName.get(entry.file).push(entry);
  }

  // Shared long-lived `git cat-file --batch` process (see
  // scripts/lib/git-cat-file-batch.mjs) — ONE process serves every historical
  // blob lookup across every file below instead of one subprocess per commit.
  const catFile = createCatFileBatch(ROOT);

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
    const byId = new Map(slice.jobs.map(j => [resolveJobDiffKey(j), j]).filter(([k]) => k));

    // Build the per-file locale index ONCE; per-job lookup is O(1) below.
    const fileIndex = await buildFileLocaleIndex(filePath, catFile);

    // Map every current job's own content-hash disambiguator to itself, so a
    // recovered slug carrying a MISMATCHED tail can be redirected to its real
    // owner (or skipped) instead of misattributed to whatever job the loss
    // event's stale historical id happens to resolve to today.
    const bySuffixHash = new Map();
    for (const j of slice.jobs) {
      const h = stableSlugHash(j);
      if (h && !bySuffixHash.has(h)) bySuffixHash.set(h, j);
    }

    const changedJobIds = new Set();
    for (const { jobId, slugs } of entries) {
      const job = byId.get(jobId);
      if (!job) { stats.jobsMissing++; continue; }
      const slugLocaleIndex = fileIndex.get(jobId) || new Map();
      for (const slug of slugs) {
        const { targetJob, redirected } = resolveRecoveryTarget(job, slug, bySuffixHash);
        if (redirected) {
          stats.slugsRedirected = (stats.slugsRedirected || 0) + 1;
          console.warn(`  ↪️  Redirect "${slug}" from ${jobId} to ${resolveJobDiffKey(targetJob)} (disambiguator tail matches that job instead)`);
        }
        let locale = slugLocaleIndex.get(slug);
        if (locale) {
          stats.slugsRestoredFromHistory++;
        } else {
          locale = detectLocaleFromSlug(slug);
          stats.slugsRestoredFromDetection++;
        }
        // Write the recovered slug capacity-permitting (see applyRecoveredSlug
        // docstring for why this must never evict currently-live entries).
        const { restored, skippedAtCap } = applyRecoveredSlug(targetJob, locale, slug, CAP);
        if (restored) {
          changedJobIds.add(resolveJobDiffKey(targetJob));
          stats.slugsRestoredByLocale++;
        }
        if (skippedAtCap) {
          stats.slugsSkippedAtCap++;
        }
      }
    }
    stats.jobsUpdated += changedJobIds.size;

    if (changedJobIds.size > 0) {
      if (!DRY_RUN) {
        writeJsonAtomic(filePath, slice);
      }
      stats.filesUpdated++;
    }
  }
  catFile.close();

  console.log('\n📊 Backfill complete:');
  console.log(`  files updated:               ${stats.filesUpdated}${DRY_RUN ? ' (dry-run, no writes)' : ''}`);
  console.log(`  jobs updated:                ${stats.jobsUpdated}`);
  console.log(`  slugs restored (byLocale):   ${stats.slugsRestoredByLocale}`);
  console.log(`  ├─ from git history:        ${stats.slugsRestoredFromHistory}`);
  console.log(`  └─ from language detection: ${stats.slugsRestoredFromDetection}`);
  console.log(`  slugs redirected (mismatch): ${stats.slugsRedirected || 0}`);
  console.log(`  slugs skipped (denylisted):  ${denylistSkipped}`);
  console.log(`  slugs skipped (bucket full): ${stats.slugsSkippedAtCap}`);
  console.log(`  jobs missing in current:     ${stats.jobsMissing}`);
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
