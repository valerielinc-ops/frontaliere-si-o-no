import fs from 'node:fs';
import path from 'node:path';
import { isSafeCompatPath } from '../../scripts/lib/compat-path-safety.mjs';

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
  return isSafeCompatPath(pathname);
}

export interface SafeDistPageWriteOptions {
  indexPath: string;
  html: string;
  urlPath: string;
  logPrefix: string;
  flatPath?: string;
  flatHtml?: string;
  overwriteFlat?: boolean;
}

/** Write one bridge page without allowing a bad path or disk error to abort the build. */
export function writeDistPageSafely(options: SafeDistPageWriteOptions): boolean {
  if (!isSafeDistPath(options.urlPath)) {
    console.warn(`[${options.logPrefix}] skipped unsafe path ${options.urlPath}`);
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(options.indexPath), { recursive: true });
    fs.writeFileSync(options.indexPath, options.html, 'utf-8');
    if (options.flatPath && (options.overwriteFlat || !fs.existsSync(options.flatPath))) {
      fs.mkdirSync(path.dirname(options.flatPath), { recursive: true });
      fs.writeFileSync(options.flatPath, options.flatHtml ?? options.html, 'utf-8');
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
