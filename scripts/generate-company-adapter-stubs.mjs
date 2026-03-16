#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANIES_TSX = path.resolve(ROOT, 'components', 'vita', 'TicinoCompanies.tsx');
const EXTRA = path.resolve(ROOT, 'data', 'ticino-companies-extra.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters');
const REGISTRY_PATH = path.resolve(ADAPTERS_DIR, 'registry.json');
const META_PATH = path.resolve(ADAPTERS_DIR, '_meta.json');

function slugify(input = '') {
  return String(input || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizeHost(rawUrl = '') {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\d?\./, '');
  } catch {
    return '';
  }
}

function parseTsxCompanies(tsxSource) {
  const objects = tsxSource.match(/\{[^{}]*name:\s*'[^']+'[^{}]*\}/g) || [];
  const out = [];
  for (const raw of objects) {
    const name = raw.match(/name:\s*'([^']+)'/)?.[1];
    const website = raw.match(/website:\s*'([^']+)'/)?.[1];
    if (!name || !website) continue;
    out.push({ key: slugify(name), name, website });
  }
  return out;
}

function loadExtra() {
  if (!fs.existsSync(EXTRA)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(EXTRA, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === 'object' && x.name && x.website)
      .map((x) => ({ key: slugify(x.name), name: String(x.name), website: String(x.website) }));
  } catch {
    return [];
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function defaultSeedUrls(website) {
  const out = [];
  try {
    const base = new URL(website);
    const hints = ['/careers', '/career', '/jobs', '/karriere', '/offene-stellen', '/lavora-con-noi'];
    for (const hint of hints) {
      out.push(new URL(hint, base).toString());
    }
  } catch {
    // noop
  }
  return out;
}

const tsx = fs.readFileSync(COMPANIES_TSX, 'utf8');
const all = [...parseTsxCompanies(tsx), ...loadExtra()];
const dedup = new Map();
for (const c of all) {
  if (!c.key) continue;
  if (!dedup.has(c.key)) dedup.set(c.key, c);
}
const companies = [...dedup.values()].sort((a, b) => a.name.localeCompare(b.name));

const currentRegistry = readJson(REGISTRY_PATH, { adapters: {} });
const currentAdapters = currentRegistry && typeof currentRegistry === 'object' && currentRegistry.adapters && typeof currentRegistry.adapters === 'object'
  ? currentRegistry.adapters
  : {};

const registryOut = {};
let created = 0;
let updated = 0;

for (const company of companies) {
  const host = normalizeHost(company.website);
  if (!host) continue;

  const fileName = `${company.key}.json`;
  const relPath = `adapters/${fileName}`;
  const absPath = path.resolve(ADAPTERS_DIR, relPath);
  const existing = readJson(absPath, null);
  const next = {
    companyKey: company.key,
    companyName: company.name,
    companyHost: host,
    enabled: true,
    priority: 0,
    crawlerModes: existing?.crawlerModes || ['generic_ats', 'html', 'jsonld'],
    seedUrls: Array.isArray(existing?.seedUrls) && existing.seedUrls.length > 0
      ? existing.seedUrls
      : defaultSeedUrls(company.website),
    notes: existing?.notes || '',
    updatedAt: new Date().toISOString(),
  };

  const existed = fs.existsSync(absPath);
  writeJson(absPath, next);
  if (existed) updated += 1;
  else created += 1;
  registryOut[company.key] = relPath;
}

writeJson(REGISTRY_PATH, { generatedAt: new Date().toISOString(), adapters: registryOut });
writeJson(META_PATH, {
  generatedAt: new Date().toISOString(),
  totalCompanies: companies.length,
  totalAdapters: Object.keys(registryOut).length,
  created,
  updated,
});

console.log(`✅ Adapter stubs generated: total=${Object.keys(registryOut).length}, created=${created}, updated=${updated}`);

