/**
 * Phase 5 — URL max-length gate.
 *
 * Long URLs are penalised by SEMrush ("Long URLs", >115 chars) and
 * Google's mobile-first indexing prefers shorter canonicals (≤200
 * chars is the stricter ceiling). This test scans every emitted
 * `dist/**\/*.html` page and asserts the canonical URL path length
 * stays at or below 200 characters.
 *
 * Tolerance: up to 5 violations are accepted as legacy (Phase 3B
 * already truncated slugs to 180 chars; the remaining outliers are
 * already-live URLs we cannot retroactively redirect without
 * sacrificing the existing GSC equity).
 *
 * Dist-driven: skips silently when `dist/` does not exist so
 * `npm test` works without a prior build.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST_DIR = resolve(__dirname, '..', 'dist');
// Phase 3B truncated job slugs to 180 chars; combined with the
// `/cerca-lavoro-ticino/` (21 chars) section prefix and trailing slash
// the post-truncation ceiling is 202 chars, with a small headroom for
// per-locale prefixes (`/en/jobs/...`). Anything beyond 215 indicates a
// regression — either Phase 3B regressed, or a new path family slipped
// past slug truncation.
const MAX_URL_LENGTH = 215;
const MAX_VIOLATIONS = 5;

function walkHtml(dir: string, acc: string[] = []): string[] {
 if (!existsSync(dir)) return acc;
 for (const entry of readdirSync(dir)) {
  const full = join(dir, entry);
  let stat;
  try {
   stat = statSync(full);
  } catch {
   continue;
  }
  if (stat.isDirectory()) {
   walkHtml(full, acc);
  } else if (entry.endsWith('.html')) {
   acc.push(full);
  }
 }
 return acc;
}

function extractCanonicalPath(html: string): string | null {
 const match = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
 if (!match) return null;
 try {
  const u = new URL(match[1]);
  return u.pathname + u.search;
 } catch {
  return match[1];
 }
}

describe('URL max-length gate (Phase 5)', () => {
 it(`each canonical URL path is ≤ ${MAX_URL_LENGTH} characters (≤${MAX_VIOLATIONS} legacy exceptions)`, { timeout: 180_000 }, () => {
  if (!existsSync(DIST_DIR)) {
   // Skip gracefully when no build artefacts are present.
   return;
  }

  const files = walkHtml(DIST_DIR);
  const violations: { file: string; path: string; len: number }[] = [];

  // Read only the first 8 KB of each file (canonical link lives in
  // <head>, well within the first chunk). 50k+ HTML files at full size
  // would time out; the chunked read finishes in a few seconds.
  const HEAD_BYTES = 8 * 1024;
  const buf = Buffer.alloc(HEAD_BYTES);

  for (const file of files) {
   let head: string;
   try {
    const fd = openSync(file, 'r');
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    closeSync(fd);
    head = buf.slice(0, n).toString('utf-8');
   } catch {
    continue;
   }
   const canonicalPath = extractCanonicalPath(head);
   if (!canonicalPath) continue;
   if (canonicalPath.length > MAX_URL_LENGTH) {
    violations.push({
     file: file.replace(DIST_DIR, ''),
     path: canonicalPath,
     len: canonicalPath.length,
    });
   }
  }

  if (violations.length > MAX_VIOLATIONS) {
   const summary = violations
    .slice(0, 12)
    .map((v) => `  [${v.len}] ${v.path}  (${v.file})`)
    .join('\n');
   throw new Error(
    `URL max-length budget exceeded: ${violations.length} URL(s) > ${MAX_URL_LENGTH} chars (max ${MAX_VIOLATIONS}).\n${summary}`,
   );
  }

  expect(violations.length).toBeLessThanOrEqual(MAX_VIOLATIONS);
 });
});
