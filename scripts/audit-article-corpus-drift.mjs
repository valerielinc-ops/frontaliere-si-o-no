#!/usr/bin/env -S npx -y tsx
// audit-article-corpus-drift.mjs — issue #4881 Fase 4: periodic template-drift
// audit, the DETECTION half of the safety net scripts/rerender-article-corpus.mjs
// / .github/workflows/rerender-article-corpus.yml replace.
//
// WHY: once articles are published/updated via the fast path
// (scripts/publish-article-fast.mjs, #4837) instead of always riding a full
// `vite build`, that full build's whole-corpus re-render stops acting as a
// free, automatic safety net against template regressions — a bug in
// ogPagesPlugin.ts or any of its post-render plugins could silently drift
// live article HTML away from what the current source tree would actually
// render, with nothing noticing until a human happens to look. This script
// is the periodic, read-only check: sample some already-published articles,
// re-render each with the CURRENT source tree, diff against what is
// currently LIVE, report divergence.
//
// ONE IMPLEMENTATION, NEVER A FORK: the actual per-article render + diff
// mechanics (curl-vs-local comparison, trailing-newline tolerance, the
// ASSET_CDN/TZ preconditions, Cloudflare bot-fight-script tolerance) already
// exist, unmodified, in scripts/check-article-byte-identity.mjs (#4837
// stream A deliverable 4) — this script is a thin sampling + aggregation
// wrapper that shells out to it once per sampled article id. It does NOT
// re-implement or duplicate that comparison logic.
//
// ── Sampling design (explicit — not exhaustive; state size + method) ──────
// Exhaustive diffing (every article, every locale) would cost roughly what
// the full `vite build` this whole effort exists to avoid costs — that is
// exactly the case the corpus re-render workflow handles instead. This audit
// is a SAMPLE, by design:
//   - Size: --sample-size per section, default DEFAULT_SAMPLE_SIZE (20).
//     Reasoned budget, not a hard measurement: each sampled article costs one
//     scripts/publish-article-fast.mjs render (~1s scale, see
//     scripts/rerender-article-corpus.mjs's own measured smoke-test batch
//     timings: 1-2 article batches completed in 0.6-1.0s including `npx tsx`
//     cold start) plus up to 4 locale `curl`s (network-bound, sub-second
//     each typically) inside check-article-byte-identity.mjs — ~20 articles
//     keeps one audit run in the low minutes, not hours.
//   - Method: uniform random sample WITHOUT replacement, drawn from the full
//     per-section id list (enumerateSectionArticleIds — the SAME
//     superset-safe enumeration scripts/rerender-article-corpus.mjs uses to
//     build render batches; issue #4881 Fase 4, AGENTS.md #6: one
//     implementation, not a second copy). No stratification (e.g. "always
//     include the newest N") is applied — kept deliberately simple to avoid
//     a second, untested dependency on the article registry's date-field
//     shape. Coverage over time is PROBABILISTIC: run periodically (e.g.
//     weekly cron), the expected number of runs before any given article has
//     been sampled at least once is roughly ids.length / sampleSize — this
//     script does NOT persist state across runs to guarantee round-robin
//     coverage; that is a known, accepted limitation of this design, not a
//     promise it keeps.
//   - Known tolerable/false-positive sources, NOT mitigated by forking the
//     underlying script, only by interpreting its stdout more finely (see
//     parseLocaleVerdicts below):
//       1. Cloudflare's bot-fight `<script>` tag (`__CF$cv$params={...}`) is
//          injected at the edge on every live response and never appears in
//          origin-rendered HTML — check-article-byte-identity.mjs's own
//          header comment documents this as an EXPECTED live-only diff, yet
//          its exit code still treats it as a MISMATCH. Confirmed empirically
//          during this script's own development: sampling a real,
//          template-unrelated article showed this tag as the ONLY remaining
//          diff once an unrelated local-fixture gap was fixed (this worktree's
//          minimal sparse-checkout initially lacked the article's hero image
//          — see this PR's report). Without accounting for this, the audit
//          would report "FAIL" on nearly every real run regardless of actual
//          drift — a useless, always-crying-wolf signal. This script
//          recognizes that specific, stable marker in the underlying
//          script's own printed diff block and categorizes it separately
//          (`ok-cf-bot-script-only`) instead of as real drift.
//       2. "live fetch returned non-200" (e.g. an article published in the
//          last few minutes, still propagating) is ALSO reported by
//          check-article-byte-identity.mjs as an undifferentiated MISMATCH.
//          Categorized here as `fetch-or-liveness`, also excluded from the
//          audit's pass/fail signal — it is a timing artifact, not template
//          drift.
//     Both categorizations read ONLY the underlying script's own already-
//     printed, stable log-line format (`[byte-identity] <locale>: ...`) —
//     never a second curl, never a re-derived diff.
//
// Exit code 0 = no sampled article showed a real divergence category.
// Exit code 1 = at least one sampled article diverged (any category) — see
// the written --report JSON for the full per-article breakdown; a CI caller
// (e.g. a scheduled workflow) is expected to file/update a tracking issue on
// non-zero exit, mirroring every other audit script + workflow pair in this
// repo (the script itself never calls the GitHub API).
//
// CLI:
//   npx -y tsx scripts/audit-article-corpus-drift.mjs \
//     [--section frontaliere|svizzera|all] [--sample-size 20] [--report <path>] \
//     [--only-ids id1,id2,...]   (bypasses random sampling — check exactly
//                                 these ids; useful to re-check a specific
//                                 article on demand, or to deterministically
//                                 exercise this script itself)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SAMPLE_SIZE = 20; // per section — see header comment for the reasoned budget

