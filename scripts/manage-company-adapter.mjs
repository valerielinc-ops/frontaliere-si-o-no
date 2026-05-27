#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters');
const REGISTRY_PATH = path.resolve(ADAPTERS_DIR, 'registry.json');

const ADAPTER_KEY = String(process.env.ADAPTER_KEY || '').trim().toLowerCase();
const ADAPTER_ACTION = String(process.env.ADAPTER_ACTION || '').trim().toLowerCase();
const ADAPTER_ENABLED = String(process.env.ADAPTER_ENABLED || '').trim().toLowerCase();

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeHost(raw = '') {
  try {
    return new URL(String(raw)).hostname.toLowerCase().replace(/^www\d?\./, '');
  } catch {
    return String(raw || '').trim().toLowerCase().replace(/^www\d?\./, '');
  }
}

function defaultSeedUrlsFromHost(host = '') {
  if (!host) return [];
  const base = `https://${host}`;
  const hints = ['/careers', '/career', '/jobs', '/karriere', '/offene-stellen', '/lavora-con-noi'];
  return hints.map((h) => `${base}${h}`);
}

function clampModes(input) {
  const allowed = new Set(['workday', 'teaser_api', 'generic_ats', 'html', 'jsonld', 'greenhouse', 'lever', 'smartrecruiters']);
  const list = Array.isArray(input) ? input : [];
  const out = list.map((x) => String(x || '').trim().toLowerCase()).filter((x) => allowed.has(x));
  return out.length > 0 ? [...new Set(out)] : ['generic_ats', 'html', 'jsonld'];
}

function ensureAdapterDefaults(adapter) {
  const host = normalizeHost(adapter.companyHost || '');
  const seeds = Array.isArray(adapter.seedUrls)
    ? adapter.seedUrls.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  return {
    ...adapter,
    companyHost: host,
    crawlerModes: clampModes(adapter.crawlerModes),
    seedUrls: seeds.length > 0 ? [...new Set(seeds)] : defaultSeedUrlsFromHost(host),
  };
}

function main() {
  if (!ADAPTER_KEY) {
    throw new Error('Missing ADAPTER_KEY');
  }
  if (!ADAPTER_ACTION || !['set_enabled', 'regenerate'].includes(ADAPTER_ACTION)) {
    throw new Error('Invalid ADAPTER_ACTION. Use set_enabled | regenerate');
  }

  const registry = readJson(REGISTRY_PATH, null);
  const relPath = registry?.adapters?.[ADAPTER_KEY];
  if (!relPath) {
    throw new Error(`Adapter key not found in registry: ${ADAPTER_KEY}`);
  }

  const absPath = path.resolve(ADAPTERS_DIR, relPath);
  const current = readJson(absPath, null);
  if (!current || typeof current !== 'object') {
    throw new Error(`Adapter file missing/invalid: ${relPath}`);
  }

  let next = { ...current };
  if (ADAPTER_ACTION === 'set_enabled') {
    if (!['true', 'false'].includes(ADAPTER_ENABLED)) {
      throw new Error('ADAPTER_ENABLED must be true|false for set_enabled');
    }
    next.enabled = ADAPTER_ENABLED === 'true';
  }

  next = ensureAdapterDefaults(next);
  next.updatedAt = new Date().toISOString();

  writeJson(absPath, next);
  console.log(`✅ Adapter updated: key=${ADAPTER_KEY}, action=${ADAPTER_ACTION}, enabled=${String(next.enabled)}`);
}

main();
