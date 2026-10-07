#!/usr/bin/env node
/** Build the site-owned unified SPA index for the blog cover ledger. */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { coverKey, validateImageCreditRecord } from '../../packages/articles/engine/shared/imageCredits.mjs';

const ROOT = process.cwd();
const RECORD_DIR = path.join(ROOT, 'packages/articles/content/image-credits/blog');
const OUTPUT = path.join(ROOT, 'data/image-credits-blog.json');
const LEDGER = path.join(ROOT, 'data/blog-cover-ledger.json');
const REGISTRIES = [
  'packages/articles/content/blog-articles-data.ts',
  'packages/articles/content/swiss-articles-data.ts',
];

function parseRegistry(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const covers = new Set();
  const imageRx = /\bimage:\s*'([^']+)'/g;
  let match;
  while ((match = imageRx.exec(source))) {
    const key = coverKey(match[1]);
    if (key) covers.add(key);
  }
  return covers;
}

function readRecord(key) {
  const file = path.join(RECORD_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function wikiFile(record) {
  return {
    source: 'wikimedia-commons',
    pageUrl: record.commons.pageUrl,
    author: {
      text: record.author.text,
      name: record.author.name,
      url: record.author.url,
      type: record.author.type,
    },
    attribution: record.attribution,
    licence: record.licence,
    fetchedAt: record.fetchedAt,
  };
}

function generatedFile(record) {
  return {
    source: 'generated-provider',
    commons: record.commons,
    author: record.author,
    attribution: record.attribution,
    licence: record.licence,
    restrictions: record.restrictions,
    fetchedAt: record.fetchedAt,
    generated: record.generated,
  };
}

function main() {
  const keys = new Set(REGISTRIES.flatMap((file) => [...parseRegistry(file)]));
  const ledger = readJson(LEDGER);
  const files = {};
  const covers = {};
  let generated = 0;
  let inferred = 0;
  for (const key of [...keys].sort()) {
    const record = readRecord(key);
    if (!record) {
      const item = ledger.covers?.[key];
      if (item?.proofLevel === 6 && item.evidence === 'inferred' && item.verifiedAt) {
        covers[key] = {
          evidence: 'inferred',
          provider: null,
          verifiedAt: item.verifiedAt,
          status: 'no-credit',
        };
        inferred += 1;
      }
      continue;
    }
    const validation = validateImageCreditRecord(record);
    if (!validation.valid) throw new Error(`${key}: invalid record: ${validation.errors.join('; ')}`);
    if (record.source === 'inferred') {
      covers[key] = {
        evidence: 'inferred',
        provider: null,
        verifiedAt: record.verifiedAt,
        status: 'no-credit',
      };
      inferred += 1;
      continue;
    }
    const fileKey = record.source === 'generated-provider'
      ? `generated:${record.generated.assetId}`
      : record.commons.title;
    const compact = record.source === 'generated-provider' ? generatedFile(record) : wikiFile(record);
    if (files[fileKey] && JSON.stringify(files[fileKey]) !== JSON.stringify(compact)) {
      throw new Error(`${key}: one compact file key maps to conflicting records: ${fileKey}`);
    }
    files[fileKey] = compact;
    covers[key] = { file: fileKey, modified: record.modified };
    if (record.source === 'generated-provider') generated += 1;
  }
  const output = {
    schema: 1,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    section: 'blog',
    files,
    covers,
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ covers: Object.keys(covers).length, files: Object.keys(files).length, generated, inferred, output: 'data/image-credits-blog.json' }, null, 2));
}

main();
