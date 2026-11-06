#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

/** Verify the complete committed campaign before exposing code that uses it. */
export function checkHouseAdImages({ root, manifestPath = 'docs/house-ad-creatives.json' }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.images) || manifest.images.length === 0) {
    throw new Error('Campaign manifest has no images');
  }
  const directory = realpathSync(resolve(root));
  const seen = new Set();
  let totalBytes = 0;
  for (const image of manifest.images) {
    if (!image || !/^\/images\/job-search-campaign\/[a-z0-9-]+\.webp$/.test(image.path)
        || !/^[a-f0-9]{64}$/.test(image.sha256)
        || !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || seen.has(image.path)) {
      throw new Error('Campaign manifest contains an invalid or duplicate image');
    }
    seen.add(image.path);
    let file;
    try { file = realpathSync(resolve(directory, image.path.slice(1))); }
    catch { throw new Error(`Missing campaign image: ${image.path}`); }
    if (!file.startsWith(directory + sep) || !statSync(file).isFile()) {
      throw new Error(`Campaign image escapes its asset root: ${image.path}`);
    }
    const bytes = readFileSync(file);
    if (bytes.length !== image.bytes) throw new Error(`Campaign image size mismatch: ${image.path}`);
    if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
      throw new Error(`Campaign image SHA-256 mismatch: ${image.path}`);
    }
    totalBytes += bytes.length;
  }
  return { images: seen.size, bytes: totalBytes };
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string', default: 'public' } }, strict: true });
    const result = checkHouseAdImages({ root: values.root });
    console.log(`[house-images] verified ${result.images} image(s), ${result.bytes} bytes`);
  } catch (error) {
    console.error(`[house-images] ${error.message}`);
    process.exitCode = 1;
  }
}
