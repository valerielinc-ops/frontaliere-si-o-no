#!/usr/bin/env node
/**
 * flat-content-replace — Post-build script that ensures flat .html files serve
 * the same content as their corresponding directory index.html files.
 *
 * Problem: Flat `.html` files (e.g., `articoli-frontaliere/slug.html`) contain
 * a thin "Versione canonica disponibile" bridge page. Google classifies these as
 * "Pagina con reindirizzamento" (Page with redirect) and refuses to index them.
 *
 * Fix: This script runs AFTER vite build and replaces every flat bridge file
 * with a copy of the corresponding `path/index.html`. Both URLs now serve
 * identical content with the same `<link rel="canonical">` pointing to the
 * trailing-slash version. Google sees content (not a redirect) and consolidates
 * via canonical.
 *
 * Usage: node scripts/flat-content-replace.mjs
 */

import fs from 'fs';
import path from 'path';

const distDir = path.resolve('dist');
if (!fs.existsSync(distDir)) {
  console.error('[flat-content] dist/ not found');
  process.exit(1);
}

let replaced = 0;
let notBridge = 0;
let bridgeMissingTarget = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name));
      continue;
    }

    if (
      !entry.name.endsWith('.html') ||
      entry.name === 'index.html' ||
      entry.name === '404.html'
    ) continue;

    const flatPath = path.join(dir, entry.name);
    const content = fs.readFileSync(flatPath, 'utf-8');

    const isRedirect =
      content.includes('location.replace(') ||
      content.includes('Versione canonica disponibile');
    if (!isRedirect) {
      notBridge++;
      continue;
    }

    const baseName = entry.name.replace(/\.html$/, '');
    const indexPath = path.join(dir, baseName, 'index.html');

    if (fs.existsSync(indexPath)) {
      fs.copyFileSync(indexPath, flatPath);
      replaced++;
    } else {
      bridgeMissingTarget++;
    }
  }
}

walk(distDir);
console.log(
  `\x1b[36m[flat-content]\x1b[0m Replaced ${replaced} bridge pages (${notBridge} non-bridge files, ${bridgeMissingTarget} bridges without target)`,
);

if (bridgeMissingTarget > 0) {
  console.warn(
    `[flat-content] ⚠️  ${bridgeMissingTarget} bridge page(s) could not be replaced — sibling index.html missing. Check upstream build output.`,
  );
}
