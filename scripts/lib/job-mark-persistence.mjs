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
 *
 * WRITING THE MARK IS NOT ENOUGH — IT HAS TO SURVIVE OTHER WRITERS (#5645).
 * The slices are written by three families of process that do not coordinate:
 * this marker (inside `translate-pending.yml`), the 23 `crawler-group-NN.yml`
 * workflows, and the housekeeping scripts. `writeJsonAtomic` guarantees that a
 * single file is never observed half-written; it guarantees NOTHING about the
 * ORDER of two writers, and the two failure modes below are what this module
 * now defends against explicitly.
 *
 *   1. LOST UPDATE ON THE FILE. Read slice → apply marks → write. Anything
 *      another process committed to that same file in between is overwritten by
 *      our stale parse. `markSliceCompareAndSwap` re-reads the bytes
 *      immediately before the write and, if they moved, re-applies the marks to
 *      the FRESH content instead of shipping the stale document.
 *   2. THE MARK LANDS ON THE COPY THAT LOSES ASSEMBLY. The same job is
 *      routinely present in several slices (measured on b10e8eed: 931 slugs in
 *      more than one `by-crawler` slice, 26.943 records over 571 slices), and
 *      `assemble-jobs-dataset.mjs` keeps exactly one copy per identity — the
 *      one whose slice carries the newest `assembledAt`. A crawler that
 *      re-crawls the winning slice after we marked it rebuilds the record from
 *      scratch, without the flag; the marked copy then sits in the losing slice
 *      and the mark is discarded on the next assembly, silently. Measured on
 *      the same commit: 223 slugs whose copies DISAGREE on
 *      `needsRetranslation`, of which 25 have the mark exclusively on a copy
 *      that loses the `assembledAt` race — 25 marks discarded on every single
 *      assembly. `dedupeByIdentityPreservingMarks` is the repair: collapsing
 *      duplicates merges the record's mark instead of taking one side whole.
 *
 * The policy for a slug present in several slices is MERGE, never first-match:
 * every copy is marked, and the count is reported so a caller can say it out
 * loud. Skipping the duplicates, or stopping at the first hit, is what turns a
 * marked job into an unmarked one three hours later.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write-json.mjs';

/**
 * How many times a single slice write may be rebuilt on fresher bytes before
 * the pass gives up on it. Each retry costs one read of one slice file, and a
 * writer that keeps winning the race that many times in a row is a writer that
 * is rewriting the file continuously — reporting it is more useful than
 * spinning.
 */
export const MAX_SLICE_WRITE_ATTEMPTS = 5;

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
 * Carry a `needsRetranslation` mark from a discarded duplicate onto the copy
 * that survives — the per-record half of the merge.
 *
 * The flag is MONOTONE by construction everywhere it is set (`applyMarks`, both
 * markers, the assembler's collision guard), so a union across the copies of
 * one job is the only resolution that cannot invent a state neither copy had.
 * The asymmetry is deliberate and is the same one this repository already
 * accepts for `previousSlugs` in `scripts/lib/git-commit-data.sh`: carrying a
 * mark that a fresher crawl had legitimately cleared costs one extra pass of a
 * cascade that is free for the dominant family (local Argos mop-up) and
 * converges as soon as every copy is re-crawled; DROPPING a mark leaves a
 * description in the wrong language on an indexed page, with nothing that will
 * ever notice — which is the failure #5637 was opened for.
 *
 * @returns {number} 1 when a mark was carried, 0 otherwise
 */
export function carryForwardMarks(winner, loser) {
  if (!winner || !loser) return 0;
  if (loser.needsRetranslation !== true) return 0;
  if (winner.needsRetranslation === true) return 0;
  winner.needsRetranslation = true;
  return 1;
}

/**
 * Collapse duplicate job records to one per identity — newest `assembledAt`
 * wins, as before — WITHOUT letting the winner's silence delete a mark the
 * losing copy carried.
 *
 * This is `assemble-jobs-dataset.mjs`'s own dedup rule, lifted into a pure
 * function so the mark-preserving half is testable without importing the
 * assembler (which pulls ~12 files under `data/` and `public/assets/` at module
 * scope and is therefore unimportable from a sparse worktree).
 *
 * @param {Array<{job: object, assembledAt: string}>} tagged
 * @param {(job: object) => string} identityOf
 * @returns {{winners: object[], marksCarried: number, collapsed: number}}
 */
export function dedupeByIdentityPreservingMarks(tagged, identityOf) {
  const byIdentity = new Map();
  let marksCarried = 0;
  let collapsed = 0;

  for (const entry of Array.isArray(tagged) ? tagged : []) {
    if (!entry || !entry.job) continue;
    const identity = identityOf(entry.job);
    if (!identity) continue;
    const assembledAt = entry.assembledAt || '';
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, { job: entry.job, assembledAt });
      continue;
    }
    collapsed += 1;
    // `>=` (not `>`) preserves the pre-existing last-write-wins tie-break: with
    // equal timestamps the later slice in iteration order still wins.
    if (assembledAt >= existing.assembledAt) {
      marksCarried += carryForwardMarks(entry.job, existing.job);
      byIdentity.set(identity, { job: entry.job, assembledAt });
    } else {
      marksCarried += carryForwardMarks(existing.job, entry.job);
    }
  }

  return { winners: [...byIdentity.values()].map((e) => e.job), marksCarried, collapsed };
}

