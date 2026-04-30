/**
 * Lifecycle wrapper for `sharedWriteRegistry`.
 *
 * Resets the registry at `buildStart` so watch-mode rebuilds don't carry
 * stale claims from the previous build, then prints a collision summary at
 * `closeBundle` (post phase) and persists `dist/.write-collisions.json` for
 * inspection.
 *
 * Two registration spots in `vite.config.ts`:
 *   - One instance with `enforce: 'pre'` to run reset before any plugin's
 *     `closeBundle` writes. (Vite invokes `buildStart` on every plugin in
 *     parallel, so this hook fires alongside everything else — that's fine
 *     because no `claim()` calls happen during `buildStart`.)
 *   - The same plugin handles the `closeBundle` summary as the LAST plugin
 *     to run (`enforce: 'post'` + `order: 'post'` + `sequential: true`).
 *
 * Mode handling:
 *   - `WRITE_COLLISION_MODE=throw` makes `claim()` raise immediately on the
 *     first collision. The collision is captured in `getCollisions()` for
 *     completeness even when throwing, but the build aborts before the
 *     summary runs. That's intentional: throw mode is for CI gates after
 *     the codebase is clean.
 *   - `WRITE_COLLISION_MODE=report` (default) collects every collision and
 *     prints a summary at end-of-build. The build succeeds; the report tells
 *     you what to fix. Used during the migration phase to discover every
 *     existing collision in one pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

import {
 reset,
 getCollisions,
 getPathHistory,
 configureDumpDir,
 getDumpDir,
 pruneDumpToCollidingHashes,
 type CollisionRecord,
 type ClaimVersion,
} from './sharedWriteRegistry';

interface LifecycleOptions {
 readonly rootDir: string;
}

const RESET = 'write-registry-reset';
const REPORT = 'write-registry-report';

/**
 * Resolve the per-build content dump directory. Enabled when
 * `WRITE_COLLISION_DUMP=1`, in which case every unique-by-hash content seen
 * during the build is written to `dist/.write-collisions-data/<hash>.html`.
 * After the build, the report plugin prunes this dir to keep only hashes
 * referenced by colliding paths (typically <50 MB out of GBs of writes).
 *
 * Disabled by default so local builds don't create extra files. CI sets
 * `WRITE_COLLISION_DUMP=1` on the Build step.
 */
function resolveDumpDir(rootDir: string): string | null {
 const flag = (process.env.WRITE_COLLISION_DUMP || '').toLowerCase();
 if (flag !== '1' && flag !== 'true' && flag !== 'yes') return null;
 return path.resolve(rootDir, 'dist', '.write-collisions-data');
}

export function writeRegistryResetPlugin(opts: LifecycleOptions): Plugin {
 return {
 name: RESET,
 apply: 'build',
 enforce: 'pre',
 buildStart() {
 reset();
 configureDumpDir(resolveDumpDir(opts.rootDir));
 },
 };
}

export function writeRegistryReportPlugin(opts: LifecycleOptions): Plugin {
 return {
 name: REPORT,
 apply: 'build',
 enforce: 'post',
 closeBundle: {
 order: 'post',
 sequential: true,
 handler: async () => {
 const distDir = path.resolve(opts.rootDir, 'dist');
 const records = getCollisions();
 const mode = (process.env.WRITE_COLLISION_MODE || 'report').toLowerCase();

 if (records.length === 0) {
 // eslint-disable-next-line no-console
 console.log('\x1b[36m[write-registry]\x1b[0m no collisions detected — every dist/ path has a single canonical writer.');
 return;
 }

 const summary = summarise(records);
 // eslint-disable-next-line no-console
 console.log(formatConsoleSummary(records, summary, mode));

 // Enriched JSON: includes the FULL version history for every colliding
 // path (not just adjacent-pair `records`), so the analysis script can
 // compare ALL versions ever proposed for each path. The legacy `records`
 // field is kept for backward compatibility with the in-flight summary
 // consumers (none yet — but cheap to keep).
 const collidingPaths = collectCollidingPaths();
 if (fs.existsSync(distDir)) {
 const reportPath = path.join(distDir, '.write-collisions.json');
 fs.writeFileSync(
 reportPath,
 JSON.stringify({ mode, records, summary, paths: collidingPaths }, null, 2),
 'utf-8',
 );
 // eslint-disable-next-line no-console
 console.log(`\x1b[36m[write-registry]\x1b[0m full report → ${reportPath}`);
 }

 // If the per-claim content dump was enabled, prune it to keep only the
 // content of hashes referenced by colliding paths. This converts a
 // "dump every unique content seen during the build" (potentially GBs)
 // into a "dump every content that competed for a colliding path"
 // (typically <50 MB), which is what the analysis script needs.
 const dumpDir = getDumpDir();
 if (dumpDir) {
 const { kept, removed } = pruneDumpToCollidingHashes();
 // eslint-disable-next-line no-console
 console.log(
 `\x1b[36m[write-registry]\x1b[0m content dump pruned: kept ${kept} (referenced by colliding paths), removed ${removed} (non-colliding) at ${dumpDir}`,
 );
 }
 },
 },
 };
}

