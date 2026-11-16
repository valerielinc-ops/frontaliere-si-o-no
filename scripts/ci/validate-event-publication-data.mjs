#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATASET_PATH = 'data/events.json';
const PUBLIC_DATASET_PATH = 'public/data/events.json';
const GEOCODE_PATH = 'data/events-geocode-cache.json';
const TRANSLATION_PATH = 'data/events-translation-cache.json';
const MANIFEST_PATH = 'data/events-image-manifest.json';
const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function add(errors, file, field, message) {
  errors.push(`${file}:${field}: ${message}`);
}

function validateDataset(value, file, errors, nowMs) {
  if (!isObject(value)) {
    add(errors, file, '$', 'dataset deve essere un oggetto');
    return;
  }
  if (value.schemaVersion !== 1) add(errors, file, 'schemaVersion', 'deve essere 1');
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) {
    add(errors, file, 'generatedAt', 'timestamp ISO non valido');
  } else if (Date.parse(value.generatedAt) > nowMs + 5 * 60 * 1000) {
    add(errors, file, 'generatedAt', 'timestamp nel futuro oltre 5 minuti');
  }
  if (!Array.isArray(value.events) || value.events.length === 0) {
    add(errors, file, 'events', 'array non vuoto richiesto');
    return;
  }
  if (value.totalEvents !== value.events.length) {
    add(errors, file, 'totalEvents', `deve coincidere con events.length (${value.events.length})`);
  }
  const ids = new Set();
  for (const [index, event] of value.events.entries()) {
    const field = `events[${index}]`;
    if (!isObject(event)) {
      add(errors, file, field, 'evento deve essere un oggetto');
      continue;
    }
    if (typeof event.id !== 'string' || !event.id.trim()) add(errors, file, `${field}.id`, 'stringa non vuota richiesta');
    else if (ids.has(event.id)) add(errors, file, `${field}.id`, `id duplicato: ${event.id}`);
    else ids.add(event.id);
    if (typeof event.title !== 'string' || !event.title.trim()) add(errors, file, `${field}.title`, 'stringa non vuota richiesta');
    if (!isDate(event.startDate)) add(errors, file, `${field}.startDate`, 'data YYYY-MM-DD non valida');
    if (event.endDate !== undefined && event.endDate !== null && event.endDate !== '' && !isDate(event.endDate)) {
      add(errors, file, `${field}.endDate`, 'data YYYY-MM-DD non valida');
    }
  }
}

function validateGeocodeCache(value, errors) {
  if (!isObject(value)) {
    add(errors, GEOCODE_PATH, '$', 'cache deve essere un oggetto');
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) add(errors, GEOCODE_PATH, '$', 'chiave vuota');
    if (entry === null) continue;
    if (!isObject(entry)) {
      add(errors, GEOCODE_PATH, key, 'voce deve essere un oggetto o null');
      continue;
    }
    const coordinates = Number.isFinite(entry.lat) && Number.isFinite(entry.lng)
      && entry.lat >= -90 && entry.lat <= 90 && entry.lng >= -180 && entry.lng <= 180;
    const locality = typeof entry.canton === 'string'
      && entry.canton.trim().length > 0
      && (entry.comune === null || typeof entry.comune === 'string');
    if (!coordinates && !locality) add(errors, GEOCODE_PATH, key, 'coordinate o località cantonale valide richieste');
  }
}

function validateTranslationCache(value, errors) {
  if (!isObject(value)) {
    add(errors, TRANSLATION_PATH, '$', 'cache deve essere un oggetto');
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) add(errors, TRANSLATION_PATH, '$', 'chiave vuota');
    if (!isObject(entry) || Object.keys(entry).length === 0) {
      add(errors, TRANSLATION_PATH, key, 'mappa locale non vuota richiesta');
      continue;
    }
    for (const [locale, text] of Object.entries(entry)) {
      if (!LOCALES.has(locale)) add(errors, TRANSLATION_PATH, `${key}.${locale}`, 'locale non supportata');
      if (text !== null && (typeof text !== 'string' || !text.trim())) {
        add(errors, TRANSLATION_PATH, `${key}.${locale}`, 'traduzione non vuota o null richiesta');
      }
    }
  }
}

