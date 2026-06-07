#!/usr/bin/env node
/**
 * audit-no-literal-markdown
 *
 * Fails when raw `**...**` markdown bold tokens (or separator runs like
 * `______`, `======`) leak into the visible body of a job detail page.
 *
 * Root cause history (2026-05-20): the AI translation pipeline mangled bold
 * markers in `descriptionByLocale`, leaving unbalanced `**` runs that the
 * SSG renderer (`jobsSeoPagesPlugin.ts plainTextToHtml`) and the SPA
 * renderer (`components/community/JobBoard.tsx renderFormattedDescription`)
 * passed through literally. The shared parser in
 * `build-plugins/shared/jobDescription/parser.ts` now strips them; this
 * audit pins that down as a deploy-blocking 0-tolerance gate.
 *
 * Scope: only `<main class="seo-static-content">` content inside
 * `dist/cerca-lavoro-ticino/**` is scanned. Outside the main and non-job
 * pages can legitimately contain `**` (e.g. legal text, code samples).
 *
 * Two execution modes:
 *   1. Standalone:  `node scripts/audit-no-literal-markdown.mjs`
 *   2. Unified runner: import { auditor } from this file, register it with
 *                       scripts/audit-all.mjs.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

// Quote-flexible: minified pages may ship single-token classes without
// quotes, e.g. `<main class=seo-static-content>`.
const SEO_STATIC_OPEN = /<main\b(?=[^>]*\bclass=(?:"[^"]*\bseo-static-content\b[^"]*"|'[^']*\bseo-static-content\b[^']*'|seo-static-content)(?=[\s>]))[^>]*>/i;
const MAIN_CLOSE = /<\/main>/i;

// `\*\*[^*\n]{1,200}\*\*` — bold tokens with non-empty body
const LITERAL_BOLD_RE = /\*\*[^*\n]{1,200}\*\*/g;
// 3+ run of `_`, `=`, `~` as separator decoration
const SEPARATOR_RUN_RE = /[_=~]{3,}/g;
// Inline <script>/<style> blocks are code, not visible body. Their contents
// can legitimately contain `===` (JS strict-equality, e.g. the per-card logo
// fallback script `w.length===0`) or `~`/`_` runs that are NOT literal
// markdown. Strip them before detection so code can't false-flag the gate.
const CODE_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
// Tag markup and attribute values (e.g. `onerror="jcLF(this)"`,
// `data-props='{"eq":"==="}'`, a logo `src` URL with `?a===b`) are NOT visible
// body text either — `[_=~]{3,}` or `**…**` inside an attribute must not flag
// the gate. The element-level CODE_BLOCK_RE strip only removes script/style
// *blocks*; remaining attributes survive. Strip all tags so only the rendered
// text nodes are scanned, matching the canonical sibling auditors
// (audit-content-duplicates.mjs, audit-text-html-ratio.mjs). Order matters:
// script/style block *contents* must go first (TAG_RE removes only the tags,
// not the JS body between them); replace tags with a space so text either side
// of a tag boundary can't merge into a false `**`.
const TAG_RE = /<[^>]+>/g;

function extractMainBody(html) {
  const openMatch = html.match(SEO_STATIC_OPEN);
  if (!openMatch) return '';
  const startIdx = openMatch.index + openMatch[0].length;
  const closeIdx = html.slice(startIdx).search(MAIN_CLOSE);
  const raw = closeIdx < 0 ? html.slice(startIdx) : html.slice(startIdx, startIdx + closeIdx);
  return raw.replace(CODE_BLOCK_RE, ' ').replace(TAG_RE, ' ');
}

function isJobDetailPage(absPath) {
  const rel = relative(ROOT, absPath).replace(/^dist\//, '');
  return rel.startsWith('cerca-lavoro-ticino/') && rel.endsWith('.html');
}

export function createAuditor(opts = {}) {
  const limit = Math.max(1, opts.limit ?? 30);
  const offenders = [];
  let scanned = 0;

  return {
    name: 'no-literal-markdown',
    collect(file, html) {
      if (!html || !isJobDetailPage(file)) return;
      scanned++;
      const body = extractMainBody(html);
      if (!body) return;

      const bolds = body.match(LITERAL_BOLD_RE);
      const seps = body.match(SEPARATOR_RUN_RE);
      if ((bolds && bolds.length > 0) || (seps && seps.length > 0)) {
        offenders.push({
          path: relative(ROOT, file),
          literalBoldSamples: (bolds || []).slice(0, 3),
          separatorSamples: (seps || []).slice(0, 3),
        });
      }
    },
    report() {
      const passed = offenders.length === 0;
      const humanSummary = passed
        ? `scanned ${scanned} job detail page(s) — no literal ** or separator runs in <main>`
        : `${offenders.length} of ${scanned} job detail page(s) carry literal markdown in <main>`;
      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'literalMarkdownOffenders', value: 0, comparator: '<=' },
        extra: { scanned, limit },
        humanSummary,
      };
    },
  };
}

export const auditor = createAuditor();
export { createAuditor as factory };

async function standalone() {
  const args = process.argv.slice(2);
  const limit = (() => {
    const a = args.find((s) => s.startsWith('--limit='));
    return a ? Math.max(1, parseInt(a.split('=')[1], 10) || 30) : 30;
  })();

  const distStat = await stat(DEFAULT_DIST).catch(() => null);
  if (!distStat || !distStat.isDirectory()) {
    console.error(`audit-no-literal-markdown: dist/ not found at ${DEFAULT_DIST}. Run a build first.`);
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

  console.log(`audit-no-literal-markdown: ${result.humanSummary}`);
  if (result.passed) {
    console.log('PASS: no literal ** or separator runs leak into job detail bodies.');
    process.exit(0);
  }

  console.error(`\nFAIL: ${result.offendersTotal} job detail page(s) leak literal markdown.`);
  console.error(`First ${Math.min(limit, result.offenders.length)} offenders:`);
  for (const o of result.offenders.slice(0, limit)) {
    const tail = [
      ...(o.literalBoldSamples || []).map((s) => `** ${s.slice(0, 60)}`),
      ...(o.separatorSamples || []).map((s) => `sep ${s.slice(0, 16)}`),
    ].slice(0, 3).join(' | ');
    console.error(`  ${o.path} — ${tail}`);
  }
  console.error(`\nHow to fix`);
  console.error(`----------`);
  console.error(`Both SSG (build-plugins/jobsSeoPagesPlugin.ts) and SPA`);
  console.error(`(components/community/JobBoard.tsx) must call into the shared parser at`);
  console.error(`build-plugins/shared/jobDescription/parser.ts. Crawler-time normalization`);
  console.error(`runs in scripts/lib/crawler-template.mjs#cleanCrawlerArtifacts via`);
  console.error(`scripts/assemble-jobs-dataset.mjs.`);
  process.exit(1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('audit-no-literal-markdown: fatal', err);
    process.exit(2);
  });
}
