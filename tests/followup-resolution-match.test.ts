import { describe, it, expect } from 'vitest';
import {
  isDistinctiveToken,
  citedFiles,
  citedTokens,
  suggestedActionText,
  mostSpecificToken,
  detectAlreadyResolved,
  closingMergedPr,
} from '../scripts/ci/followup-resolution-match.mjs';

// Locks the conservative matcher shared by the issue-fix.yml pre-flight gate
// (check-issue-already-resolved.mjs) and the scheduled reconciler
// (reconcile-followups.mjs). A false positive here = the gate drops a REAL bug,
// so the bias is "miss a resolved issue rather than flag a live one".

describe('isDistinctiveToken', () => {
  it('accepts tokens carrying code punctuation', () => {
    expect(isDistinctiveToken('markStale()')).toBe(true);
    expect(isDistinctiveToken('obj.method()')).toBe(true); // dot-member + parens
    expect(isDistinctiveToken("type === 'x'")).toBe(true);
    expect(isDistinctiveToken('count >= 2')).toBe(true);
    expect(isDistinctiveToken('a => b')).toBe(true);
  });

  it('treats a bare `name.ext`-shaped token as a file path, not a code token', () => {
    // `foo.bar` is indistinguishable from a filename → rejected (citedFiles handles paths).
    expect(isDistinctiveToken('foo.bar')).toBe(false);
  });

  it('rejects bare prose words and plain identifiers (precision over recall)', () => {
    expect(isDistinctiveToken('refactor')).toBe(false); // single prose word, no punctuation
    expect(isDistinctiveToken('handle the edge case')).toBe(false); // prose phrase
    expect(isDistinctiveToken('abc')).toBe(false); // too short
    expect(isDistinctiveToken('x'.repeat(81))).toBe(false); // too long
  });

  it('rejects bare file paths (handled by citedFiles, not token match)', () => {
    expect(isDistinctiveToken('scripts/foo.mjs')).toBe(false);
    expect(isDistinctiveToken('build-plugins/bar.ts')).toBe(false);
  });

  it('rejects bare funnel field/helper names — they occur in cited files independent of any fix (#1647)', () => {
    // REVIEW.md L92 fields: present in slug/redirect/orphan-merge files INDEPENDENTLY of any
    // prescribed fix. A bare occurrence must NOT qualify as distinctive, or a coincidental
    // hit short-circuits the gate and drops a still-pending redirect/canonical fix.
    expect(isDistinctiveToken('previousSlugs')).toBe(false);
    expect(isDistinctiveToken('mergedCount')).toBe(false);
    expect(isDistinctiveToken('getList')).toBe(false);
    expect(isDistinctiveToken('markStale')).toBe(false);
    expect(isDistinctiveToken('expect')).toBe(false); // bare vitest matcher name
    // …but the punctuated forms still qualify:
    expect(isDistinctiveToken('previousSlugs.push(')).toBe(true);
    expect(isDistinctiveToken('getList()')).toBe(true);
  });

  it('STILL accepts those field names when carrying code punctuation (real prescribed signal)', () => {
    // With code punctuation (call / member / comparison) the token is the actual prescribed
    // code shape → legitimate evidence, not a coincidental bare field name.
    expect(isDistinctiveToken('markStale()')).toBe(true); // call
    expect(isDistinctiveToken('mergedCount >= 1')).toBe(true); // comparison
    expect(isDistinctiveToken('job.previousSlugs')).toBe(true); // dot-member
    expect(isDistinctiveToken('getList()')).toBe(true); // call
  });

  it('does NOT short-circuit on a bare funnel field present for unrelated reasons (#1647 false-positive)', () => {
    // Issue prescribes a real (absent) fix AND happens to mention the bare field name.
    // The bare field must not produce evidence; with the prescribed token absent → proceed.
    const body = [
      '- Original text:',
      '  > redirect bridge for renamed jobs not persisted',
      '- Suggested action: call `writeRedirectBridge()` so `previousSlugs` is persisted',
    ].join('\n');
    const io = {
      fileExists: (p: string) => p === 'scripts/lib/slug-history-journal.mjs',
      // file references previousSlugs (it is a slug builder) but lacks the prescribed call
      readFile: () => 'export function build(job) { return job.previousSlugs ?? []; }',
    };
    expect(detectAlreadyResolved(body, io).resolved).toBe(false);
  });
});

describe('mostSpecificToken', () => {
  it('picks the token carrying the richest code structure', () => {
    expect(mostSpecificToken(['markStale()', 'previousSlugs:'])).toBe('markStale()');
    expect(mostSpecificToken([])).toBe(null);
  });
});

describe('citedFiles', () => {
  const fileExists = (p: string) => p === 'scripts/ci/foo.mjs' || p === 'components/Bar.tsx';

  it('extracts backticked paths that resolve, stripping :Lnnn suffix', () => {
    const body = 'fix in `scripts/ci/foo.mjs:L42` and `components/Bar.tsx`';
    expect(citedFiles(body, fileExists).sort()).toEqual(['components/Bar.tsx', 'scripts/ci/foo.mjs']);
  });

  it('ignores paths without a slash and non-existent files', () => {
    expect(citedFiles('see `package.json` and `scripts/ci/missing.mjs`', fileExists)).toEqual([]);
  });
});

