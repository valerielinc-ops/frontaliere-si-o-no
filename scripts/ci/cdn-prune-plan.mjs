// Pure CDN-janitor prune planner — no I/O, no shebang, no side effects.
// Imported by prune-cdn-assets.mjs (CLI) and tests/prune-cdn-assets.test.ts.

/**
 * Pure planner (no I/O) — testable core of the janitor. Updates the age
 * registry in place and decides which CDN JS/CSS files to prune.
 *
 * Registry schema: `{ [file]: { f: firstSeen, a: lastActive } }`. `lastActive`
 * is the last run a file was in the ACTIVE set (present in the just-built
 * dist/assets, or referenced by the live homepage). A file is an orphan once it
 * has been ABSENT from the active set for the whole grace window — the single
 * robust prune signal in the stable-name world (#1933): the build emits FIXED
 * names, so "absent from dist/assets" reliably means "no longer referenced",
 * and the 600 s HTML max-age (public/_headers) guarantees no live page has
 * pointed at it for >10 min after it left the build.
 *
 * This replaces the old chunk-name "superseded sibling" heuristic, which could
 * not GC the post-cutover legacy hashed chunks: locale-qualified stable names
 * (`slug.it.js`) live in a DIFFERENT chunk-name group than the legacy
 * `slug-<hash>.js` / `slug2-<hash>.js`, so those hashed files never gained a
 * strictly-newer sibling and lingered forever (16 k files / 1.7 GB, breaching
 * the ~1 GB GitHub Pages soft limit).
 *
 * @param {object} o
 * @param {string[]} o.allAssets  - JS/CSS filenames currently in CDN assets/
 * @param {Record<string, any>} o.registry - age registry (mutated in place)
 * @param {(f: string) => boolean} o.isActive - true if f is in the active set
 * @param {boolean} o.canPrune - false when dist/assets absent → FAIL-CLOSED, no prune
 * @param {string} o.now - ISO timestamp for this run
 * @param {number} o.graceCutoffMs - epoch ms; lastActive older than this is prunable
 * @param {number} o.maxPrune - cap on files pruned this run
 */
export function planJanitor({ allAssets, registry, isActive, canPrune, now, graceCutoffMs, maxPrune }) {
  const norm = (v) => {
    if (typeof v === 'string') return { f: v, a: v }; // legacy firstSeen-only → best-effort lastActive
    if (v && typeof v === 'object' && v.f) return { f: v.f, a: v.a || v.f };
    return null;
  };

  // Register new files + refresh lastActive for files in the active set.
  let newCount = 0, refreshed = 0;
  for (const f of allAssets) {
    const cur = norm(registry[f]);
    if (!cur) { registry[f] = { f: now, a: now }; newCount++; continue; }
    registry[f] = cur;
    if (canPrune && isActive(f) && cur.a !== now) { cur.a = now; refreshed++; }
  }
  // Drop registry entries for files no longer on the CDN (keeps it bounded).
  const present = new Set(allAssets);
  let registryPruned = 0;
  for (const k of Object.keys(registry)) {
    if (!present.has(k)) { delete registry[k]; registryPruned++; }
  }

  // Prune candidate = absent from the active set AND inactive for the whole
  // grace window. Oldest-inactive first, capped to bound blast radius and drain
  // the one-time post-cutover backlog over several deploys.
  let toPrune = [], eligible = 0;
  if (canPrune) {
    const cand = [];
    for (const f of allAssets) {
      if (isActive(f)) continue;
      const a = registry[f].a;
      if (new Date(a).getTime() > graceCutoffMs) continue; // inactive but within grace
      cand.push({ file: f, a });
    }
    cand.sort((x, y) => x.a.localeCompare(y.a)); // oldest-inactive first
    eligible = cand.length;
    toPrune = cand.slice(0, maxPrune).map(x => x.file);
  }

  return { registry, toPrune, eligible, newCount, refreshed, registryPruned };
}
