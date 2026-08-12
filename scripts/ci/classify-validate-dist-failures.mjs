#!/usr/bin/env node
/**
 * Classify `validate-dist` gate failures: does this red run invalidate the
 * DEPLOY, or does it report a QUALITY defect on pages that are already live?
 *
 * Why this exists (issues #4828 → #5128)
 * -------------------------------------
 * `deploy-publish.yml` gated `publish` on `needs.validate-dist.result ==
 * 'success'`. `publish` is what tells Google a deploy happened: Indexing API,
 * IndexNow, GSC submit, previous-slug-winners sync. When `audit:hreflang`
 * started failing on 22 offenders (#5114), `publish` went `skipped` for 18
 * consecutive runs — no search engine was told about ANY new page for two
 * days, on a site that lives on organic traffic.
 *
 * The coupling was not doing what its comment claimed. `validate-dist` runs
 * in PARALLEL with `deploy`, so by the time it goes red the dist is already
 * live; and `deploy-publish.yml` wires NO rollback to it (grep: zero hits).
 * The original rationale — "don't announce URLs a rollback is about to
 * revert" — describes a mechanism that no longer exists in the caller. What
 * remained was: a page with a broken hreflang stays live and unannounced,
 * which is strictly worse for the page than announcing it.
 *
 * What this does NOT do
 * ---------------------
 * It does not silence, downgrade, or widen ANY gate (AGENTS.md
 * non-negotiables #1 and #2). Every audit keeps its own pass/fail threshold,
 * the gate job still exits non-zero, `validate-dist` still reports FAILURE,
 * and the failure issue still opens. The only thing this changes is whether
 * a QUALITY failure is allowed to sequester the indexing notification of a
 * deploy that `deploy` and `validate-live` both certified as live.
 *
 * Default-deny by construction
 * ----------------------------
 * Every gate is deploy-invalidating UNLESS it appears in `QUALITY_GATES`
 * below. A gate added to the workflow later therefore blocks `publish` until
 * someone deliberately classifies it — the safe direction. An unparseable or
 * missing result set also fails closed (`integrity_ok=false`), so a broken
 * classifier can never widen the gate.
 *
 * Usage:
 *   node scripts/ci/classify-validate-dist-failures.mjs --failed "a,b,c"
 *   node scripts/ci/classify-validate-dist-failures.mjs --results-file <path>
 *
 * Writes `integrity_ok=true|false` (+ `blocking_gates`, `quality_gates`) to
 * $GITHUB_OUTPUT when set. Always exits 0 — the verdict is the output, not
 * the exit code — so the verdict is unambiguous and the caller's step summary
 * can render it.
 *
 * This used to say "outputs of a FAILED job do not [survive the boundary]".
 * That is FALSE, measured on probe runs 31081857672 (a job that wrote an
 * output and then exited 1 still delivered it) and 31081032808 (a reusable
 * workflow whose overall conclusion is `failure` still delivers outputs).
 * The value is lost only when the step never writes it — see #4828.
 */

/**
 * Gates whose failure describes a defect in pages that are already live and
 * serving correctly. Not announcing such a page to Google does not fix the
 * defect — it only keeps a working page out of the index.
 *
 * Everything not listed here is treated as deploy-invalidating. In
 * particular the sitemap validators stay blocking: `publish` submits the
 * sitemap URL set verbatim, so a bad sitemap means we would push wrong or
 * dead URLs to Google and Bing.
 */
export const QUALITY_GATES = Object.freeze({
  // #5114. A broken <link rel="alternate"> is a real SEO defect, but the
  // page itself renders and serves. Google tolerates a MISSING hreflang.
  'audit:hreflang': 'broken cross-locale alternates; pages serve correctly',
  // Internal-link depth. Affects discoverability, not validity.
  'audit:max-bfs-depth': 'link-graph depth ratchet; pages serve correctly',
  // In the sitemap but not internally linked. The page exists.
  'audit:orphan-sitemap-pages': 'orphan pages; URLs resolve',
  // Completeness of job records (salary, postcode, …) in already-live pages.
  'validate:jobs-quality': 'job record completeness; pages serve correctly',
  // Issue #5656 item 1: five vitest RUN_DIST_GATES files newly wired
  // (duplicate meta descriptions, duplicate page-scoped JSON-LD, anchor-text
  // budget, single-H1-per-page, related-search-cluster contract), running
  // for the first time ever against production dist/. Same class as
  // content-duplicates/h1-title-duplicates below — a page with one of these
  // defects still renders and serves. Unreviewed-first-run, so it must not
  // sequester the indexing notification of an already-live, valid deploy.
  'dist:quality-tests': 'newly-wired dist content-quality gates; pages serve correctly',

  // ── `audit:all` sub-auditors (#4828) ───────────────────────────────────
  // `audit:all` is a bundle of 12 auditors reported under ONE gate name.
  // Left opaque it is unclassifiable, so default-deny blocked `publish`
  // whenever any of the 12 went red — including the purely cosmetic ones.
  // Run 31077435060 is the proof: audit:all red for h1-title-duplicates +
  // text-html-ratio + no-literal-markdown only, every structural auditor
  // green, and `publish` skipped.
  //
  // validate-dist-postbuild now expands the bundle into `audit:all/<name>`.
  // Only auditors whose failure describes a defect on a page that RENDERS
  // AND SERVES are listed here. The four deliberately NOT listed —
  // `audit:all/footer-root-presence` (hydration-safe shell: a failure means
  // pages may be broken shells), `audit:all/jsonld-no-nested-scripts`
  // (nested <script> wrappers can break the document), plus
  // `audit:all/faqpage-validity` and `audit:all/image-object-license`
  // (structured-data validity we submit alongside the URL) — stay blocking
  // through default-deny, as does any auditor registered in future.
  'audit:all/title-length': 'title over the length ratchet; page serves',
  'audit:all/title-no-disambig-hash': 'cosmetic title suffix; page serves',
  'audit:all/h1-title-duplicates': 'h1 duplicates title; page serves',
  'audit:all/text-html-ratio': 'thin text/markup ratio; page serves',
  'audit:all/content-duplicates': 'near-duplicate bodies; pages serve',
  'audit:all/page-weight': 'page byte budget; page serves',
  'audit:all/no-literal-markdown': 'unrendered markdown in <main>; page serves',
  'audit:all/salary-landing-template': 'landing template drift; page serves',
});

