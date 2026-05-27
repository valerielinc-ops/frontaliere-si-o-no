#!/usr/bin/env node
/**
 * audit-jsonld-no-nested-scripts
 *
 * Zero-tolerance: every JSON-LD payload in dist/ HTML must live inside
 * exactly ONE `<script type="application/ld+json">…</script>` wrapper.
 *
 * Regression caught: GSC "Tipo di valore non corretto" (2026-05-16) on
 * ~80 canton-hub URLs in de/en/fr/it (jobs-im-wallis, find-jobs-valais,
 * trouver-emploi-valais, cerca-lavoro-vallese, …).
 *
 * Root cause: jobsSeoPagesPlugin.ts produced `cantonBreadcrumbLd` already
 * wrapped in `<script type="application/ld+json">…</script>`, then passed
 * it through `buildSeoPageHtml({ jsonLdScripts: [cantonBreadcrumbLd] })`.
 * `buildSimplePage` (htmlTemplate.ts:183) wraps every array entry with the
 * same tag, yielding nested wrappers. Google parses the outer script's
 * literal-string content as the JSON-LD payload, finds `<script>{…}</script>`
 * (not an object), and flags the page as "wrong value type" / "unparsable
 * structured data". Fixed in PR #317; this audit prevents the regression
 * from any future plugin that pre-wraps a JSON-LD string before handing
 * it to the shell helper.
 *
 * Two execution modes:
 *   1. Standalone:        `node scripts/audit-jsonld-no-nested-scripts.mjs`
 *   2. Unified runner:    import { auditor } and register with audit-all.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

// Matches an `application/ld+json` opening tag whose first non-whitespace
// content is another `<script` opening tag (any attributes, any type).
const NESTED_JSONLD_RE =
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>\s*<script\b/gi;

export function createAuditor(opts = {}) {
  const limit = Math.max(1, opts.limit ?? 30);
  const offenders = [];
  let scanned = 0;

  return {
    name: 'jsonld-no-nested-scripts',
    collect(file, html) {
      if (!html) return;
      scanned++;
      // Cheap pre-filter: skip pages that don't carry the MIME type at all.
      if (!html.includes('application/ld+json')) return;
      NESTED_JSONLD_RE.lastIndex = 0;
      const matches = html.match(NESTED_JSONLD_RE);
      if (matches && matches.length > 0) {
        offenders.push({ path: relative(ROOT, file), feature: featureOf(file), metric: matches.length });
      }
    },
    report() {
      const passed = offenders.length === 0;
      const totalNests = offenders.reduce((acc, o) => acc + o.metric, 0);
      const humanSummary = passed
        ? `scanned ${scanned} HTML file(s) — no nested wrappers`
        : `${offenders.length} page(s) with nested JSON-LD wrappers (${totalNests} total)`;
      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'nestedJsonldPages', value: 0, comparator: '<=' },
        extra: { scanned, totalNests, limit },
        humanSummary,
      };
    },
  };
}

function featureOf(absPath) {
  const rel = relative(ROOT, absPath).replace(/^dist\//, '');
  const first = rel.split('/')[0];
  return first || 'root';
}

export const auditor = createAuditor();
export { createAuditor as factory };

async function standalone() {
  const args = process.argv.slice(2);
  const limit = (() => {
    const a = args.find((s) => s.startsWith('--limit='));
    return a ? Math.max(1, parseInt(a.split('=')[1], 10) || 30) : 30;
  })();

  const s = await stat(DEFAULT_DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`audit-jsonld-no-nested-scripts: dist/ not found at ${DEFAULT_DIST}. Run a build first.`);
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
    threshold: result.threshold ?? null,
    offenders: result.offenders ?? [],
    extra: result.extra ?? {},
  });

  console.log(`audit-jsonld-no-nested-scripts: ${result.humanSummary}`);
  if (result.passed) {
    console.log('PASS: no nested <script type="application/ld+json"> wrappers in dist/.');
    process.exit(0);
  }

  const totalNests = result.extra.totalNests;
  console.error(`\nFAIL: ${result.offendersTotal} page(s) ship nested <script type="application/ld+json"> wrappers (${totalNests} total occurrence(s)).`);
  console.error(`Google parses the outer wrapper's literal-string content as the JSON-LD payload,`);
  console.error(`flagging the page as "Tipo di valore non corretto" / "Wrong value type" in GSC.`);
  console.error(`\nFirst ${Math.min(limit, result.offenders.length)} offenders:`);
  for (const o of result.offenders.slice(0, limit)) {
    console.error(`  ${o.path}${o.metric > 1 ? ` (${o.metric}×)` : ''}`);
  }
  if (result.offenders.length > limit) console.error(`  ... and ${result.offenders.length - limit} more`);
  console.error(`\nHow to fix`);
  console.error(`----------`);
  console.error(`The emitter is pre-wrapping JSON-LD in <script type="application/ld+json">…</script>`);
  console.error(`before passing it to a shell helper that wraps it again. Find the offender:`);
  console.error(`  grep -rn '\\\`<script type="application/ld+json">\\\${JSON.stringify' build-plugins/`);
  console.error(`Pass the raw JSON.stringify(...) output to jsonLdScripts[]; let buildSimplePage`);
  console.error(`wrap exactly once. Reference fix: PR #317 (build-plugins/jobsSeoPagesPlugin.ts:7750).`);
  process.exit(1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('audit-jsonld-no-nested-scripts: fatal', err);
    process.exit(2);
  });
}