describe('suggestedActionText scoping', () => {
  it('returns only the Suggested action region when present (not Original text)', () => {
    const body = [
      '- Original text:',
      '  > old `legacyFlag` value here',
      '- Suggested action: replace with `newFlag()` call',
    ].join('\n');
    const region = suggestedActionText(body);
    expect(region).toContain('newFlag()');
    expect(region).not.toContain('legacyFlag');
  });

  it('falls back to whole body for free-form issues', () => {
    const body = 'no structured sections, just `someToken()` inline';
    expect(suggestedActionText(body)).toContain('someToken()');
  });
});

describe('citedTokens', () => {
  it('pulls distinctive tokens only from the Suggested action region', () => {
    const body = [
      '- Original text:',
      '  > current `staleConst` is wrong',
      '- Suggested action: add `markStale()` to the parser',
    ].join('\n');
    const toks = citedTokens(body);
    expect(toks).toContain('markStale()');
    // The Original-text token must NOT leak in — it is in the file because work is NOT done.
    expect(toks).not.toContain('staleConst');
  });
});

describe('detectAlreadyResolved (end-to-end matcher)', () => {
  const body = [
    '### 1. Add stale-marking to parser',
    '- Original text:',
    '  > the parser never marks `oldBehavior`',
    '- Suggested action: call `markStale()` inside `scripts/ci/parser.mjs`',
  ].join('\n');

  it('flags resolved when the prescribed token is present in the cited file', () => {
    const io = {
      fileExists: (p: string) => p === 'scripts/ci/parser.mjs',
      readFile: (p: string) => (p === 'scripts/ci/parser.mjs' ? 'export function run() { markStale(); }' : null),
    };
    const res = detectAlreadyResolved(body, io);
    expect(res.resolved).toBe(true);
    expect(res.evidence).toEqual([{ file: 'scripts/ci/parser.mjs', tok: 'markStale()' }]);
  });

  it('does NOT flag when the prescribed token is absent (work still pending)', () => {
    const io = {
      fileExists: (p: string) => p === 'scripts/ci/parser.mjs',
      readFile: () => 'export function run() { /* nothing yet */ }',
    };
    expect(detectAlreadyResolved(body, io).resolved).toBe(false);
  });

  it('does NOT flag on Original-text token only (status-quo present ≠ done)', () => {
    // File still contains the status-quo `oldBehavior` the issue wants changed.
    const io = {
      fileExists: (p: string) => p === 'scripts/ci/parser.mjs',
      readFile: () => 'export function run() { oldBehavior(); }',
    };
    expect(detectAlreadyResolved(body, io).resolved).toBe(false);
  });

  it('does NOT flag when there is no cited file', () => {
    const noFile = '- Suggested action: call `markStale()` somewhere';
    const io = { fileExists: () => false, readFile: () => null };
    expect(detectAlreadyResolved(noFile, io).resolved).toBe(false);
  });

  it('does NOT flag when there is no distinctive token', () => {
    const noTok = '- Suggested action: improve `scripts/ci/parser.mjs` readability';
    const io = { fileExists: (p: string) => p === 'scripts/ci/parser.mjs', readFile: () => 'anything' };
    expect(detectAlreadyResolved(noTok, io).resolved).toBe(false);
  });

  it('tolerates unreadable files (readFile null) without throwing', () => {
    const io = { fileExists: () => true, readFile: () => null };
    expect(detectAlreadyResolved(body, io).resolved).toBe(false);
  });

  // ── False-positive safety: the reviewer 🔴 — a coincidental bare field-name match
  //    must NOT short-circuit and drop a still-pending fix. ──────────────────────────
  it('does NOT flag when only a BARE field name is cited and the prescribed code token is absent', () => {
    // Body cites a slug/redirect builder; the ONLY backticked span in Suggested action is a
    // bare `previousSlugs` (no punctuation). It is no longer distinctive → no token → proceed,
    // even though the file legitimately contains the field independently of the fix.
    const bareBody = [
      '### Restore redirects',
      '- Suggested action: ensure `previousSlugs` are preserved in `scripts/ci/slug-builder.mjs`',
    ].join('\n');
    const io = {
      fileExists: (p: string) => p === 'scripts/ci/slug-builder.mjs',
      // File contains the field name as part of unrelated existing code — must NOT count.
      readFile: () => 'const out = { previousSlugs: job.previousSlugs ?? [] };',
    };
    const res = detectAlreadyResolved(bareBody, io);
    expect(res.tokens).toEqual([]); // bare identifier rejected → no distinctive token
    expect(res.resolved).toBe(false); // → proceed (run the fixer), do not drop the fix
  });

  it('does NOT short-circuit when only SOME (not all) prescribed tokens are present', () => {
    // Two prescribed tokens; only one happens to be in the file. The bar is ALL tokens
    // present — a partial match proves the fix is incomplete → proceed.
    const twoTokBody = [
      '- Suggested action: add `mergedCount >= 1` guard and call `markStale()` in',
      '  `scripts/ci/parser.mjs`',
    ].join('\n');
    const io = {
      fileExists: (p: string) => p === 'scripts/ci/parser.mjs',
      // Contains `mergedCount >= 1` but NOT `markStale()`.
      readFile: () => 'if (mergedCount >= 1) { /* TODO: still need markStale call */ }',
    };
    const res = detectAlreadyResolved(twoTokBody, io);
    expect(res.evidence.length).toBeGreaterThan(0); // one token did match…
    expect(res.resolved).toBe(false); // …but not ALL → proceed (do not drop the fix)
  });

  it('flags resolved only when ALL prescribed tokens are present', () => {
    const twoTokBody = [
      '- Suggested action: add `mergedCount >= 1` guard and call `markStale()` in',
      '  `scripts/ci/parser.mjs`',
    ].join('\n');
    const io = {
      fileExists: (p: string) => p === 'scripts/ci/parser.mjs',
      readFile: () => 'if (mergedCount >= 1) { markStale(); }',
    };
    expect(detectAlreadyResolved(twoTokBody, io).resolved).toBe(true);
  });

  // ── Total / defensive: a malformed body or faulty resolver must never throw. ──────
  it('does NOT throw on a malformed / non-string body → proceed', () => {
    const io = { fileExists: () => true, readFile: () => 'whatever' };
    expect(() => detectAlreadyResolved(null, io)).not.toThrow();
    expect(detectAlreadyResolved(undefined, io).resolved).toBe(false);
    // @ts-expect-error
    expect(detectAlreadyResolved({ not: 'a string' }, io).resolved).toBe(false);
  });

  it('does NOT throw when the resolver itself throws → proceed', () => {
    const io = {
      fileExists: () => true,
      readFile: () => {
        throw new Error('git show exploded');
      },
    };
    expect(() => detectAlreadyResolved(body, io)).not.toThrow();
    expect(detectAlreadyResolved(body, io).resolved).toBe(false);
  });

  it('does NOT throw when io is missing/partial → proceed', () => {
    // @ts-expect-error — missing readFile
    expect(detectAlreadyResolved(body, {}).resolved).toBe(false);
    expect(() => detectAlreadyResolved(body, undefined)).not.toThrow();
  });
});

