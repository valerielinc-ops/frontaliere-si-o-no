/**
 * Regression test for the topic-gate-abort retry logic in
 * scripts/create-article.mjs.
 *
 * 2026-05-11 incident (run 25697916845): the REGOLA #0 topic-gate added
 * in PR #94 correctly rejected a cronaca-nera headline (good!) by
 * throwing an Error with `err.topicGateAbort = true`. The headline-retry
 * loops (proven pool + evergreen) detected fact-check / fabrication
 * rejects via a regex on the error message, but the regex did NOT cover
 * `Topic-gate abort: …`. So the error propagated up to main(), the
 * workflow exited with code 1, and the next headline was never tried.
 *
 * Fix: both quality-reject branches now also flag `err.topicGateAbort
 * === true` OR `/topic-gate abort/i` in the message. The loop continues
 * to the next headline / keyword. Same quality outcome (slop not
 * published) but workflow stays green and retry budget is honored.
 *
 * This test parses the source file and asserts the recognition logic
 * matches both error shapes at both call sites.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '..', 'scripts/create-article.mjs'),
  'utf8',
);

describe('topic-gate-abort recovery in headline retry loops', () => {
  it('recognises err.topicGateAbort and the message pattern at the proven-pool catch site', () => {
    // The proven-pool retry loop is around line 5946 (Fact-check / quality
    // failures branch inside the per-pool catch). Both shapes must be checked.
    const provenBlock = SRC.match(
      /\/\/ Fact-check \/ quality failures → skip this article, try next[\s\S]*?break; \/\/ try next pool, then evergreen\n\s+\}/,
    );
    expect(provenBlock, 'proven-pool quality-reject block not found').toBeTruthy();
    expect(provenBlock![0]).toMatch(/e\.topicGateAbort\s*===\s*true/);
    expect(provenBlock![0]).toMatch(/\/topic-gate abort\/i/);
    // The quality decision is now delegated to the shared isQualityRejectError
    // helper so the proven-pool catch, evergreen catch, and main().catch can
    // never drift apart (CLAUDE.md non-negotiable #6).
    expect(provenBlock![0]).toMatch(/isQualityReject\s*=\s*isQualityRejectError\(e\)/);
  });

  it('recognises err.topicGateAbort and the message pattern at the evergreen catch site', () => {
    const evergreenBlock = SRC.match(
      /\/\/ Fact-check \/ quality failures → try next keyword instead of crashing[\s\S]*?Duplicato post-generazione[\s\S]*?\}/,
    );
    expect(evergreenBlock, 'evergreen quality-reject block not found').toBeTruthy();
    expect(evergreenBlock![0]).toMatch(/e\.topicGateAbort\s*===\s*true/);
    expect(evergreenBlock![0]).toMatch(/\/topic-gate abort\/i/);
  });

  it('the original topicGateAbort throw site still tags the error', () => {
    // Sanity: the throw site that creates err.topicGateAbort=true is still
    // present. If this guard is ever removed without updating the recognition
    // regex, the loop falls back to the message-pattern match instead.
    expect(SRC).toMatch(/err\.topicGateAbort\s*=\s*true/);
    expect(SRC).toMatch(/Topic-gate abort:/);
  });

  it('recognition is order-safe: topicGateAbort flag is checked before the message regex', () => {
    // Both shapes are valid signals; the flag check is faster and clearer.
    // We use `||` so even if the message text changes, the flag catches it.
    const provenBlock = SRC.match(
      /isTopicGateAbort\s*=\s*e\.topicGateAbort\s*===\s*true\s*\|\|\s*\/topic-gate abort\/i\.test\(e\.message\)/g,
    );
    expect(provenBlock).toBeTruthy();
    expect(provenBlock!.length).toBeGreaterThanOrEqual(2); // both call sites
  });
});

/**
 * Regression test for the headline-validation hard-fail incident
 * (run 28000585473 → spurious Bug issue #2750, 2026-06-23).
 *
 * A free-tier model kept emitting an over-length IT title (>110 char); after
 * the headline retry budget was spent, create-article.mjs threw
 * `Headline validation failed after retry`. That message did NOT match the
 * quality-reject regex, so it propagated as an infrastructure error: the run
 * exited 1, the workflow went red, and the `if: failure()` step opened a
 * false-positive "Workflow Failure" Bug issue — even though "no conformant
 * headline this run" is the SAME benign disposition as a fact-check reject.
 *
 * Fix: the throw is tagged `err.qualityReject = true`, and a single shared
 * `isQualityRejectError(e)` helper recognises every content-rejection shape
 * (topic-gate abort, fact-check, fabrication, non-conformant headline). The
 * retry loops rotate; if exhausted, main().catch defers cleanly (exit 0). Per
 * CLAUDE.md non-negotiable #1 the headline gate itself is untouched — slop is
 * still refused, only the disposition changes from failure to deferral.
 */
describe('headline-validation reject defers instead of hard-failing', () => {
  it('the headline-validation throw site tags the error as a quality reject', () => {
    const block = SRC.match(
      /Headline validation failed after retry[\s\S]*?throw headlineErr;/,
    );
    expect(block, 'headline-validation throw block not found').toBeTruthy();
    expect(block![0]).toMatch(/\.qualityReject\s*=\s*true/);
  });

  it('a single isQualityRejectError helper recognises every content-rejection shape', () => {
    const helper = SRC.match(
      /function isQualityRejectError\(e\)\s*\{[\s\S]*?\n\}/,
    );
    expect(helper, 'isQualityRejectError helper not found').toBeTruthy();
    const body = helper![0];
    // Flag shapes (fast path).
    expect(body).toMatch(/e\.qualityReject\s*===\s*true/);
    expect(body).toMatch(/e\.topicGateAbort\s*===\s*true/);
    // Message-pattern fallback covers fact-check, fabrication, topic-gate, and
    // the headline-validation failure that triggered #2750.
    expect(body).toMatch(/fact-check/);
    expect(body).toMatch(/fabricat/);
    expect(body).toMatch(/topic-gate abort/);
    expect(body).toMatch(/headline validation failed/);
  });

  it('main().catch defers (exit 0) on a quality reject, not exit 1', () => {
    // The top-level catch must treat a bubbled-up quality reject the same as an
    // exhausted free-model pool: finalize as deferred and exit 0 so the
    // self-trigger back-off retries — never raise a spurious failure issue.
    const tail = SRC.slice(SRC.indexOf('main().catch'));
    expect(tail).toMatch(/if\s*\(isQualityRejectError\(e\)\)\s*\{/);
    const guard = tail.match(/if\s*\(isQualityRejectError\(e\)\)\s*\{[\s\S]*?process\.exit\(0\);/);
    expect(guard, 'quality-reject guard in main().catch not found').toBeTruthy();
    expect(guard![0]).toMatch(/finalizeRunReport\('deferred'/);
    expect(guard![0]).toMatch(/process\.exit\(0\)/);
  });
});
