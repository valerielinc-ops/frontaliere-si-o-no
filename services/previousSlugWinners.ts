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
 */
export interface WinnerEntry {
  readonly winnerJobIdentifier: string;
  readonly winnerCanonical: string;
  readonly decidedAt: string;
  readonly score: number;
  readonly candidatesCount: number;
}

/** A candidate for ownership of a previous-slug bridge. */
export interface CandidateInput {
  readonly jobIdentifier: string;
  readonly canonicalSlug: string;
}

/** The full on-disk format. Keys are `${locale}::${oldSlug}` (see {@link makeKey}). */
export type WinnersFile = Record<string, WinnerEntry>;

/**
 * Compose the storage key for a (locale, oldSlug) pair. Locale is included
 * because previousSlugs ARE locale-specific in `previousSlugsByLocale`, and
 * the same string can legitimately exist as a prevSlug for different jobs in
 * different locales. Using the same key for both would conflate them.
 */
export function makeKey(locale: string, oldSlug: string): string {
  return `${locale}::${oldSlug}`;
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
 * Decision tree:
 *   1. Single candidate → trivial winner; no entry update needed.
 *      Returns the candidate's identifier verbatim.
 *   2. Multiple candidates AND a prior entry exists AND the prior winner is
 *      still in the candidates list → reuse the prior decision (URL stable).
 *   3. Otherwise (no prior entry, or prior winner no longer active) →
 *      run the heuristic, mutate `winners` with the new entry, return the
 *      new winner.
 *
 * Returns the winner entry (whether new or reused), or `null` if candidates
 * is empty. The caller should compare the entry's `winnerJobIdentifier`
 * against the iterating job's identifier and skip emit when they differ.
 *
 * Mutation note: `winners` is mutated in place when a new decision is made.
 * Callers should detect changes (e.g. by computing `Object.keys(winners).
 * length` before/after, or by tracking writes via an out parameter — this
 * helper takes the simpler "mutate and let the caller diff" approach).
 */
export function resolveWinner(
  winners: WinnersFile,
  locale: string,
  oldSlug: string,
  candidates: readonly CandidateInput[],
  now: string,
): WinnerEntry | null {
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    // Trivial: one claimant, no decision to record.
    return {
      winnerJobIdentifier: candidates[0].jobIdentifier,
      winnerCanonical: candidates[0].canonicalSlug,
      decidedAt: now,
      score: jaccardSimilarity(oldSlug, candidates[0].canonicalSlug),
      candidatesCount: 1,
    };
  }

  const key = makeKey(locale, oldSlug);
  const existing = winners[key];
  if (
    existing &&
    candidates.some((c) => c.jobIdentifier === existing.winnerJobIdentifier)
  ) {
    // Prior decision still valid — keep URL stable.
    return existing;
  }

  // Re-elect.
  const fresh = chooseWinner(oldSlug, candidates, now);
  if (fresh) winners[key] = fresh;
  return fresh;
}
