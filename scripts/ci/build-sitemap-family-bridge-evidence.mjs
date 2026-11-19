#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isExternallyServedUrl } from '../lib/externally-served-paths.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { readSitemapSnapshot } from '../lib/sitemap-snapshot.mjs';
import {
  SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION,
  SITEMAP_FAMILY_CHURN_TOLERANCE,
  sitemapFamilyUrlDifferences,
} from '../lib/sitemap-family-coverage.mjs';

export const BRIDGE_EVIDENCE_KIND = 'sitemap-family-bridge-evidence';
const LOCALES = new Set(['it', 'en', 'de', 'fr']);

export function urlLocale(url) {
  const pathname = new URL(url).pathname;
  for (const locale of ['en', 'de', 'fr']) {
    if (pathname.startsWith(`/${locale}/`)) return locale;
  }
  return 'it';
}

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

function metaAttributes(tag) {
  const attributes = new Map();
  const source = tag.replace(/^<meta\b/iu, '').replace(/\/?>$/u, '');
  const attributePattern = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of source.matchAll(attributePattern)) {
    const name = match[1].toLowerCase();
    if ((name === 'name' || name === 'content') && attributes.has(name)) return null;
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

export function hasNoindexFollow(html) {
  const tags = html.match(/<meta\b[^>]*>/giu) ?? [];
  return tags.some((tag) => {
    const attributes = metaAttributes(tag);
    if (attributes?.get('name')?.toLowerCase() !== 'robots') return false;
    const directives = (attributes.get('content') ?? '').toLowerCase().split(/[\s,]+/u);
    return directives.includes('noindex') && directives.includes('follow');
  });
}

function familyRemovedUrls(previousSnapshot, currentSnapshot, family) {
  return sitemapFamilyUrlDifferences(previousSnapshot, currentSnapshot, family).removedUrls;
}

export function createTarDistReader(tarFile) {
  const listing = spawnSync('tar', ['-tf', tarFile], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (listing.status !== 0) {
    const stderr = String(listing.stderr ?? '').trim();
    throw new Error(stderr || listing.error?.message || `tar -tf exited with status ${listing.status}`);
  }

  const members = new Set();
  const originalNames = new Map();
  for (const originalName of listing.stdout.split(/\r?\n/u)) {
    if (!originalName) continue;
    const normalizedName = originalName.replace(/^\.\//u, '');
    members.add(normalizedName);
    originalNames.set(normalizedName, originalName);
  }

  return {
    exists(relative) {
      return members.has(relative);
    },
    read(relative) {
      const originalName = originalNames.get(relative);
      if (originalName === undefined) throw new Error(`tar member is absent: ${relative}`);
      const output = spawnSync('tar', ['-xOf', tarFile, originalName], {
        maxBuffer: 64 * 1024 * 1024,
      });
      if (output.status !== 0) {
        const stderr = String(output.stderr ?? '').trim();
        throw new Error(stderr || output.error?.message || `tar -xOf exited with status ${output.status}`);
      }
      return output.stdout.toString('utf8');
    },
  };
}

function createDirectoryDistReader(distDir) {
  return {
    exists(relative) {
      const file = path.join(distDir, relative);
      return fs.existsSync(file) && fs.statSync(file).isFile();
    },
    read(relative) {
      return fs.readFileSync(path.join(distDir, relative), 'utf8');
    },
  };
}

export function buildSitemapFamilyBridgeEvidence({ previousSnapshot, currentSnapshot, distDir, distReader, locale }) {
  const reader = distReader ?? createDirectoryDistReader(distDir);
  const entries = [];
  const missing = [];
  const externallyServed = [];
  for (const family of Object.keys(SITEMAP_FAMILY_CHURN_TOLERANCE)) {
    for (const url of familyRemovedUrls(previousSnapshot, currentSnapshot, family)) {
      if (locale && urlLocale(url) !== locale) continue;
      // The Worker serves these URLs from the corpus shard. As in
      // validate-sitemap-pages/links and audit-hreflang, BUILD_EMIT_SKIP means
      // this build neither owns nor emits them, so no bridge is required.
      if (isExternallyServedUrl(url)) {
        externallyServed.push({ family, url });
        continue;
      }
      const candidate = routeCandidates(url).find((relative) => reader.exists(relative));
      if (!candidate) {
        missing.push({ family, url, reason: 'bridge file is absent from dist' });
        continue;
      }
      const html = reader.read(candidate);
      if (!hasNoindexFollow(html)) {
        missing.push({ family, url, reason: 'bridge file is not noindex,follow' });
        continue;
      }
      entries.push({
        family,
        url,
        path: candidate,
        sha256: crypto.createHash('sha256').update(html).digest('hex'),
        robots: 'noindex,follow',
      });
    }
  }
  entries.sort((a, b) => `${a.family}\0${a.url}`.localeCompare(`${b.family}\0${b.url}`));
  missing.sort((a, b) => `${a.family}\0${a.url}`.localeCompare(`${b.family}\0${b.url}`));
  externallyServed.sort((a, b) => `${a.family}\0${a.url}`.localeCompare(`${b.family}\0${b.url}`));
  return {
    schemaVersion: SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION,
    kind: BRIDGE_EVIDENCE_KIND,
    complete: missing.length === 0,
    ...(locale ? { locale } : {}),
    entries,
    missing,
    externallyServed,
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
    if (args.locale !== undefined && !LOCALES.has(args.locale)) {
      throw new Error(`--locale must be one of ${[...LOCALES].join(', ')}`);
    }
    if (args.dist !== undefined && args['dist-tar'] !== undefined) {
      throw new Error('--dist and --dist-tar are mutually exclusive');
    }
    result = buildSitemapFamilyBridgeEvidence({
      previousSnapshot: readSitemapSnapshot(args.previous),
      currentSnapshot: readSitemapSnapshot(args.current),
      distDir: args.dist,
      ...(args['dist-tar'] !== undefined ? { distReader: createTarDistReader(args['dist-tar']) } : {}),
      ...(args.locale !== undefined ? { locale: args.locale } : {}),
    });
  } catch (error) {
    result = {
      schemaVersion: SITEMAP_FAMILY_BRIDGE_EVIDENCE_VERSION,
      kind: BRIDGE_EVIDENCE_KIND,
      complete: false,
      ...(LOCALES.has(args.locale) ? { locale: args.locale } : {}),
      entries: [],
      externallyServed: [],
      missing: [{ reason: `cannot build bridge evidence: ${error.message}` }],
    };
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result)}\n`);
  console.log(`[bridge-evidence] ${args.locale ?? 'all'} ${result.complete ? 'complete' : 'incomplete'} entries=${result.entries.length} missing=${result.missing.length} externallyServed=${result.externallyServed.length}`);
}

if (isInvokedDirectly(import.meta.url)) main();
