/**
 * Batch file writer for build plugins.
 * Collects file writes in memory and flushes them in parallel batches,
 * dramatically faster than sequential writeFileSync for 1000+ files.
 *
 * Supports optional content-hash manifest: when enabled, files whose
 * content hasn't changed since the last build are skipped entirely.
 *
 * Streaming behavior (added 2026-04 to fix OOM at 11.6 GB / 12 GB heap):
 * - add() returns synchronously; auto-flush kicks off in the background
 *   when pending writes cross the threshold (default 5000 entries).
 * - With ~30 KB content average, peak in-memory pending writes are
 *   bounded at ~150 MB regardless of total page volume (was 6.6 GB
 *   for 220k pages × 30 KB before this change).
 * - flush() awaits all outstanding background flushes plus drains
 *   any remaining writes.
 * - Errors raised during a background flush are stored on the
 *   collector and re-thrown by the next flush() call (never silently
 *   swallowed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getManifest } from './contentHash';
import { claim, type ClaimOutcome } from './sharedWriteRegistry';

export interface PendingWrite {
 filePath: string;
 content: string;
}

/** Ensures parent directories exist (sync, cached) */
const ensuredDirs = new Set<string>();
function ensureDir(dir: string) {
 if (ensuredDirs.has(dir)) return;
 fs.mkdirSync(dir, { recursive: true });
 ensuredDirs.add(dir);
}

/**
 * Flush an array of pending writes in parallel batches.
 * @param writes - Array of { filePath, content } objects
 * @param concurrency - Number of files written in parallel per batch.
 *
 * Default 500: tuned for ubuntu-latest CI runners (SSD-backed, ulimit -n
 * default 65535). Local benchmark on ~175K files saw ~30 % flush-time
 * reduction going 200→500 without measurable contention. Stay below
 * ~1024 to remain compatible with conservative ulimits (e.g. macOS
 * launchd default 256/1024).
 */
export async function flushWrites(writes: PendingWrite[], concurrency = 500): Promise<number> {
 // Pre-create all unique directories first (sync, very fast)
 const dirs = new Set<string>();
 for (const w of writes) dirs.add(path.dirname(w.filePath));
 for (const d of dirs) ensureDir(d);

 // Write files in parallel batches
 let written = 0;
 for (let i = 0; i < writes.length; i += concurrency) {
 const batch = writes.slice(i, i + concurrency);
 await Promise.all(
 batch.map(w =>
 fs.promises.writeFile(w.filePath, w.content, 'utf-8')
 )
 );
 written += batch.length;
 }
 return written;
}

/** Default threshold above which add() kicks off a background flush. */
const DEFAULT_AUTO_FLUSH_THRESHOLD = 5000;

export interface WriteCollectorOptions {
 /** When true, add() skips files that already exist on disk. */
 skipExisting?: boolean;
 /** Used by the content-hash manifest to compute relative paths. */
 distDir?: string;
 /** Per-batch parallelism for {@link flushWrites}. Default 500. */
 concurrency?: number;
 /**
  * Pending-write count above which add() spawns a background flush.
  * Default 5000 → ~150 MB peak with 30 KB average content.
  * Set to Infinity to opt out of streaming (legacy buffer-everything mode).
  */
 autoFlushThreshold?: number;
 /**
  * Plugin name used for cross-plugin write collision detection via the
  * shared write registry. Defaults to `'unknown'` for backward compatibility,
  * but every caller SHOULD pass its own plugin name so collision messages
  * can name both writers. See `sharedWriteRegistry.ts` for the invariant.
  */
 pluginName?: string;
}

/**
 * Collector class for building up writes and flushing at once.
 * Plugins can push writes as they generate HTML, then flush at the end.
 *
 * When a ContentHashManifest is active (initialized via initManifest()),
 * files whose content hash matches the previous build are automatically skipped.
 *
 * Streaming behavior:
 * - add() returns synchronously; auto-flush kicks off when pending crosses 5000
 * - peak in-memory pending writes ≤ 5000 entries × ~30 KB = ~150 MB
 * - flush() awaits all outstanding background flushes
 * - errors during background flush are stored and re-thrown by flush()
 */
export class WriteCollector {
 // Map<filePath → PendingWrite>. Last add() per filePath wins, eliminating
 // intra-plugin write races deterministically (Phase 4 case 4): when two
 // emit categories within the same plugin target the same path (e.g.
 // jobsSeoPagesPlugin's legacy-redirect emits a stub at line 2293, then a
 // richer cross-locale-active-bridge emits at the same path at line 7420),
 // the array-based collector flushed both via Promise.all and the OS
 // resolved the race non-deterministically. With Map dedup, only ONE
 // write reaches the disk per path: the LAST `add()` call. The plugin's
 // emit code order then determines the winner — and in jobsSeoPagesPlugin
 // the order is intentional (canonical first, then bridges by content
 // richness, with stub-style emits late) so the rich bridge wins.
 //
 // For cross-plugin races (different plugins, different collectors,
 // same path), the existing sharedWriteRegistry + declareSharedPath
 // covers the case. Map dedup here is purely intra-plugin.
 private writes: Map<string, PendingWrite> = new Map();
 private skipExisting: boolean;
 private _skippedByHash = 0;
 private _skippedByCollision = 0;
 private _overwrittenInPlugin = 0;
 private _distDir: string;
 private _pluginName: string;
 private _pendingFlushes: Promise<number>[] = [];
 private _firstError: Error | null = null;
 private readonly _concurrency: number;
 private readonly _autoFlushThreshold: number;

