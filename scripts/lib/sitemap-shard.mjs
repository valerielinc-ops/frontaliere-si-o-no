/**
 * sitemap-shard.mjs
 *
 * Sitemap shard splitter + sitemap-index emitter.
 *
 * Data flow:
 *
 *   urls (Array<UrlEntry>)
 *        │
 *        ▼
 *   ┌──────────────────┐
 *   │  splitToShards   │  ── shardKey(url) → group; cap per shard
 *   └──────────────────┘
 *        │
 *        ▼
 *   shards (Array<{filename, urls}>)
 *        │
 *        ├──► emitSitemapXml(urls)        ──► dist/<shard>.xml  (one per shard)
 *        │
 *        └──► emitSitemapIndex(filenames) ──► dist/sitemap-index.xml
 *
 *   writeShardsToDist orchestrates both emitters and persists to disk.
 *
 * @module scripts/lib/sitemap-shard
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {Object} UrlEntry
 * @property {string} loc
 * @property {string} [lastmod]
 * @property {string} [changefreq]
 * @property {number} [priority]
 */

/**
 * @typedef {Object} Shard
 * @property {string} filename - e.g. "sitemap-jobs-ti.xml" or "sitemap-jobs-001.xml"
 * @property {Array<UrlEntry>} urls
 */

const DEFAULT_CAP_PER_SHARD = 45000;
const FILENAME_PREFIX = 'sitemap-jobs';

/**
 * Escape XML-reserved characters in a string.
 * Order matters: '&' must be replaced first.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Pad a numeric index to a zero-padded 3-digit string (001, 002, ...).
 * Falls back to the unpadded number for indices >= 1000.
 *
 * @param {number} index
 * @returns {string}
 */
function padIndex(index) {
  if (index >= 1000) return String(index);
  return String(index).padStart(3, '0');
}

/**
 * Slugify a shardKey return value into something safe for a filename.
 * Lowercases, strips diacritics, replaces non [a-z0-9] with '-'.
 *
 * @param {string} key
 * @returns {string}
 */
function slugifyKey(key) {
  return String(key)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'misc';
}

/**
 * Split an array of URL entries into shards capped at `capPerShard` entries each.
 *
 * Two modes:
 *   - **Round-robin** (default `shardKey`): URLs distributed by index, filenames
 *     numbered (sitemap-jobs-001.xml, sitemap-jobs-002.xml, ...).
 *   - **Keyed** (custom `shardKey`): URLs grouped by `shardKey(url)`. Each group
 *     is then split into capped sub-shards if it exceeds `capPerShard`. Filenames
 *     embed the slugified key (sitemap-jobs-ti.xml, sitemap-jobs-ti-002.xml).
 *
 * @param {Array<UrlEntry>} urls
 * @param {Object} [options]
 * @param {number} [options.capPerShard=45000]
 * @param {(url: UrlEntry) => string} [options.shardKey] - if omitted, round-robin numeric shards
 * @param {string} [options.filenamePrefix="sitemap-jobs"]
 * @returns {Array<Shard>}
 */
export function splitToShards(urls, options = {}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return [];
  }

  const capPerShard = options.capPerShard ?? DEFAULT_CAP_PER_SHARD;
  const filenamePrefix = options.filenamePrefix ?? FILENAME_PREFIX;
  const shardKey = options.shardKey;

  if (capPerShard <= 0 || !Number.isFinite(capPerShard)) {
    throw new Error(`capPerShard must be a positive finite number, got ${capPerShard}`);
  }

  // Round-robin numeric mode
  if (typeof shardKey !== 'function') {
    const shards = [];
    const totalShards = Math.ceil(urls.length / capPerShard);
    for (let i = 0; i < totalShards; i++) {
      const slice = urls.slice(i * capPerShard, (i + 1) * capPerShard);
      shards.push({
        filename: `${filenamePrefix}-${padIndex(i + 1)}.xml`,
        urls: slice,
      });
    }
    return shards;
  }

  // Keyed mode: group by shardKey, then split each group if it exceeds the cap
  const groups = new Map();
  for (const url of urls) {
    const rawKey = shardKey(url);
    const key = rawKey === undefined || rawKey === null || rawKey === ''
      ? 'misc'
      : slugifyKey(rawKey);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(url);
  }

  const shards = [];
  // Stable order by key for reproducible output
  const sortedKeys = Array.from(groups.keys()).sort();
  for (const key of sortedKeys) {
    const groupUrls = groups.get(key);
    const partCount = Math.ceil(groupUrls.length / capPerShard);
    for (let i = 0; i < partCount; i++) {
      const slice = groupUrls.slice(i * capPerShard, (i + 1) * capPerShard);
      const suffix = partCount === 1 ? '' : `-${padIndex(i + 1)}`;
      shards.push({
        filename: `${filenamePrefix}-${key}${suffix}.xml`,
        urls: slice,
      });
    }
  }

  return shards;
}