describe('closingMergedPr (explicit done-but-open via merged PR cross-ref)', () => {
  it('flags the multi-issue `Closes #a #b #c` gotcha — GitHub closed only #a, #b/#c stay open', () => {
    const prs = [{ number: 1320, title: 'fix: x', body: 'Closes #100 #2035 #2036' }];
    expect(closingMergedPr(2035, prs)).toBe(1320);
    expect(closingMergedPr(2036, prs)).toBe(1320);
  });

  it('flags `Supersedes #N` (GitHub never auto-closes supersede)', () => {
    expect(closingMergedPr(2031, [{ number: 2042, body: 'Supersedes #2031 — memory-safe retry' }])).toBe(2042);
  });

  it('accepts the closing-keyword variants on the same line as the ref', () => {
    expect(closingMergedPr(7, [{ number: 9, body: 'Fixes #7' }])).toBe(9);
    expect(closingMergedPr(7, [{ number: 9, body: 'Resolved #7 in passing' }])).toBe(9);
    expect(closingMergedPr(7, [{ number: 9, title: 'closed #7', body: '' }])).toBe(9);
  });

  it('flags a comma/`and`-separated closing list (`Closes #a, #b and #c`)', () => {
    expect(closingMergedPr(7, [{ number: 9, body: 'Closes #5, #6 and #7' }])).toBe(9);
  });

  it('does NOT flag a bare mention without a closing keyword (Related: #N)', () => {
    expect(closingMergedPr(7, [{ number: 9, body: 'Related: #7\nSee also #7 for context' }])).toBeNull();
  });

  it('does NOT flag when the keyword and ref are on DIFFERENT lines', () => {
    expect(closingMergedPr(7, [{ number: 9, body: 'Closes #8\nUnrelated note about #7' }])).toBeNull();
  });

  it('does NOT flag when a word breaks the ref-run (`Fixes #8 and touches #N`) — adv #2', () => {
    expect(closingMergedPr(2123, [{ number: 9, body: 'Fixes #8 and touches #2123 in passing' }])).toBeNull();
  });

  it('guards against numeric prefix collisions — #2035 must not match #20350', () => {
    expect(closingMergedPr(2035, [{ number: 9, body: 'Closes #20350' }])).toBeNull();
    expect(closingMergedPr(35, [{ number: 9, body: 'Closes #2035' }])).toBeNull();
  });

  it('returns null on empty/invalid input (proceed-safe)', () => {
    expect(closingMergedPr(7, [])).toBeNull();
    // @ts-expect-error — non-array
    expect(closingMergedPr(7, null)).toBeNull();
    expect(closingMergedPr(0, [{ number: 9, body: 'Closes #0' }])).toBeNull();
    expect(closingMergedPr(NaN, [{ number: 9, body: 'Closes #5' }])).toBeNull();
  });
});
