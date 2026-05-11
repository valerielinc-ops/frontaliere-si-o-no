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
    expect(provenBlock![0]).toMatch(/isQualityReject\s*=\s*isTopicGateAbort/);
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
