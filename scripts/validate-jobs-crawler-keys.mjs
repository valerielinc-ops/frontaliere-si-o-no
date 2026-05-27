#!/usr/bin/env node
/**
 * validate-jobs-crawler-keys.mjs
 *
 * Hard-fail validation for crawler company keys/aliases before push.
 * Goal: catch unknown or ambiguous company keys locally, before remote workflows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const COMPANIES_TSX = path.resolve(ROOT, 'components', 'vita', 'TicinoCompanies.tsx');
const EXTRA_COMPANIES = path.resolve(ROOT, 'data', 'ticino-companies-extra.json');
const CRAWLER_CONFIG = path.resolve(ROOT, 'data', 'jobs-crawler-config.json');
const ADAPTERS_REGISTRY = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'registry.json');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeHost(raw = '') {
  const str = normalizeSpace(raw).toLowerCase();
  if (!str) return '';
  try {
    const u = new URL(str.includes('://') ? str : `https://${str}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function registrableDomain(host = '') {
  const h = normalizeHost(host);
  if (!h) return '';
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  return `${parts.at(-2)}.${parts.at(-1)}`;
}

function normalizeCompanyKey(input = '') {
  return String(input || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function parseCompanySourcesFromTsx(tsxSource) {
  const objects = tsxSource.match(/\{[^{}]*name:\s*'[^']+'[^{}]*\}/g) || [];
  const parsed = [];
  for (const raw of objects) {
    const name = raw.match(/name:\s*'([^']+)'/)?.[1];
    const website = raw.match(/website:\s*'([^']+)'/)?.[1];
    if (!name || !website) continue;
    const host = normalizeHost(website);
    if (!host) continue;
    parsed.push({ name: normalizeSpace(name), website, host });
  }
  return parsed;
}

function loadKnownCompanies() {
  if (!fs.existsSync(COMPANIES_TSX)) {
    throw new Error(`Missing companies source: ${COMPANIES_TSX}`);
  }
  const tsx = fs.readFileSync(COMPANIES_TSX, 'utf-8');
  const base = parseCompanySourcesFromTsx(tsx);
  const extraRaw = readJson(EXTRA_COMPANIES, []);
  const extra = Array.isArray(extraRaw)
    ? extraRaw
      .map((row) => ({
        name: normalizeSpace(row?.name || ''),
        website: normalizeSpace(row?.website || ''),
        host: normalizeHost(row?.website || ''),
      }))
      .filter((row) => row.name && row.host)
    : [];

  const all = [...base, ...extra].map((c) => ({
    ...c,
    key: normalizeCompanyKey(c.name),
  }));
  const byKey = new Map();
  for (const c of all) {
    if (!c.key) continue;
    if (!byKey.has(c.key)) byKey.set(c.key, c);
  }
  return [...byKey.values()];
}

function buildResolver(knownCompanies, configAliases = {}) {
  const knownCanonical = new Set(knownCompanies.map((c) => c.key).filter(Boolean));
  const aliasToCanonicals = new Map();

  const add = (aliasRaw, canonicalRaw) => {
    const alias = normalizeCompanyKey(aliasRaw);
    const canonical = normalizeCompanyKey(canonicalRaw);
    if (!alias || !canonical) return;
    if (!knownCanonical.has(canonical)) return;
    const set = aliasToCanonicals.get(alias) || new Set();
    set.add(canonical);
    aliasToCanonicals.set(alias, set);
  };

  for (const c of knownCompanies) {
    add(c.key, c.key);
    add(c.name, c.key);
    add(c.host, c.key);
    add(registrableDomain(c.host), c.key);
  }
  for (const [alias, canonical] of Object.entries(configAliases || {})) {
    add(alias, canonical);
  }

  const ambiguous = new Map();
  const resolved = new Map();
  for (const [alias, set] of aliasToCanonicals.entries()) {
    const vals = [...set];
    if (vals.length === 1) resolved.set(alias, vals[0]);
    else ambiguous.set(alias, vals.sort());
  }
  return { knownCanonical, resolved, ambiguous };
}

function parseEnvKeyList(nameA, nameB) {
  return String(process.env[nameA] || process.env[nameB] || '')
    .split(',')
    .map((x) => normalizeCompanyKey(x))
    .filter(Boolean);
}

function validateRequestedKeyList(label, keys, resolver) {
  const unknown = [];
  const ambiguous = [];
  for (const key of keys) {
    if (resolver.ambiguous.has(key)) {
      ambiguous.push(`${key}=>[${resolver.ambiguous.get(key).join('|')}]`);
      continue;
    }
    if (!resolver.resolved.has(key)) unknown.push(key);
  }
  if (unknown.length > 0 || ambiguous.length > 0) {
    const parts = [];
    if (unknown.length > 0) parts.push(`unknown=${unknown.join(', ')}`);
    if (ambiguous.length > 0) parts.push(`ambiguous=${ambiguous.join(', ')}`);
    throw new Error(`${label}: ${parts.join(' ; ')}`);
  }
}

function main() {
  const companies = loadKnownCompanies();
  if (companies.length === 0) throw new Error('No known companies parsed from sources');

  const cfg = readJson(CRAWLER_CONFIG, {});
  const companyCrawlerMode = (cfg?.companyCrawlerMode && typeof cfg.companyCrawlerMode === 'object')
    ? cfg.companyCrawlerMode
    : {};
  const companyKeyAliases = (cfg?.companyKeyAliases && typeof cfg.companyKeyAliases === 'object')
    ? cfg.companyKeyAliases
    : {};

  const resolver = buildResolver(companies, companyKeyAliases);

  const errors = [];
  const warnings = [];

  for (const [rawKey] of Object.entries(companyCrawlerMode)) {
    const key = normalizeCompanyKey(rawKey);
    if (!key) continue;
    if (resolver.ambiguous.has(key)) {
      errors.push(`companyCrawlerMode key "${rawKey}" is ambiguous (${resolver.ambiguous.get(key).join('|')})`);
      continue;
    }
    if (!resolver.resolved.has(key)) {
      errors.push(`companyCrawlerMode key "${rawKey}" is unknown`);
    }
  }

  const aliasTargetsByAlias = new Map();
  for (const [rawAlias, rawCanonical] of Object.entries(companyKeyAliases)) {
    const alias = normalizeCompanyKey(rawAlias);
    const canonical = normalizeCompanyKey(rawCanonical);
    if (!alias || !canonical) continue;
    if (!resolver.knownCanonical.has(canonical)) {
      errors.push(`companyKeyAliases "${rawAlias}" -> "${rawCanonical}" points to unknown canonical key "${canonical}"`);
    }
    const prev = aliasTargetsByAlias.get(alias);
    if (prev && prev !== canonical) {
      errors.push(`companyKeyAliases conflict: alias "${alias}" maps to both "${prev}" and "${canonical}"`);
    }
    aliasTargetsByAlias.set(alias, canonical);
  }

  const registry = readJson(ADAPTERS_REGISTRY, null);
  const adapterKeys = registry && typeof registry === 'object' && registry.adapters && typeof registry.adapters === 'object'
    ? Object.keys(registry.adapters)
    : [];
  for (const rawKey of adapterKeys) {
    const key = normalizeCompanyKey(rawKey);
    if (!key) continue;
    if (resolver.ambiguous.has(key)) {
      errors.push(`adapter registry key "${rawKey}" is ambiguous (${resolver.ambiguous.get(key).join('|')})`);
      continue;
    }
    if (!resolver.resolved.has(key)) {
      errors.push(`adapter registry key "${rawKey}" is unknown (add company or alias)`);
    }
  }

  try {
    validateRequestedKeyList(
      'JOBS_CRAWLER_COMPANY_KEYS',
      parseEnvKeyList('JOBS_CRAWLER_COMPANY_KEYS', 'JOBS_CRAWLER_COMPANY_KEY'),
      resolver
    );
    validateRequestedKeyList(
      'JOBS_CRAWLER_EXCLUDE_COMPANY_KEYS',
      parseEnvKeyList('JOBS_CRAWLER_EXCLUDE_COMPANY_KEYS', 'JOBS_CRAWLER_EXCLUDE_COMPANY_KEY'),
      resolver
    );
  } catch (err) {
    errors.push(err?.message || String(err));
  }

  if (resolver.ambiguous.size > 0) {
    warnings.push(`ambiguous auto-aliases detected: ${resolver.ambiguous.size} (safe unless referenced directly)`);
  }

  if (errors.length > 0) {
    console.error('❌ Jobs crawler key validation failed:');
    for (const err of errors) console.error(`   - ${err}`);
    process.exit(1);
  }

  console.log(
    `✅ Jobs crawler key validation passed ` +
    `(companies=${companies.length}, aliases=${resolver.resolved.size}, adapters=${adapterKeys.length})`
  );
  for (const warn of warnings) {
    console.warn(`⚠️  ${warn}`);
  }
}

main();
