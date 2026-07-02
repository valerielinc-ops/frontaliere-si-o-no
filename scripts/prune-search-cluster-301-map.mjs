#!/usr/bin/env node
/**
 * Prune stale entries from data/search-cluster-301-map.json.
 *
 * Issue #2918 item 3: the map is a point-in-time snapshot of which legacy
 * cluster URLs resolve to which LIVE national cluster page. As national
 * clusters churn (a role/city combination stops being live), a "specific"
 * entry that pointed at a real cluster page can go stale — the redirect
 * target itself starts 404ing, turning a working 301 into a dead-end
 * 301→404. City-page and canton/national-board targets are structural nav
 * pages (always live) and are left untouched; only "specific" cluster-page
 * targets (the ones sourced from the sitemap-search-clusters-*.xml shards
 * in build-search-cluster-301-map.mjs) are checked against the CURRENT live
 * set and dropped if they no longer resolve.
 *
 * Analogous to scripts/prune-404-compat-paths.ts (same "verify against a
 * live source of truth, drop what no longer resolves, never leave a stale
 * target un-flagged" pattern), applied to this map's own generated store
 * instead of the seo-404-compat store.
 *
 * NOTE (issue #2918 item 3, second half — periodic regeneration): this
 * script implements the PRUNE PASS only. Wiring this (and a periodic re-run
 * of build-search-cluster-301-map.mjs itself) into a scheduled GitHub
 * Actions workflow (cron) is a follow-up, out of reach for a code-only
 * worktree agent to provision/validate live — see the PR/commit message.
 * Run manually for now, in this order:
 *   node scripts/build-search-cluster-301-map.mjs   # regenerate from current live sitemaps
 *   node scripts/prune-search-cluster-301-map.mjs   # drop now-stale "specific" entries
 *
 * Usage:
 *   node scripts/prune-search-cluster-301-map.mjs                    # fetch live sitemaps
 *   node scripts/prune-search-cluster-301-map.mjs --live-file <path> # offline
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUT,
  LOCALES,
  LOCALE_CONFIG,
  sectionRoot,
  fetchLiveClusterSet,
  loadLiveFromFile,
} from './build-search-cluster-301-map.mjs';
import { AGGREGATE_KEY } from '../build-plugins/shared/cantonResolvers.mjs';

const __filename = fileURLToPath(import.meta.url);

// A "specific" target is the national cluster hub page for a role+city body
// (e.g. it: /cerca-lavoro-svizzera/ricerca-<body>/) — the only target type
// sourced directly from the live cluster sitemap shards, and therefore the
// only type that can go stale as those shards churn. Reuses the same
// sectionRoot/LOCALE_CONFIG.searchPrefix building blocks as the generator
// so the "what counts as a specific target" definition can't drift between
// the two scripts (rule #6: single source of truth, no hand-rolled mirror).
export function isSpecificClusterTarget(target) {
  for (const locale of LOCALES) {
    const root = sectionRoot(locale, AGGREGATE_KEY);
    const prefix = LOCALE_CONFIG[locale].searchPrefix;
    if (target.startsWith(`${root}/${prefix}-`)) return true;
  }
  return false;
}

// Locale of a legacy (old, dead) URL — used only to recompute the byLocale
// breakdown after a prune, not to decide what gets pruned.
export function detectLocale(oldUrl) {
  for (const locale of LOCALES) {
    if (LOCALE_CONFIG[locale].legacyBodyRx.test(oldUrl)) return locale;
  }
  return null;
}

/**
 * Pure function: given the parsed map file contents and the current live
 * cluster-page set, returns the pruned map plus bookkeeping. No I/O — kept
 * separate from main() so it's directly unit-testable.
 */
export function pruneStaleEntries(mapData, liveSet) {
  const map = mapData && typeof mapData.map === 'object' && mapData.map !== null ? mapData.map : {};
  const kept = {};
  const dropped = [];
  for (const [oldUrl, target] of Object.entries(map)) {
    if (isSpecificClusterTarget(target) && !liveSet.has(target)) {
      dropped.push([oldUrl, target]);
      continue;
    }
    kept[oldUrl] = target;
  }

  const byLocale = { it: 0, en: 0, de: 0, fr: 0 };
  for (const oldUrl of Object.keys(kept)) {
    const locale = detectLocale(oldUrl);
    if (locale) byLocale[locale]++;
  }

  const prevCounts = mapData && mapData.counts ? mapData.counts : {};
  const counts = {
    ...prevCounts,
    total: Object.keys(kept).length,
    // Every dropped entry is a "specific" target by construction (only
    // isSpecificClusterTarget() results are ever dropped above).
    specific: Math.max(0, (prevCounts.specific ?? 0) - dropped.length),
    byLocale,
  };

  return { kept, dropped, counts };
}

async function main() {
  const args = process.argv.slice(2);
  const liveFileIdx = args.indexOf('--live-file');
  const live = liveFileIdx >= 0 ? loadLiveFromFile(args[liveFileIdx + 1]) : await fetchLiveClusterSet();
  if (live.size === 0) {
    console.error(
      '[prune-search-cluster-301-map] no live cluster URLs loaded — refusing to prune blind ' +
        '(would treat every "specific" entry as stale and drop the whole recovery set). Aborting.',
    );
    process.exit(2);
    return;
  }

  const raw = JSON.parse(readFileSync(OUT, 'utf8'));
  if (!raw || typeof raw !== 'object' || typeof raw.map !== 'object' || raw.map === null) {
    console.error(
      `[prune-search-cluster-301-map] unexpected shape in ${OUT} — expected an object with a ` +
        '"map" object. Aborting rather than guessing.',
    );
    process.exitCode = 1;
    return;
  }

  const before = Object.keys(raw.map).length;
  const { kept, dropped, counts } = pruneStaleEntries(raw, live);

  if (dropped.length === 0) {
    console.log(
      `[prune-search-cluster-301-map] ${before} entries, all "specific" targets still live — no change.`,
    );
    return;
  }

  writeFileSync(OUT, `${JSON.stringify({ ...raw, counts, map: kept }, null, 2)}\n`);
  console.log(
    `[prune-search-cluster-301-map] pruned ${dropped.length} stale entr${dropped.length === 1 ? 'y' : 'ies'} ` +
      `(redirect target no longer live) — ${before} → ${Object.keys(kept).length}. ` +
      `Sample: ${dropped
        .slice(0, 5)
        .map(([u, t]) => `${u} → ${t}`)
        .join(', ') || '(none)'}`,
  );
}

// Run only when executed directly, not when imported by tests.
const isMainModule = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isMainModule) {
  main().catch((err) => {
    console.error('[prune-search-cluster-301-map] unexpected error:', err);
    process.exitCode = 1;
  });
}
