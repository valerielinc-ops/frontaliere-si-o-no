/**
 * Batch file writer for build plugins.
 * Collects file writes in memory and flushes them in parallel batches,
 * dramatically faster than sequential writeFileSync for 1000+ files.
 *
 * Supports optional content-hash manifest: when enabled, files whose
 * content hasn't changed since the last build are skipped entirely.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getManifest } from './contentHash';

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

/**
 * Collector class for building up writes and flushing at once.
 * Plugins can push writes as they generate HTML, then flush at the end.
 *
 * When a ContentHashManifest is active (initialized via initManifest()),
 * files whose content hash matches the previous build are automatically skipped.
 */
export class WriteCollector {
 private writes: PendingWrite[] = [];
 private skipExisting: boolean;
 private _skippedByHash = 0;
 private _distDir: string;

 constructor(opts?: { skipExisting?: boolean; distDir?: string }) {
 this.skipExisting = opts?.skipExisting ?? false;
 this._distDir = opts?.distDir ?? '';
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
 this.writes.push({ filePath, content });
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

 get count() { return this.writes.length; }
 get skippedByHash() { return this._skippedByHash; }

 /** Flush all queued writes in parallel batches (see {@link flushWrites}) */
 async flush(concurrency = 500): Promise<number> {
 return flushWrites(this.writes, concurrency);
 }
}
