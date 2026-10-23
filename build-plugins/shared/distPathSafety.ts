import fs from 'node:fs';
import path from 'node:path';
import {
  isDistPathOverFilesystemLimits as isDistPathOverFilesystemLimitsShared,
  MAX_FILESYSTEM_SEGMENT_BYTES as MAX_FILESYSTEM_SEGMENT_BYTES_SHARED,
  isSafeCompatPath,
} from '../../scripts/lib/compat-path-safety.mjs';

export {
  MAX_FILESYSTEM_SEGMENT_BYTES,
  MAX_DIST_PATH_BYTES,
  isDistPathOverFilesystemLimits,
} from '../../scripts/lib/compat-path-safety.mjs';

/**
 * A URL path segment beginning with `.` must never become a dist output path.
 *
 * A trailing-slash URL such as `/foo/.env.bak/` otherwise produces both
 * `dist/foo/.env.bak/index.html` and the flat sibling
 * `dist/foo/.env.bak.html`; the latter is an invalid dotfile HTML output.
 * The shared predicate also rejects external SQL/XSS probes, malformed URL
 * escapes and oversized segments before any filesystem join/write.
 */
export function isSafeDistPath(pathname: string): boolean {
  return !isDistPathOverFilesystemLimitsShared(pathname)
    && isSafeCompatPath(pathname, { maxSegmentBytes: MAX_FILESYSTEM_SEGMENT_BYTES_SHARED });
}

export interface SafeDistPageWriteOptions {
  distDir?: string;
  indexPath: string;
  html: string;
  urlPath: string;
  logPrefix: string;
  flatPath?: string;
  flatHtml?: string;
  overwriteFlat?: boolean;
}

export interface SafeDistPageTargets {
  directoryPath: string;
  indexPath: string;
  flatPath?: string;
}

/**
 * Leave headroom below POSIX PATH_MAX for the absolute runner path and for
 * the derived `index.html`/`.html` suffixes. The URL-path guard alone cannot
 * account for either of those bytes.
 */
export const MAX_DIST_TARGET_PATH_BYTES = 4096 - 128;

/** Return false when an absolute filesystem target exceeds POSIX bounds. */
export function isSafeDistTargetPath(targetPath: string): boolean {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
  const absolutePath = path.resolve(targetPath);
  if (Buffer.byteLength(absolutePath, 'utf8') > MAX_DIST_TARGET_PATH_BYTES) return false;
  return absolutePath
    .split(path.sep)
    .filter(Boolean)
    .every((segment) => Buffer.byteLength(segment, 'utf8') <= MAX_FILESYSTEM_SEGMENT_BYTES_SHARED);
}

/**
 * Calculate every filesystem target for a URL page before an emitter writes.
 * `includeFlat:false` is for emitters that deliberately write only the
 * directory form; the default validates the directory, index and flat twin
 * as one atomic preflight.
 */
export function getSafeDistPageTargets(
  distDir: string,
  pathname: string,
  { includeFlat = true }: { includeFlat?: boolean } = {},
): SafeDistPageTargets | null {
  if (!isSafeDistPath(pathname)) return null;

  const relativePath = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const directoryPath = path.join(distDir, relativePath);
  const indexPath = path.join(directoryPath, 'index.html');
  const flatPath = includeFlat ? path.join(distDir, `${relativePath}.html`) : undefined;
  const targets = [directoryPath, indexPath, ...(flatPath ? [flatPath] : [])];
  if (!targets.every(isSafeDistTargetPath)) return null;

  return { directoryPath, indexPath, flatPath };
}

/** Write one bridge page without allowing a bad path or disk error to abort the build. */
export function writeDistPageSafely(options: SafeDistPageWriteOptions): boolean {
  const safeTargets = options.distDir
    ? getSafeDistPageTargets(options.distDir, options.urlPath, { includeFlat: Boolean(options.flatPath) })
    : null;
  if (
    !isSafeDistPath(options.urlPath)
    || (options.distDir && !safeTargets)
    || !isSafeDistTargetPath(options.indexPath)
    || (options.flatPath && !isSafeDistTargetPath(options.flatPath))
    || (safeTargets && path.resolve(options.indexPath) !== path.resolve(safeTargets.indexPath))
    || (safeTargets?.flatPath && options.flatPath && path.resolve(options.flatPath) !== path.resolve(safeTargets.flatPath))
  ) {
    console.warn(`[${options.logPrefix}] skipped unsafe path ${options.urlPath}`);
    return false;
  }

  const indexPath = safeTargets?.indexPath ?? options.indexPath;
  const flatPath = safeTargets?.flatPath ?? options.flatPath;

  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, options.html, 'utf-8');
    if (flatPath && (options.overwriteFlat || !fs.existsSync(flatPath))) {
      fs.mkdirSync(path.dirname(flatPath), { recursive: true });
      fs.writeFileSync(flatPath, options.flatHtml ?? options.html, 'utf-8');
    }
    return true;
  } catch (error) {
    console.warn(
      `[${options.logPrefix}] skipped unwritable path ${options.urlPath}:`,
      error,
    );
    return false;
  }
}
