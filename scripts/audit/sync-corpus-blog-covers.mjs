#!/usr/bin/env node

/**
 * Carry site-side licence-audit blog replacements into the corpus publisher.
 * The article URL remains unchanged; this copies the exact new hero and
 * thumbnail bytes and upserts the same governed record before a corpus PR.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateGeneratedImageRecord,
  validateGeneratedImageRegistry,
} from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

function safePath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`path escapes checkout: ${relativePath}`);
  }
  return resolved;
}

function blogTargetForUrl(imageUrl) {
  if (!/^\/images\/blog\/[a-z0-9][a-z0-9._-]{2,127}\.webp$/.test(String(imageUrl || ''))) {
    throw new Error(`audit replacement is not a canonical blog hero URL: ${imageUrl}`);
  }
  return `public${imageUrl}`;
}

function thumbnailTargetForUrl(imageUrl) {
  const filename = path.basename(imageUrl, '.webp');
  return `public/images/blog/thumbnails/${filename}-480w.webp`;
}

export function buildCorpusBlogCoverSyncItems({
  report,
  siteRoot,
  siteRegistryPath = path.join(siteRoot, 'data', 'blog-generated-image-registry.json'),
}) {
  const registry = readJson(siteRegistryPath, { assets: [] });
  const assets = Array.isArray(registry?.assets) ? registry.assets : [];
  const actions = Array.isArray(report?.actions?.generated) ? report.actions.generated : [];
  const seen = new Set();
  const items = [];
  for (const action of actions.filter((item) => item?.kind === 'article-hero')) {
    const imageUrl = String(action.imageUrl || '');
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    const record = assets.find((item) => item?.imageUrl === imageUrl || item?.assetId === action.assetId);
    const validation = validateGeneratedImageRecord(record, { scope: 'article-hero' });
    if (!validation.valid) {
      throw new Error(`${imageUrl}: site blog record is invalid: ${validation.errors.join('; ')}`);
    }
    const heroRelativePath = blogTargetForUrl(imageUrl);
    const thumbnailRelativePath = thumbnailTargetForUrl(imageUrl);
    const heroPath = safePath(siteRoot, heroRelativePath);
    const thumbnailPath = safePath(siteRoot, thumbnailRelativePath);
    if (!fs.existsSync(heroPath)) throw new Error(`${imageUrl}: generated hero is missing from the site checkout`);
    if (!fs.existsSync(thumbnailPath)) throw new Error(`${imageUrl}: generated thumbnail is missing from the site checkout`);
    items.push({
      assetId: record.assetId,
      imageUrl,
      record,
      sourceFiles: {
        hero: heroRelativePath,
        thumbnail: thumbnailRelativePath,
      },
      targetFiles: {
        hero: heroRelativePath,
        thumbnail: thumbnailRelativePath,
      },
    });
  }
  return items;
}

export function syncCorpusBlogCovers({
  report,
  siteRoot,
  corpusRoot,
  siteRegistryPath = path.join(siteRoot, 'data', 'blog-generated-image-registry.json'),
  corpusRegistryPath = path.join(corpusRoot, 'data', 'generated-image-registry.json'),
}) {
  const items = buildCorpusBlogCoverSyncItems({ report, siteRoot, siteRegistryPath });
  if (!items.length) return { items: [], changed: false };

  const current = readJson(corpusRegistryPath, { schema: 1, assetCount: 0, assets: [] });
  const registryValidation = validateGeneratedImageRegistry(current);
  if (!registryValidation.valid) {
    throw new Error(`corpus generated image registry is invalid: ${registryValidation.errors.join('; ')}`);
  }
  const assets = new Map((current.assets || []).map((record) => [record.assetId, record]));
  for (const item of items) {
    fs.mkdirSync(path.dirname(safePath(corpusRoot, item.targetFiles.hero)), { recursive: true });
    fs.mkdirSync(path.dirname(safePath(corpusRoot, item.targetFiles.thumbnail)), { recursive: true });
    fs.copyFileSync(safePath(siteRoot, item.sourceFiles.hero), safePath(corpusRoot, item.targetFiles.hero));
    fs.copyFileSync(safePath(siteRoot, item.sourceFiles.thumbnail), safePath(corpusRoot, item.targetFiles.thumbnail));
    for (const [assetId, record] of assets) {
      if (record.imageUrl === item.record.imageUrl && assetId !== item.record.assetId) {
        assets.delete(assetId);
      }
    }
    assets.set(item.record.assetId, item.record);
  }
  const next = {
    ...current,
    schema: 1,
    assetCount: assets.size,
    assets: [...assets.values()].sort((left, right) => String(left.imageUrl).localeCompare(String(right.imageUrl))),
  };
  const nextValidation = validateGeneratedImageRegistry(next);
  if (!nextValidation.valid) {
    throw new Error(`corpus generated image registry after sync is invalid: ${nextValidation.errors.join('; ')}`);
  }
  writeJson(corpusRegistryPath, next);
  return {
    items,
    changed: true,
    files: items.flatMap((item) => [item.targetFiles.hero, item.targetFiles.thumbnail]),
  };
}

function parseArgs(argv) {
  const args = { report: null, siteRoot: process.cwd(), corpusRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report') args.report = argv[++index];
    else if (arg === '--site-root') args.siteRoot = argv[++index];
    else if (arg === '--corpus-root') args.corpusRoot = argv[++index];
    else if (arg === '--help') {
      console.log('Usage: sync-corpus-blog-covers.mjs --report FILE --corpus-root DIR [--site-root DIR]');
      return null;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.report || !args.corpusRoot) throw new Error('--report and --corpus-root are required');
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args) process.exit(0);
    const report = readJson(path.resolve(args.siteRoot, args.report));
    if (!report) throw new Error(`report is not valid JSON: ${args.report}`);
    console.log(JSON.stringify(syncCorpusBlogCovers({
      report,
      siteRoot: path.resolve(args.siteRoot),
      corpusRoot: path.resolve(args.corpusRoot),
    })));
  } catch (error) {
    console.error(`[sync-corpus-blog-covers] ${String(error?.stack || error)}`);
    process.exitCode = 1;
  }
}
