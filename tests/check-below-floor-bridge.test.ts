/**
 * check-below-floor-bridge.test.ts — unit tests for the below-floor-bridge
 * advisory surfacer (issue #3659). Mirrors the sibling-check-gate.test.ts
 * style: import the pure exported functions directly, test against realistic
 * fixture strings rather than shelling out to git.
 */
import { describe, it, expect } from 'vitest';
import {
  FLOOR_TOKEN_RX,
  BRIDGE_CALL_RX,
  extractIfBlocks,
  findInlineFloorContinueGaps,
  findBooleanGuardContinueGaps,
  findBelowFloorBridgeGaps,
  extractAddedBridgeCallNames,
  selfMapAdvisory,
} from '../scripts/ci/check-below-floor-bridge.mjs';

describe('FLOOR_TOKEN_RX / BRIDGE_CALL_RX — token shape', () => {
  it('matches MIN_JOBS_FOR_CANTON_PAGE', () => {
    expect(FLOOR_TOKEN_RX.test('cantonTotal < MIN_JOBS_FOR_CANTON_PAGE')).toBe(true);
  });

  it('matches bare MIN_JOBS', () => {
    expect(FLOOR_TOKEN_RX.test('snapshot.liveCount < MIN_JOBS')).toBe(true);
  });

  it('matches a *_FLOOR / *_THRESHOLD constant', () => {
    expect(FLOOR_TOKEN_RX.test('count < SECTOR_HUB_FLOOR')).toBe(true);
    expect(FLOOR_TOKEN_RX.test('count >= COMPANY_CITY_THRESHOLD')).toBe(true);
  });

  it('does NOT match a content-quality word-count floor (out of scope by design)', () => {
    expect(FLOOR_TOKEN_RX.test('r.words < MIN_INDEXABLE_WORDS')).toBe(false);
  });

  it('BRIDGE_CALL_RX matches known bridge-emit call shapes', () => {
    expect(BRIDGE_CALL_RX.test('renderBelowFloorBridge(locale, canton)')).toBe(true);
    expect(BRIDGE_CALL_RX.test('emitEditorialBelowFloorBridge(locale, canton, slug)')).toBe(true);
    expect(BRIDGE_CALL_RX.test('emitSectorHubBelowFloorBridge(locale, canton, slug)')).toBe(true);
    expect(BRIDGE_CALL_RX.test('emitCantonHubBelowFloorBridge(locale, canton)')).toBe(true);
    expect(BRIDGE_CALL_RX.test('emitOrphanCompanyCityBridge(locale, canton)')).toBe(true);
  });

  it('BRIDGE_CALL_RX does not match an unrelated emit/render call', () => {
    expect(BRIDGE_CALL_RX.test('renderJobCard(job)')).toBe(false);
    expect(BRIDGE_CALL_RX.test('emitSitemapEntry(url)')).toBe(false);
  });
});

describe('extractIfBlocks — brace-matching + wrapped-condition tolerance', () => {
  it('extracts a single-line-condition block body', () => {
    const src = [
      'for (const c of X) {',
      '  if (count < MIN_JOBS) {',
      '    continue;',
      '  }',
      '  doWork();',
      '}',
    ].join('\n');
    const blocks = extractIfBlocks(src, /MIN_JOBS/);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(2);
    expect(blocks[0].blockText).toContain('continue;');
    expect(blocks[0].blockText).not.toContain('doWork');
  });

  it('extracts a single-statement if (no braces)', () => {
    const src = ['for (const c of X) {', '  if (count < MIN_JOBS) continue;', '  doWork();', '}'].join('\n');
    const blocks = extractIfBlocks(src, /MIN_JOBS/);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockText).toContain('continue;');
  });

  it('tolerates a condition wrapped onto the line above the token match', () => {
    // Condition itself doesn't literally contain the rx on the `if (` line,
    // but the floor token appears on the very next line inside the parens —
    // exercised via a conditionRx that matches the token line, with `if (`
    // found by the "up to 3 lines before" lookback.
    const src = [
      'if (',
      '  cantonTotal < MIN_JOBS_FOR_CANTON_PAGE',
      ') {',
      '  continue;',
      '}',
    ].join('\n');
    const blocks = extractIfBlocks(src, /MIN_JOBS_FOR_CANTON_PAGE/);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockText).toContain('continue;');
  });
});

