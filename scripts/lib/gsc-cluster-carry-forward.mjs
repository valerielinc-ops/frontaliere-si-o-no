/**
 * gsc-cluster-carry-forward.mjs — the GSC-cluster half of issue #5631's
 * carry-forward gap in `scripts/generate-keyword-pages-config.mjs`.
 *
 * The defect
 * ----------
 * `generate-keyword-pages-config.mjs` rebuilds `data/keyword-pages-config.json`
 * from scratch on every run. Its "Profession-gap feed" section (#3396)
 * carries forward previously-fed pages tagged `source: 'profession-gap'`
 * across regenerations — the doc comment on that block names exactly why:
 * "questo script ricostruisce la config da zero... senza carry-forward la
 * pagina flip-flopperebbe settimanalmente (URL churn)".
 *
 * The OTHER page family — plain GSC-cluster pages, generated straight from
 * `data/gsc-orphan-queries.json` clusters, with no `source` field — never
 * got the same protection. That loop keeps only the top 50 clusters by
 * clicks (`clusters.slice(0, 50)`); a cluster that ranked 51st this run is a
 * real, still-live, still-indexed page with no memory of ever having
 * existed, and it 301s on the next deploy for a reason that has nothing to
 * do with its own traffic. PR #5603 documented this explicitly in its "Non
 * implementato" section and left it unfixed ("PR concatenata: da aprire").
 * Measured 2026-08-13/14 against the live site (issue #5631): of the three
 * named examples, `ricerca-venditrice-lavoro-ticino/` had already 301'd,
 * and none of the three were back in `data/keyword-pages-config.json`.
 *
 * The fix, symmetric with the profession-gap block
 * --------------------------------------------------
 * A previously-generated page NOT tagged `source: 'profession-gap'` (the
 * profession-gap block carries those forward on its own terms — this
 * function must not double-carry them) survives regeneration UNLESS the
 * SAME coverage gate the fresh cluster loop already applies to a brand-new
 * query says this query is now covered (GENERIC_PATTERNS / COVERED_KEYWORDS,
 * evaluated against the carried page's own `query`). That is the one
 * legitimate reason to drop a carried page — an editorial or generic-listing
 * page took over, not a ranking fluctuation.
 */

/**
 * @param {Array<object>} prevPages           the previous config's `pages`
 *        array (read from the OUTPUT file before this run overwrites it).
 * @param {object} opts
 * @param {Set<string>} opts.usedSlugs         slugs already claimed by THIS
 *        run (fresh clusters + anything already carried) — mutated in place:
 *        every carried slug is added, so a caller iterating multiple carry
 *        sources never double-adds the same slug twice.
 * @param {RegExp[]} opts.genericPatterns      GENERIC_PATTERNS from the
 *        caller — same instances, so a future edit there cannot silently
 *        diverge the two checks.
 * @param {Set<string>} opts.coveredKeywords   COVERED_KEYWORDS from the
 *        caller.
 * @returns {Array<object>} pages to carry forward, in `prevPages` order.
 */
export function carryForwardGscClusterPages(prevPages, { usedSlugs, genericPatterns, coveredKeywords }) {
  const carried = [];
  for (const page of prevPages || []) {
    // Carried by the profession-gap block instead — do not double-carry.
    if (page?.source === 'profession-gap') continue;
    const slug = String(page?.slug || '').trim();
    if (!slug || usedSlugs.has(slug)) continue;
    const query = String(page?.query || '');
    if (genericPatterns.some((re) => re.test(query))) continue;
    const queryLower = query.toLowerCase();
    if ([...coveredKeywords].some((kw) => queryLower.includes(kw))) continue;
    carried.push(page);
    usedSlugs.add(slug);
  }
  return carried;
}
