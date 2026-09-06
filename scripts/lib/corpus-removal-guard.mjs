/**
 * corpus-removal-guard — decide whether a corpus sync is allowed to DELETE
 * articles from this repo's slug registries.
 *
 * WHY THIS EXISTS (measured, 2026-08-07)
 * ──────────────────────────────────────
 * `scripts/pull-articles-corpus.mjs` mirrors nanako's `content/` onto
 * `packages/articles/content/`, deleting anything the upstream tree lacks. Its
 * only guard is a FILE-COUNT floor (`srcN < dstN` → refuse), and a file count
 * cannot see an article leaving: commit `10c8c8178` removed two live articles
 * from `SWISS_SLUGS` and one from `BLOG_SLUGS` while ADDING three others, so
 * the deleted and added files cancelled out and the floor never fired.
 *
 * What it cost, that same morning:
 *   04:43Z  the site's own `generate-article.yml` writes
 *           `rimborsi-730-sostituti-imposta` into THIS repo. nanako, which owns
 *           the corpus since the cutover, never had it.
 *   07:10Z  the sync mirrors nanako over the site and deletes it — silently.
 *           The shard keeps serving the page 200 in all four locales, and
 *           `sitemap-news.xml` keeps announcing it (correctly: it is inside the
 *           48h Google News window). A sitemap now names a slug no registry
 *           knows, which is exactly what `tests/blog-slugs-sitemap-sync.test.ts`
 *           asserts against → `main` goes red and blocks seven PRs.
 *   08:32Z  a HUMAN restores the article upstream (nanako PR #20).
 *
 * That is the load-bearing fact: the deletion did not heal on its own. Nothing
 * in the automation puts back an article the corpus never had, because the
 * corpus is the source it syncs FROM. Recovery took a hand-written commit on
 * another repo, 82 minutes later, with `main` red in between.
 *
 * THE CRITERION
 * ─────────────
 * A removal is legitimate when a human decided it, and the site already records
 * that decision in one place: the `redirects` table in
 * `build-plugins/legacyRedirectsPlugin.ts`. Withdrawing an article means giving
 * its URL a redirect bridge there (PR #5299 retired four articles exactly this
 * way, 16 URLs across 4 locales) — otherwise the next shard deploy turns a live
 * page into a bare 404 with no signal for the crawler. So:
 *
 *   removal WITH a bridge entry  → deliberate retirement, allow.
 *   removal WITHOUT one          → nobody decided this, refuse and write nothing.
 *
 * The ledger cannot be forged by the sync itself: it lives in this repo, in a
 * build plugin the corpus never touches, and only a PR can add to it. That
 * asymmetry is what makes it a usable signal rather than a restatement of the
 * same data. There is deliberately NO retirement field on the corpus side —
 * `manifest.json`, `articles.json` and `slugs.json` carry none — so this is the
 * only place the distinction exists.
 *
 * SECOND GATE: manifest counts. `manifest.json` publishes `counts.articles` /
 * `counts.swissArticles` for the surface the API is ALREADY serving. A pulled
 * tree holding fewer articles than that is behind the published sitemaps — the
 * same "sitemap names a slug no registry knows" state, arrived at from the
 * other direction. Refusing there costs one skipped run; accepting it costs a
 * red `main`.
 *
 * Pure functions, no I/O: the caller reads the files and the manifest.
 */

import {
  ARTICLE_SECTION_KEYS,
  MANIFEST_COUNT_KEY,
  articlePathsFor,
  extractObjectLiteral,
} from './article-slug-registry.mjs';

/**
 * Source paths of `legacyRedirectsPlugin`'s `redirects` table — the site's
 * retirement ledger. Keys only; the target is the operator's editorial choice
 * and says nothing about whether the removal was intended.
 */
export function parseRedirectSources(src) {
  const block = extractObjectLiteral(src, 'redirects');
  const out = new Set();
  const rx = /["'](\/[^"']*)["']\s*:\s*["'][^"']*["']/g;
  let m;
  while ((m = rx.exec(block)) !== null) out.add(m[1]);
  return out;
}

