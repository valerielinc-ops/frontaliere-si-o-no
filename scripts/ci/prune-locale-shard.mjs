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
  for (const loc of PREFIX) {
    if (!ownedSet.has(loc)) rm(path.join(distDir, loc));
  }
} else {
  // Pure locale shard: keep ONLY the owned locale subtree(s).
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
