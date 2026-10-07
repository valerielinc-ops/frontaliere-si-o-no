#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * Build gate for the images emitted in `<meta property="og:image">`.
 *
 * It samples the three build families that matter to sharing: event-library
 * images, article heroes and static-page cards. Every sampled URL must be a
 * recorded generated asset / credited cover, or one of the small explicit
 * site-owned exceptions in published-image-policy.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITE_ORIGIN,
  loadPublishedImagePolicy,
} from './lib/published-image-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function walkHtml(root) {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) files.push(filePath);
    }
  };
  visit(root);
  return files.sort();
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

export function collectOgImageReferences(distDir) {
  const references = [];
  for (const filePath of walkHtml(distDir)) {
    const relative = path.relative(distDir, filePath).split(path.sep).join('/');
    const pageUrl = new URL(relative, `${SITE_ORIGIN}/`).href;
    const html = fs.readFileSync(filePath, 'utf8');
    for (const url of extractOgImageUrls(html, pageUrl)) {
      references.push({ file: relative, url });
    }
  }
  return references;
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

export function verifyOgImageReferences(references, { policy, sampleSize = 3, requireFamilies = true } = {}) {
  const selected = representative(references, sampleSize);
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
  const references = collectOgImageReferences(distDir);
  const result = verifyOgImageReferences(references, { policy, sampleSize, requireFamilies });
  if (policy.registryErrors.length > 0) {
    result.valid = false;
    result.errors.unshift(...policy.registryErrors.map((error) => `registry: ${error}`));
  }

  console.log(`og:image references: ${references.length}; sample events=${result.counts.events} articles=${result.counts.articles} static=${result.counts.static}`);
  for (const sample of result.samples) console.log(`  sample ${sample.family}: ${sample.file} → ${sample.url}`);
  if (!result.valid) {
    for (const error of result.errors) console.error(`::error::og-image gate: ${error}`);
    return 1;
  }
  console.log('✅ og:image registry/ownership gate passed');
  return 0;
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  process.exitCode = run();
}
