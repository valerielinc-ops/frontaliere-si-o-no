/**
 * readHead — read just enough of an HTML file to contain its `<head>`.
 *
 * Several dist/ auditors only ever look at `<head>` metadata: `<link
 * rel="canonical">`, `<link rel="alternate" hreflang>`, `<meta name="robots">`.
 * Reading whole pages to regex those tags is the dominant cost of walking a
 * ~3.3M-page dist/ — on post-deploy-validate-dist run 30376520728 the two
 * gates doing it accounted for 2000 s and 1711 s, the job's critical path.
 *
 * The single definition lives here so the two callers cannot drift (AGENTS.md:
 * a helper duplicated in ≥2 files gets extracted into one shared module).
 *
 * Plain `.mjs` so the Node-run auditors under scripts/ can import it without a
 * tsx loader, matching scripts/lib/audit-runner.mjs.
 */

import { open } from 'node:fs/promises';
import { openSync, readSync, readFileSync, closeSync } from 'node:fs';

/**
 * Read window for the `<head>` fast path. Comfortably larger than any head
 * this build emits (inlined critical CSS included), so the whole-file fallback
 * is effectively never taken.
 */
export const HEAD_CHUNK_BYTES = 64 * 1024;

/**
 * Read `file` up to the end of its `<head>`.
 *
 * Returns the complete file when it is smaller than one chunk, the head slice
 * when `</head>` is found inside the first chunk, and — only when the head is
 * somehow larger than {@link HEAD_CHUNK_BYTES} — the entire file. Callers that
 * only inspect head metadata therefore see exactly what a full read would have
 * given them.
 *
 * Returns `null` on any read error, so callers keep the same "skip this file"
 * contract they had with `try { readFileSync(...) } catch { continue }`.
 *
 * @param {string} file absolute path to an HTML file
 * @returns {Promise<string|null>}
 */
export async function readHeadOrAll(file) {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(HEAD_CHUNK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_CHUNK_BYTES, 0);
    const chunk = buf.toString('utf-8', 0, bytesRead);
    if (bytesRead < HEAD_CHUNK_BYTES) return chunk;
    const headEnd = chunk.indexOf('</head>');
    if (headEnd !== -1) return chunk.slice(0, headEnd);
    return await fh.readFile('utf-8');
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Synchronous twin of {@link readHeadOrAll}, for callers whose scan loop is
 * still sequential and would need restructuring to go async (currently
 * audit-sitemap-canonicals.mjs, which walks sitemap `<loc>`s rather than
 * dist/ and only ever needs the canonical tag).
 *
 * Same three cases and the same guarantee: whole file when it fits in one
 * chunk, head slice when `</head>` is inside the chunk, whole file otherwise.
 * Throws exactly like `readFileSync` so existing try/catch offender handling
 * keeps working unchanged.
 *
 * @param {string} file absolute path to an HTML file
 * @returns {string}
 */
export function readHeadOrAllSync(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(HEAD_CHUNK_BYTES);
    const bytesRead = readSync(fd, buf, 0, HEAD_CHUNK_BYTES, 0);
    const chunk = buf.toString('utf-8', 0, bytesRead);
    if (bytesRead < HEAD_CHUNK_BYTES) return chunk;
    const headEnd = chunk.indexOf('</head>');
    if (headEnd !== -1) return chunk.slice(0, headEnd);
  } finally {
    closeSync(fd);
  }
  // Head larger than the window — pay for the whole document.
  return readFileSync(file, 'utf-8');
}