/**
 * Build the `paths: [...]` block of the JSON report. Only paths whose
 * version count is ≥ 2 (i.e. that had at least one collision) are included.
 * Each path lists the ordered sequence of versions seen, which the analysis
 * script joins with the corresponding `<hash>.html` files in the dump dir.
 */
function collectCollidingPaths(): Array<{
 path: string;
 versions: ClaimVersion[];
}> {
 const out: Array<{ path: string; versions: ClaimVersion[] }> = [];
 for (const [p, versions] of getPathHistory()) {
 if (versions.length >= 2) {
 out.push({ path: p, versions: versions.slice() });
 }
 }
 // Sort by collision count descending so the heaviest paths are first
 // — useful when eyeballing the JSON.
 out.sort((a, b) => b.versions.length - a.versions.length);
 return out;
}

interface CollisionSummary {
 totalCollisions: number;
 uniquePaths: number;
 byPluginPair: Array<{ pair: string; count: number }>;
}

function summarise(records: readonly CollisionRecord[]): CollisionSummary {
 const uniquePaths = new Set<string>();
 const pairCounts = new Map<string, number>();
 for (const r of records) {
 uniquePaths.add(r.path);
 const pair = [r.first.plugin, r.attempted.plugin].sort().join(' ↔ ');
 pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
 }
 const byPluginPair = Array.from(pairCounts.entries())
 .map(([pair, count]) => ({ pair, count }))
 .sort((a, b) => b.count - a.count);
 return {
 totalCollisions: records.length,
 uniquePaths: uniquePaths.size,
 byPluginPair,
 };
}

function formatConsoleSummary(
 records: readonly CollisionRecord[],
 summary: CollisionSummary,
 mode: string,
): string {
 const lines: string[] = [];
 lines.push('');
 lines.push('\x1b[33m━━━ write-registry collision report ━━━\x1b[0m');
 lines.push(`mode: \x1b[1m${mode}\x1b[0m`);
 lines.push(
 `${summary.totalCollisions} collision(s) across ${summary.uniquePaths} unique path(s):`,
 );
 for (const { pair, count } of summary.byPluginPair) {
 lines.push(` ${count.toString().padStart(4)} × ${pair}`);
 }
 lines.push('');
 lines.push('first 5 colliding paths:');
 for (const r of records.slice(0, 5)) {
 lines.push(` • ${r.path}`);
 lines.push(
 ` ${r.first.plugin} (${truncate(r.first.callSite, 80)})`,
 );
 lines.push(
 ` vs ${r.attempted.plugin} (${truncate(r.attempted.callSite, 80)})`,
 );
 }
 if (records.length > 5) {
 lines.push(` … and ${records.length - 5} more (see dist/.write-collisions.json)`);
 }
 lines.push('');
 if (mode !== 'throw') {
 lines.push(
 '\x1b[33mhint:\x1b[0m re-run with WRITE_COLLISION_MODE=throw locally to fail on the first collision once you start fixing them.',
 );
 }
 lines.push('\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
 return lines.join('\n');
}

function truncate(s: string, max: number): string {
 if (s.length <= max) return s;
 return s.slice(0, max - 1) + '…';
}
