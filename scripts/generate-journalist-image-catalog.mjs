#!/usr/bin/env node
/**
 * Local, non-AI image catalog for the redazione cover-image picker
 * (components/pages/JournalistDashboardPage.tsx / services/journalistImageCatalog.ts).
 *
 * No network calls, no external service: the catalog is every real photo
 * already used by a published article (public/images/blog/*.webp — the
 * filename IS the article slug, e.g. "a2-melide-chiusure-notturne-lavori.webp"),
 * searched client-side by simple keyword overlap against the draft's own
 * title + body. Mirrors the same "filename keyword overlap" strategy already
 * used server-side by scripts/create-article.mjs's findBestFallbackImage(),
 * just exposed as a ranked multi-candidate list instead of a single silent pick.
 *
 * Run directly to do a full rescan (`node scripts/generate-journalist-image-catalog.mjs`).
 * appendCatalogEntry() is called incrementally by the two places that ever
 * write a new file into public/images/blog: create-article.mjs's automated
 * pipeline and publish-journalist-article.mjs's resolveHeroImage() upload path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_DIR = path.join(PROJECT_ROOT, 'public', 'images', 'blog');
const OUT_PATH = path.join(PROJECT_ROOT, 'public', 'data', 'journalist-image-catalog.json');

/** Meaningful (4+ char) lowercase word tokens from a blog image filename. */
export function wordsFromFilename(file) {
  return file
    .replace(/\.(webp|jpg|jpeg|png)$/i, '')
    .toLowerCase()
    .split(/[^a-zà-ÿ0-9]+/)
    .filter((w) => w.length >= 4);
}

/** Full rescan of public/images/blog — used for the initial/manual seed. */
export function buildCatalog() {
  const files = fs.existsSync(BLOG_DIR)
    ? fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith('.webp'))
    : [];
  return files
    .map((f) => ({ path: `/images/blog/${f}`, words: wordsFromFilename(f) }))
    .filter((entry) => entry.words.length > 0);
}

function readExistingCatalog() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeCatalog(catalog) {
  writeJsonAtomic(OUT_PATH, catalog, { compact: true });
}

/**
 * Appends a single newly-written blog image to the committed catalog
 * manifest without a full directory rescan. No-op (never throws) if the
 * entry is already present — safe to call unconditionally after any write
 * to public/images/blog/*.webp.
 */
export function appendCatalogEntry(blogImagePath) {
  try {
    const file = blogImagePath.replace(/^\/images\/blog\//, '');
    const words = wordsFromFilename(file);
    if (words.length === 0) return;
    const catalog = readExistingCatalog();
    if (catalog.some((entry) => entry.path === blogImagePath)) return;
    catalog.push({ path: blogImagePath, words });
    writeCatalog(catalog);
  } catch (err) {
    console.warn(`  ⚠️  appendCatalogEntry(${blogImagePath}) failed (non-fatal): ${err.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const catalog = buildCatalog();
  writeCatalog(catalog);
  console.log(`✅ Wrote ${catalog.length} entries to ${path.relative(PROJECT_ROOT, OUT_PATH)}`);
}
