/**
 * The four locale URLs of every retired article, kept AFTER the registry row
 * that named them is gone.
 *
 * WHY THIS FILE EXISTS (issue #7669)
 * ──────────────────────────────────
 * `tests/edge-retired-paths.test.ts` asserts that a retirement declared in one
 * locale is declared in all four — otherwise the append-only shard keeps
 * serving the EN/DE/FR pages 200 with `robots: index` and the withdrawal is
 * honoured in Italian only. That check needs to know which four URLs belong to
 * the same article, and until #7669 it read them from the LIVE registries
 * (`routerBlogData.ts` / `routerSwissData.ts`):
 *
 *     for (const [id, slugMap] of Object.entries(registry))
 *
 * A retirement whose rows `pull-articles-corpus.mjs` has already pruned is not
 * in that loop, so it is not checked. Measured on 2026-09-06, before this file
 * existed: **0** of the 81 declared retirements were still visited — every one
 * had been pruned, and the check had quietly become a test of nothing. It read
 * as green not because the invariant held but because the population was empty.
 *
 * So the population is pinned here instead, independently of what the
 * registries still carry. Two producers keep it honest:
 *
 *   1. `scripts/pull-articles-corpus.mjs` records a group at the moment it
 *      prunes the row — the last moment the four slugs exist together.
 *   2. `scripts/lib/corpus-removal-guard.mjs` refuses a removal whose bridge is
 *      locale-partial, so a group can never be recorded half-declared.
 *
 * Between them, a retirement enters this file complete or the sync does not
 * happen — which is what makes the check non-vacuous BY CONSTRUCTION rather
 * than by an ordering of commits nobody enforces.
 *
 * Pure functions and one path constant; the caller does the I/O, like every
 * other lib the corpus sync and the tests share.
 */

/** Repo-relative location of the pin. */
export const RETIRED_LOCALE_GROUPS_FILE = 'data/retired-article-locale-groups.json';

/**
 * Entries below which the pin is treated as a READ failure rather than as a
 * repo with no retirements. Same fail-closed idiom as
 * `MIN_PARSED_REGISTRY_ENTRIES` in corpus-removal-guard.mjs: an emptied or
 * malformed pin must redden the check, not silence it — being silenced is the
 * exact defect #7669 is about. The floor is the 2026-09-06 reconstruction
 * rounded down, so it survives a legitimate correction of one or two groups.
 */
export const MIN_PINNED_GROUPS = 20;

/** `<section>/<id>` — the key a group is filed under. */
export const groupKey = (section, id) => `${section}/${id}`;

/**
 * Parse the pin's JSON text into `Map<'<section>/<id>', string[]>`.
 * Throws on anything that is not the documented shape: a pin that parses to
 * garbage must not read as "no retirements".
 */
export function parseRetiredLocaleGroups(text) {
  const doc = JSON.parse(text);
  const groups = doc?.groups;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
    throw new Error(`${RETIRED_LOCALE_GROUPS_FILE}: expected an object under "groups"`);
  }
  const out = new Map();
  for (const [key, paths] of Object.entries(groups)) {
    if (!Array.isArray(paths) || paths.length !== 4 || paths.some((p) => typeof p !== 'string')) {
      throw new Error(`${RETIRED_LOCALE_GROUPS_FILE}: ${key} is not four locale paths`);
    }
    out.set(key, paths);
  }
  return out;
}

/**
 * Add the retirements of this sync to the pin.
 *
 * Only `fullyBridged` removals are recorded, and that is not a filter on the
 * data so much as a restatement of the guard: `evaluateCorpusRemoval` refuses
 * the whole sync when a ledgered removal is locale-partial, so a removal that
 * reaches here and is not fully bridged means the two disagree — which is worth
 * an exception rather than a half-written pin.
 *
 * Existing keys are never overwritten: the group recorded when the article was
 * pruned is the one that names the URLs the shard is still serving. A later
 * re-appearance under the same id (a republished article) has different slugs
 * and would erase exactly the evidence this file exists to keep.
 *
 * @param {Map<string, string[]>} pinned Current pin.
 * @param {Array<{section: string, id: string, paths: string[], ledgered: boolean, fullyBridged: boolean}>} removals
 * @returns {{groups: Map<string, string[]>, added: string[]}}
 */
export function withRemovalGroups(pinned, removals) {
  const groups = new Map(pinned);
  const added = [];
  for (const r of removals) {
    if (!r.ledgered) continue;
    if (!r.fullyBridged) {
      throw new Error(
        `refusing to pin ${groupKey(r.section, r.id)}: bridge is locale-partial `
        + `(${r.unbridgedLocalePaths?.join(' ') ?? '?'}) — the guard should have refused this sync`,
      );
    }
    const key = groupKey(r.section, r.id);
    if (groups.has(key)) continue;
    groups.set(key, [...r.paths]);
    added.push(key);
  }
  return { groups, added };
}

/**
 * Render the pin back to text: keys sorted, two-space indent, trailing newline
 * — a stable diff, so a sync that retires one article shows one added block.
 */
export function serializeRetiredLocaleGroups(groups, { note } = {}) {
  const doc = {
    note:
      note
      ?? 'The four locale URLs of every retired article, kept after the registry row that named '
      + 'them was pruned. Written by scripts/pull-articles-corpus.mjs, read by '
      + 'tests/edge-retired-paths.test.ts. See scripts/lib/retired-locale-groups.mjs (issue #7669).',
    groups: Object.fromEntries([...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
