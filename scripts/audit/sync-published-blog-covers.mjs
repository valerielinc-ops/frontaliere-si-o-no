#!/usr/bin/env node
/**
 * Add newly published blog covers to the site-owned ledger and compact index.
 *
 * The corpus sync writes article registries and cover blobs before it opens its
 * stable PR. This bounded writer closes that transaction without re-auditing
 * historical covers: existing entries are untouched, while a new cover is
 * recorded conservatively as inferred/no-credit until the dedicated licence
 * audit can prove a stronger source.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { coverKey } from '../../packages/articles/engine/shared/imageCredits.mjs';

const ROOT = process.cwd();
const LEDGER_PATH = path.join(ROOT, 'data/blog-cover-ledger.json');
const INDEX_PATH = path.join(ROOT, 'data/image-credits-blog.json');
const BASELINE_PATH = path.join(ROOT, 'data/blog-cover-corpus-baseline.json');
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date());
const REGISTRIES = [
  { section: 'frontaliere', file: 'packages/articles/content/blog-articles-data.ts' },
  { section: 'svizzera', file: 'packages/articles/content/swiss-articles-data.ts' },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseRegistry({ section, file }) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const articles = [];
  const objectRx = /\{\s*\n\s*id:\s*'([^']+)'([\s\S]*?)\n\s*\},?/g;
  let match;
  while ((match = objectRx.exec(source))) {
    const id = match[1];
    const block = match[0];
    const image = block.match(/\bimage:\s*'([^']+)'/)?.[1];
    if (!image) continue;
    articles.push({
      section,
      id,
      image,
      category: block.match(/\bcategory:\s*'([^']+)'/)?.[1] || null,
      date: block.match(/\bdate:\s*'([^']+)'/)?.[1] || null,
      updatedAt: block.match(/\bupdatedAt:\s*'([^']+)'/)?.[1] || null,
      authorSlug: block.match(/\bauthorSlug:\s*'([^']+)'/)?.[1] || null,
    });
  }
  return articles;
}

function coverBytes(image) {
  const relative = `public/${image.replace(/^\/+/, '')}`;
  const expectedRoot = path.join(ROOT, 'public/images/blog');
  const absolute = path.resolve(ROOT, relative);
  if (!absolute.startsWith(`${expectedRoot}${path.sep}`)) {
    throw new Error(`Refusing non-blog cover path: ${image}`);
  }
  if (fs.existsSync(absolute)) return fs.readFileSync(absolute);
  try {
    return execFileSync('git', ['show', `HEAD:${relative}`], {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Published cover blob is unavailable: ${relative}`);
  }
}

function priority(article) {
  return Math.round((Date.parse(article.updatedAt || article.date || '') || 0) / 1e9);
}

function reference(article) {
  const { section, id, category, date, updatedAt, authorSlug } = article;
  return { section, id, category, date, updatedAt, authorSlug };
}

function refreshCounts(ledger) {
  const entries = Object.values(ledger.covers);
  const levels = Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => [String(level), 0]));
  for (const item of entries) {
    const level = String(item.proofLevel);
    if (Object.hasOwn(levels, level)) levels[level] += 1;
  }
  const published = entries.filter((item) => item.published);
  ledger.counts = {
    ...ledger.counts,
    allCoversByProofLevel: levels,
    publishedCovers: published.length,
    publishedWithExistingOrInheritedRecord: published.filter((item) => item.action === 'keep' || item.action === 'copy-record').length,
    publishedReplacements: published.filter((item) => String(item.action || '').startsWith('replace-')).length,
  };
}

function main() {
  const ledger = readJson(LEDGER_PATH);
  const index = readJson(INDEX_PATH);
  const baseline = readJson(BASELINE_PATH);
  if (!ledger.covers || !index.covers || !baseline.registries) {
    throw new Error('Blog cover ledger, compact index and corpus baseline are required');
  }

  const byKey = new Map();
  const registryArticles = new Map(REGISTRIES.map((registry) => [registry.file, parseRegistry(registry)]));
  for (const article of [...registryArticles.values()].flat()) {
    const key = coverKey(article.image);
    if (!key) continue;
    const entries = byKey.get(key) || [];
    entries.push(article);
    byKey.set(key, entries);
  }

  // Resolve every blob before writing either file: one unavailable cover keeps
  // the paired ledger/index update fail-closed, with no partial data rewrite.
  const additions = [];
  for (const [key, articles] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    if (ledger.covers[key]) continue;
    const sorted = articles.slice().sort((a, b) => priority(b) - priority(a));
    const bytes = coverBytes(sorted[0].image);
    additions.push({ key, articles: sorted, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
  }

  for (const { key, articles, hash } of additions) {
    ledger.covers[key] = {
      cover: articles[0].image,
      hash,
      published: true,
      historicalPublished: true,
      references: articles.map(reference),
      proofLevel: 6,
      evidence: 'inferred',
      recordFile: null,
      inheritedFrom: null,
      action: 'record-inferred',
      reason: 'Copertina senza prova certa; conservata con record inferred senza credito.',
      priority: priority(articles[0]),
      verifiedAt: TODAY,
      provider: null,
      currentlyPublished: true,
      status: 'no-credit',
    };
    index.covers[key] = {
      evidence: 'inferred',
      provider: null,
      verifiedAt: TODAY,
      status: 'no-credit',
    };
  }

  const repairedIndexKeys = [];
  for (const key of [...byKey.keys()].sort()) {
    const item = ledger.covers[key];
    if (index.covers[key]
      || item?.proofLevel !== 6
      || item?.evidence !== 'inferred'
      || typeof item?.verifiedAt !== 'string') continue;
    index.covers[key] = {
      evidence: 'inferred',
      provider: null,
      verifiedAt: item.verifiedAt,
      status: 'no-credit',
    };
    repairedIndexKeys.push(key);
  }

  const sourceCommit = process.env.ARTICLES_SYNC_COMMIT || null;
  if (sourceCommit && !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error('ARTICLES_SYNC_COMMIT must be a full lowercase Git SHA');
  }
  const beforeBaseline = JSON.stringify(baseline);
  if (sourceCommit) baseline.sourceCommit = sourceCommit;
  baseline.generatedAt = TODAY;
  for (const { file } of REGISTRIES) {
    const articles = registryArticles.get(file);
    const entry = baseline.registries[file];
    if (!entry) throw new Error(`Corpus baseline is missing registry: ${file}`);
    entry.articles = articles.length;
    entry.distinctImages = new Set(articles.map(({ image }) => image)).size;
  }
  const baselineUpdated = JSON.stringify(baseline) !== beforeBaseline;

  if (additions.length || repairedIndexKeys.length || baselineUpdated) {
    ledger.generatedAt = TODAY;
    index.covers = Object.fromEntries(Object.entries(index.covers).sort(([a], [b]) => a.localeCompare(b)));
    refreshCounts(ledger);
    writeJson(LEDGER_PATH, ledger);
    writeJson(INDEX_PATH, index);
    writeJson(BASELINE_PATH, baseline);
  }

  console.log(JSON.stringify({
    added: additions.length,
    keys: additions.map(({ key }) => key),
    repairedIndexKeys,
    baselineUpdated,
  }, null, 2));
}

main();
