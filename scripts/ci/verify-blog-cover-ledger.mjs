#!/usr/bin/env node
/**
 * CI gate: every currently published blog hero must resolve to a valid record.
 * An inferred historical cover is valid only when the ledger and unified
 * index carry its explicit no-credit record. The generation queue is status
 * metadata, never a licence exemption.
 */

import fs from 'node:fs';
import path from 'node:path';
import { coverKey, validateImageCreditRecord } from '../../packages/articles/engine/shared/imageCredits.mjs';
import { validateGeneratedImageRegistry } from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';
import { isExplicitInferredCover } from '../lib/blog-cover-decisions.mjs';

const ROOT = process.cwd();
const REGISTRIES = [
  'packages/articles/content/blog-articles-data.ts',
  'packages/articles/content/swiss-articles-data.ts',
];
const RECORD_DIR = path.join(ROOT, 'packages/articles/content/image-credits/blog');
const IMAGE_CREDITS_INDEX = path.join(ROOT, 'data/image-credits-blog.json');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function parseCovers(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const covers = new Set();
  const imageRx = /\bimage:\s*'([^']+)'/g;
  let match;
  while ((match = imageRx.exec(source))) {
    const key = coverKey(match[1]);
    if (key) covers.add(key);
  }
  return covers;
}

function recordForKey(key) {
  const file = path.join(RECORD_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function main() {
  const inventory = readJson(path.join(ROOT, 'data/blog-cover-ledger.json'));
  const replacements = readJson(path.join(ROOT, 'data/blog-cover-replacements.json'));
  const imageCreditsIndex = readJson(IMAGE_CREDITS_INDEX);
  const generatedRegistry = readJson(path.join(ROOT, 'data/blog-generated-image-registry.json'));
  if (!inventory || !replacements || !imageCreditsIndex) {
    throw new Error('blog-cover-ledger.json, blog-cover-replacements.json and image-credits-blog.json are required');
  }

  const generatedValidation = generatedRegistry
    ? validateGeneratedImageRegistry(generatedRegistry, { scope: 'article-hero' })
    : { valid: true, errors: [] };
  if (!generatedValidation.valid) throw new Error(`generated registry invalid: ${generatedValidation.errors.join('; ')}`);
  const generatedByUrl = new Map((generatedRegistry?.assets || []).map((record) => [record.imageUrl, record]));
  const currentKeys = new Set(REGISTRIES.flatMap((file) => [...parseCovers(file)]));
  const errors = [];
  const counts = { currentUnique: currentKeys.size, withRecord: 0, generated: 0, wikimedia: 0, inferred: 0 };
  for (const key of [...currentKeys].sort()) {
    const inventoryItem = inventory.covers[key];
    if (!inventoryItem) {
      errors.push(`${key}: missing from data/blog-cover-ledger.json`);
      continue;
    }
    const record = recordForKey(key);
    if (!record) {
      if (isExplicitInferredCover(inventoryItem, imageCreditsIndex.covers?.[key])) {
        counts.inferred += 1;
        continue;
      }
      errors.push(`${key}: published cover has no image-credit record`);
      continue;
    }
    const validation = validateImageCreditRecord(record);
    if (!validation.valid) {
      errors.push(`${key}: ${validation.errors.join('; ')}`);
      continue;
    }
    if (coverKey(record.cover) !== key) {
      errors.push(`${key}: record cover does not match key`);
      continue;
    }
    if (record.source === 'inferred') {
      counts.inferred += 1;
      continue;
    }
    if (record.source === 'generated-provider') {
      counts.generated += 1;
      const generated = generatedByUrl.get(record.generated.imageUrl);
      if (!generated || generated.sha256 !== record.generated.sha256) {
        errors.push(`${key}: generated record is absent or differs from data/blog-generated-image-registry.json`);
        continue;
      }
    } else {
      counts.wikimedia += 1;
    }
    counts.withRecord += 1;
  }

  for (const [key, item] of Object.entries(replacements.items || {})) {
    if (item.mode !== 'generated') errors.push(`${key}: replacement mode must be generated; fallback repointing is forbidden`);
    if (item.mode === 'generated' && item.fromCover !== item.toCover) {
      errors.push(`${key}: generated replacement must keep the article's own cover URL`);
    }
    if (item.mode === 'generated' && item.status === 'generated' && !recordForKey(key)) {
      errors.push(`${key}: generated replacement is marked complete without a credit record`);
    }
  }
  if (errors.length) {
    for (const error of errors.slice(0, 80)) console.error(`::error::${error}`);
    if (errors.length > 80) console.error(`::error::and ${errors.length - 80} more ledger errors`);
    process.exitCode = 1;
  }
  console.log(JSON.stringify({ ...counts, errors: errors.length }, null, 2));
}

main();