/**
 * Split a failed-gate list into the two classes.
 * @param {readonly string[]} failedGates
 * @returns {{ blocking: string[], quality: string[] }}
 */
export function classifyFailures(failedGates) {
  const blocking = [];
  const quality = [];
  for (const raw of failedGates) {
    const gate = String(raw || '').trim();
    if (!gate) continue;
    if (Object.prototype.hasOwnProperty.call(QUALITY_GATES, gate)) quality.push(gate);
    else blocking.push(gate);
  }
  return { blocking, quality };
}

/**
 * `publish` may run when nothing deploy-invalidating failed.
 *
 * `failedGates === null` means "could not determine" (a job crashed before
 * writing its result set, a malformed row, an infra failure). That fails
 * CLOSED: an unknown failure is treated as blocking.
 *
 * @param {readonly string[] | null} failedGates
 * @returns {{ integrityOk: boolean, blocking: string[], quality: string[], reason: string }}
 */
export function evaluateIntegrity(failedGates) {
  if (failedGates === null || failedGates === undefined) {
    return {
      integrityOk: false,
      blocking: [],
      quality: [],
      reason: 'gate results unavailable — failing closed',
    };
  }
  const { blocking, quality } = classifyFailures(failedGates);
  if (blocking.length > 0) {
    return {
      integrityOk: false,
      blocking,
      quality,
      reason: `deploy-invalidating gate(s) failed: ${blocking.join(', ')}`,
    };
  }
  if (quality.length > 0) {
    return {
      integrityOk: true,
      blocking,
      quality,
      reason:
        `only quality gate(s) failed: ${quality.join(', ')} — dist is valid, ` +
        `publish proceeds. validate-dist stays RED and the failure is tracked.`,
    };
  }
  return { integrityOk: true, blocking, quality, reason: 'no gate failures' };
}

/**
 * Parse the `<name>  <seconds>  rc=<code>` rows the gate jobs emit into the
 * list of gates that failed. Returns null when a row is malformed — the
 * summary loop in the workflow treats a missing rc as FAIL, and so do we,
 * but a row we cannot even name has to fail closed.
 *
 * @param {string} text
 * @returns {string[] | null}
 */
export function parseResultRows(text) {
  const failed = [];
  for (const line of String(text || '').split('\n')) {
    const row = line.trim();
    if (!row) continue;
    const m = /^(\S+)\s+.*\brc=(\d+)\s*$/.exec(row);
    if (!m) return null; // unparseable row → cannot classify → fail closed
    if (m[2] !== '0') failed.push(m[1]);
  }
  return failed;
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const { appendFileSync, readFileSync, existsSync } = await import('node:fs');

  let failedGates;
  const failedArg = argOf('--failed');
  const resultsFile = argOf('--results-file');

  if (failedArg !== undefined) {
    failedGates = failedArg.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (resultsFile) {
    // A missing results file means the job died before running any gate.
    failedGates = existsSync(resultsFile)
      ? parseResultRows(readFileSync(resultsFile, 'utf-8'))
      : null;
  } else {
    failedGates = null;
  }

  const verdict = evaluateIntegrity(failedGates);

  console.log('─'.repeat(70));
  console.log(`validate-dist integrity verdict: ${verdict.integrityOk ? 'OK' : 'BLOCKED'}`);
  console.log(`  reason:   ${verdict.reason}`);
  console.log(`  blocking: ${verdict.blocking.join(', ') || '(none)'}`);
  console.log(`  quality:  ${verdict.quality.join(', ') || '(none)'}`);
  console.log('─'.repeat(70));
  if (verdict.quality.length > 0) {
    console.log(
      '::warning::validate-dist failed on quality gate(s) ' +
        `${verdict.quality.join(', ')}. The deploy is live and validated, so ` +
        'publish (IndexNow / Indexing API / GSC) is NOT sequestered. The ' +
        'validate-dist job stays RED and its failure issue still opens — fix ' +
        'the audit, do not widen it.',
    );
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `integrity_ok=${verdict.integrityOk ? 'true' : 'false'}\n` +
        `blocking_gates=${verdict.blocking.join(',')}\n` +
        `quality_gates=${verdict.quality.join(',')}\n`,
    );
  }
  // Always 0: the verdict travels as an output, never as an exit code, so a
  // quality-only failure stays distinguishable from an infra failure. (A
  // non-zero exit would NOT by itself lose the output — see the header note.)
  process.exit(0);
}

const isMain =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) await main();
