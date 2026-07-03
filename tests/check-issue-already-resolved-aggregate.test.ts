/**
 * Lock the aggregate-detection guard of the issue-fix.yml pre-flight gate
 * (scripts/ci/check-issue-already-resolved.mjs). An aggregate follow-up must NEVER be
 * short-circuited on a single token match — one resolved sub-item ≠ all resolved. The
 * matcher itself (`detectAlreadyResolved`) is covered in followup-resolution-match.test.ts;
 * here we only lock `isAggregate`, including the sweep/batch/bulk keyword fallback that
 * catches sweeps with no "N items deferred" count (#1826 class).
 */
import { describe, it, expect } from 'vitest';
import { isAggregate } from '../scripts/ci/check-issue-already-resolved.mjs';

describe('isAggregate — aggregate follow-ups bypass the already-resolved short-circuit', () => {
  it('flags "N items deferred" with N>=2', () => {
    expect(isAggregate('follow-up(#1674): 3 items deferred — fix(seo)', '')).toBe(true);
    expect(isAggregate('follow-up(#1651): 2 item deferred', '')).toBe(true);
  });
  it('matches the count in the body too, not just the title', () => {
    expect(isAggregate('follow-up(#10): cleanup', 'This batch has 4 items deferred for later.')).toBe(true);
  });
  it('treats single-item / count-less follow-ups as non-aggregate (gate may short-circuit)', () => {
    expect(isAggregate('follow-up(#1685): 1 item deferred — perf', '')).toBe(false);
    expect(isAggregate('follow-up(#999): fix one regex', 'Suggested action: tweak the pattern.')).toBe(false);
  });
  it('flags sweep/batch/bulk issues with no "N items deferred" count (#1826 class)', () => {
    expect(isAggregate('Sweep: ~30 crawlers need shared fetchHtml', '')).toBe(true);
    expect(isAggregate('follow-up(#1826): batch-fix selectors', 'Each target listed below.')).toBe(true);
    expect(isAggregate('chore: bulk migrate slugs', '')).toBe(true);
  });
  it('does not trigger on sweep/batch substrings inside unrelated words', () => {
    expect(isAggregate('fix: swept the floor', 'a debatable approach')).toBe(false);
  });
  it('explicit "1 item deferred" wins over an ordinary "batch"/"sweep"/"bulk" word in the same title — count is authoritative, no keyword fallback (#3378)', () => {
    expect(isAggregate(
      'follow-up(#3371): 1 item deferred — fix(job-alerts): batch backfill re-checks tier-3 before tier-4 URL fallback',
      '',
    )).toBe(false);
  });
  it('still flags a genuine count-less sweep even when it would also match the "N items" regex loosely (no regression on #1826)', () => {
    expect(isAggregate('Sweep: ~30 crawlers need shared fetchHtml', '')).toBe(true);
  });
});
