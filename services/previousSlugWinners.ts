/**
 * Previous-slug bridge winner registry.
 *
 * Why this exists
 * ---------------
 * `jobsSeoPagesPlugin` emits a "bridge" page at every entry of every active
 * job's `previousSlugs`/`previousSlugsByLocale`. When two or more jobs share
 * the same previous slug (e.g. multiple Convit Holding GmbH job openings
 * whose past English titles all collapsed to `social-security-advisor-...
 * -convit-holding-gmbh-biasca`), each job emits a different bridge to the
 * SAME path. The parallel-write race in `WriteCollector` then resolves
 * non-deterministically — the user lands on a bridge whose target canonical
 * is essentially random among the claimants.
 *
 * The fix is to declare ownership: for each (locale, prevSlug) claimed by
 * multiple active jobs, ONE job is the canonical owner. The bridge emit
 * skips every other claimant. The winner choice persists in
 * `data/previous-slug-winners.json` so the same slug always points to the
 * same canonical across builds — important because Google has indexed the
 * bridge URL pointing at a specific destination, and silently flipping the
 * destination per build would confuse crawlers and split link equity.
 *
 * How a winner is chosen
 * ----------------------
 * Token-Jaccard between the old slug and each candidate's current canonical
 * slug. Both are tokenised on `-`, deduped within themselves, intersected,
 * and the candidate with the highest |intersection|/|union| wins.
 *
 * Tie-break: lexicographic order of the candidate's `jobIdentifier`. This is
 * stable across runs because identifiers are content-addressed (`<crawler>-
 * <hash>`), not position-dependent.
 *
 * Empty intersection: still a valid Jaccard of 0; tie-break breaks it. The
 * caller can post-filter zero-score winners if it wants stricter behaviour.
 *
 * Persistence
 * -----------
 * - File: `data/previous-slug-winners.json` (committed to git, like every
 *   other ratchet baseline in the project).
 * - On each build: load the file, resolve winners for every claimed
 *   (locale, prevSlug) pair, save when changes occurred.
 * - A previous winner is reused when its job is still in the candidates
 *   list. A previous winner whose job is no longer active triggers
 *   re-election among the current candidates.
 *
 * NOT a build dependency
 * ----------------------
 * This module is `tsx`-loaded by the Vite plugin during `closeBundle` —
 * it doesn't need bundling. It also has no Vite/Rollup imports so it can
 * be unit-tested with vitest standalone.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * One persisted decision. The audit fields (`decidedAt`, `score`,
 * `candidatesCount`) are not used by the plugin; they exist so a developer
 * inspecting `data/previous-slug-winners.json` can understand WHY a winner
 * was chosen without re-running the build.
 *
 * `lastSeenAt` is touched on every build that re-claims this `(locale,
 * oldSlug)` pair (whether the decision was reused or re-elected). Used by
 * {@link pruneStaleWinners} to garbage-collect entries whose oldSlug nobody
 * lists in their `previousSlugs` anymore. Backward compat: if an older
 * entry on disk lacks `lastSeenAt`, the prune routine falls back to
 * `decidedAt` so historical entries don't auto-purge on the first run after
 * the field is introduced.
 */
export interface WinnerEntry {
  readonly winnerJobIdentifier: string;
  readonly winnerCanonical: string;
  readonly decidedAt: string;
  readonly lastSeenAt: string;
  readonly score: number;
  readonly candidatesCount: number;
  /**
   * Canton code (e.g. `'TI'`, `'ZH'`) that owns the bridge URL path for this
   * (locale, oldSlug) pair. Phase 8b (2026-05-12): bridges now live under the
   * job's canton-aware section (`/cerca-lavoro-zurigo/...` for ZH jobs), not
   * the legacy hardcoded TI section. Forward-compat: older entries on disk
   * may lack this field; readers MUST treat it as optional and default to
   * `'TI'` for backward-compat.
   */
  readonly canton?: string;
}

/** A candidate for ownership of a previous-slug bridge. */
export interface CandidateInput {
  readonly jobIdentifier: string;
  readonly canonicalSlug: string;
}

/** The full on-disk format. Keys are `${canton}::${locale}::${oldSlug}` (see {@link makeKey}). */
export type WinnersFile = Record<string, WinnerEntry>;

