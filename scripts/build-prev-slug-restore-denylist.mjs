#!/usr/bin/env node
/**
 * Deterministic generator (and applier) for data/prev-slug-restore-denylist.json —
 * the guard that stops the "Recover Lost previousSlugs" workflow from
 * re-importing slugs that were REMOVED ON PURPOSE by the cross-tenant
 * decontamination passes.
 *
 * Background: the umantis tenant-id collision (fixed in #4055, merged as
 * squash 028d6c1147) had pinned slugs of OTHER companies onto 75+ jobs across
 * 16 by-crawler slices (e.g. kanton-aargau job titles living inside ksa.json's
 * previousSlugs). #4055 deliberately deleted those foreign slugs from
 * previousSlugs / previousSlugsByLocale / slugByLocale. The recover workflow
 * (scripts/scan-prev-slug-losses.mjs → scripts/backfill-prev-slugs-from-loss-events.mjs)
 * then counted those intentional deletions as "losses" (#4061) and run
 * 29106416912 (commit efed987db) re-added 352 slugs — restoring the poison.
 *
 * This script re-derives, byte-deterministically, the set of intentionally
 * removed {file, jobId, slug} pairs straight from the decontamination
 * squash-merge diffs on main:
 *
 *   1. For each by-crawler slice touched by a DECON_COMMIT, diff parent vs
 *      commit per job (matched via resolveJobDiffKey, the same key the scan
 *      and backfill use) and collect every slug that disappeared from the
 *      job's previousSlugs / previousSlugsByLocale / slugByLocale (or that
 *      belonged to a job deleted outright by the commit).
 *   2. Keep only slugs that carry the slug-signature of a company FOREIGN to
 *      the slice (the same SIG/foreignHit rule the decontamination applied:
 *      a "…-kanton-aargau-aarau" slug inside ksa.json is poison; a
 *      "…-ksa-aarau" slug inside ksa.json is not).
 *   3. Add the explicitly-censused garbage-title ksa slugs (mangled crawls
 *      that were also removed intentionally / must never be restored).
 *
 * Consumers:
 *   - scripts/backfill-prev-slugs-from-loss-events.mjs loads the generated
 *     JSON and skips denylisted (file, slug) pairs before restoring anything.
 *   - --clean strips every denylisted slug from the CURRENT working-tree
 *     slices' previousSlugs / previousSlugsByLocale (one-shot repair after a
 *     re-poisoning like efed987db).
 *
 * The output is stable (sorted by file, jobId, slug) so re-running the
 * generator on the same history is a no-op diff.
 *
 * Usage:
 *   node scripts/build-prev-slug-restore-denylist.mjs            # (re)generate data file
 *   node scripts/build-prev-slug-restore-denylist.mjs --clean    # strip denylisted slugs from current slices
 *   node scripts/build-prev-slug-restore-denylist.mjs --clean --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveJobDiffKey } from './lib/job-match-key.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
export const DENYLIST_PATH = path.join(ROOT, 'data', 'prev-slug-restore-denylist.json');

/**
 * The decontamination squash-merges on main whose slice-level slug REMOVALS
 * are intentional and must never be "recovered".
 *  - 028d6c1147…: #4055 — umantis per-tenant identity fix + decontamination
 *    of 75 jobs across 16 by-crawler slices (the actual foreign-slug purge).
 *  - 81089f8f47…: #3943 — registry bonifica of the same audit cycle. Touches
 *    no by-crawler slice (contributes 0 pairs) but is pinned here so the
 *    derivation covers the full decontamination cycle explicitly.
 *  - 1472959f74…: "Remove Allianz Suisse crawler and purge all Allianz data"
 *    — deliberately stripped allianz-suisse slugs (umantis cross-tenant
 *    spill) from kispi-sg / sanatorium-kilchberg / spital-davos histories.
 *    Recovery run 29106416912 re-imported 7 of them into
 *    sanatorium-kilchberg.json.
 */
export const DECON_COMMITS = [
  '028d6c1147b4980dd2df5fda8b3677893bc87059',
  '81089f8f47abfb84d0184b10be9c4ee8ec08338e',
  '1472959f7463c37fae75189ea59fd4753cab103e',
];