function validateImageManifest(value, errors) {
  if (!isObject(value)) {
    add(errors, MANIFEST_PATH, '$', 'manifest deve essere un oggetto');
    return;
  }
  for (const [safeId, extension] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]+$/u.test(safeId)) add(errors, MANIFEST_PATH, safeId, 'id immagine non sicuro');
    if (typeof extension !== 'string' || !IMAGE_EXTENSIONS.has(extension.toLowerCase())) {
      add(errors, MANIFEST_PATH, safeId, 'estensione immagine non supportata');
    }
  }
}

function validateCacheKeyContinuity(value, baseline, file, errors) {
  if (!isObject(value) || !isObject(baseline)) return;
  const missing = Object.keys(baseline).filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length === 0) return;
  const sample = missing.slice(0, 10).join(', ');
  const suffix = missing.length > 10 ? `, ... (+${missing.length - 10})` : '';
  add(errors, file, '$', `cache troncata: mancano ${missing.length} chiavi presenti su HEAD (${sample}${suffix})`);
}

export function validateEventPublicationData({
  dataset,
  publicDataset,
  geocodeCache,
  translationCache,
  imageManifest,
  baselineGeocodeCache = null,
  baselineTranslationCache = null,
  now = new Date(),
}) {
  const errors = [];
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  validateDataset(dataset, DATASET_PATH, errors, nowMs);
  validateDataset(publicDataset, PUBLIC_DATASET_PATH, errors, nowMs);
  if (JSON.stringify(dataset) !== JSON.stringify(publicDataset)) {
    add(errors, PUBLIC_DATASET_PATH, '$', 'deve essere identico a data/events.json');
  }
  validateGeocodeCache(geocodeCache, errors);
  validateTranslationCache(translationCache, errors);
  validateImageManifest(imageManifest, errors);
  validateCacheKeyContinuity(geocodeCache, baselineGeocodeCache, GEOCODE_PATH, errors);
  validateCacheKeyContinuity(translationCache, baselineTranslationCache, TRANSLATION_PATH, errors);
  return errors;
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

export function readHeadJson(root, relative) {
  const object = `HEAD:${relative}`;
  try {
    execFileSync('git', ['cat-file', '-e', object], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? '');
    if (error?.status === 128 && stderr.includes(`path '${relative}' does not exist in 'HEAD'`)) return null;
    throw error;
  }
  return JSON.parse(execFileSync('git', ['show', object], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function main(root = ROOT) {
  let values;
  try {
    values = {
      dataset: readJson(root, DATASET_PATH),
      publicDataset: readJson(root, PUBLIC_DATASET_PATH),
      geocodeCache: readJson(root, GEOCODE_PATH),
      translationCache: readJson(root, TRANSLATION_PATH),
      imageManifest: readJson(root, MANIFEST_PATH),
      baselineGeocodeCache: readHeadJson(root, GEOCODE_PATH),
      baselineTranslationCache: readHeadJson(root, TRANSLATION_PATH),
    };
  } catch (error) {
    console.error(`❌ dati eventi non leggibili: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const errors = validateEventPublicationData(values);
  if (errors.length > 0) {
    console.error(`❌ dati eventi non pubblicabili: ${errors.length} errore/i`);
    for (const error of errors.slice(0, 100)) console.error(`   - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ dati eventi validi: ${values.dataset.events.length} eventi, ${Object.keys(values.geocodeCache).length} geocode, ${Object.keys(values.translationCache).length} traduzioni, ${Object.keys(values.imageManifest).length} immagini`);
}

if (process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})()) main();
