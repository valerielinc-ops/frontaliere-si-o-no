#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { canonicalizeCompanyDefinition } from './lib/company-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANIES_TSX = path.resolve(ROOT, 'components', 'vita', 'TicinoCompanies.tsx');
const EXTRA = path.resolve(ROOT, 'data', 'ticino-companies-extra.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters');
const REGISTRY_PATH = path.resolve(ADAPTERS_DIR, 'registry.json');
const META_PATH = path.resolve(ADAPTERS_DIR, '_meta.json');

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
    const employees = Number(raw.match(/employees:\s*(\d+)/)?.[1] || 0);
    if (!name || !website) continue;
    out.push(canonicalizeCompanyDefinition({ name, website, employees }));
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
      .map((x) => canonicalizeCompanyDefinition({
        key: x.key,
        name: String(x.name),
        website: String(x.website),
        employees: Number(x.employees || 0),
      }));
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
  const prev = dedup.get(normalizeHost(c.website));
  const preferred = !prev || c.employees > prev.employees ? c : prev;
  const aliases = [...new Set([
    ...(prev?.companyKeyAliases || []),
    ...(c.companyKeyAliases || []),
  ])].filter((alias) => alias && alias !== preferred.key);
  dedup.set(normalizeHost(c.website), {
    ...preferred,
    ...(aliases.length > 0 ? { companyKeyAliases: aliases } : {}),
  });
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
  let existing = readJson(absPath, null);
  if (!existing) {
    for (const alias of company.companyKeyAliases || []) {
      const legacyPath = path.resolve(ADAPTERS_DIR, 'adapters', `${alias}.json`);
      const legacy = readJson(legacyPath, null);
      if (legacy) {
        existing = legacy;
        break;
      }
    }
  }
  const companyKeyAliases = [...new Set([
    ...(company.companyKeyAliases || []),
    ...(Array.isArray(existing?.companyKeyAliases) ? existing.companyKeyAliases : []),
  ])].filter((alias) => alias && alias !== company.key);
  const next = {
    companyKey: company.key,
    ...(companyKeyAliases.length > 0 ? { companyKeyAliases } : {}),
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
