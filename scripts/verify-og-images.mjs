#!/usr/bin/env node
/**
 * Build gate for the images emitted in `<meta property="og:image">`.
 *
 * It samples the three build families that matter to sharing: event-library
 * images, article heroes and static-page cards. Every sampled URL must be a
 * recorded generated asset / credited cover, or one of the small explicit
 * site-owned exceptions in published-image-policy.mjs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITE_ORIGIN,
  loadPublishedImagePolicy,
} from './lib/published-image-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Generator on purpose: the full dist holds millions of HTML files, and an
// in-memory sorted list of every path was part of what pushed the gate past
// the heap limit. Siblings are ordered by the key they contribute to a full
// path (a directory counts as `name/`), which yields exactly the order of the
// former global sort over all paths — `a.html` before `a/z.html` — so the
// representative sample is unchanged.
function* walkHtml(root) {
  if (!fs.existsSync(root)) return;
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .map((entry) => ({ entry, key: entry.isDirectory() ? `${entry.name}${path.sep}` : entry.name }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { entry } of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkHtml(filePath);
    else if (entry.isFile() && /\.html?$/i.test(entry.name)) yield filePath;
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function attributes(tag) {
  const result = {};
  const attrRe = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attrRe)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

export function extractOgImageUrls(html, pageUrl = SITE_ORIGIN) {
  const urls = [];
  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (attrs.property?.toLowerCase() !== 'og:image') continue;
    const raw = String(attrs.content || '').trim();
    if (!raw) continue;
    try {
      urls.push(new URL(raw, pageUrl).href);
    } catch {
      urls.push(raw);
    }
  }
  return urls;
}

function familyFor(url) {
  try {
    const pathname = new URL(url).pathname;
    if (pathname.startsWith('/images/events/library/')) return 'events';
    if (pathname.startsWith('/images/blog/') || pathname.startsWith('/images/generated/')) return 'articles';
  } catch {
    // The policy will report the malformed URL; keep it in the static sample.
  }
  return 'static';
}

const FAMILIES = ['events', 'articles', 'static'];
// Rows kept per family while streaming. Up to this many distinct URLs the
// family is held in full and the sample is exact; beyond it the stride doubles
// and only the middle pick becomes approximate (first and last stay exact).
const FAMILY_BUFFER_CAP = 1024;

/**
 * Exact-membership set of URLs that stores a 64-bit fingerprint per entry in
 * typed arrays (open addressing) instead of the strings themselves: about 16
 * bytes of table per distinct URL at the 50% load ceiling, i.e. ~60 MB for the
 * 3.8M pages of the production dist even if every page had its own image. A
 * capped set of strings was tried first and was wrong: once full, a repeated
 * URL counted as new and could displace the sampled row. Two different URLs
 * sharing a fingerprint (odds around 1e-6 at that size) would merge into one.
 */
class UrlFingerprintSet {
  constructor(capacity = 1 << 16) {
    this.size = 0;
    this.#allocate(capacity);
  }

  #allocate(capacity) {
    this.mask = capacity - 1;
    this.hi = new Uint32Array(capacity);
    this.lo = new Uint32Array(capacity);
  }

  #insert(hi, lo) {
    let slot = lo & this.mask;
    while (this.hi[slot] !== 0 || this.lo[slot] !== 0) {
      if (this.hi[slot] === hi && this.lo[slot] === lo) return false;
      slot = (slot + 1) & this.mask;
    }
    this.hi[slot] = hi;
    this.lo[slot] = lo;
    this.size += 1;
    return true;
  }

  /** Adds the URL; returns false when it was already present. */
  add(url) {
    const digest = crypto.createHash('sha1').update(url).digest();
    const hi = digest.readUInt32LE(0);
    // (0, 0) marks an empty slot.
    const lo = digest.readUInt32LE(4) || (hi === 0 ? 1 : 0);
    if (!this.#insert(hi, lo)) return false;
    if (this.size * 2 > this.mask + 1) {
      const { hi: oldHi, lo: oldLo } = this;
      this.size = 0;
      this.#allocate((this.mask + 1) * 2);
      for (let slot = 0; slot < oldHi.length; slot += 1) {
        if (oldHi[slot] !== 0 || oldLo[slot] !== 0) this.#insert(oldHi[slot], oldLo[slot]);
      }
    }
    return true;
  }
}

/**
 * Streams the dist and returns the representative rows of each family (first,
 * middle and last distinct og:image URL in walk order, or every row when the
 * family has at most `sampleSize` of them), the distinct count per family and
 * the total number of references seen.
 *
 * Nothing is retained per page: the first version kept a `{ file, url }` row
 * for every og:image tag and aborted on the full production dist. Rows are
 * capped by FAMILY_BUFFER_CAP per family; de-duplication stays exact through
 * UrlFingerprintSet. Each row names the first page that references its URL.
 */
