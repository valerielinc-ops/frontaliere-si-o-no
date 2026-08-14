/**
 * Shared bounded scan for the full-corpus `dist/**\/*.html` gates that
 * `npm run gate:dist-quality` runs (issue #5729).
 *
 * WHY THIS EXISTS — the failure mode it removes
 * ---------------------------------------------
 * Every gate in that script used to do the same three things wrong, and the
 * combination made the gate's output unreadable rather than merely red:
 *
 * 1. `walkHtml()` returned a materialised `string[]` of every dist path. The
 *    2026-08-14 validation run measured **3,798,763** HTML files in dist/;
 *    four of these test files run in parallel worker threads, each building
 *    its own multi-hundred-MB array, on a runner whose `MemAvailable` sits at
 *    1.1-1.9 GB during post-build. That is where
 *    `Error: Worker terminated due to reaching memory limit: JS heap out of
 *    memory` (`ERR_WORKER_OUT_OF_MEMORY`) came from. This helper streams: it
 *    hands each file to a callback and never holds more than one path.
 *
 * 2. The test bodies were fully synchronous and ran far past
 *    `testTimeout: 15000` (vitest.config.ts). **Vitest cannot interrupt a
 *    synchronous body** — the timer it races against the test can only fire
 *    once the body returns. So the body always ran to completion, and the
 *    already-expired timer then won the race *only when the body returned
 *    normally*. Net effect, verified by mutation:
 *
 *        sync body outlives testTimeout AND passes  -> "Test timed out in 15000ms"
 *        sync body outlives testTimeout AND throws  -> its real error
 *
 *    i.e. **a passing gate was reported as a timeout and a failing gate was
 *    reported truthfully** — the exact inversion that made #5729 look like a
 *    scan-speed problem. In the 2026-08-14 run, 7 of the 14 reported failures
 *    were tests that had actually passed. `tests/dist-gate-explicit-timeout.test.ts`
 *    is the observer that keeps this from coming back.
 *
 * 3. Nothing bounded wall time. Five full-corpus scans at ~0.54 ms/file ran
 *    ~71 minutes before reporting anything. This helper takes a wall-clock
 *    budget and ABORTS the walk when it is exceeded, so a corpus that has
 *    outgrown the gate says so in minutes, with the numbers, instead of
 *    burning an hour to emit a misleading timeout.
 *
 * WHAT THIS HELPER DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It does not sample, and it does not touch any gate's pass/fail threshold.
 * `scripts/audit-all.mjs` has a rotation-guaranteed sampling lever
 * (`AUDIT_SAMPLE_RATE` / `AUDIT_SAMPLE_SALT`, see
 * `scripts/lib/audit-runner.mjs::sampleFiles`) and folding these gates into
 * that single walk is the structural fix — the post-deploy workflow already
 * states the rule, in the comment that keeps `tests/seo/faqpage-validity.test.ts`
 * and `tests/seo/image-object-license-fields.test.ts` OUT of
 * `gate:dist-quality` because their auditor siblings already walk the same
 * dist/. Doing that here would silently re-scope four gates' coverage in a
 * PR whose job is to stop them lying; it is tracked separately.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Dirent } from 'node:fs';

/**
 * Default wall-clock ceiling for one full-corpus scan.
 *
 * Chosen against measurement, not taste: the 2026-08-14 run scanned
 * 3,798,763 files in 2,065,613 ms (~0.54 ms/file). 240 s therefore covers a
 * corpus of roughly 440k files — comfortably above every dist/ this gate was
 * written for ("~50k" per the original docstrings) and far below the point
 * where the gate stops being a gate and becomes an hour of CI. When this
 * trips, the fix is to reduce the work (sample, or fold into `audit:all`'s
 * single walk), NOT to raise the number.
 */
export const DEFAULT_SCAN_BUDGET_MS = 240_000;

/**
 * Hard vitest timeout for a test that runs one bounded scan.
 *
 * Must exceed {@link DEFAULT_SCAN_BUDGET_MS} so the *scan's own* abort is
 * what reports the failure — with file counts and elapsed time — rather than
 * vitest's opaque "Test timed out". Raising this costs nothing in wall time:
 * vitest cannot interrupt a synchronous body, so the timeout never truncated
 * anything; it only ever relabelled the result. See the header block.
 */
export const SCAN_TEST_TIMEOUT_MS = 300_000;

export interface DistScanResult {
  /** HTML files actually handed to the callback. */
  readonly filesScanned: number;
  /** Wall-clock ms spent walking + reading + invoking the callback. */
  readonly elapsedMs: number;
  /** True when the budget was hit and the walk stopped early. */
  readonly aborted: boolean;
  /** The budget that was applied, echoed for the failure message. */
  readonly budgetMs: number;
}

