#!/usr/bin/env node
/**
 * download-missing-company-logos.mjs
 *
 * Downloads logos for companies in known-company-slugs.json that are NOT yet
 * in company-logos-manifest.json, using Google's favicon API with domain
 * guessing from the employer key.
 *
 * Domain guessing (tried in order until a non-grey-globe result):
 *   1. {key}.ch / {key}.com
 *   2. {stripped-key}.ch / {stripped-key}.com  (after removing -ag, -svizzera etc)
 *   3. {first-word}.ch / {first-word}.com
 *
 * Grey globe: Google returns exactly 726 bytes at sz=128 when no favicon found.
 * Those are silently skipped and the next domain candidate is tried.
 *
 * Usage:
 *   node scripts/download-missing-company-logos.mjs
 *   node scripts/download-missing-company-logos.mjs --dry-run
 *   node scripts/download-missing-company-logos.mjs --force   # re-download all
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const MANIFEST_PATH = path.join(ROOT, 'data', 'company-logos-manifest.json');
const KNOWN_SLUGS_PATH = path.join(ROOT, 'data', 'known-company-slugs.json');
const HISTORY_DIR = path.join(ROOT, 'data', 'jobs-snapshots-history');
const OUT_DIR = path.join(ROOT, 'public', 'images', 'brands');

const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 6;
const GREY_GLOBE_SIZE = 726; // bytes — Google's generic globe at sz=128

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

function detectExtFromBytes(buf) {
  if (!buf || buf.length < 8) return null;
  const s = buf.subarray(0, 8);
  if (s[0] === 0x89 && s[1] === 0x50) return 'png';
  if (s[0] === 0xff && s[1] === 0xd8) return 'jpg';
  if (s[0] === 0x47 && s[1] === 0x49) return 'gif';
  if (s[0] === 0x52 && s[1] === 0x49) return 'webp';
  if (s[0] === 0x00 && s[1] === 0x00 && s[2] === 0x01 && s[3] === 0x00) return 'ico';
  const head = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return null;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const STRIP_SUFFIXES = [
  '-ag', '-sa', '-spa', '-gmbh', '-ltd', '-inc', '-llc', '-plc', '-nv', '-bv',
  '-co-kg', '-co', '-srl', '-sarl', '-sas', '-sagl',
  '-svizzera', '-suisse', '-schweiz', '-switzerland', '-svizzero',
  '-ticino', '-lugano', '-bellinzona', '-locarno', '-chiasso', '-mendrisio',
  '-italia', '-italy', '-france', '-germany', '-deutschland',
  '-group', '-groups', '-holding', '-international', '-global', '-europe', '-world',
];

function stripSuffixes(slug) {
  let s = slug;
  let changed = true;
  while (changed) {
    changed = false;
    for (const sfx of STRIP_SUFFIXES) {
      if (s.endsWith(sfx) && s.length > sfx.length) {
        s = s.slice(0, -sfx.length);
        changed = true;
        break;
      }
    }
  }
  return s || slug;
}

// Manual overrides for companies where the slug doesn't hint at the right domain
const DOMAIN_OVERRIDES = {
  'badrutts-palace': ['badruttspalace.com'],
  'ferrovia-retica': ['rhb.ch'],
  'impresa-pizzarotti': ['pizzarotti.it'],
  'lonza': ['lonza.com'],
  'matterhorn-gotthard-bahn': ['mgb.ch'],
};

function domainCandidates(key) {
  if (DOMAIN_OVERRIDES[key]) return DOMAIN_OVERRIDES[key];
  const stripped = stripSuffixes(key);
  const firstWord = key.split('-')[0];
  const seen = new Set();
  const candidates = [];
  const add = (d) => { if (d && d.length > 1 && !seen.has(d)) { seen.add(d); candidates.push(d); } };

  // Swiss (.ch) first, then .com — favour local TLD for Ticino context
  add(`${key}.ch`);
  add(`${key}.com`);
  if (stripped !== key) {
    add(`${stripped}.ch`);
    add(`${stripped}.com`);
  }
  if (firstWord.length > 1 && firstWord !== key && firstWord !== stripped) {
    add(`${firstWord}.ch`);
    add(`${firstWord}.com`);
  }
  return candidates;
}

async function fetchTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoLogoBot/1.0)',
        Accept: 'image/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

async function tryGFavicon(domain) {
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  try {
    const res = await fetchTimeout(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length === GREY_GLOBE_SIZE) return null;
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = MIME_EXT[ct] || detectExtFromBytes(buf) || 'png';
    return { buf, ext, domain, size: buf.length };
  } catch {
    return null;
  }
}

async function downloadForKey(key) {
  for (const domain of domainCandidates(key)) {
    const result = await tryGFavicon(domain);
    if (result) return result;
  }
  return null;
}

async function runConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]);
    }
  }));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const [manifestRaw, slugsRaw] = await Promise.all([
    readFile(MANIFEST_PATH, 'utf8').catch(() => '{}'),
    readFile(KNOWN_SLUGS_PATH, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const companySlugs = JSON.parse(slugsRaw);

  // Build URL slug → employerKey and employerKey → name from latest snapshot
  const urlToKey = new Map();
  const keyToName = new Map();
  if (existsSync(HISTORY_DIR)) {
    const files = (await readdir(HISTORY_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
    if (files.length > 0) {
      const snap = JSON.parse(await readFile(path.join(HISTORY_DIR, files[0]), 'utf8'));
      for (const job of (snap.jobs || [])) {
        if (!job.employer || !job.employerKey) continue;
        const urlSlug = slugify(job.employer);
        if (!urlToKey.has(urlSlug)) urlToKey.set(urlSlug, job.employerKey);
        if (!keyToName.has(job.employerKey)) keyToName.set(job.employerKey, job.employer);
      }
    }
  }

  // Collect unique employer keys that still need a logo
  // Deduplicate: multiple URL slugs may map to the same employer key
  const seenKeys = new Set();
  const toDownload = [];
  for (const urlSlug of companySlugs) {
    const key = urlToKey.get(urlSlug) ?? urlSlug;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (!force && (manifest[key] || manifest[urlSlug])) continue;
    toDownload.push({ key, name: keyToName.get(key) ?? urlSlug });
  }

  const alreadyHave = [...seenKeys].filter((k) => manifest[k]).length;
  console.log(`[download-missing] Company slugs: ${companySlugs.length} → unique keys: ${seenKeys.size}`);
  console.log(`[download-missing] Already in manifest: ${alreadyHave} / ${seenKeys.size}`);
  console.log(`[download-missing] To download: ${toDownload.length}${dryRun ? ' (DRY RUN)' : ''}`);

  if (dryRun) {
    for (const { key, name } of toDownload) {
      console.log(`  ${key} ("${name}") → ${domainCandidates(key).join(', ')}`);
    }
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  let downloaded = 0, failed = 0;
  const results = await runConcurrent(toDownload, async ({ key, name }) => {
    const result = await downloadForKey(key);
    if (!result) {
      process.stdout.write(`  ✗ ${key}\n`);
      failed++;
      return { key, name, status: 'failed' };
    }
    const filename = `${key}.${result.ext}`;
    await writeFile(path.join(OUT_DIR, filename), result.buf);
    const publicPath = `/images/brands/${filename}`;
    manifest[key] = publicPath;
    downloaded++;
    process.stdout.write(`  ✓ ${key} (${result.domain}, ${result.size}B)\n`);
    return { key, name, status: 'downloaded', domain: result.domain, path: publicPath };
  }, CONCURRENCY);

  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(MANIFEST_PATH, JSON.stringify(sorted, null, 2) + '\n');

  console.log(`\n[download-missing] Done. downloaded=${downloaded} failed=${failed}`);
  console.log(`[download-missing] Manifest: ${MANIFEST_PATH}`);

  if (failed > 0) {
    console.log('\nNo logo found (no matching domain):');
    for (const r of results.filter((r) => r.status === 'failed')) {
      console.log(`  ✗ ${r.key} ("${r.name}")`);
    }
  }
}

main().catch((err) => {
  console.error('[download-missing-company-logos] Fatal:', err);
  process.exit(1);
});