describe('findInlineFloorContinueGaps — Mode 1 (direct antipattern)', () => {
  it('flags a bare floor-guard continue with no bridge call (the pre-#3594-fix shape)', () => {
    const src = [
      'for (const editorialCanton of EDITORIAL_CANTONS) {',
      '  if ((editorialCantonJobCounts.get(editorialCanton) ?? 0) < MIN_JOBS_FOR_CANTON_PAGE) {',
      '    continue;',
      '  }',
      '  emitEditorialLandingPage(editorialCanton);',
      '}',
    ].join('\n');
    const gaps = findInlineFloorContinueGaps(src);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].line).toBe(2);
  });

  it('does NOT flag the real post-fix shape (bridge call present before continue)', () => {
    // Real shape from jobsSeoPagesPlugin.ts (post-#3594 fix).
    const src = [
      'for (const editorialCanton of EDITORIAL_CANTONS) {',
      '  if ((editorialCantonJobCounts.get(editorialCanton) ?? 0) < MIN_JOBS_FOR_CANTON_PAGE) {',
      '    for (const locale of localeList) {',
      '      if (!shouldEmitLocale(locale)) continue;',
      '      emitEditorialBelowFloorBridge(locale, editorialCanton, getJobTodayLandingSlug(locale, editorialCanton));',
      '    }',
      '    continue;',
      '  }',
      '  emitEditorialLandingPage(editorialCanton);',
      '}',
    ].join('\n');
    const gaps = findInlineFloorContinueGaps(src);
    expect(gaps).toHaveLength(0);
  });

  it('does NOT flag an unrelated TI-only skip (no floor token)', () => {
    const src = ['for (const canton of ALL_CANTONS) {', "  if (canton === 'TI') continue;", '  doWork(canton);', '}'].join(
      '\n',
    );
    expect(findInlineFloorContinueGaps(src)).toHaveLength(0);
  });

  it('does NOT flag a content-quality word-count guard (out-of-scope-by-design class)', () => {
    const src = [
      'if (rendered.some((r) => r.words < MIN_INDEXABLE_WORDS)) {',
      '  result.pagesSkippedForWordCount++;',
      '  continue;',
      '}',
    ].join('\n');
    expect(findInlineFloorContinueGaps(src)).toHaveLength(0);
  });

  it('flags the real newly-discovered shape (per-sector-in-canton floor, no bridge)', () => {
    // Simplified from jobsSeoPagesPlugin.ts's sector-hub-per-canton loop —
    // a DISTINCT, finer-grained floor from MIN_JOBS_FOR_CANTON_PAGE that this
    // gate also catches (see PR body for why it's tracked as a separate
    // follow-up rather than fixed inline here).
    const src = [
      'for (const sector of SECTOR_HUB_KEYS) {',
      '  const sJobs = bySector.get(sector) ?? [];',
      '  if (sJobs.length < MIN_JOBS_PER_CANTON_SECTOR) continue;',
      '  markCantonSectorPage(canton, sector);',
      '  emitSectorHubPage(canton, sector, sJobs);',
      '}',
    ].join('\n');
    const gaps = findInlineFloorContinueGaps(src);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].guard).toContain('MIN_JOBS_PER_CANTON_SECTOR');
  });
});

describe('findBooleanGuardContinueGaps — Mode 2 (boolean-variable-mediated guard)', () => {
  it('flags `meetsThreshold`-style boolean guard continue with no bridge call', () => {
    const src = [
      'const meetsThreshold = cantonTotal >= MIN_JOBS_FOR_CANTON_PAGE;',
      'if (!meetsThreshold) {',
      '  continue;',
      '}',
      'emitCantonPage(canton);',
    ].join('\n');
    const gaps = findBooleanGuardContinueGaps(src);
    expect(gaps).toHaveLength(1);
  });

  it('does NOT flag when the boolean guard is used only for a robots-attribute toggle (no continue)', () => {
    // Real shape: below-threshold cantons still get the page, just
    // noindex,follow — no `continue` anywhere, so nothing to flag.
    const src = [
      'const meetsCantonThreshold = cantonTotal >= MIN_JOBS_FOR_CANTON_PAGE;',
      "robots: (!meetsCantonThreshold || isCityEmpty) ? 'noindex,follow' : 'index,follow',",
    ].join('\n');
    expect(findBooleanGuardContinueGaps(src)).toHaveLength(0);
  });

  it('does NOT flag when the guarded block already calls a bridge function', () => {
    const src = [
      'const meetsThreshold = cantonCount >= MIN_JOBS_FOR_CANTON_PAGE;',
      'if (!meetsThreshold) {',
      '  emitCantonHubBelowFloorBridge(locale, canton);',
      '  continue;',
      '}',
    ].join('\n');
    expect(findBooleanGuardContinueGaps(src)).toHaveLength(0);
  });

  it('ignores unrelated boolean locals not derived from a floor token', () => {
    const src = ['const isTicino = canton === \'TI\';', 'if (!isTicino) {', '  continue;', '}'].join('\n');
    expect(findBooleanGuardContinueGaps(src)).toHaveLength(0);
  });
});

