#!/usr/bin/env node
/**
 * verify-l2-equivalence.mjs
 *
 * Validates that the L2 HTML minifier (build-plugins/shared/htmlMinify.ts)
 * preserves DOM and content semantics: every page produced by the post-L2
 * shell should parse to the SAME DOM and the SAME visible text as the
 * corresponding pre-L2 page.
 *
 * Strategy:
 *   1. Walk a baseline dist (pre-L2 deploy artifact) and the current dist.
 *   2. Intersect path sets; random-sample N (default 1000).
 *   3. For each file:
 *      - normalise both with a deterministic DOM serialiser (cheerio.load
 *        + .html() with explicit options) to fold whitespace differences
 *      - compare normalised DOM (must be string-equal)
 *      - extract visible text (strip script/style/comments → collapse ws)
 *        from both; must be byte-equal
 *      - extract JSON-LD blocks; must be byte-equal (vincolo N2 — minifier
 *        is opaque on JSON-LD)
 *
 * The bar is DOM-equivalent + content-equivalent (vincolo C1 relaxed in the
 * L1+L2+L3 design). Whitespace inside text content can differ (the minifier
 * is conservative but does collapse multi-spaces inside text in some
 * conditions); we explicitly normalise whitespace before compare.
 *
 * Usage:
 *   node scripts/verify-l2-equivalence.mjs \
 *     --baseline=download/artifact \
 *     --candidate=dist \
 *     --sample=1000
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { load as cheerioLoad } from 'cheerio';

function parseArgs() {
  const args = new Map();
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args.set(k, v ?? true);
    }
  }
  return args;
}

async function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith('.html')) out.push(relative(root, p));
    }
  }
  return out;
}

function sampleRandom(arr, n) {
  if (arr.length <= n) return [...arr];
  const out = new Set();
  while (out.size < n) out.add(arr[Math.floor(Math.random() * arr.length)]);
  return [...out];
}

const JSONLD_RE = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const SCRIPT_RE = /<script\b[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style\b[\s\S]*?<\/style>/gi;
const NOSCRIPT_RE = /<noscript\b[\s\S]*?<\/noscript>/gi;
const TEMPLATE_RE = /<template\b[\s\S]*?<\/template>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<[^>]+>/g;

function extractVisibleText(html) {
  let s = html;
  s = s.replace(COMMENT_RE, ' ');
  s = s.replace(SCRIPT_RE, ' ');
  s = s.replace(STYLE_RE, ' ');
  s = s.replace(NOSCRIPT_RE, ' ');
  s = s.replace(TEMPLATE_RE, ' ');
  s = s.replace(TAG_RE, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.replace(/\s+/g, ' ').trim();
}

function extractJsonLdBlocks(html) {
  const out = [];
  JSONLD_RE.lastIndex = 0;
  let m;
  while ((m = JSONLD_RE.exec(html)) !== null) out.push(m[1].trim());
  return out;
}

function normalizeDom(html) {
  // cheerio parses the html and we re-serialise with a deterministic
  // configuration. This folds attribute order, whitespace between tags,
  // optional close tags. Result: any two semantically-equivalent HTML
  // inputs serialise to the same string.
  try {
    const $ = cheerioLoad(html, { decodeEntities: true });
    return $.html();
  } catch (err) {
    return `__PARSE_ERROR__:${err.message}`;
  }
}

async function main() {
  const args = parseArgs();
  const baseline = args.get('baseline');
  const candidate = args.get('candidate');
  const sampleN = Number(args.get('sample') ?? 1000);
  const verbose = args.has('verbose');

  if (!baseline || !candidate) {
    console.error('Usage: verify-l2-equivalence.mjs --baseline=<dist> --candidate=<dist> [--sample=N]');
    process.exit(2);
  }
  for (const d of [baseline, candidate]) {
    const s = await stat(d).catch(() => null);
    if (!s || !s.isDirectory()) { console.error(`missing dir: ${d}`); process.exit(2); }
  }

  console.log(`[verify-l2] walking baseline ${baseline}…`);
  const baselineSet = new Set(await walk(baseline));
  console.log(`[verify-l2] walking candidate ${candidate}…`);
  const candidateAll = await walk(candidate);
  const intersection = candidateAll.filter((f) => baselineSet.has(f));
  console.log(`[verify-l2] baseline=${baselineSet.size} candidate=${candidateAll.length} both=${intersection.length}`);

  const sample = sampleRandom(intersection, sampleN);
  console.log(`[verify-l2] sampling ${sample.length} files…`);

  let scanned = 0;
  let domMismatches = 0;
  let textMismatches = 0;
  let jsonLdMismatches = 0;
  const firstFew = [];
  let totalSavingBytes = 0;
  let totalBaselineBytes = 0;

  for (const rel of sample) {
    const a = await readFile(join(baseline, rel), 'utf8');
    const b = await readFile(join(candidate, rel), 'utf8');
    scanned++;
    totalBaselineBytes += Buffer.byteLength(a, 'utf8');
    totalSavingBytes += Buffer.byteLength(a, 'utf8') - Buffer.byteLength(b, 'utf8');

    const aDom = normalizeDom(a);
    const bDom = normalizeDom(b);
    const aText = extractVisibleText(a);
    const bText = extractVisibleText(b);
    const aJsonLd = extractJsonLdBlocks(a);
    const bJsonLd = extractJsonLdBlocks(b);

    let issues = [];
    if (aDom !== bDom) { domMismatches++; issues.push('dom'); }
    if (aText !== bText) { textMismatches++; issues.push('text'); }
    if (JSON.stringify(aJsonLd) !== JSON.stringify(bJsonLd)) { jsonLdMismatches++; issues.push('jsonld'); }

    if (issues.length > 0 && firstFew.length < 5) {
      firstFew.push({ path: rel, issues, aLen: Buffer.byteLength(a), bLen: Buffer.byteLength(b) });
    }

    if (verbose && scanned % 100 === 0) {
      console.log(`[verify-l2] progress: ${scanned}/${sample.length}`);
    }
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`[verify-l2] sampled:           ${scanned}`);
  console.log(`[verify-l2] DOM mismatches:    ${domMismatches}`);
  console.log(`[verify-l2] text mismatches:   ${textMismatches}`);
  console.log(`[verify-l2] JSON-LD mismatches:${jsonLdMismatches}`);
  if (totalBaselineBytes > 0) {
    console.log(`[verify-l2] byte reduction:    ${((totalSavingBytes / totalBaselineBytes) * 100).toFixed(2)}% (${(totalSavingBytes / 1024).toFixed(0)} KB saved on ${(totalBaselineBytes / 1024 / 1024).toFixed(1)} MB sampled)`);
  }
  console.log('══════════════════════════════════════════════════════════════════════');

  if (domMismatches > 0 || textMismatches > 0 || jsonLdMismatches > 0) {
    console.error('\nFirst mismatches:');
    for (const f of firstFew) {
      console.error(`  ${f.path} (${f.issues.join(',')}, baseline=${f.aLen}B candidate=${f.bLen}B)`);
    }
    process.exit(1);
  }
  console.log('PASS: DOM + visible text + JSON-LD are equivalent on every sampled file.');
  process.exit(0);
}

main().catch((err) => {
  console.error('verify-l2-equivalence: fatal', err);
  process.exit(2);
});
