/**
 * Sitemap snapshot files: the streaming v4 writer and the single shared reader.
 *
 * Dependency-free on purpose (node built-ins only): the publisher's
 * validate-dist job sparse-checks out an explicit list of scripts, and the gate
 * must be able to read a snapshot without the crawler or its imports.
 * `scripts/lib/sitemap-crawl.mjs` re-exports everything here.
 */

import {
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { rm, rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * ── Snapshot file format v4 (NDJSON) ────────────────────────────────────────
 *
 * A snapshot used to be ONE JSON document (v3). The whole document had to be
 * built as a single string, and a graph with ~1.5 M listed URLs serialises to
 * more than V8's maximum string length (2^29 - 24 characters), which made
 * `JSON.stringify` throw "Invalid string length" and left the publisher
 * without its current snapshot. v4 writes one line per sitemap instead:
 *
 *   {"version":4,"capturedAt":…,"source":…,"host":…,"sitemapFiles":[…],"missingSitemaps":[…]}
 *   {"sitemap":"sitemap-x.xml","urls":[…],"digest":"…","lastmod":{…}}
 *   …one line per entry of `sitemapFiles`, in the same order…
 *
 * The sitemap protocol caps every file at 50 000 URLs / 50 MB, so each line is
 * bounded by the largest single sitemap, never by the size of the whole graph.
 * `_allUrls` is gone (derive it with `snapshotUrls`). The reader returns the
 * familiar v3-shaped object so every consumer keeps working unchanged.
 */
export const SNAPSHOT_FORMAT_VERSION = 4;
const SNAPSHOT_PEEK_BYTES = 4096;
const SNAPSHOT_READ_CHUNK_BYTES = 1 << 20;
const V4_HEADER_RE = /^\s*\{\s*"version"\s*:\s*4\s*[,}]/;

function* snapshotSitemapEntries(source) {
  if (source?.records instanceof Map) {
    for (const [key, record] of [...source.records.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      yield [key, record.urls || [], record.digest ?? '', record.lastmod || {}];
    }
    return;
  }
  const perSitemap = source?.perSitemap || {};
  for (const key of Object.keys(perSitemap).sort((a, b) => a.localeCompare(b))) {
    yield [
      key,
      perSitemap[key] || [],
      source.perSitemapDigests?.[key] ?? '',
      source.perSitemapLastmod?.[key] || {},
    ];
  }
}

/**
 * Yield the v4 snapshot as bounded string chunks (header, then one line per
 * sitemap). Accepts a crawl result or a v3-shaped snapshot. No chunk is ever
 * longer than the largest single sitemap's serialisation.
 */
export function* serializeSnapshotChunks(source, { capturedAt = new Date().toISOString() } = {}) {
  const entries = [...snapshotSitemapEntries(source)];
  const missing = Array.isArray(source?.missing)
    ? source.missing
    : (Array.isArray(source?.missingSitemaps) ? source.missingSitemaps : []);
  yield `${JSON.stringify({
    version: SNAPSHOT_FORMAT_VERSION,
    capturedAt,
    source: source?.source,
    host: source?.host,
    sitemapFiles: entries.map(([key]) => key),
    missingSitemaps: missing,
  })}\n`;
  for (const [sitemap, urls, digest, lastmod] of entries) {
    try {
      yield `${JSON.stringify({ sitemap, urls, digest, lastmod })}\n`;
    } catch (error) {
      if (error instanceof RangeError) {
        throw new Error(`Sitemap snapshot entry ${sitemap} is too large to serialise (${urls.length} URLs): ${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * Stream a snapshot to `file` (backpressure-aware, flushed and closed before
 * the promise resolves). The bytes go to a temporary sibling that is renamed
 * only on success, and on any failure both the temporary file and `file` are
 * removed: a truncated snapshot must never be mistaken for a valid one.
 */
export async function writeSnapshotFile(file, source, options = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  const stats = { sitemaps: 0, urls: 0, bytes: 0, maxChunkChars: 0 };
  async function* counted() {
    for (const chunk of serializeSnapshotChunks(source, options)) {
      stats.bytes += Buffer.byteLength(chunk);
      stats.maxChunkChars = Math.max(stats.maxChunkChars, chunk.length);
      yield chunk;
    }
  }
  try {
    await pipeline(Readable.from(counted()), createWriteStream(tmp, { encoding: 'utf8' }));
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    await rm(file, { force: true }).catch(() => {});
    throw error;
  }
  for (const [, urls] of snapshotSitemapEntries(source)) {
    stats.sitemaps += 1;
    stats.urls += urls.length;
  }
  return stats;
}

function* readLinesSync(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(SNAPSHOT_READ_CHUNK_BYTES);
    // Pieces of the line currently being assembled. A line (one sitemap) can
    // span many chunks; it is joined once, when its newline arrives.
    let pending = [];
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      let start = 0;
      for (let i = buffer.indexOf(0x0a, 0); i !== -1 && i < read; i = buffer.indexOf(0x0a, i + 1)) {
        pending.push(Buffer.from(buffer.subarray(start, i)));
        yield (pending.length === 1 ? pending[0] : Buffer.concat(pending)).toString('utf8');
        pending = [];
        start = i + 1;
      }
      if (start < read) pending.push(Buffer.from(buffer.subarray(start, read)));
    }
    // A final line without its newline is a truncated write: surface it as a
    // line anyway so the caller's JSON parse (or sitemap count) rejects it.
    if (pending.length) yield Buffer.concat(pending).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function peekFile(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(SNAPSHOT_PEEK_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readV4Snapshot(file) {
  let header = null;
  let lineNumber = 0;
  const perSitemap = {};
  const perSitemapDigests = {};
  const perSitemapLastmod = {};
  for (const line of readLinesSync(file)) {
    lineNumber += 1;
    if (!line.trim()) {
      throw new Error(`Sitemap snapshot ${file} line ${lineNumber} is empty (v4 has no blank lines)`);
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`Sitemap snapshot ${file} line ${lineNumber} is not valid JSON (truncated file?): ${error.message}`);
    }
    if (lineNumber === 1) {
      if (row?.version !== SNAPSHOT_FORMAT_VERSION || !Array.isArray(row.sitemapFiles)) {
        throw new Error(`Sitemap snapshot ${file} has an invalid v4 header`);
      }
      header = row;
      continue;
    }
    if (!row || typeof row.sitemap !== 'string' || !Array.isArray(row.urls)) {
      throw new Error(`Sitemap snapshot ${file} line ${lineNumber} is not a sitemap entry`);
    }
    if (Object.prototype.hasOwnProperty.call(perSitemap, row.sitemap)) {
      throw new Error(`Sitemap snapshot ${file} line ${lineNumber} repeats sitemap ${row.sitemap}`);
    }
    perSitemap[row.sitemap] = row.urls;
    perSitemapDigests[row.sitemap] = row.digest;
    perSitemapLastmod[row.sitemap] = row.lastmod && typeof row.lastmod === 'object' ? row.lastmod : {};
  }
  if (!header) throw new Error(`Sitemap snapshot ${file} is empty`);
  const found = Object.keys(perSitemap);
  if (found.length !== header.sitemapFiles.length
    || header.sitemapFiles.some((key, index) => key !== found[index])) {
    throw new Error(
      `Sitemap snapshot ${file} is incomplete: header lists ${header.sitemapFiles.length} sitemap(s), file holds ${found.length} (truncated file?)`,
    );
  }
  return {
    // v3-shaped in memory, so snapshotUrls/changedUrls/filterSnapshot and every
    // gate keep their contract; `snapshotFormat` records what was on disk.
    version: 3,
    snapshotFormat: SNAPSHOT_FORMAT_VERSION,
    capturedAt: header.capturedAt,
    source: header.source,
    host: header.host,
    sitemapFiles: header.sitemapFiles,
    perSitemap,
    perSitemapDigests,
    perSitemapLastmod,
    missingSitemaps: Array.isArray(header.missingSitemaps) ? header.missingSitemaps : [],
  };
}

/**
 * The single reader for snapshot files (deploy gate, IndexNow, propagation
 * wait, sitemap diff). Reads v4 NDJSON line by line (never the whole file in
 * one string) and also accepts the legacy single-JSON documents v1/v2/v3,
 * which are small (older toolchains, test fixtures). Throws a descriptive
 * error when the file is absent, truncated or not a snapshot.
 */
export function readSitemapSnapshot(file) {
  if (!existsSync(file)) throw new Error(`Sitemap snapshot ${file} does not exist (ENOENT)`);
  if (V4_HEADER_RE.test(peekFile(file))) return readV4Snapshot(file);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Sitemap snapshot ${file} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Sitemap snapshot ${file} is not a snapshot document`);
  }
  return parsed;
}
