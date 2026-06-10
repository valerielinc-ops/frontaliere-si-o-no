import { describe, it, expect } from 'vitest';
import {
  isDistinctiveToken,
  citedFiles,
  citedTokens,
  suggestedActionText,
  detectAlreadyResolved,
  // @ts-expect-error — plain .mjs module, no types
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
    // A bare field name lives in a slug/redirect builder regardless of whether the
    // prescribed fix landed; promoting it to "distinctive" would silently short-circuit a
    // still-pending funnel-critical fix. Only its real punctuated form is distinctive.
    expect(isDistinctiveToken('previousSlugs')).toBe(false);
    expect(isDistinctiveToken('mergedCount')).toBe(false);
    expect(isDistinctiveToken('getList')).toBe(false);
    expect(isDistinctiveToken('markStale')).toBe(false);
    expect(isDistinctiveToken('expect')).toBe(false); // bare vitest matcher name
    // …but the punctuated forms still qualify:
    expect(isDistinctiveToken('previousSlugs.push(')).toBe(true);
    expect(isDistinctiveToken('getList()')).toBe(true);
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
});
