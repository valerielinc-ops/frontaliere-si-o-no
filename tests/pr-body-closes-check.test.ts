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
import { checkClosesLines, maskQuoted } from '../scripts/lib/pr-body-closes-check.mjs';

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

  it('every violation carries a message (nanako renders v.message)', () => {
    for (const body of ['Closes #1 #2', 'Chiude #133']) {
      for (const v of checkClosesLines(body).violations) {
        expect(typeof v.message).toBe('string');
        expect(v.message.length).toBeGreaterThan(20);
        expect(v.type).toMatch(/^(multi-ref-close|ineffective-closing-keyword)$/);
      }
    }
  });
});

/**
 * Defect 2 — a closing keyword GitHub does not honor.
 *
 * `Chiude #133` reads as closure and does nothing: GitHub acts only on
 * close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved. PR #139 on
 * the corpus merged with that line and issue #133 stayed open with its fix
 * already on `main`. The old detector could not see it: it started FROM the
 * valid keywords, so a line without one was neither a violation nor a `Closes`.
 */
describe('checkClosesLines — ineffective closing keyword', () => {
  describe('flags closure intent GitHub will ignore', () => {
    const bad: Array<{ body: string; ref: string }> = [
      { body: 'Chiude #133', ref: '#133' }, // the measured recurrence (PR #139)
      { body: 'Chiude definitivamente #133', ref: '#133' },
      { body: 'Risolve #94', ref: '#94' },
      { body: 'Risolto #94', ref: '#94' },
      { body: 'Chiusa da #71', ref: '#71' },
      { body: 'Corregge #5417', ref: '#5417' },
      { body: 'Fixa #12', ref: '#12' },
      { body: 'Closing #12', ref: '#12' }, // gerund is NOT a GitHub keyword
      { body: 'Fixing #12', ref: '#12' },
      { body: 'Resolving #12', ref: '#12' },
      { body: 'Chiude owner/repo#8', ref: 'owner/repo#8' },
      { body: '## Implementato\n- roba\n\nChiude #133\n', ref: '#133' },
      // The negation guard reaches back two words and stops at punctuation, so
      // a real intent in a later clause is still caught: without this case the
      // guard could be widened until any `non` on the line silenced the check.
      { body: 'Questo non è un problema, chiude #12', ref: '#12' },
      // "non solo" CONCEDES the closure instead of denying it, so the negation
      // guard must not swallow it — otherwise widening the guard would turn a
      // false positive into a missed closure, the worse direction.
      { body: 'Non solo chiude #12, ma anche altro', ref: '#12' },
    ];
    for (const c of bad) {
      it(JSON.stringify(c.body.slice(0, 40)), () => {
        const res = checkClosesLines(c.body);
        expect(res.ok).toBe(false);
        const v = res.violations.find((x) => x.type === 'ineffective-closing-keyword');
        expect(v).toBeDefined();
        expect(v!.ref).toBe(c.ref);
        expect(v!.suggestion).toBe(`Closes ${c.ref}`);
        // The gate must hand over the line to write, not just the diagnosis.
        expect(v!.message).toContain(`Closes ${c.ref}`);
      });
    }
  });

  describe('never flags a body whose refs GitHub really closes', () => {
    const good: string[] = [
      'Closes #133',
      'Fixes #133\nResolves #134',
      // The criterion is body-level: a valid keyword anywhere covers the ref,
      // so restating it in prose is redundancy, not a missed closure.
      'Closes #133\n\nQuesta PR chiude #133 e basta.',
      'Chiude la questione senza citare numeri.',
      // Past-tense report about something ELSE having closed it.
      'La sibling è già chiusa da #66, qui non si tocca.',
      'That path was fixed by #66 upstream.',
      // NEGATED report: the sentence says the ref stays OPEN. Reporting it made
      // the gate answer "write `Closes #849`" on a line declaring #849 open —
      // and on PR #881 the author complied, so a PR that left three items of
      // #849 uncovered was one merge away from closing it.
      'Sono difetti reali, non coperti qui e non chiusi: #849 resta aperta.',
      '#849 non è ancora chiusa da questa PR.',
      'Landed without resolving #77 — the cap stays.',
      // Accented forms: `\w` is ASCII, so the first round of this guard broke
      // the chain at the `è` and left the commonest Italian negation reported.
      'Non è chiusa #849.',
      'Il bug non è chiuso: #849 resta aperta.',
      'Non più risolto da #12 dopo il revert.',
      // Connective verbs that deliberately do NOT close.
      'Addresses #12',
      'See #42 and #43 for background',
      'Supersedes #10',
      'Related to #99',
    ];
    for (const body of good) {
      it(JSON.stringify(body.slice(0, 44)), () => {
        expect(checkClosesLines(body).ok).toBe(true);
      });
    }
  });

  describe('what is QUOTED is not claimed', () => {
    // Without this the gate fires on the two bodies most likely to be right
    // about the rule: the PR that documents it, and any PR opened from the
    // template that warns about it (the template ships its guidance in HTML
    // comments, which stay in the body).
    const quoted: Array<[string, string]> = [
      ['inline code span', 'Non scrivere `Chiude #133`, usa la forma inglese.'],
      ['fenced block', '```\nChiude #133\n```'],
      ['tilde fence', '~~~\nChiude #133\n~~~'],
      ['HTML comment (the template case)', '<!-- «Chiude #133» è prosa: il link non viene creato -->'],
      ['multi-ref quoted in a code span', 'La forma `Closes #12 #34` chiude solo la prima.'],
      ['multi-ref inside an HTML comment', '<!-- Closes #12 #34 chiude solo #12 -->'],
    ];
    for (const [name, body] of quoted) {
      it(name, () => expect(checkClosesLines(body).ok).toBe(true));
    }

    it('still flags the same shape when it is NOT quoted', () => {
      expect(checkClosesLines('Chiude #133').ok).toBe(false);
      expect(checkClosesLines('Closes #12 #34').ok).toBe(false);
    });

    it('masking preserves line numbers, and the report shows the original line', () => {
      const body = '`ignora #1`\n\nChiude #133';
      const res = checkClosesLines(body);
      expect(res.violations).toHaveLength(1);
      expect(res.violations[0].line).toBe(3);
      expect(res.violations[0].text).toBe('Chiude #133');
    });

    it('maskQuoted blanks content but keeps every newline', () => {
      const out = maskQuoted('a\n```\nx\n```\nb');
      expect(out.split('\n')).toHaveLength(5);
      expect(out.split('\n')[2]).toBe(' ');
      expect(out.split('\n')[0]).toBe('a');
    });
  });

  it('reports the ineffective ref and the multi-ref bug independently', () => {
    const res = checkClosesLines('Closes #1 #2\nChiude #133');
    expect(res.violations.map((v) => v.type)).toEqual([
      'multi-ref-close',
      'ineffective-closing-keyword',
    ]);
    expect(res.violations[1].line).toBe(2);
  });
});