describe('findBelowFloorBridgeGaps — union + dedup', () => {
  it('merges Mode 1 and Mode 2 findings, sorted by line, deduped', () => {
    const src = [
      'if (cantonTotal < MIN_JOBS_FOR_CANTON_PAGE) {',
      '  continue;',
      '}',
      'const meetsThreshold = otherTotal >= MIN_JOBS_FOR_CANTON_PAGE;',
      'if (!meetsThreshold) {',
      '  continue;',
      '}',
    ].join('\n');
    const gaps = findBelowFloorBridgeGaps(src);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps.map((g) => g.line)).toEqual([...gaps.map((g) => g.line)].sort((a, b) => a - b));
  });

  it('returns empty array for a clean file (no floor tokens at all)', () => {
    const src = ['for (const x of list) {', '  doWork(x);', '}'].join('\n');
    expect(findBelowFloorBridgeGaps(src)).toEqual([]);
  });
});

describe('extractAddedBridgeCallNames — diff-added bridge calls only', () => {
  it('extracts a bridge call name from an added (+) line', () => {
    const diff = [
      '--- a/build-plugins/foo.ts',
      '+++ b/build-plugins/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' unchanged();',
      '+emitEditorialBelowFloorBridge(locale, canton, slug);',
      '-removedCall();',
    ].join('\n');
    expect(extractAddedBridgeCallNames(diff)).toEqual(['emitEditorialBelowFloorBridge']);
  });

  it('ignores the +++ file header line', () => {
    const diff = ['+++ b/build-plugins/emitEditorialBelowFloorBridge.ts'].join('\n');
    expect(extractAddedBridgeCallNames(diff)).toEqual([]);
  });

  it('ignores removed (-) lines', () => {
    const diff = ['-emitCantonHubBelowFloorBridge(locale, canton);'].join('\n');
    expect(extractAddedBridgeCallNames(diff)).toEqual([]);
  });

  it('dedupes and sorts multiple distinct call names', () => {
    const diff = [
      '+emitSectorHubBelowFloorBridge(a);',
      '+emitEditorialBelowFloorBridge(b);',
      '+emitSectorHubBelowFloorBridge(c);',
    ].join('\n');
    expect(extractAddedBridgeCallNames(diff)).toEqual([
      'emitEditorialBelowFloorBridge',
      'emitSectorHubBelowFloorBridge',
    ]);
  });

  it('returns empty array for empty/undefined input', () => {
    expect(extractAddedBridgeCallNames('')).toEqual([]);
    expect(extractAddedBridgeCallNames(undefined as unknown as string)).toEqual([]);
  });
});

describe('selfMapAdvisory — self-map drift check', () => {
  it('returns null when no new bridge calls were added', () => {
    expect(selfMapAdvisory([], ['build-plugins/foo.ts'])).toBeNull();
  });

  it('returns null when searchConsoleCompat.ts is among the changed files', () => {
    expect(
      selfMapAdvisory(['emitEditorialBelowFloorBridge'], [
        'build-plugins/foo.ts',
        'build-plugins/searchConsoleCompat.ts',
      ]),
    ).toBeNull();
  });

  it('flags when a new bridge call is added but searchConsoleCompat.ts is untouched', () => {
    const advisory = selfMapAdvisory(['emitEditorialBelowFloorBridge'], ['build-plugins/foo.ts']);
    expect(advisory).not.toBeNull();
    expect(advisory!.addedBridgeNames).toEqual(['emitEditorialBelowFloorBridge']);
    expect(advisory!.message).toContain('searchConsoleCompat.ts');
  });
});
