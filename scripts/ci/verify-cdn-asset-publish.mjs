#!/usr/bin/env node
/**
 * Verify the CDN asset references in the exact HTML files a partial publisher
 * is about to make live. This is deliberately a publish gate, not a report:
 * an unknown or missing producer leaves the previous shard page live.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCdnAssetRefsLive,
  extractCdnAssetUrlsFromHtml,
  findSameOriginAssetRefs,
} from '../lib/cdn-asset-existence.mjs';

export const DEFAULT_SAMPLE_FILES = 32;

function underRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`path escapes dist root: ${candidate}`);
  }
  return resolved;
}

function htmlFilesUnder(root, relativeDir, maxFiles) {
  const start = underRoot(root, relativeDir);
  if (!fs.existsSync(start)) throw new Error(`scan directory missing: ${relativeDir}`);
  const files = [];
  const pending = [start];
  while (pending.length > 0 && files.length < maxFiles) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.html') {
        files.push(absolute);
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}

/**
 * Read only the files being pushed (or a bounded representative sample of a
 * full section tree) and collect the static asset refs they contain.
 *
 * Full section pages use one shared generated shell, so the bounded sample is
 * sufficient to identify the shell's content-addressed producers without
 * adding a second full-corpus walk to the multi-GB section publisher. The
 * incremental article path passes its exact relpaths and is therefore not
 * sampled.
 */
export function collectCdnAssetRefs({
  distDir,
  files = [],
  scanDir = null,
  maxFiles = DEFAULT_SAMPLE_FILES,
  cdnOrigin,
}) {
  if (!distDir) throw new Error('--dist is required');
  if (files.length === 0 && !scanDir) throw new Error('at least one --file or --scan-dir is required');
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('--max-files must be a positive integer');

  const candidates = [
    ...files.map((file) => underRoot(distDir, file)),
    ...(scanDir ? htmlFilesUnder(distDir, scanDir, maxFiles) : []),
  ];
  const uniqueFiles = [...new Set(candidates)];
  const urls = new Set();
  const sameOrigin = [];
  for (const file of uniqueFiles) {
    if (path.extname(file).toLowerCase() !== '.html') continue;
    const html = fs.readFileSync(file, 'utf8');
    for (const url of extractCdnAssetUrlsFromHtml(html, cdnOrigin)) urls.add(url);
    const sameOriginRefs = findSameOriginAssetRefs(html);
    if (sameOriginRefs.length > 0) {
      sameOrigin.push({
        file: path.relative(path.resolve(distDir), file),
        refs: sameOriginRefs,
      });
    }
  }
  return {
    files: uniqueFiles.map((file) => path.relative(path.resolve(distDir), file)),
    urls: [...urls].sort(),
    sameOrigin,
  };
}

function parseArgs(argv) {
  const result = {
    distDir: null,
    files: [],
    scanDir: null,
    maxFiles: DEFAULT_SAMPLE_FILES,
    cdnOrigin: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dist') result.distDir = argv[++i];
    else if (arg === '--file') result.files.push(argv[++i]);
    else if (arg === '--scan-dir') result.scanDir = argv[++i];
    else if (arg === '--max-files') result.maxFiles = Number(argv[++i]);
    else if (arg === '--cdn-origin') result.cdnOrigin = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

function formatFailure(result) {
  return `::error::[cdn-asset-publish-gate] ${result.url} is not proven live `
    + `(state=${result.state}, status=${result.status ?? 'none'}${result.reason ? `, ${result.reason}` : ''})`;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const collected = collectCdnAssetRefs(args);
  let failed = false;

  for (const item of collected.sameOrigin) {
    failed = true;
    console.error(
      `::error::[cdn-asset-publish-gate] ${item.file} still contains same-origin /assets/ ref(s): ${item.refs.join(', ')}`,
    );
  }

  if (collected.urls.length > 0) {
    try {
      await assertCdnAssetRefsLive({ urls: collected.urls });
      console.log(`[cdn-asset-publish-gate] verified ${collected.urls.length} CDN asset reference(s) in ${collected.files.length} HTML file(s)`);
    } catch (error) {
      failed = true;
      for (const result of error.results || []) {
        if (result.state !== 'present') console.error(formatFailure(result));
      }
    }
  } else if (!failed) {
    console.log(`[cdn-asset-publish-gate] no CDN /assets/ references found in ${collected.files.length} HTML file(s)`);
  }

  return failed ? 1 : 0;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`::error::[cdn-asset-publish-gate] ${error.message || error}`);
    process.exitCode = 1;
  });
}
