// scripts/lib/audit-runner.mjs
//
// Unified audit runner — walks dist/ once, dispatches each HTML file to every
// registered Auditor. Replaces the per-audit walker pattern that forces every
// audit to spawn its own Node process, load V8 + dependencies, walk dist/ via
// readdir, read every file via readFile. With ~12 dist-walking audits and
// ~132k files in CI dist, that's ~1.5M file reads and 12× V8 startup cost,
// which is exactly why post-deploy-validate-dist.yml hit OOM on the 7 GB
// ubuntu-latest runner and had to be forced fully-serial.
//
// Architecture:
//   1. Single dist walk produces the file list.
//   2. For each file: read ONCE, dispatch to every Auditor.collect(file, html).
//      Each auditor runs its own regex matches against the same html string;
//      they share the file read but not the regex parse (which is already
//      very fast — the I/O is the dominant cost).
//   3. After the walk, each Auditor.report() runs and decides pass/fail +
//      writes its JSON report via writeAuditReport().
//
// `sharedExtract()` is still exported for auditors that want the common
// regex outputs (title, h1, isNoindex, jsonLdScripts), but it is NOT called
// eagerly by the runner — calling it on every file when most audits don't
// need every field measured at +730 μs/file overhead (a 3× regression on
// audit-footer-root-presence in pilot tests). Auditors opt in via:
//
//   import { sharedExtract } from './lib/audit-runner.mjs';
//   collect(file, html) { const ex = sharedExtract(html); ... }
//
// Worker parallelism (worker_threads) is intentionally NOT enabled here.
// The historical OOM problem on ubuntu-latest free (7 GB) was caused by
// MULTIPLE Node processes each at 1-3 GB RSS — running one Node process
// with all audits in memory peaks much lower (~500 MB-1 GB) because V8 and
// modules are shared. Adding worker_threads on top would reintroduce the
// per-worker V8 overhead this design eliminates. If a future runner has
// more RAM, parallelism can be opted into via AUDIT_WORKERS=N (TODO).

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAuditReport, auditReportPath } from './auditReport.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = join(__dirname, '..', '..');
export const DEFAULT_DIST = join(ROOT, 'dist');

/**
 * @typedef {Object} ExtractedFields
 * @property {string|null} title           — text content of first <title>, decoded, trimmed
 * @property {string|null} h1              — text content of first <h1>, decoded, trimmed
 * @property {boolean}     isNoindex       — true if robots=noindex or meta-refresh redirect
 * @property {string[]}    jsonLdScripts   — inner-text of every <script type="application/ld+json">
 */

/**
 * @typedef {Object} AuditorResult
 * @property {boolean}      passed              — gate verdict
 * @property {number}       offendersTotal      — count of failing items
 * @property {Array}        offenders           — offender list (passed to writeAuditReport)
 * @property {object|null}  [threshold]         — { metric, value, comparator }
 * @property {string|null}  [baselineFile]      — repo-relative baseline path
 * @property {object|null}  [baselineDelta]     — { before, after, regression }
 * @property {object}       [extra]             — extra fields merged into report
 * @property {string}       [humanSummary]      — human-readable line for stdout
 */

/**
 * @typedef {Object} Auditor
 * @property {string} name
 *   The npm-script suffix (e.g., "footer-root-presence" for audit:footer-root-presence).
 *   The runner uses this for report path + stdout labelling.
 * @property {(file: string, html: string) => void} collect
 *   Called once per HTML file. Audit accumulates state in its closure.
 *   MUST NOT mutate `html` (verified when AUDIT_STRICT=1). For shared regex
 *   helpers, import `sharedExtract` from this module and call it inside
 *   collect() — the runner does NOT call it eagerly.
 * @property {() => AuditorResult|Promise<AuditorResult>} report
 *   Called after the walk. Produces the report + gate verdict.
 */

// Shared regex extractions — computed once per file, reused by every audit
// that needs them. Approximate (regex, not full HTML parse) but matches the
// audits' current behaviour byte-for-byte (they all use the same regex
// idioms today).

const RX_TITLE         = /<title[^>]*>([\s\S]*?)<\/title>/i;
const RX_H1            = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const RX_NOINDEX       = /<meta\s+name=["']robots["']\s+content=["'][^"']*\bnoindex\b/i;
const RX_META_REFRESH  = /<meta\s+http-equiv=["']refresh["'][^>]*url=/i;
const RX_JSONLD_SCRIPT = /<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * @param {string} html
 * @returns {ExtractedFields}
 */
export function sharedExtract(html) {
  const t = html.match(RX_TITLE);
  const h1 = html.match(RX_H1);
  const jsonLd = [];
  let m;
  RX_JSONLD_SCRIPT.lastIndex = 0;
  while ((m = RX_JSONLD_SCRIPT.exec(html)) !== null) jsonLd.push(m[1]);
  return {
    title: t ? normalizeText(t[1]) : null,
    h1: h1 ? normalizeText(h1[1]) : null,
    isNoindex: RX_NOINDEX.test(html) || RX_META_REFRESH.test(html),
    jsonLdScripts: jsonLd,
  };
}

function normalizeText(s) {
  return decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();
}
function stripTags(s) { return s.replace(/<[^>]+>/g, ''); }
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Walk a directory recursively, returning absolute paths of every `.html` file.
 * Skips dot-directories (e.g., `.git`, `.cache`).
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function walkHtmlFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith('.html')) out.push(p);
    }
  }
  return out;
}

