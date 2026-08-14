#!/usr/bin/env node
/**
 * audit-breadcrumb-coverage.mjs
 *
 * Post-build gate (Workstream D.2): every **indexable** `dist/` HTML page
 * must include a `BreadcrumbList` JSON-LD block. Mirror of
 * `tests/seo/breadcrumb-coverage.test.ts` — same exemptions (noindex pages,
 * canonical bridge pages, the root `/index.html` and `/404.html`), migrated
 * into the unified `audit-all` runner (issue #5874) so this walks dist/ once
 * alongside faqpage-validity/image-object-license instead of a second
 * full-corpus walk inside `gate:seo-source`, which vitest cannot bound —
 * see `tests/helpers/distHtmlScan.ts`.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-breadcrumb-coverage.mjs [...]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

const ALLOWED_MISSING = new Set(['/404.html', '/index.html', '/']);

const BREADCRUMB_JSONLD_RE = /"@type"\s*:\s*"BreadcrumbList"/;
// Quote-flexible: scripts/dist-shrink.mjs removes attribute quotes, so
// `name="robots" content="noindex,follow"` becomes
// `name=robots content="noindex,follow"` (commas force quotes, plain
// `name=robots` does not). Match both shapes.
const NOINDEX_RE =
  /<meta[^>]*\bname\s*=\s*["']?robots["']?[^>]*\bcontent\s*=\s*["']?[^"'>]*noindex/i;
// Canonical bridge pages (built via `buildCanonicalBridgePage` in
// build-plugins/constants.ts) consolidate crawl signals into their
// canonical target and never surface directly in SERPs — exempt.
const BRIDGE_PAGE_RE = /Questa URL\s+(?:legacy|azienda|alias|di ricerca|dell[’'\\s]annuncio)/i;

function fileToUrlPath(relPath) {
  if (relPath === '/index.html') return '/index.html';
  if (relPath.endsWith('/index.html')) return relPath.slice(0, -'index.html'.length);
  return relPath;
}

// Mirrors scripts/audit-footer-root-presence.mjs::featureOf's
// relative(ROOT, file).replace(/^dist\//, '') pattern, with the leading
// slash tests/seo/breadcrumb-coverage.test.ts's ALLOWED_MISSING expects.
function toDistRelPath(absPath) {
  return `/${relative(ROOT, absPath).replace(/^dist\//, '')}`;
}

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 20;
  const offenders = [];

  return {
    name: 'breadcrumb-coverage',
    collect(file, html) {
      // Zero-byte files are corrupted artifacts (e.g. from an OOM crash
      // mid-build), not real indexable pages — skip rather than count as a
      // coverage gap.
      if (html.length === 0) return;
      const url = fileToUrlPath(toDistRelPath(file));
      if (ALLOWED_MISSING.has(url)) return;
      if (NOINDEX_RE.test(html)) return;
      if (BRIDGE_PAGE_RE.test(html)) return;
      if (!BREADCRUMB_JSONLD_RE.test(html)) {
        offenders.push({ path: relative(ROOT, file), url, metric: 1 });
      }
    },
    report() {
      const passed = offenders.length === 0;
      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'count', value: 0, comparator: '<=' },
        extra: { limit },
        humanSummary: passed
          ? 'Breadcrumb coverage gate: 0 offenders'
          : `${offenders.length} page(s) missing BreadcrumbList JSON-LD`,
      };
    },
  };
}

export const factory = createAuditor;
export const auditor = factory();

// ─── Standalone CLI ──────────────────────────────────────────────────────────

async function standalone() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx === -1 ? undefined : args[idx + 1];
  };
  const limit = Number(getArg('--limit') ?? 20);
  const JSON_OUT = args.includes('--json');

  const s = await stat(DEFAULT_DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`[audit-breadcrumb-coverage] ${DEFAULT_DIST} not found — run \`npm run build\` first.`);
    process.exit(2);
  }

  const a = createAuditor({ limit });
  const files = await walkHtmlFiles(DEFAULT_DIST);
  for (const file of files) {
    let html;
    try { html = await readFile(file, 'utf8'); }
    catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    a.collect(file, html);
  }
  const result = await a.report();
  await writeAuditReport({
    audit: a.name,
    passed: result.passed,
    threshold: result.threshold,
    offenders: result.offenders.slice(0, 100),
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({ total: result.offendersTotal, offenders: result.offenders.slice(0, limit) }, null, 2));
  } else if (result.passed) {
    console.log('✅ Breadcrumb coverage gate: 0 offenders.');
  } else {
    console.error(`❌ Breadcrumb coverage gate: ${result.offendersTotal} page(s) missing BreadcrumbList JSON-LD.`);
    console.error('');
    console.error(`Top ${Math.min(limit, result.offenders.length)} offenders:`);
    for (const o of result.offenders.slice(0, limit)) {
      console.error(`  - ${o.url}  (${o.path})`);
    }
    console.error('');
    console.error('Fix: emit a BreadcrumbList JSON-LD block on every indexable page (mirror: tests/seo/breadcrumb-coverage.test.ts).');
  }
  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('[audit-breadcrumb-coverage] fatal', err);
    process.exit(2);
  });
}