export interface DistScanOptions {
  /** Wall-clock ceiling; the walk stops once exceeded. */
  readonly budgetMs?: number;
  /**
   * How often to re-check the clock, in files. Reading `Date.now()` per file
   * across millions of files is itself measurable, so the check is amortised.
   */
  readonly checkEvery?: number;
}

/**
 * Stream every `dist/**\/*.html` file through `onFile`, bounded by a
 * wall-clock budget.
 *
 * The walk is iterative (an explicit stack, not recursion) and uses
 * `readdirSync(..., { withFileTypes: true })` so the dirent kind comes back
 * from the single `readdir` syscall instead of a `statSync` per entry — the
 * optimisation #5778 applied to `dist-duplicate-structured-data` and that the
 * other gates never received.
 *
 * `onFile` receives the dist-relative path (leading `/`, matching what the
 * existing offender messages print) and the file contents.
 */
export function scanDistHtml(
  distDir: string,
  onFile: (relPath: string, html: string) => void,
  options: DistScanOptions = {},
): DistScanResult {
  const budgetMs = options.budgetMs ?? DEFAULT_SCAN_BUDGET_MS;
  const checkEvery = options.checkEvery ?? 512;
  const started = Date.now();

  let filesScanned = 0;
  let aborted = false;

  if (!existsSync(distDir)) {
    return { filesScanned: 0, elapsedMs: 0, aborted: false, budgetMs };
  }

  const stack: string[] = [distDir];
  let sinceClockCheck = 0;

  walk: while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, race with a concurrent rehydrate)
      // is not this gate's business — skip it rather than fail the run.
      continue;
    }

    for (const ent of entries) {
      const full = join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.html')) continue;

      let html: string;
      try {
        html = readFileSync(full, 'utf-8');
      } catch {
        continue;
      }
      onFile(full.slice(distDir.length), html);
      filesScanned += 1;

      if (++sinceClockCheck >= checkEvery) {
        sinceClockCheck = 0;
        if (Date.now() - started > budgetMs) {
          aborted = true;
          break walk;
        }
      }
    }
  }

  return { filesScanned, elapsedMs: Date.now() - started, aborted, budgetMs };
}

/**
 * OBSERVER for #5729, generalised from the one PR #5778 added to
 * `dist-duplicate-structured-data`.
 *
 * That observer worked exactly as designed — it is why the 2026-08-14 run
 * could name "2065613ms across 3798763 HTML files" instead of leaving another
 * bisection to a human. The defect was that only one of the five gates had
 * it; the other four still failed opaquely. Call this first in every gate,
 * BEFORE asserting on offenders: a scan that aborted has not proved the
 * absence of anything, so its content assertions must not run.
 *
 * @param result   what {@link scanDistHtml} returned
 * @param gateName the gate's name, for the failure message
 * @param partial  optional preview of what the truncated scan did find, so an
 *                 abort still carries evidence instead of only a stopwatch
 */
export function assertScanCompleted(
  result: DistScanResult,
  gateName: string,
  partial?: readonly string[],
): void {
  if (!result.aborted) return;

  const rate = result.filesScanned > 0 ? result.elapsedMs / result.filesScanned : 0;
  const preview =
    partial && partial.length > 0
      ? `\n\nFound in the ${result.filesScanned} files scanned before the abort ` +
        `(NOT a complete list — the scan did not finish):\n${partial
          .slice(0, 20)
          .map((p) => `  - ${p}`)
          .join('\n')}`
      : '';

  throw new Error(
    `${gateName}: dist scan ABORTED after ${result.elapsedMs}ms having read ` +
      `${result.filesScanned} HTML files (budget ${result.budgetMs}ms, ` +
      `${rate.toFixed(3)}ms/file). dist/ has outgrown a full-corpus walk in a ` +
      `vitest gate.\n\n` +
      `This is a SCALE failure, not a content failure: nothing is asserted about ` +
      `the pages, because a truncated scan cannot prove the absence of an offender.\n\n` +
      `Fix by reducing the work, NOT by raising the budget:\n` +
      `  - sample, using the rotation-guaranteed lever the auditors already share ` +
      `(AUDIT_SAMPLE_RATE / AUDIT_SAMPLE_SALT, scripts/lib/audit-runner.mjs::sampleFiles); or\n` +
      `  - register this invariant as an auditor in scripts/audit-all.mjs, which walks ` +
      `the same dist/ ONCE for all of them — the rule the post-deploy workflow already ` +
      `applies to faqpage-validity and image-object-license.\n` +
      `Raising the budget is how #5729 kept reopening.${preview}`,
  );
}