export function collectOgImageReferences(distDir, { sampleSize = 3 } = {}) {
  const seen = new UrlFingerprintSet();
  const state = new Map(FAMILIES.map((family) => [family, { count: 0, stride: 1, buffer: [], last: null }]));
  let total = 0;
  for (const filePath of walkHtml(distDir)) {
    const relative = path.relative(distDir, filePath).split(path.sep).join('/');
    const pageUrl = new URL(relative, `${SITE_ORIGIN}/`).href;
    const html = fs.readFileSync(filePath, 'utf8');
    for (const url of extractOgImageUrls(html, pageUrl)) {
      total += 1;
      if (!seen.add(url)) continue;
      const family = state.get(familyFor(url));
      const row = { file: relative, url };
      // buffer[i] always holds the row with ordinal i * stride.
      if (family.count % family.stride === 0) {
        family.buffer.push(row);
        if (family.buffer.length > FAMILY_BUFFER_CAP) {
          family.buffer = family.buffer.filter((_, index) => index % 2 === 0);
          family.stride *= 2;
        }
      }
      family.last = row;
      family.count += 1;
    }
  }

  const keep = Math.min(FAMILY_BUFFER_CAP, Math.max(1, Number(sampleSize) || 1));
  const references = [];
  const counts = {};
  for (const name of FAMILIES) {
    const family = state.get(name);
    counts[name] = family.count;
    if (family.count <= keep) {
      // count <= keep <= cap: the buffer is the whole family.
      references.push(...family.buffer);
      continue;
    }
    const middle = family.buffer[Math.floor(Math.floor((family.count - 1) / 2) / family.stride)];
    references.push(...new Set([family.buffer[0], middle, family.last]));
  }
  return { references, total, counts };
}

function representative(rows, sampleSize) {
  const unique = new Map();
  for (const row of rows) unique.set(`${familyFor(row.url)}\n${row.url}`, row);
  const byFamily = new Map();
  for (const row of unique.values()) {
    const family = familyFor(row.url);
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(row);
  }

  const samples = [];
  for (const family of ['events', 'articles', 'static']) {
    const rowsForFamily = byFamily.get(family) || [];
    const count = Math.max(1, Number(sampleSize) || 1);
    const indexes = rowsForFamily.length <= count
      ? rowsForFamily.map((_, index) => index)
      : [...new Set([0, Math.floor((rowsForFamily.length - 1) / 2), rowsForFamily.length - 1])].slice(0, count);
    for (const index of indexes) samples.push({ ...rowsForFamily[index], family });
  }
  return {
    samples,
    counts: Object.fromEntries(['events', 'articles', 'static'].map((family) => [family, byFamily.get(family)?.length || 0])),
  };
}

export function verifyOgImageReferences(references, { policy, sampleSize = 3, requireFamilies = true, counts } = {}) {
  const selected = representative(references, sampleSize);
  // A streamed collection hands over only the sampled rows: its per-family
  // distinct counts are the real ones, not the size of that sample.
  if (counts) selected.counts = counts;
  const errors = [];
  if (selected.samples.length === 0) errors.push('no og:image meta tags found in dist');
  if (requireFamilies) {
    for (const family of ['events', 'articles', 'static']) {
      if (selected.counts[family] === 0) errors.push(`representative ${family} og:image family is missing`);
    }
  }
  for (const sample of selected.samples) {
    const verdict = policy.checkOg(sample.url);
    if (!verdict.valid) {
      errors.push(`${sample.file}: ${sample.family} ${sample.url} → ${verdict.reason || 'rejected'}`);
    }
  }
  return { valid: errors.length === 0, errors, counts: selected.counts, samples: selected.samples };
}

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
}

export function run(argv = process.argv.slice(2), { root = ROOT } = {}) {
  const distDir = path.resolve(root, argValue(argv, '--dist', 'dist'));
  const sampleSize = Number(argValue(argv, '--sample-size', '3')) || 3;
  const requireFamilies = !argv.includes('--allow-missing-families');
  const policy = loadPublishedImagePolicy({ root });
  const { references, total, counts } = collectOgImageReferences(distDir, { sampleSize });
  const result = verifyOgImageReferences(references, { policy, sampleSize, requireFamilies, counts });
  if (policy.registryErrors.length > 0) {
    result.valid = false;
    result.errors.unshift(...policy.registryErrors.map((error) => `registry: ${error}`));
  }

  console.log(`og:image references: ${total}; distinct events=${result.counts.events} articles=${result.counts.articles} static=${result.counts.static}`);
  for (const sample of result.samples) console.log(`  sample ${sample.family}: ${sample.file} → ${sample.url}`);
  if (!result.valid) {
    for (const error of result.errors) console.error(`::error::og-image gate: ${error}`);
    return 1;
  }
  console.log('✅ og:image registry/ownership gate passed');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = run();
}