// Shallow-clone guard: on a clone whose history doesn't reach the pinned
// decontamination commits, gitShowJson would fail-open (null) and the
// regeneration would be silently near-empty — turning `--clean` into a
// deceptive no-op. Fail loud instead. NB: called from buildDenylist(), NOT at
// module load — test files import this module for the pure helpers and CI
// checkouts are depth-1 (a top-level throw would break the vitest gate).
import { execFileSync as __execFileSync } from 'node:child_process';
export function assertDeconCommitsReachable(commits = DECON_COMMITS) {
  for (const c of commits) {
    try {
      __execFileSync('git', ['cat-file', '-e', `${c}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    } catch {
      throw new Error(`Pinned decontamination commit ${c} is unreachable (shallow clone?) — deepen history before regenerating/cleaning (git fetch --deepen or --unshallow).`);
    }
  }
}

/**
 * Company slug signatures — substrings that unambiguously identify the
 * employer a slug was generated for (same signature set the #4055
 * decontamination used to flag foreign slugs). Keys are signature ids;
 * values are lowercase substrings matched against the whole slug.
 */
export const COMPANY_SIGS = {
  'kanton-aargau': ['kanton-aargau'],
  'gkb': ['graubundner-kantonalbank', '-gkb-ch'],
  'kanton-st-gallen': ['kanton-st-gallen'],
  'spital-maennedorf': ['spital-mannedorf', 'spital-maennedorf'],
  'bethesda-spital': ['bethesda-spital'],
  'klinik-sonnenhalde': ['klinik-sonnenhalde'],
  'eoc': ['eoc-ente-ospedaliero-cantonale'],
  'tschuggen': ['tschuggen'],
  'gesundheitszentrum-fricktal': ['gesundheitszentrum-fricktal'],
  'upd': ['upd-bern', 'universitare-psychiatrische-dienste'],
  'see-spital': ['see-spital'],
  'spital-davos': ['spital-davos'],
  'kispi-sg': ['ostschweizer-kinderspital'],
  'klinik-im-hasel': ['klinik-im-hasel'],
  'ksa': ['kantonsspital-aarau', '-ksa-ch', '-ksa-aarau'],
  'sanatorium-kilchberg': ['sanatorium-kilchberg'],
  'buergenstock': ['buergenstock'],
  // Crawler and slice deleted by 1472959f74 — allianz-suisse slugs are
  // foreign to every remaining slice by construction.
  'allianz-suisse': ['allianz-suisse'],
};

/**
 * Which signature id(s) are the slice's OWN company (never denylisted there).
 * Only slices touched by the decontamination commits need an entry.
 */
export const SLICE_OWN_SIG = {
  'bethesda-spital.json': ['bethesda-spital'],
  'buergenstock-hotels.json': ['buergenstock'],
  'gesundheitszentrum-fricktal.json': ['gesundheitszentrum-fricktal'],
  'gkb.json': ['gkb'],
  'kanton-aargau.json': ['kanton-aargau'],
  'kanton-st-gallen.json': ['kanton-st-gallen'],
  'kispi-sg.json': ['kispi-sg'],
  'klinik-im-hasel.json': ['klinik-im-hasel'],
  'ksa.json': ['ksa'],
  'sanatorium-kilchberg.json': ['sanatorium-kilchberg'],
  'see-spital.json': ['see-spital'],
  'spital-davos.json': ['spital-davos'],
  'spital-maennedorf.json': ['spital-maennedorf'],
  'tschuggen.json': ['tschuggen'],
  'upd.json': ['upd'],
};

/**
 * Garbage-title slugs (mangled crawl output, e.g. "Logistikfachfrau" crawled
 * as "logi-hyardfachfrau", "Vor-Ort-Leiter" as "vor-ort-letter") that carry
 * the slice's OWN signature — so the foreign-signature rule can't catch them —
 * but were removed intentionally (#4055 deleted the job holding the first)
 * or re-introduced from a stale loss event by recovery run 29106416912.
 * jobId records provenance; the runtime guard matches on file+slug.
 */
export const EXPLICIT_GARBAGE = [
  {
    file: 'ksa.json',
    jobId: 'ksa-1150b9473d2c',
    slug: 'logi-hyardfachfrau-hyardfachmann-kantonsspital-aarau-ksa-aarau-23121f',
    reason: 'garbage-title',
  },
  {
    file: 'ksa.json',
    jobId: 'ksa-c124b4a1ad14',
    slug: 'vor-ort-letter-in-ikt-unterstutzung-kantonsspital-aarau-ksa-aarau',
    reason: 'garbage-title',
  },
  // Allianz cross-tenant hybrid: an Allianz Vevey posting relocalized with
  // spital-davos' own suffix, so the foreign-signature rule cannot see it.
  // Removed intentionally by the Allianz purge (1472959f74).
  {
    file: 'spital-davos.json',
    jobId: 'spital-davos-501ff253ad6d',
    slug: 'conseiller-en-prevoyance-au-service-externe-vevey-h-f-d-100-spital-davos-davos',
    reason: 'cross-tenant-hybrid',
  },
];

/**
 * Return the FOREIGN signature id a slug matches relative to a slice file,
 * or null when the slug is the slice's own company / matches no signature.
 * Pure — unit-testable without git.
 *
 * @param {string} file slice basename, e.g. "ksa.json"
 * @param {string} slug
 * @returns {string|null}
 */
export function foreignSigForSlug(file, slug) {
  const own = new Set(SLICE_OWN_SIG[file] || []);
  const s = String(slug || '').toLowerCase();
  for (const [sigId, patterns] of Object.entries(COMPANY_SIGS)) {
    if (own.has(sigId)) continue;
    if (patterns.some((p) => s.includes(p))) return sigId;
  }
  return null;
}

/** Every slug a job version carries, across active + history fields. */
function allSlugsOf(job) {
  const out = new Set();
  if (Array.isArray(job.previousSlugs)) for (const s of job.previousSlugs) if (s) out.add(s);
  if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
    for (const arr of Object.values(job.previousSlugsByLocale)) for (const s of (arr || [])) if (s) out.add(s);
  }
  if (job.slug) out.add(job.slug);
  if (job.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const s of Object.values(job.slugByLocale)) if (s) out.add(s);
  }
  return out;
}

function gitShowJson(ref, rel) {
  try {
    return JSON.parse(execSync(`git show ${ref}:${rel}`, {
      encoding: 'utf8', maxBuffer: 200 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], cwd: ROOT,
    }));
  } catch {
    return null;
  }
}

/**
 * Derive the denylist entries from the decontamination commits' diffs.
 * @returns {Array<{file: string, jobId: string, slug: string, reason: string}>}
 */
export function buildDenylist(commits = DECON_COMMITS) {
  assertDeconCommitsReachable(commits);
  const entries = new Map(); // `${file}\0${jobId}\0${slug}` → entry
  for (const commit of commits) {
    const files = execSync(`git show --name-only --pretty=format: ${commit}`, { encoding: 'utf8', cwd: ROOT })
      .trim().split('\n')
      .filter((f) => f.startsWith('data/jobs/by-crawler/') && f.endsWith('.json'));
    for (const rel of files) {
      const before = gitShowJson(`${commit}~1`, rel);
      const after = gitShowJson(commit, rel);
      if (!Array.isArray(before?.jobs) || !Array.isArray(after?.jobs)) continue;
      const file = path.basename(rel);
      const afterByKey = new Map();
      for (const j of after.jobs) {
        const k = resolveJobDiffKey(j);
        if (k) afterByKey.set(k, j);
      }
      for (const bj of before.jobs) {
        const jobId = resolveJobDiffKey(bj);
        if (!jobId) continue;
        const aj = afterByKey.get(jobId);
        const afterSet = aj ? allSlugsOf(aj) : new Set();
        for (const slug of allSlugsOf(bj)) {
          if (afterSet.has(slug)) continue; // not removed
          const sig = foreignSigForSlug(file, slug);
          if (!sig) continue; // own-company or unrecognized → not poison
          const key = `${file}\u0000${jobId}\u0000${slug}`;
          if (!entries.has(key)) {
            entries.set(key, { file, jobId, slug, reason: `foreign:${sig}` });
          }
        }
      }
    }
  }
  for (const g of EXPLICIT_GARBAGE) {
    const key = `${g.file}\u0000${g.jobId}\u0000${g.slug}`;
    if (!entries.has(key)) entries.set(key, { ...g });
  }
  return [...entries.values()].sort((a, b) =>
    a.file.localeCompare(b.file) || a.jobId.localeCompare(b.jobId) || a.slug.localeCompare(b.slug));
}

/**
 * Strip every denylisted slug from the CURRENT slices' previousSlugs /
 * previousSlugsByLocale. Matches on file+slug across ALL jobs in the file
 * (not just the provenance jobId): a recovery run can re-home a poisoned
 * slug onto a different job via the hash-tail redirect, and a foreign slug
 * belongs to no job of the slice anyway.
 *
 * @param {Array<{file: string, slug: string}>} denylistEntries
 * @param {{dryRun?: boolean, dir?: string}} [opts]
 */
export function cleanSlices(denylistEntries, { dryRun = false, dir = BY_CRAWLER_DIR } = {}) {
  const byFile = new Map();
  for (const e of denylistEntries) {
    if (!byFile.has(e.file)) byFile.set(e.file, new Set());
    byFile.get(e.file).add(e.slug);
  }
  const report = { filesChanged: 0, slugsRemoved: 0, activeHits: [], perFile: {} };
  for (const [file, slugs] of byFile) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) continue;
    const slice = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(slice.jobs)) continue;
    let removed = 0;
    for (const job of slice.jobs) {
      if (Array.isArray(job.previousSlugs)) {
        const before = job.previousSlugs.length;
        job.previousSlugs = job.previousSlugs.filter((s) => !slugs.has(s));
        removed += before - job.previousSlugs.length;
      }
      if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
        for (const [loc, arr] of Object.entries(job.previousSlugsByLocale)) {
          if (!Array.isArray(arr)) continue;
          const before = arr.length;
          job.previousSlugsByLocale[loc] = arr.filter((s) => !slugs.has(s));
          removed += before - job.previousSlugsByLocale[loc].length;
        }
      }
      // Never touch active slug/slugByLocale — just surface the anomaly.
      const active = new Set([job.slug, ...Object.values(job.slugByLocale || {})].filter(Boolean));
      for (const s of active) if (slugs.has(s)) report.activeHits.push({ file, jobId: resolveJobDiffKey(job), slug: s });
    }
    if (removed > 0) {
      report.filesChanged++;
      report.slugsRemoved += removed;
      report.perFile[file] = removed;
      if (!dryRun) writeJsonAtomic(filePath, slice);
    }
  }
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const CLEAN = args.includes('--clean');
  const DRY_RUN = args.includes('--dry-run');

  const entries = buildDenylist();
  const byFileCount = {};
  for (const e of entries) byFileCount[e.file] = (byFileCount[e.file] || 0) + 1;

  if (!CLEAN) {
    const payload = {
      description:
        'Slugs INTENTIONALLY removed from by-crawler slice histories by the umantis cross-tenant '
        + 'decontamination (#4055 / #4056 cycle, squash 028d6c1147; registry side 81089f8f47) plus censused '
        + 'garbage-title slugs. The recover-prev-slugs workflow must NEVER restore these: '
        + 'scan-prev-slug-losses.mjs sees the decontamination as a "loss" and '
        + 'backfill-prev-slugs-from-loss-events.mjs would re-import foreign companies\' slugs '
        + '(this happened in run 29106416912, commit efed987db). jobId is provenance (the job the '
        + 'slug was removed from); the runtime guard matches on file+slug. '
        + 'Regenerate with: node scripts/build-prev-slug-restore-denylist.mjs',
      generatedBy: 'scripts/build-prev-slug-restore-denylist.mjs',
      sourceCommits: DECON_COMMITS,
      entries,
    };
    if (!DRY_RUN) writeJsonAtomic(DENYLIST_PATH, payload);
    console.log(`Denylist: ${entries.length} (file, jobId, slug) pairs${DRY_RUN ? ' (dry-run, not written)' : ` → ${path.relative(ROOT, DENYLIST_PATH)}`}`);
    for (const [f, n] of Object.entries(byFileCount).sort()) console.log(`  ${String(n).padStart(4)}  ${f}`);
    return;
  }

  const report = cleanSlices(entries, { dryRun: DRY_RUN });
  console.log(`${DRY_RUN ? 'DRY-RUN' : 'APPLIED'}: removed ${report.slugsRemoved} denylisted slug occurrence(s) across ${report.filesChanged} file(s)`);
  for (const [f, n] of Object.entries(report.perFile).sort()) console.log(`  ${String(n).padStart(4)}  ${f}`);
  if (report.activeHits.length) {
    console.log('⚠️  Denylisted slugs still ACTIVE (slug/slugByLocale) — not touched, investigate:');
    for (const h of report.activeHits) console.log(`  ${h.file} ${h.jobId} ${h.slug}`);
  }
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
  main();
}
