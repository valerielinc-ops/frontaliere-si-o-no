#!/usr/bin/env node
/**
 * Audit a built artifact for inline `<style>...</style>` blocks in emitted
 * static HTML — the dist-bloat class the PR #454 `.s-*` codemod does NOT cover
 * (that codemod only extracted inline `style="..."` ATTRIBUTES into hashed
 * classes; whole `<style>` blocks injected via `extraHeadHtml` are still
 * shipped per-page by hand-written build plugins).
 *
 * This is an OFFLINE diagnostic, not a build-time plugin. Run it against a
 * local artifact to find which plugins still inline a `<style>` block, fix the
 * offenders at the source (move the CSS into `public/assets/seo-static.css`,
 * renaming root selectors when two page types share one), and re-run to
 * confirm the block is gone. No need to run it every build.
 *
 * Usage:
 *   node scripts/audit-inline-style-blocks.mjs [distDir] [--json] [--min-bytes N]
 *     distDir       artifact root to scan (default: download/artifact, else dist)
 *     --json        emit machine-readable JSON instead of the text report
 *     --min-bytes N ignore unique blocks whose total shipped bytes < N (default 0)
 *
 * For each UNIQUE block (deduped by normalized content hash) it reports:
 *   - shipped bytes = block length × page count  (≈ what externalizing saves)
 *   - page count + a sample page path
 *   - distinctive selectors found in the block
 *   - best-guess SOURCE plugin (grep of build-plugins/ for a distinctive selector)
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const minBytesArg = args.indexOf('--min-bytes');
const minBytes = minBytesArg >= 0 ? Number(args[minBytesArg + 1]) || 0 : 0;
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] === '--min-bytes'));

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function resolveDistDir() {
  if (positional[0]) return path.resolve(positional[0]);
  for (const c of ['download/artifact', 'dist']) {
    const abs = path.join(repoRoot, c);
    if (fs.existsSync(abs)) return abs;
  }
  console.error('No artifact dir found. Pass one explicitly, e.g.:\n  node scripts/audit-inline-style-blocks.mjs download/artifact');
  process.exit(2);
}

const distDir = resolveDistDir();

/** Fast candidate list: only HTML files that contain `<style`. Falls back to a
 *  Node walk if ripgrep is unavailable. */
function listCandidateFiles() {
  try {
    const out = execFileSync('rg', ['-l', '--glob', '*.html', '<style', distDir], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return []; // rg: no matches
    // rg missing or other failure → Node walk (slower).
    const acc = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith('.html')) {
          if (fs.readFileSync(p, 'utf8').includes('<style')) acc.push(p);
        }
      }
    };
    walk(distDir);
    return acc;
  }
}

const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

/** Normalize a block's inner CSS for hashing: collapse whitespace so cosmetic
 *  differences don't split otherwise-identical blocks. */
function normalize(css) {
  return css.replace(/\s+/g, ' ').trim();
}

/** Pull a few distinctive selectors out of a CSS block for display + source
 *  mapping. Only looks at the selector prelude BEFORE each `{` rule body (so
 *  value-internal noise like `rgba(0,0,0,.1)` or `#533afd` is never mistaken
 *  for a selector), and keeps only class/id selectors that are valid CSS
 *  identifiers (start with a letter or `_` — excludes `.1`, `.15`, …). */
function selectorsOf(css) {
  const set = new Set();
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    for (const part of m[1].split(',')) {
      const first = part.trim().split(/[\s>+~]/)[0];
      const cm = first.match(/[.#][A-Za-z_][\w-]*/);
      if (cm) set.add(cm[0]);
    }
  }
  return [...set];
}

/** Best-guess source plugin: grep build-plugins/ for a distinctive selector
 *  literal from the block. Cached per selector. */
const sourceCache = new Map();
function findSource(selectors) {
  // Prefer the longest/most distinctive class selector.
  const candidates = selectors
    .filter((s) => s.startsWith('.'))
    .sort((a, b) => b.length - a.length);
  for (const sel of candidates) {
    if (sourceCache.has(sel)) {
      const hit = sourceCache.get(sel);
      if (hit) return { selector: sel, files: hit };
      continue;
    }
    let files = [];
    try {
      const out = execFileSync(
        'rg',
        ['-l', '-F', sel, path.join(repoRoot, 'build-plugins')],
        { encoding: 'utf8' },
      );
      files = out.split('\n').filter(Boolean).map((f) => path.relative(repoRoot, f));
    } catch {
      files = [];
    }
    sourceCache.set(sel, files.length ? files : null);
    if (files.length) return { selector: sel, files };
  }
  return { selector: candidates[0] || selectors[0] || '?', files: [] };
}

const files = listCandidateFiles();

/** hash → { len, count, pages:[sample paths], css } */
const blocks = new Map();
for (const file of files) {
  let html;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const m of html.matchAll(STYLE_RE)) {
    const css = normalize(m[1]);
    if (!css) continue;
    const h = createHash('sha256').update(css).digest('hex').slice(0, 12);
    let rec = blocks.get(h);
    if (!rec) {
      rec = { len: m[0].length, count: 0, pages: [], css };
      blocks.set(h, rec);
    }
    rec.count++;
    if (rec.pages.length < 3) rec.pages.push(path.relative(distDir, file));
  }
}

const ranked = [...blocks.entries()]
  .map(([hash, r]) => {
    const shipped = r.len * r.count;
    const selectors = selectorsOf(r.css);
    return { hash, shipped, ...r, selectors };
  })
  .filter((r) => r.shipped >= minBytes)
  .sort((a, b) => b.shipped - a.shipped);

// Source mapping only for the ranked set (cheap: one rg per unique block).
for (const r of ranked) r.source = findSource(r.selectors);

const totalShipped = ranked.reduce((s, r) => s + r.shipped, 0);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        distDir,
        filesScanned: files.length,
        uniqueBlocks: ranked.length,
        totalShippedBytes: totalShipped,
        blocks: ranked.map((r) => ({
          hash: r.hash,
          blockBytes: r.len,
          pages: r.count,
          shippedBytes: r.shipped,
          selectors: r.selectors,
          sourcePlugins: r.source.files,
          matchedSelector: r.source.selector,
          samplePages: r.pages,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

console.log(`\nInline <style> block audit — ${path.relative(repoRoot, distDir) || distDir}`);
console.log(`HTML files with a <style> block: ${files.length}`);
console.log(`Unique blocks: ${ranked.length}   Potential dedup savings: ~${mb(totalShipped)}\n`);

let i = 0;
for (const r of ranked) {
  i++;
  const src = r.source.files.length
    ? r.source.files.join(', ') + `  (matched ${r.source.selector})`
    : `UNKNOWN (tried ${r.source.selector})`;
  console.log(
    `#${i}  ${kb(r.len)}/page × ${r.count} pages = ~${mb(r.shipped)}  [${r.hash}]`,
  );
  console.log(`    source : ${src}`);
  console.log(`    sel    : ${r.selectors.slice(0, 8).join(' ')}${r.selectors.length > 8 ? ' …' : ''}`);
  console.log(`    sample : ${r.pages[0]}`);
}
console.log('');