/**
 * Run all auditors against every HTML file under `distDir`.
 *
 * Memory profile: walks files one at a time (no batch loading). Each
 * auditor accumulates state in its own closure; peak per-file RSS = file
 * size (~20 KB avg) + extracted fields (~5 KB) + per-auditor accumulator
 * growth. With N auditors all running in the same Node process, total RSS
 * is bounded by sum of accumulator sizes, NOT N× file content.
 *
 * @param {Object} opts
 * @param {string} opts.distDir
 * @param {Auditor[]} opts.auditors
 * @param {boolean} [opts.verbose=true]
 * @param {boolean} [opts.writeReports=true]   — call writeAuditReport per auditor
 * @returns {Promise<{
 *   totalElapsedSec: number,
 *   walkElapsedSec: number,
 *   collectElapsedSec: number,
 *   filesScanned: number,
 *   reports: Array<AuditorResult & { name: string, reportPath: string|null, elapsedSec: number }>
 * }>}
 */
export async function runAudits({ distDir, auditors, verbose = true, writeReports = true }) {
  if (!Array.isArray(auditors) || auditors.length === 0) {
    throw new Error('runAudits: no auditors registered');
  }
  for (const a of auditors) {
    if (!a || typeof a.collect !== 'function' || typeof a.report !== 'function' || typeof a.name !== 'string') {
      throw new Error(`runAudits: invalid auditor (must expose { name, collect, report })`);
    }
  }

  const t0 = performance.now();

  const distStat = await stat(distDir).catch(() => null);
  if (!distStat || !distStat.isDirectory()) {
    throw new Error(`runAudits: distDir not found or not a directory: ${distDir}`);
  }

  const tWalk0 = performance.now();
  const files = await walkHtmlFiles(distDir);
  const walkElapsedSec = (performance.now() - tWalk0) / 1000;
  if (verbose) console.log(`[audit-runner] walked ${files.length} HTML files in ${walkElapsedSec.toFixed(2)}s`);

  const strict = process.env.AUDIT_STRICT === '1';
  if (strict && verbose) console.log('[audit-runner] AUDIT_STRICT=1 (mutation detection on)');

  const tCollect0 = performance.now();
  const progressInterval = Math.max(1, Math.floor(files.length / 20));

  let scanned = 0;
  for (const file of files) {
    let html;
    try { html = await readFile(file, 'utf8'); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      continue;
    }

    for (const auditor of auditors) {
      const beforeHtml = strict ? html : null;
      try {
        auditor.collect(file, html);
      } catch (err) {
        console.error(`[audit-runner] ${auditor.name} threw on ${file}: ${err.message}`);
        throw err;
      }
      if (strict && html !== beforeHtml) {
        throw new Error(`[audit-runner] auditor ${auditor.name} mutated html for ${file}`);
      }
    }

    scanned++;
    if (verbose && scanned % progressInterval === 0) {
      const pct = ((scanned / files.length) * 100).toFixed(0);
      console.log(`[audit-runner] progress: ${scanned}/${files.length} (${pct}%)`);
    }
  }

  const collectElapsedSec = (performance.now() - tCollect0) / 1000;
  if (verbose) console.log(`[audit-runner] collected ${scanned} files in ${collectElapsedSec.toFixed(2)}s`);

  const reports = [];
  for (const auditor of auditors) {
    const tReport0 = performance.now();
    const result = await auditor.report();
    const elapsedSec = (performance.now() - tReport0) / 1000;

    let reportPath = null;
    if (writeReports) {
      reportPath = await writeAuditReport({
        audit: auditor.name,
        passed: !!result.passed,
        threshold: result.threshold ?? null,
        baselineFile: result.baselineFile ?? null,
        baselineDelta: result.baselineDelta ?? null,
        offenders: result.offenders ?? [],
        byFeature: result.byFeature,
        extra: result.extra ?? {},
      });
    }

    if (verbose) {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      const summary = result.humanSummary || `${result.offendersTotal ?? (result.offenders?.length ?? 0)} offender(s)`;
      console.log(`${status} ${auditor.name.padEnd(36)} ${elapsedSec.toFixed(2)}s — ${summary}`);
    }

    reports.push({ name: auditor.name, ...result, reportPath, elapsedSec });
  }

  const totalElapsedSec = (performance.now() - t0) / 1000;
  return { totalElapsedSec, walkElapsedSec, collectElapsedSec, filesScanned: scanned, reports };
}

/**
 * Helper: pick a subset of auditors by name (CLI --audits=a,b,c).
 * @param {Auditor[]} all
 * @param {string|undefined} csv
 * @returns {Auditor[]}
 */
export function filterAuditors(all, csv) {
  if (!csv) return all;
  const want = new Set(csv.split(',').map(s => s.trim()).filter(Boolean));
  return all.filter(a => want.has(a.name));
}

export { auditReportPath };
