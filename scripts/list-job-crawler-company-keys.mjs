#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const COMPANIES_TSX = path.resolve(ROOT, 'components', 'vita', 'TicinoCompanies.tsx');
const EXTRA = path.resolve(ROOT, 'data', 'ticino-companies-extra.json');

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
  const arr = JSON.parse(fs.readFileSync(EXTRA, 'utf8'));
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x === 'object' && x.name && x.website)
    .map((x) => ({ key: slugify(x.name), name: x.name, website: x.website }));
}

const tsx = fs.readFileSync(COMPANIES_TSX, 'utf8');
const all = [...parseTsxCompanies(tsx), ...loadExtra()];
const dedup = new Map();
for (const c of all) {
  if (!c.key) continue;
  if (!dedup.has(c.key)) dedup.set(c.key, c);
}
const companies = [...dedup.values()].sort((a, b) => a.name.localeCompare(b.name));

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(companies.map((c) => c.key))}\n`);
} else {
  process.stdout.write(`${JSON.stringify(companies, null, 2)}\n`);
}