/**
 * Compose the storage key for a (canton, locale, oldSlug) triple.
 *
 * - Canton is the FIRST segment because the bridge URL path depends on the
 *   winning job's canton — the same (locale, oldSlug) pair can legitimately
 *   exist for different jobs under different cantons (e.g. an `infermieri-...`
 *   bridge served at `/cerca-lavoro-ticino/` for a TI job and at
 *   `/cerca-lavoro-zurigo/` for a ZH job that shared the historical slug).
 *   Conflating them by dropping canton would resurrect the production bug
 *   that Phase 8b fixes.
 * - Locale is included because `previousSlugsByLocale` IS locale-specific.
 *   The same string can legitimately exist as a prevSlug for different
 *   jobs in different locales.
 *
 * Schema versioning (2026-05-12, Phase 8b): the old key shape was
 * `${locale}::${oldSlug}` (no canton). The migration script at
 * `scripts/migrate-previous-slug-winners-add-canton.mjs` rewrites
 * `data/previous-slug-winners.json` once to the new shape, defaulting
 * unmappable entries to canton `'TI'`.
 */
export function makeKey(canton: string, locale: string, oldSlug: string): string {
  return `${canton}::${locale}::${oldSlug}`;
}

/**
 * Tokenise a slug into the set of unique non-empty `-`-separated tokens.
 * Lowercased so casing differences (rare in slugs but possible in callers)
 * don't fragment the intersection.
 */
function tokenize(slug: string): Set<string> {
  const out = new Set<string>();
  for (const tok of slug.toLowerCase().split('-')) {
    if (tok.length > 0) out.add(tok);
  }
  return out;
}

/**
 * Jaccard similarity over the two token sets. Returns a value in [0, 1].
 * Both sets empty → returns 0 (avoids 0/0). Identical → returns 1.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Pick the canonical winner among `candidates` for `oldSlug` using the
 * Jaccard heuristic. Returns `null` only when `candidates` is empty.
 *
 * The score in the returned entry is the candidate's Jaccard similarity
 * (0 to 1, four decimals retained) — useful for inspection and for the
 * caller to decide whether to filter out very-low-similarity winners.
 *
 * Tie-break: lexicographic on `jobIdentifier` (deterministic across builds).
 */
export function chooseWinner(
  oldSlug: string,
  candidates: readonly CandidateInput[],
  now: string,
): WinnerEntry | null {
  if (candidates.length === 0) return null;

  let bestScore = -1;
  let bestIdentifier = '';
  let bestCanonical = '';

  for (const c of candidates) {
    const score = jaccardSimilarity(oldSlug, c.canonicalSlug);
    if (score > bestScore) {
      bestScore = score;
      bestIdentifier = c.jobIdentifier;
      bestCanonical = c.canonicalSlug;
      continue;
    }
    if (score === bestScore && c.jobIdentifier < bestIdentifier) {
      bestIdentifier = c.jobIdentifier;
      bestCanonical = c.canonicalSlug;
    }
  }

  return {
    winnerJobIdentifier: bestIdentifier,
    winnerCanonical: bestCanonical,
    decidedAt: now,
    lastSeenAt: now,
    score: Math.round(bestScore * 10000) / 10000,
    candidatesCount: candidates.length,
  };
}

/**
 * Load the registry from disk. Returns an empty object when the file is
 * missing or malformed (so a fresh project / first build doesn't crash on
 * a non-existent file). Malformed JSON is logged but not thrown — diagnostic
 * tooling shouldn't break a deploy.
 */