function parseArgs(argv) {
  const out = { section: 'all', sampleSize: DEFAULT_SAMPLE_SIZE, report: undefined, onlyIds: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--section') out.section = argv[++i];
    else if (a === '--sample-size') out.sampleSize = Number(argv[++i]);
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--only-ids') out.onlyIds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!['frontaliere', 'svizzera', 'all'].includes(out.section)) {
    console.error(`[audit-article-corpus-drift] --section must be frontaliere|svizzera|all, got "${out.section}"`);
    process.exit(1);
  }
  return out;
}

// Uniform random sample without replacement, size <= arr.length.
function sampleWithoutReplacement(arr, n) {
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

// Per-locale verdict parser for a check-article-byte-identity.mjs run.
//
// That script prints exactly one status line per locale in a stable,
// human-authored format: `[byte-identity] <locale>: OK — ...` or
// `[byte-identity] <locale>: <FAIL-reason> — ...`, optionally followed by a
// firstDiffLines() context block before the next locale's line. Splitting on
// that literal prefix (never re-deriving the diff ourselves — only reading
// what the script already printed) recovers one verdict per locale:
//   - 'ok'                  — byte-identical, per that script's own check.
//   - 'cf-bot-script-only'  — a MISMATCH whose diff block contains the
//     literal Cloudflare bot-fight marker `__CF$cv$params` — the exact
//     divergence source check-article-byte-identity.mjs's own header comment
//     documents as EXPECTED-live-only (a `<script>` tag Cloudflare's edge
//     injects at serve time, never present in origin-rendered HTML).
//     firstDiffLines() reports only the FIRST divergence point per locale, so
//     the CF tag appearing in that reported block means the whole document
//     UP TO that point matched — treated as non-divergent for this audit
//     (confirmed empirically during this script's own smoke test: after
//     fixing an unrelated local-fixture gap — see this PR's report — the
//     ONLY remaining diff for a real, unmodified article was this exact tag).
//     Reusing check-article-byte-identity.mjs unmodified means its own exit
//     code conflates this known-tolerable case with genuine drift; this
//     script does NOT alter that shared script, it only interprets its
//     stdout more finely for periodic-audit purposes.
//   - 'render-failure'      — "local file missing" (the fast-render side
//     itself produced no output for this locale).
//   - 'fetch-or-liveness'   — "curl ... exited" / "live fetch ... -> HTTP"
//     (live URL unreachable or non-200 — e.g. a very recently published
//     article still propagating; see header comment).
//   - 'content-mismatch'    — a real MISMATCH with no CF marker in its
//     reported diff block: the signal this audit actually exists to catch.
export function parseLocaleVerdicts(combinedOutput) {
  const verdicts = {};
  let currentLocale = null;
  let currentBlockLines = [];

  const flush = () => {
    if (!currentLocale) return;
    const firstLine = currentBlockLines[0] || '';
    const blockText = currentBlockLines.join('\n');
    if (/:\s*OK\s*—/.test(firstLine)) {
      verdicts[currentLocale] = 'ok';
    } else if (/local file missing/.test(firstLine)) {
      verdicts[currentLocale] = 'render-failure';
    } else if (/curl .* exited/.test(firstLine) || /live fetch .* -> HTTP/.test(firstLine)) {
      verdicts[currentLocale] = 'fetch-or-liveness';
    } else if (/:\s*MISMATCH\s*—/.test(firstLine) && blockText.includes('__CF$cv$params')) {
      verdicts[currentLocale] = 'cf-bot-script-only';
    } else if (/:\s*MISMATCH\s*—/.test(firstLine)) {
      verdicts[currentLocale] = 'content-mismatch';
    } else {
      verdicts[currentLocale] = 'unknown';
    }
  };

  for (const line of combinedOutput.split('\n')) {
    const m = /^\[byte-identity\]\s+(it|en|de|fr):\s/.exec(line);
    if (m) {
      flush();
      currentLocale = m[1];
      currentBlockLines = [line];
    } else if (currentLocale) {
      currentBlockLines.push(line);
    }
  }
  flush();
  return verdicts;
}

// Categories that count as a genuine finding for this audit's pass/fail exit
// code: real content drift, or a run this script could not even categorize
// (fail loud rather than silently treat "could not evaluate" as a pass — see
// AGENTS.md "never downgrade error to warning"). 'render-failure' and
// 'fetch-or-liveness' are recorded and printed but do NOT fail the run: they
// are operational/timing noise (a slow deploy propagation, a transient
// network blip), not template drift — the thing this audit exists to catch.
/**
 * Collapses the per-locale verdicts of one article into a single category.
 *
 * Pure and exported so the precedence order is unit-testable: it has been
 * wrong twice. The first version fell through to 'ok' whenever no known
 * verdict matched; the second only caught the all-'unknown' case, so a mix
 * (it=ok, en=unknown) still passed silently with en never actually verified
 * — the same blind spot, just narrowed (reviewer finding on PR #4914).
 *
 * Precedence, and why:
 *   1. no-locale-verdicts — the checker never printed a single line.
 *   2. content-mismatch   — real drift, the thing this audit exists to catch.
 *   3. unrecognized-verdicts — ANY locale unparseable. Outranks the tolerated
 *      noise below: 'it=cf-bot-script-only, en=unknown' must not report as a
 *      pass, because en was never verified at all.
 *   4-5. render-failure / fetch-or-liveness — operational noise, reported but
 *      not failing (see DIVERGENT_CATEGORIES).
 *   6. ok.
 */
export function categorizeLocaleVerdicts(localeVerdicts) {
  const values = Object.values(localeVerdicts ?? {});
  if (values.length === 0) return 'no-locale-verdicts';
  if (values.includes('content-mismatch')) return 'content-mismatch';
  if (values.includes('unknown')) return 'unrecognized-verdicts';
  if (values.includes('cf-bot-script-only')) return 'ok-cf-bot-script-only';
  if (values.includes('render-failure')) return 'render-failure';
  if (values.includes('fetch-or-liveness')) return 'fetch-or-liveness';
  return 'ok';
}

export const DIVERGENT_CATEGORIES = new Set(['content-mismatch', 'no-locale-verdicts', 'unrecognized-verdicts']);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { ARTICLE_SECTION_DESCRIPTORS, enumerateSectionArticleIds } = await import('../build-plugins/shared/articleSectionDescriptors.ts');
  const sections = ARTICLE_SECTION_DESCRIPTORS.filter((s) => args.section === 'all' || s.name === args.section);

  const report = { generatedAt: new Date().toISOString(), sampleSizeRequested: args.sampleSize, sections: {} };
  let anyDivergence = false;

  for (const section of sections) {
    const ids = enumerateSectionArticleIds(section, ROOT_DIR);
    const sample = args.onlyIds && args.onlyIds.length
      ? args.onlyIds.filter((id) => ids.includes(id))
      : sampleWithoutReplacement(ids, Math.min(args.sampleSize, ids.length));
    console.log(`[audit-article-corpus-drift] section=${section.name} corpusSize=${ids.length} sampled=${sample.length}`);

    const results = [];
    for (const id of sample) {
      const checkScript = path.join(ROOT_DIR, 'scripts', 'check-article-byte-identity.mjs');
      const result = spawnSync('npx', ['-y', 'tsx', checkScript, '--id', id, '--section', section.name], {
        cwd: ROOT_DIR,
        encoding: 'utf-8',
      });
      const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
      const localeVerdicts = parseLocaleVerdicts(combinedOutput);

      const category = categorizeLocaleVerdicts(localeVerdicts);

      const ok = !DIVERGENT_CATEGORIES.has(category);
      if (!ok) anyDivergence = true;
      results.push({ articleId: id, ok, category, localeVerdicts });
      console.log(`[audit-article-corpus-drift]   ${section.name}/${id}: ${ok ? `OK (${category})` : `FAIL (${category})`}`);
    }

    report.sections[section.name] = {
      corpusSize: ids.length,
      sampled: sample.length,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
      results,
    };
  }

  const reportPath = args.report ? path.resolve(args.report) : path.join(os.tmpdir(), 'article-corpus-drift-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`[audit-article-corpus-drift] report written to ${reportPath}`);

  if (anyDivergence) {
    console.error('[audit-article-corpus-drift] FAIL — at least one sampled article diverged (see categories above / report for detail)');
    process.exit(1);
  }
  console.log('[audit-article-corpus-drift] PASS — no divergence found in this sample');
}

// Run as standalone only if invoked directly. Same idiom as
// scripts/audit-footer-root-presence.mjs and siblings — without it, merely
// IMPORTING this module (as tests/audit-article-corpus-drift-categorize.test.ts
// does to reach the pure categorizer) would execute the whole audit: spawn
// `npx tsx` per sampled article, hit the live site, and call process.exit.
const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[audit-article-corpus-drift] fatal error:', err);
    process.exit(1);
  });
}
