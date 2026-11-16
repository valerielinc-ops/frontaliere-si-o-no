#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { readSitemapSnapshot } from '../lib/sitemap-snapshot.mjs';
import {
  SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION,
  SITEMAP_FAMILY_CHURN_TOLERANCE,
  sitemapFamilyUrlDifferences,
} from '../lib/sitemap-family-coverage.mjs';

export const BRIDGE_EVIDENCE_KIND = 'sitemap-family-bridge-evidence';

function routeCandidates(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return []; }
  if (parsed.origin !== 'https://frontaliereticino.ch') return [];
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { return []; }
  if (pathname.includes('\0') || pathname.split('/').includes('..')) return [];
  if (pathname === '/') return ['index.html'];
  const relative = pathname.replace(/^\/+|\/+$/gu, '');
  if (path.posix.extname(relative)) return [relative];
  return [`${relative}/index.html`, `${relative}.html`];
}

function hasNoindexFollow(html) {
  const tags = html.match(/<meta\b[^>]*>/giu) ?? [];
  return tags.some((tag) => {
    const nameFirst = /\bname\s*=\s*["']?robots["']?/iu.test(tag)
      && /\bcontent\s*=\s*["'][^"']*\bnoindex\b[^"']*\bfollow\b/iu.test(tag);
    const contentFirst = /\bcontent\s*=\s*["'][^"']*\bnoindex\b[^"']*\bfollow\b/iu.test(tag)
      && /\bname\s*=\s*["']?robots["']?/iu.test(tag);
    return nameFirst || contentFirst;
  });
}

function familyRemovedUrls(previousSnapshot, currentSnapshot, family) {
  return sitemapFamilyUrlDifferences(previousSnapshot, currentSnapshot, family).removedUrls;
}

export function buildSitemapFamilyBridgeEvidence({ previousSnapshot, currentSnapshot, distDir }) {
  const entries = [];
  const missing = [];
  for (const family of Object.keys(SITEMAP_FAMILY_CHURN_TOLERANCE)) {
    for (const url of familyRemovedUrls(previousSnapshot, currentSnapshot, family)) {
      const candidate = routeCandidates(url).map((relative) => path.join(distDir, relative))
        .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
      if (!candidate) {
        missing.push({ family, url, reason: 'bridge file is absent from dist' });
        continue;
      }
      const html = fs.readFileSync(candidate, 'utf8');
      if (!hasNoindexFollow(html)) {
        missing.push({ family, url, reason: 'bridge file is not noindex,follow' });
        continue;
      }
      entries.push({
        family,
        url,
        path: path.relative(distDir, candidate).split(path.sep).join('/'),
        sha256: crypto.createHash('sha256').update(html).digest('hex'),
        robots: 'noindex,follow',
      });
    }
  }
  entries.sort((a, b) => `${a.family}\0${a.url}`.localeCompare(`${b.family}\0${b.url}`));
  missing.sort((a, b) => `${a.family}\0${a.url}`.localeCompare(`${b.family}\0${b.url}`));
  return {
    schemaVersion: SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION,
    kind: BRIDGE_EVIDENCE_KIND,
    complete: missing.length === 0,
    entries,
    missing,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=', 2);
    args[key] = inline ?? argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out;
  if (!out) throw new Error('--out is required');
  let result;
  try {
    result = buildSitemapFamilyBridgeEvidence({
      previousSnapshot: readSitemapSnapshot(args.previous),
      currentSnapshot: readSitemapSnapshot(args.current),
      distDir: args.dist,
    });
  } catch (error) {
    result = {
      schemaVersion: SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION,
      kind: BRIDGE_EVIDENCE_KIND,
      complete: false,
      entries: [],
      missing: [{ reason: `cannot build bridge evidence: ${error.message}` }],
    };
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result)}\n`);
  console.log(`[bridge-evidence] ${result.complete ? 'complete' : 'incomplete'} entries=${result.entries.length} missing=${result.missing.length}`);
}

if (isInvokedDirectly(import.meta.url)) main();
