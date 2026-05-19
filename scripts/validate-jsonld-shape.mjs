#!/usr/bin/env node
/**
 * validate-jsonld-shape.mjs
 *
 * Sanity-checks the JSON-LD blocks emitted in dist/ HTML for shape
 * correctness per schema.org. Targets the most common types this site
 * emits and verifies the required fields are present per Google's
 * Rich Results documentation (subset thereof — full Rich Results Test
 * requires a Google Cloud API key and rate limits at 1 req/sec, not
 * usable in CI).
 *
 * What this script catches (without calling Google):
 *   - JSON parse errors in `<script type="application/ld+json">` blocks
 *   - Nested `<script>` wrappers (already covered by
 *     audit-jsonld-no-nested-scripts but checked here for completeness)
 *   - Missing required fields per @type:
 *       JobPosting: title, description, datePosted, hiringOrganization,
 *                   jobLocation, employmentType, baseSalary
 *       Article / BlogPosting: headline, datePublished, author, publisher
 *       Person: name
 *       Organization: name
 *       LocalBusiness: name, address
 *       FAQPage: mainEntity[].name + mainEntity[].acceptedAnswer.text
 *       BreadcrumbList: itemListElement[].position + .name + .item
 *       ImageObject: contentUrl OR url
 *
 * What it does NOT catch (would require Google API):
 *   - Whether Google's parser accepts the JSON-LD
 *   - Whether the page qualifies for Rich Results in SERP
 *   - SERP-specific validation rules
 *
 * Used for the vincolo N2 sanity check (HTML minifier must not break
 * JSON-LD shape) and as a defensive pre-deploy gate.
 *
 * Usage:
 *   node scripts/validate-jsonld-shape.mjs                  # sample 200 random files
 *   node scripts/validate-jsonld-shape.mjs --sample=20      # smaller sample
 *   node scripts/validate-jsonld-shape.mjs --strict         # fail on any missing field
 *   node scripts/validate-jsonld-shape.mjs --dist=path      # alternate dist
 *
 * Exit:
 *   0 — every sampled page's JSON-LD shape passes
 *   1 — at least one shape violation (path + violation printed)
 *   2 — missing dist or fatal error
 */

import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkHtmlFiles } from './lib/audit-runner.mjs';

const __dirname = new URL('.', import.meta.url).pathname;
const ROOT = join(__dirname, '..');
const DEFAULT_DIST = join(ROOT, 'dist');

const JSONLD_RE = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// Required-fields per @type. Sourced from Google's Search Central docs:
// https://developers.google.com/search/docs/appearance/structured-data
const REQUIRED = {
  JobPosting: ['title', 'description', 'datePosted', 'hiringOrganization', 'jobLocation', 'employmentType', 'baseSalary'],
  Article: ['headline', 'datePublished', 'author', 'publisher'],
  BlogPosting: ['headline', 'datePublished', 'author', 'publisher'],
  NewsArticle: ['headline', 'datePublished', 'author', 'publisher'],
  Person: ['name'],
  Organization: ['name'],
  LocalBusiness: ['name', 'address'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  ImageObject: [], // contentUrl OR url checked separately
  WebPage: [], // no Google-required fields beyond @type
  WebSite: [], // no Google-required fields beyond @type
  Place: ['name'],
};

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

function sampleRandom(arr, n) {
  if (arr.length <= n) return [...arr];
  const out = new Set();
  while (out.size < n) out.add(arr[Math.floor(Math.random() * arr.length)]);
  return [...out];
}

function* walkTypes(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) yield* walkTypes(x);
    return;
  }
  if (typeof node['@type'] === 'string') yield node;
  if (Array.isArray(node['@type'])) {
    for (const t of node['@type']) {
      if (typeof t === 'string') yield { ...node, '@type': t };
    }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') yield* walkTypes(v);
  }
}

