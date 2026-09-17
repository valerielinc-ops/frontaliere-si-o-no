import fs from 'node:fs';
import path from 'node:path';

function indexPath(distDir: string, relativePath: string): string {
  const normalized = relativePath.replace(/^\/+/, '').replace(/\/+$/, '');
  return path.join(distDir, normalized, 'index.html');
}

/** Read an already-emitted page without retaining its HTML in the build heap. */
export function readEmittedHtml(distDir: string, relativePath: string): string | undefined {
  if (!relativePath.trim()) return undefined;
  try {
    return fs.readFileSync(indexPath(distDir, relativePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Test the disk-backed fallback without allocating the page body. */
export function hasEmittedHtml(distDir: string, relativePath: string): boolean {
  if (!relativePath.trim()) return false;
  return fs.existsSync(indexPath(distDir, relativePath));
}

/** Prefer a one-off fallback entry, otherwise read the emitted page from disk. */
export function readCachedOrEmittedHtml(
  cache: ReadonlyMap<string, string>,
  key: string,
  distDir: string,
  relativePath: string,
): string | undefined {
  const cached = cache.get(key);
  return cached !== undefined ? cached : readEmittedHtml(distDir, relativePath);
}

/** Check the same source choice as {@link readCachedOrEmittedHtml} without reading HTML. */
export function hasCachedOrEmittedHtml(
  cache: ReadonlyMap<string, string>,
  key: string,
  distDir: string,
  relativePath: string,
): boolean {
  return cache.has(key) || hasEmittedHtml(distDir, relativePath);
}

/** Drop only entries whose identical source is now guaranteed to live on disk. */
export function releaseDiskBackedHtmlCache(
  cache: Map<string, string>,
  diskBackedKeys: Set<string>,
): number {
  let released = 0;
  for (const key of diskBackedKeys) {
    if (cache.delete(key)) released++;
  }
  diskBackedKeys.clear();
  return released;
}
