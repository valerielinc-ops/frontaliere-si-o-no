#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isValidRewriteCacheEntry,
  isValidSourceDescriptionHash,
  loadEventDescriptionRewriteCache,
  rewriteCacheKey,
} from '../lib/event-description-policy.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DATASET_PATHS = [
  path.join(ROOT, 'data', 'events.json'),
  path.join(ROOT, 'public', 'data', 'events.json'),
];
const CACHE_PATH = path.join(ROOT, 'data', 'events-description-rewrites.json');
const TRANSLATION_CACHE_PATH = path.join(ROOT, 'data', 'events-translation-cache.json');
const RAW_FIELDS = ['description', 'descriptionByLocale', 'sourceDescription', 'sourceDescriptionByLocale'];
const RAW_SOURCE_FIELDS = ['sourceDescription', 'sourceDescriptionByLocale'];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function hasRawDescription(event) {
  return RAW_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(event || {}, field));
}

function fail(code, details = {}) {
  return { code, ...details };
}

function checkSliceFiles() {
  const errors = [];
  const dir = path.join(ROOT, 'data', 'events', 'by-source');
  if (!existsSync(dir)) return errors;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const parsed = readJson(path.join(dir, file));
    for (const event of parsed.events || []) {
      if (hasRawDescription(event)) errors.push(fail('raw-description-in-source-slice', { file, id: event.id }));
      if (event.sourceDescriptionHash !== undefined && !isValidSourceDescriptionHash(event.sourceDescriptionHash)) {
        errors.push(fail('invalid-source-description-hash-in-source-slice', { file, id: event.id }));
      }
      if (event.descriptionRewriteValidated !== undefined) {
        errors.push(fail('rewrite-marker-in-source-slice', { file, id: event.id }));
      }
    }
  }
  return errors;
}

function checkDatasets(cache) {
  const errors = [];
  for (const filePath of DATASET_PATHS) {
    if (!existsSync(filePath)) continue;
    const dataset = readJson(filePath);
    for (const event of dataset.events || []) {
      if (event.sourceDescription || event.sourceDescriptionByLocale) {
        errors.push(fail('raw-source-description-in-dataset', { file: path.relative(ROOT, filePath), id: event.id }));
      }
      if (event.sourceDescriptionHash !== undefined && !isValidSourceDescriptionHash(event.sourceDescriptionHash)) {
        errors.push(fail('invalid-source-description-hash-in-dataset', { file: path.relative(ROOT, filePath), id: event.id }));
      }
      if (event.description && event.descriptionRewriteValidated !== true) {
        errors.push(fail('description-without-rewrite-marker', { file: path.relative(ROOT, filePath), id: event.id }));
      }
      if (!event.description && event.descriptionRewriteValidated !== undefined) {
        errors.push(fail('rewrite-marker-without-description', { file: path.relative(ROOT, filePath), id: event.id }));
      }
      if (event.descriptionByLocale && !event.description) {
        errors.push(fail('locale-description-without-default', { file: path.relative(ROOT, filePath), id: event.id }));
      }
      if (event.description) {
        const hash = event.sourceDescriptionHash;
        const entry = cache.entries?.[rewriteCacheKey(event.id, hash)];
        if (!isValidSourceDescriptionHash(hash) || !isValidRewriteCacheEntry(entry, { id: event.id, sourceHash: hash })) {
          errors.push(fail('description-without-valid-rewrite-cache', { file: path.relative(ROOT, filePath), id: event.id }));
        }
      }
    }
  }
  return errors;
}

function checkRewriteCache(cache) {
  const errors = [];
  for (const [key, entry] of Object.entries(cache.entries || {})) {
    if (Object.keys(entry || {}).some((field) => RAW_SOURCE_FIELDS.includes(field))) {
      errors.push(fail('raw-source-field-in-rewrite-cache', { key }));
    }
    if (key !== rewriteCacheKey(entry?.id, entry?.sourceDescriptionHash)) {
      errors.push(fail('rewrite-cache-key-mismatch', { key }));
    }
    if (!isValidRewriteCacheEntry(entry, { id: entry?.id, sourceHash: entry?.sourceDescriptionHash })) {
      errors.push(fail('invalid-rewrite-cache-entry', { key }));
    }
  }
  return errors;
}

function main() {
  const cache = loadEventDescriptionRewriteCache(CACHE_PATH);
  const errors = [
    ...checkSliceFiles(),
    ...checkDatasets(cache),
    ...checkRewriteCache(cache),
  ];
  if (existsSync(TRANSLATION_CACHE_PATH)) {
    const translationCache = readJson(TRANSLATION_CACHE_PATH);
    for (const key of Object.keys(translationCache || {})) {
      if (key.startsWith('description::')) errors.push(fail('description-translation-cache-entry', { key }));
    }
  }
  if (errors.length) {
    console.error(JSON.stringify({ ok: false, errors: errors.slice(0, 50), errorCount: errors.length }));
    process.exitCode = 1;
    return;
  }
  const dataset = existsSync(DATASET_PATHS[0]) ? readJson(DATASET_PATHS[0]) : { events: [] };
  const rewritten = (dataset.events || []).filter((event) => event.description).length;
  console.log(JSON.stringify({ ok: true, datasets: DATASET_PATHS.filter(existsSync).length, events: (dataset.events || []).length, rewritten, cacheEntries: Object.keys(cache.entries || {}).length }));
}

main();
