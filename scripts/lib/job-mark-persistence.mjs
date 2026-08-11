/**
 * job-mark-persistence — where a `needsRetranslation` mark has to be written
 * for it to still exist on the next pipeline run.
 *
 * WHY THIS MODULE EXISTS. `data/jobs.json` is a gitignored BUILD ARTEFACT:
 * `scripts/assemble-jobs-dataset.mjs` regenerates it from
 * `data/jobs/by-crawler/*.json` at the top of every run, and only those slices
 * are committed. A flag written to the artefact alone therefore evaporates
 * before anything can act on it — the marker re-detects the same jobs on the
 * next run, re-flags them, and loses them again.
 *
 * That is not hypothetical. `mark-mistranslated-jobs.mjs` (titles) always wrote
 * both; `mark-locale-mismatched-jobs.mjs` (descriptions) wrote only the
 * artefact. Descriptions are serviced by that second script alone, so the
 * descriptions backlog could never drain, and on 2026-08-11 a batch of German
 * apprenticeship postings whose `it` description was a byte-identical copy of
 * the `de` source pushed tests/job-locale-consistency.test.ts to 0.320% against
 * its 0.300% ratchet — red on every open PR at once, with no branch able to fix
 * it because the defect was in main's data.
 *
 * Both markers now share this module: the write path is one implementation, so
 * the two cannot drift apart again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write-json.mjs';

/**
 * Apply `needsRetranslation` to every record whose slug is in `slugs`.
 * Monotone (never clears a flag) and no-ops on an unchanged list, so calling it
 * twice writes once.
 *
 * @returns {number} records mutated
 */
export function applyMarks(list, slugs) {
  let marked = 0;
  for (const job of Array.isArray(list) ? list : []) {
    if (job && slugs.has(job.slug) && !job.needsRetranslation) {
      job.needsRetranslation = true;
      marked += 1;
    }
  }
  return marked;
}

/**
 * Write the marks into the COMMITTED per-crawler slices — the half that
 * survives the next `assemble-jobs-dataset.mjs`.
 *
 * A slice that cannot be parsed is skipped rather than thrown on: one corrupt
 * file must not sink a pass that can still persist every other mark. Slices are
 * only rewritten when a value actually changed, so a re-run over unchanged data
 * touches nothing and produces no commit.
 *
 * @param {Set<string>} slugs
 * @param {{root: string, dryRun?: boolean}} options
 * @returns {{totalMarked: number, slicesChanged: number, unresolved: number}}
 *   `unresolved` = slugs that matched no slice record. Non-zero means the mark
 *   exists only in the artefact and will still evaporate — the caller should
 *   say so out loud rather than report a clean run.
 */
export function persistMarksToSlices(slugs, { root, dryRun = false } = {}) {
  const byCrawler = path.join(root, 'data', 'jobs', 'by-crawler');
  let totalMarked = 0;
  let slicesChanged = 0;
  const resolved = new Set();

  if (!slugs || slugs.size === 0 || !fs.existsSync(byCrawler)) {
    return { totalMarked, slicesChanged, unresolved: slugs ? slugs.size : 0 };
  }

  for (const file of fs.readdirSync(byCrawler).filter((f) => f.endsWith('.json'))) {
    const filePath = path.join(byCrawler, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue; // an unreadable slice must not sink the whole pass
    }
    const list = Array.isArray(data) ? data : data?.jobs || [];
    const marked = applyMarks(list, slugs);
    // Record every slug present in this slice, not just the ones mutated: a job
    // already carrying the flag is resolved, not missing.
    for (const job of Array.isArray(list) ? list : []) {
      if (job && slugs.has(job.slug)) resolved.add(job.slug);
    }
    if (marked > 0) {
      if (!dryRun) writeJsonAtomic(filePath, data);
      totalMarked += marked;
      slicesChanged += 1;
    }
  }

  return { totalMarked, slicesChanged, unresolved: slugs.size - resolved.size };
}