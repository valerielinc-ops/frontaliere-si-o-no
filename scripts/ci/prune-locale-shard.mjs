#!/usr/bin/env node
/**
 * Post-build shard prune for per-locale matrix builds (BUILD_LOCALE=<loc>).
 *
 * This is the UNIVERSAL, filesystem-level enforcement of per-locale ownership.
 * The in-build `BUILD_LOCALE` filter (build-plugins/shared/localeEmitFilter.ts)
 * only gates the `WriteCollector` chokepoint — the bulk of pages (job, hub,
 * landing, cluster). ~15 plugins emit small redirect/bridge/weather/alias
 * pages via direct `fs.writeFileSync`, bypassing the collector, so they still
 * write every locale. This step removes the non-owned locale output AFTER the
 * build, exactly the way production's `push_shard` copies only `dist/<locale>`
 * and the "Strip locale shards" step removes en/de/fr from the main artifact.
 *
 * Ownership (path prefix): IT lives at the root (no prefix); en/de/fr live
 * under their `/en` `/de` `/fr` subtrees.
 *   - Shard set INCLUDES `it`  → main shard: keep the root + shared files,
 *     drop only the non-owned locale subtrees (mirrors the deploy.yml strip).
 *   - Shard set EXCLUDES `it`  → pure locale shard: keep ONLY the owned
 *     locale subtree(s) (mirrors `push_shard` copying just `dist/<locale>`).
 *
 * Usage: BUILD_LOCALE=en node scripts/ci/prune-locale-shard.mjs [distDir]
 * No-op when BUILD_LOCALE is unset/empty (the default all-locale build).
 */
import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.argv[2] || 'dist');
const ALL = ['it', 'en', 'de', 'fr'];
const PREFIX = ['en', 'de', 'fr'];
const raw = (process.env.BUILD_LOCALE || '').trim().toLowerCase();
const owned = raw
  ? raw.split(',').map((s) => s.trim()).filter((l) => ALL.includes(l))
  : ALL.slice();

if (!raw || owned.length === 0 || owned.length === ALL.length) {
  console.log(`[prune-locale-shard] BUILD_LOCALE=${JSON.stringify(raw)} → all locales, nothing to prune`);
  process.exit(0);
}

if (!fs.existsSync(distDir)) {
  console.error(`[prune-locale-shard] dist dir not found: ${distDir}`);
  process.exit(1);
}

const ownedSet = new Set(owned);
const removed = [];

function rm(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(path.relative(distDir, target) || target);
}

if (ownedSet.has('it')) {
  // Main shard: keep root + shared, drop non-owned locale subtrees.
  //
  // `<loc>.html` goes WITH `<loc>`, never without it (issue #5327 class, run
  // 31240103446). infra/cloudflare-worker/locale-router.js's LOCALE_RE matches
  // `/en`, `/en/*` AND `/en.html`, so all three are routed to the locale shard
  // and none of them is servable from the main artifact — a `dist/en.html` left
  // behind here is unreachable dead weight. It is not hypothetical: the flat
  // twin used to survive this prune because localeOfDistPath() classifies
  // `en.html` as `it` (it matches neither `rel === 'en'` nor `'en/'`), so the
  // it build wrote it while dropping its `dist/en/index.html` sibling — which
  // is also what stopped postWalkCoordinatorPlugin from rewriting it into a
  // noindex bridge, leaving indexable duplicate homepage content in the trunk.
  // scripts/lib/rehydrate-locale-shards.sh then snapshotted `$loc` and
  // `$loc.html` as ONE unit (`trunk_replace_begin "locale-$loc" "$loc"
  // "$loc.html"`), found the shard could not put the flat file back, and failed
  // every validate-dist job — blocking the publish and the 7 other workflows
  // that rehydrate locale shards. The emitter is fixed at the source
  // (staticPagesPlugin.ts skips the flat twin for bare locale roots); this
  // removal is the filesystem-level backstop, in the same spirit as the rest of
  // this script — the ~15 direct-fs.writeFileSync emitters that bypass the
  // WriteCollector are exactly why it exists.
  for (const loc of PREFIX) {
    if (!ownedSet.has(loc)) {
      rm(path.join(distDir, loc));
      rm(path.join(distDir, `${loc}.html`));
    }
  }
} else {
  // Pure locale shard: keep ONLY the owned locale subtree(s).
  //
  // `<loc>.html` is deliberately NOT in `keep`: it is a top-level FILE, not the
  // owned subtree, so it is removed here like any other non-owned entry. That
  // is the intended end state, not an oversight — `/en/` is the canonical
  // locale homepage, `/en` 301s to it from GitHub Pages on the directory alone,
  // and nothing in the tree links to `/en.html`. push-locale-shard.sh's
  // `[ -f "$dist_dir/$loc.html" ]` copy and deploy.yml's tar member are both
  // conditional, so they simply no-op instead of failing.
  const keep = new Set(owned); // en/de/fr only here
  for (const entry of fs.readdirSync(distDir)) {
    if (keep.has(entry)) continue;
    rm(path.join(distDir, entry));
  }
}

console.log(
  `[prune-locale-shard] shard=[${owned.join(',')}] → pruned ${removed.length} top-level entr${removed.length === 1 ? 'y' : 'ies'}` +
  (removed.length ? `: ${removed.slice(0, 12).join(', ')}${removed.length > 12 ? ' …' : ''}` : ''),
);

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\n**Shard prune** \`[${owned.join(',')}]\`: removed ${removed.length} top-level entries from \`dist/\`.\n`,
  );
}
