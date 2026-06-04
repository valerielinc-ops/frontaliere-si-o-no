/**
 * pr-body-closes-check — regression test for the deterministic detector of the
 * "multi-issue Closes on one line" PR-body bug (scripts/lib/pr-body-closes-check.mjs).
 *
 * GitHub closes ONLY the first issue after a closing keyword on a line:
 * `Closes #a #b #c` closes only #a → #b/#c stay open and need manual cleanup
 * (real recurrence: PR #1320, 9 issues on one line, 8 left open). This guards
 * pr-body-contract.yml so the check keeps flagging the bug and never the valid
 * one-keyword-per-ref forms.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — modulo .mjs senza tipi
import { checkClosesLines } from '../scripts/lib/pr-body-closes-check.mjs';

describe('checkClosesLines', () => {
  describe('flags the bug (multiple issues, single keyword on one line)', () => {
    const bad: Array<{ name: string; body: string; refs: string[] }> = [
      { name: 'Closes space-separated', body: 'Closes #1320 #1321 #1322', refs: ['1320', '1321', '1322'] },
      { name: 'Closes comma-separated, no repeated keyword', body: 'Closes #12, #34, #56', refs: ['12', '34', '56'] },
      { name: 'Fixes two', body: 'Fixes #7 #8', refs: ['7', '8'] },
      { name: 'Resolves with and', body: 'Resolves #100 and #101', refs: ['100', '101'] },
      { name: 'lowercase closes', body: 'closes #5 #6', refs: ['5', '6'] },
      { name: 'in body among other text', body: '## Implementato\n- foo\n\nCloses #200 #201 #202\n', refs: ['200', '201', '202'] },
    ];
    for (const c of bad) {
      it(c.name, () => {
        const res = checkClosesLines(c.body);
        expect(res.ok).toBe(false);
        expect(res.violations.length).toBeGreaterThan(0);
        expect(res.violations[0].refs).toEqual(c.refs);
      });
    }
  });

  describe('accepts the correct forms', () => {
    const good: string[] = [
      'Closes #1320',
      'Closes #12\nCloses #34\nCloses #56',
      'Closes #12, closes #34, closes #56', // keyword repeated before each
      'Fixes #7\nResolves #8',
      'Closes #12. See also #99 for context.', // #99 is a bare cross-ref, not after a keyword reach... wait
      '## Implementato\n- Closes the gap in foo\n\nCloses #200\nSupersedes #201\n',
      'No issues referenced here at all.',
      'See #42 and #43 for background', // no closing keyword → not our concern
      'Supersedes #10 #11', // Supersedes is NOT a GitHub closing keyword
    ];
    for (const body of good) {
      it(JSON.stringify(body.slice(0, 40)), () => {
        expect(checkClosesLines(body).ok).toBe(true);
      });
    }
  });

  it('flags only the offending line, leaves valid lines alone', () => {
    const body = 'Closes #1\nCloses #2 #3\nCloses #4';
    const res = checkClosesLines(body);
    expect(res.ok).toBe(false);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0].line).toBe(2);
    expect(res.violations[0].refs).toEqual(['2', '3']);
  });

  it('handles owner/repo#N cross-repo refs', () => {
    const res = checkClosesLines('Closes owner/repo#5 #6');
    expect(res.ok).toBe(false);
    expect(res.violations[0].refs).toEqual(['5', '6']);
  });
});