/**
 * Read-modify-write one job slice with a compare-and-swap on its bytes.
 *
 * `writeJsonAtomic` makes the write itself indivisible; it does not stop us
 * from writing a document we parsed BEFORE another process rewrote the same
 * file. So the bytes are re-read immediately before the write and, when they
 * moved, the whole read-mutate cycle restarts on the fresh content — our change
 * is re-applied to the other writer's document instead of the other writer's
 * document being thrown away.
 *
 * `mutate(list, data)` must be REPEATABLE: it can run several times, once per
 * attempt, and must report its own counts from scratch each time (the callers
 * here reset their accumulators inside the closure for exactly this reason).
 * It returns how many records it changed; 0 means nothing to write.
 *
 * The residual window (between the verification read and `renameSync`) is not
 * zero and cannot be, without a lock every one of the ~580 crawler write sites
 * would have to take. It is a few microseconds of syscall against a cycle that
 * parses a whole slice, which is the difference that matters.
 *
 * @returns {{changed: number, wrote: boolean, retries: number, lost: boolean, unreadable: boolean}}
 */
export function updateSliceCompareAndSwap(filePath, mutate, { dryRun = false } = {}) {
  let retries = 0;

  for (let attempt = 1; attempt <= MAX_SLICE_WRITE_ATTEMPTS; attempt += 1) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { changed: 0, wrote: false, retries, lost: false, unreadable: true };
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // An unreadable slice must not sink the whole pass.
      return { changed: 0, wrote: false, retries, lost: false, unreadable: true };
    }

    const list = Array.isArray(data) ? data : data?.jobs || [];
    const changed = mutate(list, data) || 0;

    if (changed === 0 || dryRun) {
      return { changed, wrote: false, retries, lost: false, unreadable: false };
    }

    // ── compare-and-swap ────────────────────────────────────────────────────
    let current;
    try {
      current = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { changed: 0, wrote: false, retries, lost: false, unreadable: true };
    }
    if (current !== raw) {
      // Someone else committed to this slice while we were working. Their
      // document is the current truth; ours is stale by exactly their write.
      retries += 1;
      continue;
    }

    writeJsonAtomic(filePath, data);
    return { changed, wrote: true, retries, lost: false, unreadable: false };
  }

  return { changed: 0, wrote: false, retries, lost: true, unreadable: false };
}

/**
 * Mark one slice, through the compare-and-swap above.
 *
 * @returns {{marked: number, present: string[], wrote: boolean, retries: number, lost: boolean, unreadable: boolean}}
 */
export function markSliceCompareAndSwap(filePath, slugs, { dryRun = false } = {}) {
  let present = [];

  const outcome = updateSliceCompareAndSwap(
    filePath,
    (list) => {
      const marked = applyMarks(list, slugs);
      // Record every slug present in this slice, not just the ones mutated: a
      // job already carrying the flag is resolved, not missing. Rebuilt on every
      // attempt, so a retry cannot double-count it.
      const seen = new Set();
      for (const job of Array.isArray(list) ? list : []) {
        if (job && slugs.has(job.slug)) seen.add(job.slug);
      }
      present = [...seen];
      return marked;
    },
    { dryRun }
  );

  return {
    marked: outcome.changed,
    present,
    wrote: outcome.wrote,
    retries: outcome.retries,
    lost: outcome.lost,
    unreadable: outcome.unreadable,
  };
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
 * EVERY copy of a duplicated slug is marked — see the module header for why
 * first-match-wins is the wrong policy here — and `duplicated` reports how many
 * marked slugs live in more than one slice.
 *
 * @param {Set<string>} slugs
 * @param {{root: string, dryRun?: boolean}} options
 * @returns {{totalMarked: number, slicesChanged: number, unresolved: number,
 *            duplicated: number, racesResolved: number, racesLost: number}}
 *   `unresolved` = slugs that matched no slice record. Non-zero means the mark
 *   exists only in the artefact and will still evaporate — the caller should
 *   say so out loud rather than report a clean run.
 *   `racesLost` = slices abandoned because another writer kept winning the
 *   compare-and-swap; those marks did NOT reach the committed half either.
 */
export function persistMarksToSlices(slugs, { root, dryRun = false } = {}) {
  const byCrawler = path.join(root, 'data', 'jobs', 'by-crawler');
  let totalMarked = 0;
  let slicesChanged = 0;
  let racesResolved = 0;
  let racesLost = 0;
  const resolved = new Set();
  const slicesPerSlug = new Map();

  if (!slugs || slugs.size === 0 || !fs.existsSync(byCrawler)) {
    return {
      totalMarked,
      slicesChanged,
      unresolved: slugs ? slugs.size : 0,
      duplicated: 0,
      racesResolved,
      racesLost,
    };
  }

  for (const file of fs.readdirSync(byCrawler).filter((f) => f.endsWith('.json'))) {
    const filePath = path.join(byCrawler, file);
    const outcome = markSliceCompareAndSwap(filePath, slugs, { dryRun });
    if (outcome.unreadable) continue;

    for (const slug of outcome.present) {
      resolved.add(slug);
      slicesPerSlug.set(slug, (slicesPerSlug.get(slug) || 0) + 1);
    }
    racesResolved += outcome.retries;
    if (outcome.lost) {
      racesLost += 1;
      continue;
    }
    if (outcome.marked > 0) {
      totalMarked += outcome.marked;
      slicesChanged += 1;
    }
  }

  let duplicated = 0;
  for (const count of slicesPerSlug.values()) if (count > 1) duplicated += 1;

  return {
    totalMarked,
    slicesChanged,
    unresolved: slugs.size - resolved.size,
    duplicated,
    racesResolved,
    racesLost,
  };
}