 constructor(opts?: WriteCollectorOptions) {
 this.skipExisting = opts?.skipExisting ?? false;
 this._distDir = opts?.distDir ?? '';
 this._concurrency = opts?.concurrency ?? 500;
 this._autoFlushThreshold = opts?.autoFlushThreshold ?? DEFAULT_AUTO_FLUSH_THRESHOLD;
 this._pluginName = opts?.pluginName ?? 'unknown';
 }

 /** Queue a file write. Skips files unchanged since last build (via content hash manifest). */
 add(filePath: string, content: string) {
 if (this.skipExisting && fs.existsSync(filePath)) return;
 // Check content hash manifest — skip writing if content is identical to last build
 const manifest = getManifest();
 if (manifest && this._distDir) {
 const rel = path.relative(this._distDir, filePath);
 const fileExists = fs.existsSync(filePath);
 if (fileExists && !manifest.shouldWrite(rel, content)) {
 this._skippedByHash++;
 return;
 }
 if (!fileExists) {
  manifest.shouldWrite(rel, content);
 }
 }
 // Cross-plugin/intra-plugin write collision check.
 // claim() throws WriteCollisionError in `throw` mode and returns 'skip-write'
 // for idempotent re-claims (identical content) or declared-shared losers.
 const outcome: ClaimOutcome = claim(filePath, this._pluginName, content);
 if (outcome === 'skip-write') {
 this._skippedByCollision++;
 return;
 }
 // Map.set semantics: if this filePath was already queued by an earlier
 // add() in the same build, this call REPLACES the queued content. The
 // earlier write is silently discarded — the disk only ever sees ONE
 // version of any path within a single plugin's flush. Track overwrite
 // count for diagnostics.
 if (this.writes.has(filePath)) this._overwrittenInPlugin += 1;
 this.writes.set(filePath, { filePath, content });

 // Auto-flush in background once we cross the threshold. add() must stay
 // synchronous for callers, so we kick off the flush without awaiting.
 // Errors are captured on the collector and re-thrown by flush().
 if (this.writes.size >= this._autoFlushThreshold) {
 const batch = Array.from(this.writes.values());
 this.writes = new Map();
 const flushPromise = flushWrites(batch, this._concurrency).catch((err: unknown) => {
  if (!this._firstError) {
  this._firstError = err instanceof Error ? err : new Error(String(err));
  }
  return 0;
 });
 this._pendingFlushes.push(flushPromise);
 }
 }

 /** Queue both a directory index.html and a flat .html file for the same content */
 addWithFlat(dirPath: string, slug: string, content: string) {
 // /dir/slug/index.html
 const indexPath = path.join(dirPath, slug, 'index.html');
 // /dir/slug.html
 const flatPath = path.join(dirPath, `${slug}.html`);
 this.add(indexPath, content);
 this.add(flatPath, content);
 }

 /** Pending in-memory writes not yet flushed (legacy semantic — same as before). */
 get count() { return this.writes.size; }
 get skippedByHash() { return this._skippedByHash; }
 /** Number of add() calls skipped because the path was already claimed
  * (idempotent re-write or declared-shared loser). */
 get skippedByCollision() { return this._skippedByCollision; }
 /** Number of add() calls that overwrote a previously queued same-path
  * write within this collector. Diagnostic only — counts intra-plugin
  * last-add-wins resolutions. */
 get overwrittenInPlugin() { return this._overwrittenInPlugin; }

 /**
  * Flush all queued writes in parallel batches (see {@link flushWrites}).
  * Awaits any background flushes spawned by auto-flush, drains remaining
  * writes, and re-throws the first error captured during a background flush.
  */
 async flush(concurrency = 500): Promise<number> {
 // Drain any writes still in the in-memory buffer.
 const remaining = Array.from(this.writes.values());
 this.writes = new Map();
 if (remaining.length > 0) {
 this._pendingFlushes.push(flushWrites(remaining, concurrency));
 }

 // Await all outstanding flushes (background + final drain).
 const results = await Promise.all(this._pendingFlushes);
 this._pendingFlushes = [];

 // Surface any error captured during a background flush.
 if (this._firstError) {
 const err = this._firstError;
 this._firstError = null;
 throw err;
 }

 // Sum total bytes written across background + final drain.
 return results.reduce(
 (sum, n) => sum + (typeof n === 'number' ? n : 0),
 0,
 );
 }
}
