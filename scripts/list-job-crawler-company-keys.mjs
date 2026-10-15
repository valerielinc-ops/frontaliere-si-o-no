#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeCompanyDefinition } from './lib/company-key.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const COMPANIES_TSX = path.resolve(ROOT, 'components', 'vita', 'TicinoCompanies.tsx');
const EXTRA = path.resolve(ROOT, 'data', 'ticino-companies-extra.json');

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
  const arr = JSON.parse(fs.readFileSync(EXTRA, 'utf8'));
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x === 'object' && x.name && x.website)
    .map((x) => canonicalizeCompanyDefinition({
      key: x.key,
      name: x.name,
      website: x.website,
      employees: Number(x.employees || 0),
    }));
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

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(companies.map((c) => c.key))}\n`);
} else {
  process.stdout.write(`${JSON.stringify(companies, null, 2)}\n`);
}