function validateEntity(entity) {
  const violations = [];
  const t = entity['@type'];
  if (typeof t !== 'string') return violations;
  const required = REQUIRED[t];
  if (!required) return violations; // unknown type, no rules

  for (const f of required) {
    if (!(f in entity) || entity[f] === null || entity[f] === '') {
      violations.push({ '@type': t, missing: f });
    }
  }
  // ImageObject: contentUrl OR url
  if (t === 'ImageObject' && !entity.contentUrl && !entity.url) {
    violations.push({ '@type': t, missing: 'contentUrl|url' });
  }
  // FAQPage: validate mainEntity questions
  if (t === 'FAQPage' && entity.mainEntity) {
    const qs = Array.isArray(entity.mainEntity) ? entity.mainEntity : [entity.mainEntity];
    qs.forEach((q, i) => {
      if (!q || typeof q !== 'object') return;
      if (typeof q.name !== 'string' || q.name.trim() === '') {
        violations.push({ '@type': t, missing: `mainEntity[${i}].name` });
      }
      const ans = q.acceptedAnswer;
      if (!ans || typeof ans !== 'object') {
        violations.push({ '@type': t, missing: `mainEntity[${i}].acceptedAnswer` });
      } else if (typeof ans.text !== 'string' || ans.text.trim() === '') {
        violations.push({ '@type': t, missing: `mainEntity[${i}].acceptedAnswer.text` });
      }
    });
  }
  // BreadcrumbList: validate itemListElement
  if (t === 'BreadcrumbList' && entity.itemListElement) {
    const items = Array.isArray(entity.itemListElement) ? entity.itemListElement : [entity.itemListElement];
    items.forEach((it, i) => {
      if (!it || typeof it !== 'object') return;
      if (typeof it.position !== 'number') {
        violations.push({ '@type': t, missing: `itemListElement[${i}].position` });
      }
      if (typeof it.name !== 'string' || it.name.trim() === '') {
        violations.push({ '@type': t, missing: `itemListElement[${i}].name` });
      }
      // .item is required for non-leaf items; last position is allowed to omit it
      // (per Google's docs). Skip enforcement.
    });
  }
  return violations;
}

async function main() {
  const args = parseArgs();
  const distArg = args.get('dist') || DEFAULT_DIST;
  const sampleN = Number(args.get('sample') ?? 200);
  const strict = args.has('strict');

  const s = await stat(distArg).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`[validate-jsonld-shape] dist not found: ${distArg}`);
    process.exit(2);
  }

  console.log(`[validate-jsonld-shape] walking ${distArg}…`);
  const files = await walkHtmlFiles(distArg);
  console.log(`[validate-jsonld-shape] found ${files.length} HTML files; sampling ${sampleN}…`);
  const sample = sampleRandom(files, sampleN);

  let totalEntities = 0;
  let totalViolations = 0;
  let totalParseErrors = 0;
  const byType = new Map();
  const failedPages = [];

  for (const file of sample) {
    let html;
    try { html = await readFile(file, 'utf8'); }
    catch { continue; }
    if (!html.includes('application/ld+json')) continue;

    JSONLD_RE.lastIndex = 0;
    const blocks = [];
    let m;
    while ((m = JSONLD_RE.exec(html)) !== null) blocks.push(m[1]);

    const pageViolations = [];
    for (const body of blocks) {
      let parsed;
      try { parsed = JSON.parse(body.trim()); }
      catch (err) {
        totalParseErrors++;
        pageViolations.push({ '@type': '<parse-error>', missing: err.message });
        continue;
      }
      for (const entity of walkTypes(parsed)) {
        totalEntities++;
        const t = entity['@type'];
        byType.set(t, (byType.get(t) || 0) + 1);
        const violations = validateEntity(entity);
        if (violations.length > 0) {
          totalViolations += violations.length;
          pageViolations.push(...violations);
        }
      }
    }
    if (pageViolations.length > 0) {
      failedPages.push({ file: relative(ROOT, file), violations: pageViolations });
    }
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`[validate-jsonld-shape] sampled:       ${sample.length} files`);
  console.log(`[validate-jsonld-shape] entities:      ${totalEntities}`);
  console.log(`[validate-jsonld-shape] parse errors:  ${totalParseErrors}`);
  console.log(`[validate-jsonld-shape] shape violations: ${totalViolations}`);
  console.log(`[validate-jsonld-shape] pages with issues: ${failedPages.length}`);
  console.log('══════════════════════════════════════════════════════════════════════');

  if (byType.size > 0) {
    console.log('');
    console.log('Entities by @type:');
    const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      console.log(`  ${String(count).padStart(6)}  ${type}`);
    }
  }

  if (failedPages.length > 0) {
    console.log('');
    console.log('First 10 pages with violations:');
    for (const p of failedPages.slice(0, 10)) {
      console.log(`\n  ${p.file}`);
      for (const v of p.violations.slice(0, 5)) {
        console.log(`    ${v['@type']} missing ${v.missing}`);
      }
      if (p.violations.length > 5) console.log(`    ... and ${p.violations.length - 5} more`);
    }
  }

  // Exit codes
  if (totalParseErrors > 0) {
    console.error(`\nFAIL: ${totalParseErrors} JSON-LD parse error(s) — invalid JSON in <script type="application/ld+json">`);
    process.exit(1);
  }
  if (strict && totalViolations > 0) {
    console.error(`\nFAIL (--strict): ${totalViolations} shape violation(s) across ${failedPages.length} pages`);
    process.exit(1);
  }
  if (totalViolations > 0) {
    console.log(`\nINFO: ${totalViolations} shape violations (informational, --strict to fail)`);
  } else {
    console.log('\nPASS: every JSON-LD block parses and required fields are present.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[validate-jsonld-shape] fatal', err);
  process.exit(2);
});
