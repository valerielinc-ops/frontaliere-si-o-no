/**
 * Batch file writer for build plugins.
 * Collects file writes in memory and flushes them in parallel batches,
 * dramatically faster than sequential writeFileSync for 1000+ files.
 */
import fs from 'node:fs';
import path from 'node:path';

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
 * @param concurrency - Number of files written in parallel per batch (default 200)
 */
export async function flushWrites(writes: PendingWrite[], concurrency = 200): Promise<number> {
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
 */
export class WriteCollector {
  private writes: PendingWrite[] = [];
  private skipExisting: boolean;

  constructor(opts?: { skipExisting?: boolean }) {
    this.skipExisting = opts?.skipExisting ?? false;
  }

  /** Queue a file write. If skipExisting is true, skips files that already exist on disk. */
  add(filePath: string, content: string) {
    if (this.skipExisting && fs.existsSync(filePath)) return;
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

  /** Flush all queued writes in parallel batches */
  async flush(concurrency = 200): Promise<number> {
    return flushWrites(this.writes, concurrency);
  }
}
