import { describe, expect, it } from 'vitest';
import { sweepMayPush } from '../scripts/ci/pr-autorebase.mjs';

/**
 * Issue #9189. `pr-autorebase.mjs` is a fleet sweep invoked once per PR that
 * runs CI, so N open PRs produce N concurrent sweeps evaluating the same N PRs.
 * Each decides on the `gh pr list` snapshot it read at startup, then used to
 * check out whatever the remote head had become and merge `origin/main` on top
 * — a legitimate fast-forward, so neither the TOCTOU guard on the push (which
 * relies on a non-fast-forward being rejected) nor the 6-minute activity guard
 * (which measures the age of the OLD head) could see it.
 *
 * Measured on #9192 on 2026-09-19: two `Merge remote-tracking branch
 * 'origin/main'` commits 39 seconds apart, both by frontaliere-automation[bot].
 * Every push invalidates the review, because the gate requires
 * `commit_id === headSha`.
 */
describe('autorebase compare-and-swap on the decided head', () => {
  const head = 'a'.repeat(40);
  const other = 'b'.repeat(40);

  it('pushes when the remote head is still the one every gate decided on', () => {
    expect(sweepMayPush({ decidedHead: head, actualHead: head })).toBe(true);
  });

  it('refuses when a concurrent sweep already moved the head', () => {
    expect(sweepMayPush({ decidedHead: head, actualHead: other })).toBe(false);
  });

  it('is case-insensitive on the SHA, not a spurious skip', () => {
    expect(sweepMayPush({ decidedHead: head.toUpperCase(), actualHead: head })).toBe(true);
  });

  // Fail-closed. Losing a turn costs one tick; pushing onto a head that could
  // not be verified redoes exactly the damage this guard exists to stop.
  it.each([
    ['unreadable rev-parse', { decidedHead: head, actualHead: '' }],
    ['missing decided head', { decidedHead: '', actualHead: head }],
    ['abbreviated head', { decidedHead: head, actualHead: 'a'.repeat(8) }],
    ['both unknown', { decidedHead: '', actualHead: '' }],
    ['null actual', { decidedHead: head, actualHead: null as unknown as string }],
  ])('refuses to push on %s', (_label, input) => {
    expect(sweepMayPush(input)).toBe(false);
  });
});