/**
 * Emit a single sitemap XML document for the given URL entries.
 * Pure function — no I/O, no mutation of input.
 *
 * @param {Array<UrlEntry>} urls
 * @returns {string} XML string ending with newline
 */
export function emitSitemapXml(urls) {
  const list = Array.isArray(urls) ? urls : [];
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  for (const entry of list) {
    if (!entry || !entry.loc) continue;
    lines.push('  <url>');
    lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
    if (entry.lastmod) {
      lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
    }
    if (entry.changefreq) {
      lines.push(`    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`);
    }
    if (entry.priority !== undefined && entry.priority !== null) {
      const p = Number(entry.priority);
      if (Number.isFinite(p)) {
        lines.push(`    <priority>${p.toFixed(1)}</priority>`);
      }
    }
    lines.push('  </url>');
  }
  lines.push('</urlset>');
  lines.push('');
  return lines.join('\n');
}

/**
 * Emit a sitemap-index XML document referencing the shard filenames.
 * Pure function — no I/O.
 *
 * @param {Array<string|{filename: string, lastmod?: string}>} shardFilenames
 * @param {string} baseUrl - e.g. "https://frontaliereticino.ch" (no trailing slash)
 * @returns {string} XML string ending with newline
 */
export function emitSitemapIndex(shardFilenames, baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('emitSitemapIndex: baseUrl is required');
  }
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const list = Array.isArray(shardFilenames) ? shardFilenames : [];

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  for (const item of list) {
    const filename = typeof item === 'string' ? item : item?.filename;
    if (!filename) continue;
    const lastmod = typeof item === 'object' && item ? item.lastmod : undefined;
    const loc = `${trimmedBase}/${filename.replace(/^\/+/, '')}`;
    lines.push('  <sitemap>');
    lines.push(`    <loc>${escapeXml(loc)}</loc>`);
    if (lastmod) {
      lines.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`);
    }
    lines.push('  </sitemap>');
  }
  lines.push('</sitemapindex>');
  lines.push('');
  return lines.join('\n');
}

/**
 * Write all shard files plus sitemap-index.xml to disk under `distDir`.
 *
 * No-op when `shards` is empty (nothing is written, including the index).
 *
 * @param {Array<Shard>} shards
 * @param {string} distDir - absolute path to dist directory
 * @param {string} baseUrl - canonical base URL for the sitemap-index
 * @returns {Promise<{shardPaths: string[], indexPath: string|null}>}
 */
export async function writeShardsToDist(shards, distDir, baseUrl) {
  if (!Array.isArray(shards) || shards.length === 0) {
    return { shardPaths: [], indexPath: null };
  }
  if (typeof distDir !== 'string' || distDir.length === 0) {
    throw new Error('writeShardsToDist: distDir is required');
  }

  await mkdir(distDir, { recursive: true });

  const shardPaths = [];
  for (const shard of shards) {
    if (!shard || !shard.filename) continue;
    const xml = emitSitemapXml(shard.urls);
    const outPath = path.join(distDir, shard.filename);
    await writeFile(outPath, xml, 'utf8');
    shardPaths.push(outPath);
  }

  const indexXml = emitSitemapIndex(
    shards.map((s) => s.filename),
    baseUrl,
  );
  const indexPath = path.join(distDir, 'sitemap-index.xml');
  await writeFile(indexPath, indexXml, 'utf8');

  return { shardPaths, indexPath };
}