export function loadWinners(filePath: string): WinnersFile {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as WinnersFile;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[previous-slug-winners] failed to read ${filePath}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Persist the registry. Sorts keys for stable diffs in PR review and writes
 * with a trailing newline (matches every other JSON in `data/`). Best-effort:
 * swallow errors so a flaky disk doesn't break the build.
 */
export function saveWinners(filePath: string, winners: WinnersFile): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const sorted: WinnersFile = {};
    for (const k of Object.keys(winners).sort()) sorted[k] = winners[k];
    fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[previous-slug-winners] failed to write ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Resolve the winner for one (locale, oldSlug) given the current candidates.
 *
 * Decision tree (in order):
 *   1. Empty candidates → return null (caller should skip).
 *   2. Existing entry whose winner is still in the candidates list →
 *      reuse the decision unchanged BUT touch `lastSeenAt` to mark this
 *      entry alive. Keeps URL stable across builds; prevents the prune
 *      routine from garbage-collecting active entries.
 *   3. Existing entry whose winner is NO LONGER in the candidates →
 *      re-elect via the heuristic, overwrite the entry. URL flips to a
 *      remaining claimant; future builds keep the new winner stable.
 *      This branch fires both when multiple candidates remain and when
 *      only one is left — in either case we want the file to track the
 *      current canonical so subsequent builds don't dance around an
 *      orphan registry entry.
 *   4. No existing entry, multiple candidates → first-time election via
 *      heuristic; persist.
 *   5. No existing entry, single candidate → trivial winner; do NOT
 *      persist. Single-claimant slugs don't need a registry entry — they
 *      can't collide. Saves the file from accumulating one row per
 *      legitimately unique prevSlug.
 *
 * Returns the winner entry (whether new, reused, or trivial), or `null`
 * if candidates is empty. The caller should compare the entry's
 * `winnerJobIdentifier` against the iterating job's identifier and skip
 * emit when they differ.
 *
 * Mutation note: `winners` is mutated in place. Callers should JSON.
 * stringify the registry before and after the resolve loop to detect
 * whether a save() is needed.
 */
export function resolveWinner(
  winners: WinnersFile,
  canton: string,
  locale: string,
  oldSlug: string,
  candidates: readonly CandidateInput[],
  now: string,
): WinnerEntry | null {
  if (candidates.length === 0) return null;

  const key = makeKey(canton, locale, oldSlug);
  const existing = winners[key];

  // Branch 2: prior decision still valid — touch lastSeenAt and reuse.
  if (
    existing &&
    candidates.some((c) => c.jobIdentifier === existing.winnerJobIdentifier)
  ) {
    const needsTouch = existing.lastSeenAt !== now;
    const needsCantonStamp = !existing.canton && canton;
    if (needsTouch || needsCantonStamp) {
      winners[key] = {
        ...existing,
        ...(needsTouch ? { lastSeenAt: now } : {}),
        ...(needsCantonStamp ? { canton } : {}),
      };
    }
    return winners[key];
  }

  // Branch 3 + 4: existing-but-stale OR first-time multi-candidate. Re-elect.
  // Branch 3 fires regardless of candidates.length so the file always reflects
  // the current canonical when the prior winner is gone.
  if (existing || candidates.length > 1) {
    const fresh = chooseWinner(oldSlug, candidates, now);
    if (!fresh) return null;
    const stamped: WinnerEntry = canton ? { ...fresh, canton } : fresh;
    winners[key] = stamped;
    return stamped;
  }

  // Branch 5: no existing entry, single candidate — trivial, ephemeral.
  const trivial: WinnerEntry = {
    winnerJobIdentifier: candidates[0].jobIdentifier,
    winnerCanonical: candidates[0].canonicalSlug,
    decidedAt: now,
    lastSeenAt: now,
    score: jaccardSimilarity(oldSlug, candidates[0].canonicalSlug),
    candidatesCount: 1,
  };
  return canton ? { ...trivial, canton } : trivial;
}

/**
 * Garbage-collect winner entries whose `(locale, oldSlug)` pair has not
 * been re-claimed in the last `ttlMs` milliseconds. Mutates `winners` in
 * place and returns the count of pruned entries so the caller can log it.
 *
 * Why TTL instead of immediate purge: a job feed that briefly drops a
 * listing (crawler hiccup, weekend off-shift, manual de-listing during
 * editorial review) shouldn't trigger an immediate URL flip. The
 * configured grace window — 30 days for production — is wide enough that
 * a temporarily-absent winner gets restored on its return WITHOUT URL
 * churn but tight enough that genuinely-removed slugs eventually exit
 * the file.
 *
 * Backward compat: entries written before `lastSeenAt` was added fall
 * back to `decidedAt`. Entries with both fields missing or unparseable
 * are kept (defensive — better to leak an unparseable row than purge a
 * working entry).
 */
export function pruneStaleWinners(
  winners: WinnersFile,
  ttlMs: number,
  now: string,
): number {
  const cutoff = Date.parse(now);
  if (!Number.isFinite(cutoff)) return 0;
  const cutoffMinusTtl = cutoff - ttlMs;
  let pruned = 0;
  for (const key of Object.keys(winners)) {
    const entry = winners[key];
    const stamp = entry.lastSeenAt || entry.decidedAt;
    const t = Date.parse(stamp);
    if (Number.isFinite(t) && t < cutoffMinusTtl) {
      delete winners[key];
      pruned += 1;
    }
  }
  return pruned;
}
