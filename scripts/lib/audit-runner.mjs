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
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAuditReport, auditReportPath } from './auditReport.mjs';

// Use the proven `dirname(fileURLToPath(import.meta.url))` pattern instead of
// `fileURLToPath(new URL('.', import.meta.url))`. The latter throws
// `ERR_INVALID_URL_SCHEME` when vitest loads this module via a non-file:
// URL scheme (test runner uses its own bundler resolution). The former
// works in both runtime + vitest because fileURLToPath() accepts file: URLs
// directly without re-parsing them through the URL constructor.
const __dirname = dirname(fileURLToPath(import.meta.url));
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
// Quote-flexible — PR #478 baked removeAttributeQuotes upstream so single-token
// attribute values lose their quotes in dist/. `name=robots`, `http-equiv=refresh`,
// `name=author`, etc. — all now appear unquoted. The `application/ld+json` value
// contains a `/` and `+`, so the upstream minifier keeps its quotes (HTML5 spec
// rules out unquoted values containing those chars), and that regex stays as-is.
const RX_NOINDEX       = /<meta\s+name=["']?robots["']?\s+content=["']?[^"'>]*\bnoindex\b/i;
const RX_META_REFRESH  = /<meta\s+http-equiv=["']?refresh["']?[^>]*url=/i;
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
// Bounded-concurrency directory fan-out — WALK_CONCURRENCY simultaneous
// `readdir` calls instead of one at a time. The SSG output tree is one
// directory per job/page (`dist/<locale>/<section>/<slug>/index.html`), so
// on a ~3.3M-file dist that's ~3.3M individual `readdir` syscalls; awaiting
// them fully sequentially (the previous stack-based DFS) leaves the event
// loop idle between each one. Same lever this file's own `runAudits()`
// collect loop already applies to file reads (see READAHEAD below) — this
// mirrors that established pattern for the walk phase instead of inventing
// a new one. Correctness is unaffected: every directory is still visited
// exactly once, dot-prefixed directories are still skipped, and the
// returned set of `.html` files is identical — only DISCOVERY ORDER changes
// (no auditor or test depends on walk order; pass/fail is a function of the
// complete file SET, not its enumeration order — see tests/seo/audit-
// runner.test.ts, which only asserts membership/count/`.every()` predicates).
const WALK_CONCURRENCY = 24;

/**
 * @param {string} dir
 * @param {{ keep?: (absPath: string) => boolean, stats?: { seen: number } }} [opts]
 *   `keep` decides which discovered `.html` paths are RETAINED — the walk still
 *   visits every one of them, so `stats.seen` (when supplied) is the true
 *   on-disk total. This exists because materialising the whole corpus and
 *   filtering afterwards costs a multiple of the memory of never keeping the
 *   rejected paths: on run 32261742920 the walk found 3'904'613 files of which
 *   a sampled run wanted 976'903, i.e. ~2.93M path strings (~450 MB at this
 *   tree's ~140-char paths) built only to be dropped one statement later,
 *   inside the same 4 GB heap that then went `FATAL ERROR: Ineffective
 *   mark-compacts near heap limit` two thirds of the way through collect.
 *   Selection is unchanged — same predicate, same files, same results.
 * @returns {Promise<string[]>}
 */
export async function walkHtmlFiles(dir, opts = undefined) {
  const keep = typeof opts?.keep === 'function' ? opts.keep : null;
  const stats = opts?.stats ?? null;
  const out = [];
  const queue = [dir];
  let inFlight = 0;
  let cursor = 0;

  // Same "swallow any readdir error and skip that subtree" contract as the
  // original sequential walk's `catch { continue; }` — a speed refactor
  // must not also change error-handling semantics.
  await new Promise((resolve) => {
    const pump = () => {
      while (inFlight < WALK_CONCURRENCY && cursor < queue.length) {
        const cur = queue[cursor++];
        // Drop the consumed entry's string. `queue` is a BFS frontier that is
        // never truncated, so without this it ends the walk holding one path
        // string per directory in the tree — ~2M of them on this corpus,
        // alive for the whole walk purely because `cursor` moved past them.
        queue[cursor - 1] = '';
        inFlight++;
        readdir(cur, { withFileTypes: true })
          .then((entries) => {
            for (const e of entries) {
              if (e.name.startsWith('.')) continue;
              const p = join(cur, e.name);
              if (e.isDirectory()) queue.push(p);
              else if (e.isFile() && p.endsWith('.html')) {
                if (stats) stats.seen++;
                if (!keep || keep(p)) out.push(p);
              }
            }
          })
          .catch(() => {})
          .finally(() => {
            inFlight--;
            if (cursor >= queue.length && inFlight === 0) resolve();
            else pump();
          });
      }
    };
    pump();
  });

  return out;
}

// FNV-1a — fast, deterministic, language-independent (no crypto import needed
// for a non-adversarial bucket assignment). Same path always hashes to the
// same bucket on every machine/run, which is what the rotation below relies on.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic ROTATING sample of `files`. Every file hashes to one of
 * `totalBuckets` buckets (stable across runs); this call keeps only the
 * files whose bucket equals `salt % totalBuckets`. Over `totalBuckets`
 * consecutive calls with `salt` incrementing (e.g. GITHUB_RUN_NUMBER), every
 * file gets scanned at least once — full corpus coverage is preserved, just
 * spread across a bounded run window instead of happening on every single
 * run. This is NOT the same guarantee as scanning everything every run; it
 * trades per-run completeness for wall-clock, on the premise (true for this
 * repo's push-triggered validate-dist cadence) that runs happen often enough
 * for the window to stay short. See scripts/audit-all.mjs's --sample-rate
 * docs for the CI wiring and rationale (AGENTS.md non-negotiable #1: this
 * must never be silent — sampling metadata is always printed in the
 * audit-all summary and returned from runAudits()).
 *
 * @param {string[]} files absolute paths from walkHtmlFiles
 * @param {string} distDir base dir (for a machine/run-independent relative hash key)
 * @param {number} rate 0 < rate <= 1; 1 = no sampling (identity)
 * @param {number} salt rotation position (e.g. run number); any integer
 * @returns {{ sampled: string[], totalBuckets: number, activeBucket: number }}
 */
/**
 * Read the rotating-sample configuration out of the environment.
 *
 * `AUDIT_SAMPLE_RATE` / `AUDIT_SAMPLE_SALT` are set once for the whole
 * post-build step in post-deploy-validate-dist.yml, so every gate that opts
 * into sampling must parse them identically — hence one definition here next
 * to {@link sampleFiles} rather than a copy per script.
 *
 * Anything missing, unparseable or out of range degrades to "no sampling"
 * (rate 1), never to a narrower scan: a malformed env var must not silently
 * shrink a gate's coverage.
 *
 * @returns {{ rate: number, salt: number }}
 */
export function resolveSamplingEnv(env = process.env) {
  const rawRate = Number(env.AUDIT_SAMPLE_RATE);
  const rate = Number.isFinite(rawRate) && rawRate > 0 && rawRate <= 1 ? rawRate : 1;
  const rawSalt = Number(env.AUDIT_SAMPLE_SALT);
  const salt = Number.isFinite(rawSalt) ? Math.trunc(rawSalt) : 0;
  return { rate, salt };
}

export function sampleFiles(files, distDir, rate, salt) {
  const totalBuckets = Math.max(1, Math.round(1 / rate));
  if (totalBuckets <= 1) return { sampled: files, totalBuckets: 1, activeBucket: 0 };
  const activeBucket = ((salt % totalBuckets) + totalBuckets) % totalBuckets;
  const sampled = files.filter((f) => fnv1a(relative(distDir, f)) % totalBuckets === activeBucket);
  return { sampled, totalBuckets, activeBucket };
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
 * @param {number}  [opts.sampleRate=1]        — 0<rate<=1; 1 scans everything
 * @param {number}  [opts.sampleSalt=0]        — rotates which bucket is scanned
 * @returns {Promise<{
 *   totalElapsedSec: number,
 *   walkElapsedSec: number,
 *   collectElapsedSec: number,
 *   filesScanned: number,
 *   reports: Array<AuditorResult & { name: string, reportPath: string|null, elapsedSec: number }>,
 *   sampling: { totalBuckets: number, activeBucket: number, filesOnDisk: number, filesScanned: number } | null
 * }>}
 */
export async function runAudits({ distDir, auditors, verbose = true, writeReports = true, sampleRate = 1, sampleSalt = 0 }) {
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

  // Sampling is decided BEFORE the walk and applied inside it, so the rejected
  // ~75 % of paths are never materialised. `sampleFiles()` stays exported and
  // unchanged — it is the same predicate, and the post-hoc form is still what
  // the unit tests pin — but this path no longer pays for a 3.9M-entry array
  // it immediately discards. See walkHtmlFiles' opts for the measurement.
  const rate = sampleRate > 0 && sampleRate <= 1 ? sampleRate : 1;
  const totalBuckets = rate < 1 ? Math.max(1, Math.round(1 / rate)) : 1;
  const activeBucket = totalBuckets > 1 ? ((sampleSalt % totalBuckets) + totalBuckets) % totalBuckets : 0;

  const tWalk0 = performance.now();
  const walkStats = { seen: 0 };
  const files = await walkHtmlFiles(distDir, {
    stats: walkStats,
    keep: totalBuckets > 1
      ? (abs) => fnv1a(relative(distDir, abs)) % totalBuckets === activeBucket
      : undefined,
  });
  const walkElapsedSec = (performance.now() - tWalk0) / 1000;
  if (verbose) console.log(`[audit-runner] walked ${walkStats.seen} HTML files in ${walkElapsedSec.toFixed(2)}s`);

  const sampling = totalBuckets > 1
    ? { totalBuckets, activeBucket, filesOnDisk: walkStats.seen, filesScanned: files.length }
    : null;
  if (sampling && verbose) {
    console.log(
      `[audit-runner] SAMPLED run: bucket ${activeBucket + 1}/${totalBuckets} — ` +
      `scanning ${files.length}/${walkStats.seen} files (${((files.length / walkStats.seen) * 100).toFixed(1)}%). ` +
      `Full corpus coverage requires ${totalBuckets} consecutive runs (rotates via sampleSalt).`,
    );
  }

  const strict = process.env.AUDIT_STRICT === '1';
  if (strict && verbose) console.log('[audit-runner] AUDIT_STRICT=1 (mutation detection on)');

  const tCollect0 = performance.now();
  const progressInterval = Math.max(1, Math.floor(files.length / 20));

  let scanned = 0;
  // Bounded read-ahead: overlap each file's disk read with the previous file's
  // (CPU-bound, single-threaded) collect pass. We keep READAHEAD reads in flight
  // and await them in order. This is a PURE I/O-scheduling change — collect()
  // still runs on every file's exact html string in the SAME order, so every
  // auditor's accumulator and report() verdict is byte-identical to the serial
  // loop. Read promises settle to {html} | {err} so a read that rejects while
  // waiting its turn in the queue never becomes an unhandled rejection; the
  // ENOENT-skip / non-ENOENT-throw behaviour is preserved at await time.
  const READAHEAD = 8;
  const inflight = [];
  let nextIdx = 0;
  const fillQueue = () => {
    while (inflight.length < READAHEAD && nextIdx < files.length) {
      const file = files[nextIdx++];
      inflight.push({ file, p: readFile(file, 'utf8').then((html) => ({ html }), (err) => ({ err })) });
    }
  };
  fillQueue();
  while (inflight.length > 0) {
    const { file, p } = inflight.shift();
    fillQueue(); // keep the next read pre-issued while we process this one
    const { html, err } = await p;
    if (err) {
      if (err.code !== 'ENOENT') throw err;
      continue;
    }

    for (const auditor of auditors) {
      const beforeHtml = strict ? html : null;
      try {
        auditor.collect(file, html);
      } catch (e) {
        console.error(`[audit-runner] ${auditor.name} threw on ${file}: ${e.message}`);
        throw e;
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
  return { totalElapsedSec, walkElapsedSec, collectElapsedSec, filesScanned: scanned, reports, sampling };
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
