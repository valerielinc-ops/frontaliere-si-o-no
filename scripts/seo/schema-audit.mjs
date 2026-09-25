#!/usr/bin/env node
/**
 * schema-audit.mjs — Workstream D.3
 *
 * Walks `dist/**\/*.html`, extracts every `<script type="application/ld+json">`
 * block, validates that each block is well-formed JSON, and produces a
 * URL × schema-type matrix. Flags pages whose schema "profile" does not
 * match what is expected for their page type:
 *
 *   - Article pages   → Article + BreadcrumbList
 *   - Job pages       → JobPosting + BreadcrumbList
 *   - Calculator pages→ WebApplication (or SoftwareApplication) + BreadcrumbList
 *   - Comparison pages→ ItemList + BreadcrumbList
 *   - Border pages    → Place + BreadcrumbList
 *   - Other pages     → BreadcrumbList (site-wide baseline)
 *
 * Output:
 *   reports/schema-audit-YYYY-MM-DD.json
 *   reports/schema-audit-YYYY-MM-DD.md
 *
 * Safe to run before `dist/` is built — emits an empty stub and exits 0.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

function isoDate(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseArgs(argv) {
  const args = { dist: join(ROOT, 'dist'), out: join(ROOT, 'reports') };
  for (const a of argv) {
    if (a.startsWith('--dist=')) args.dist = resolve(a.slice(7));
    else if (a.startsWith('--out=')) args.out = resolve(a.slice(6));
  }
  return args;
}

function walkHtml(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'assets' || e.name === 'node_modules') continue;
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.html')) {
        out.push(full);
      }
    }
  }
  return out;
}

function fileToUrlPath(filePath, distRoot) {
  const rel = '/' + relative(distRoot, filePath).split('\\').join('/');
  if (rel === '/index.html') return '/';
  if (rel.endsWith('/index.html')) return rel.slice(0, -'index.html'.length);
  return rel;
}

const LDJSON_BLOCK_RE = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractJsonLdBlocks(html) {
  const blocks = [];
  let m;
  while ((m = LDJSON_BLOCK_RE.exec(html)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function collectTypes(node, acc) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, acc);
    return;
  }
  if (typeof node !== 'object') return;
  const t = node['@type'];
  if (Array.isArray(t)) t.forEach((x) => acc.add(String(x)));
  else if (typeof t === 'string') acc.add(t);
  // @graph is the standard container for multiple types on one page.
  if (Array.isArray(node['@graph'])) collectTypes(node['@graph'], acc);
  // Recurse into known wrappers.
  if (Array.isArray(node.itemListElement)) collectTypes(node.itemListElement, acc);
  if (Array.isArray(node.mainEntity)) collectTypes(node.mainEntity, acc);
}

function classifyPage(urlPath) {
  // Strip leading locale prefix if present (/en/, /de/, /fr/).
  const stripped = urlPath.replace(/^\/(en|de|fr)(?=\/|$)/, '') || '/';

  // Job pages — both localized and Italian slugs share the /lavori or /jobs prefix.
  if (/\/(lavori|jobs|job-board|emplois|stellen)(\/|$)/.test(stripped)) return 'job';
  // Blog / articles.
  if (/\/(blog|articoli|articles|artikel|approfondimenti)(\/|$)/.test(stripped)) return 'article';
  // Calculator hub + variants.
  if (/\/(calcola-stipendio|calculator|rechner|calculateur|calcolatore)(\/|$)/.test(stripped)) return 'calculator';
  // Comparators.
  if (/\/(compara-servizi|comparators|vergleiche|comparateurs|confronti|comparatori)(\/|$)/.test(stripped)) return 'comparison';
  // Border crossings.
  if (/\/(frontiere|frontiera|border|grenze|frontiere-?crossing)(\/|$)/.test(stripped)) return 'border';
  // Fuel / health / weekly employers — treat as "hub" (BreadcrumbList only baseline).
  if (stripped === '/' || stripped === '') return 'home';
  return 'other';
}

const EXPECTED_BY_KIND = {
  job: { required: ['JobPosting', 'BreadcrumbList'] },
  article: { required: ['Article', 'BreadcrumbList'], alternatives: { Article: ['Article', 'BlogPosting', 'NewsArticle'] } },
  calculator: { required: ['WebApplication', 'BreadcrumbList'], alternatives: { WebApplication: ['WebApplication', 'SoftwareApplication'] } },
  comparison: { required: ['ItemList', 'BreadcrumbList'] },
  border: { required: ['Place', 'BreadcrumbList'] },
  home: { required: [] },
  other: { required: ['BreadcrumbList'] },
};

function evaluateExpectation(kind, types) {
  const expected = EXPECTED_BY_KIND[kind] || EXPECTED_BY_KIND.other;
  const missing = [];
  for (const req of expected.required) {
    const alts = expected.alternatives && expected.alternatives[req];
    const candidates = alts || [req];
    const found = candidates.some((c) => types.has(c));
    if (!found) missing.push(req);
  }
  return missing;
}

function writeStubReport(args, reason) {
  mkdirSync(args.out, { recursive: true });
  const today = isoDate();
  const stub = {
    version: 1,
    date: today,
    generatedAt: new Date().toISOString(),
    distRoot: args.dist,
    reason,
    totals: { pages: 0, withSchema: 0, malformed: 0 },
    schemaCounts: {},
    pages: {},
    missingByKind: {},
  };
  writeFileSync(join(args.out, `schema-audit-${today}.json`), JSON.stringify(stub, null, 2));
  writeFileSync(join(args.out, `schema-audit-${today}.md`), `# Schema Audit — ${today}\n\n_${reason}_\n`);
  console.log(`[schema-audit] ${reason} — stub written.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dist)) {
    writeStubReport(args, `dist-missing (${args.dist})`);
    return;
  }
  const files = walkHtml(args.dist);
  if (files.length === 0) {
    writeStubReport(args, 'dist-empty');
    return;
  }

  const schemaCounts = new Map();
  const pages = {};
  const missingByKind = {};
  let malformed = 0;
  let withSchema = 0;

  for (const f of files) {
    const url = fileToUrlPath(f, args.dist);
    let html;
    try {
      html = readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    const blocks = extractJsonLdBlocks(html);
    const types = new Set();
    const blockErrors = [];
    for (const raw of blocks) {
      let parsed;
      try {
        parsed = JSON.parse(raw.trim());
      } catch (err) {
        blockErrors.push(err instanceof Error ? err.message : String(err));
        malformed++;
        continue;
      }
      collectTypes(parsed, types);
    }
    if (types.size > 0) withSchema++;
    const kind = classifyPage(url);
    const missing = evaluateExpectation(kind, types);

    for (const t of types) schemaCounts.set(t, (schemaCounts.get(t) || 0) + 1);

    pages[url] = {
      file: relative(ROOT, f),
      kind,
      types: Array.from(types).sort(),
      missing,
      malformedBlocks: blockErrors,
    };

    if (missing.length > 0) {
      if (!missingByKind[kind]) missingByKind[kind] = [];
      missingByKind[kind].push({ url, missing });
    }
  }

  mkdirSync(args.out, { recursive: true });
  const today = isoDate();
  const report = {
    version: 1,
    date: today,
    generatedAt: new Date().toISOString(),
    distRoot: args.dist,
    totals: {
      pages: files.length,
      withSchema,
      malformed,
    },
    schemaCounts: Object.fromEntries(
      Array.from(schemaCounts.entries()).sort((a, b) => b[1] - a[1])
    ),
    missingByKind,
    pages,
  };

  const jsonPath = join(args.out, `schema-audit-${today}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // Human-readable summary.
  const md = [];
  md.push(`# Schema Audit — ${today}`);
  md.push('');
  md.push(`- Pages scanned: **${files.length}**`);
  md.push(`- Pages with >=1 JSON-LD block: **${withSchema}**`);
  md.push(`- Malformed JSON-LD blocks: **${malformed}**`);
  md.push('');
  md.push('## Schema types across site');
  md.push('');
  md.push('| Type | Pages |');
  md.push('|------|------:|');
  for (const [t, c] of Object.entries(report.schemaCounts)) md.push(`| ${t} | ${c} |`);
  md.push('');
  md.push('## Missing-schema pages by page kind');
  md.push('');
  for (const [kind, items] of Object.entries(missingByKind)) {
    md.push(`### ${kind} (${items.length} pages)`);
    md.push('');
    items.slice(0, 30).forEach((i) => md.push(`- \`${i.url}\` — missing: ${i.missing.join(', ')}`));
    if (items.length > 30) md.push(`- _…and ${items.length - 30} more_`);
    md.push('');
  }
  writeFileSync(join(args.out, `schema-audit-${today}.md`), md.join('\n'));

  console.log(`[schema-audit] ${files.length} pages → ${jsonPath}`);
  console.log(`[schema-audit] withSchema=${withSchema} malformed=${malformed} missingKinds=${Object.keys(missingByKind).length}`);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('schema-audit.mjs');
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error('[schema-audit] fatal:', err);
    try {
      const args = parseArgs(process.argv.slice(2));
      writeStubReport(args, `fatal: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      /* noop */
    }
    process.exit(0);
  }
}

export { extractJsonLdBlocks, classifyPage, evaluateExpectation, collectTypes };