/**
 * Entries below which a parsed registry is treated as a PARSE failure rather
 * than a real corpus. Without this the guard fails OPEN: change the generator's
 * emit shape, the regex matches nothing, both sides read as empty, no id is
 * "missing from incoming", and every deletion sails through unnoticed. Both
 * registries have been four figures (blog) and three (swiss) since long before
 * the cutover, so 100 is far under any plausible truth and far over zero.
 *
 * It is a BACKSTOP, not the real check: at 100 against a 3789-row registry an
 * emit change that broke the parse on 97% of the rows still reads as a corpus.
 * The real check is the row count (`args.rowCounts`), which is the same file's
 * own answer to "how many rows should have parsed" and scales with the corpus.
 * The constant only covers callers that cannot supply one.
 */
export const MIN_PARSED_REGISTRY_ENTRIES = 100;

/**
 * @param {object} args
 * @param {Record<string, Record<string, Record<string,string>>>} args.local
 *   Registries as they stand in this checkout, keyed by section.
 * @param {Record<string, Record<string, Record<string,string>>>} args.incoming
 *   Registries in the tree about to be mirrored in.
 * @param {Set<string>} args.retiredPaths  Redirect-table source paths.
 * @param {{articles?: number, swissArticles?: number} | null} [args.manifestCounts]
 *   `counts` from the published manifest, or null when it could not be read.
 * @param {{local?: Record<string, number>, incoming?: Record<string, number>} | null} [args.rowCounts]
 *   `'<id>': {` rows each side's registry FILE carries, per section — the size
 *   the parse had to reach. Omitted → only the absolute floor applies.
 */
export function evaluateCorpusRemoval({
  local,
  incoming,
  retiredPaths,
  manifestCounts = null,
  rowCounts = null,
}) {
  const removals = [];
  const additions = {};

  const parseFailures = [];
  for (const section of ARTICLE_SECTION_KEYS) {
    for (const [side, tree] of [['local', local], ['incoming', incoming]]) {
      const size = Object.keys(tree?.[section] ?? {}).length;
      // Two ways a registry is not a corpus: too small to be one at all, or
      // smaller than the rows its own file carries — an incomplete parse, which
      // is the failure a flat floor cannot see.
      const rows = rowCounts?.[side]?.[section] ?? null;
      if (size < MIN_PARSED_REGISTRY_ENTRIES || (rows !== null && size < rows)) {
        parseFailures.push({ section, side, size, rows });
      }
    }
  }

  for (const section of ARTICLE_SECTION_KEYS) {
    const before = local?.[section] ?? {};
    const after = incoming?.[section] ?? {};
    additions[section] = Object.keys(after).filter((id) => !(id in before)).length;

    for (const [id, slugMap] of Object.entries(before)) {
      if (id in after) continue;
      const paths = articlePathsFor(section, slugMap);
      // The canonical <loc> is the IT path; a bridge on it is the minimum proof
      // that a human withdrew this article. The other three are reported when
      // they are missing so the bridge can be completed, but they do not gate:
      // several pre-existing retirements in the ledger only ever mapped IT.
      const canonical = paths[0] ?? null;
      const ledgered = canonical !== null && retiredPaths.has(canonical);
      removals.push({
        section,
        id,
        paths,
        canonical,
        ledgered,
        unbridgedLocalePaths: paths.filter((p) => !retiredPaths.has(p)),
      });
    }
  }

  const unledgered = removals.filter((r) => !r.ledgered);

  const shortfalls = [];
  if (manifestCounts) {
    for (const section of ARTICLE_SECTION_KEYS) {
      const published = manifestCounts[MANIFEST_COUNT_KEY[section]];
      if (typeof published !== 'number') continue;
      const size = Object.keys(incoming?.[section] ?? {}).length;
      if (size < published) shortfalls.push({ section, incoming: size, published });
    }
  }

  return {
    ok: parseFailures.length === 0 && unledgered.length === 0 && shortfalls.length === 0,
    removals,
    unledgered,
    shortfalls,
    parseFailures,
    additions,
    manifestChecked: manifestCounts !== null,
  };
}
