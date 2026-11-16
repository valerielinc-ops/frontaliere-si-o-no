import { describe, expect, it } from 'vitest';
import {
  countRenderedTables,
  hasRawTableSeparator,
  visibleTextFromHtml,
} from './helpers/dailyBriefTableParity';
import {
  classifyDailyBriefPublication,
  dailyBriefEditionId,
  shouldSkipUnpublishedDailyBrief,
} from './helpers/dailyBriefLive';

describe('daily brief table parity signal', () => {
  it('accepts a tableless source fallback without inventing a rendering failure', () => {
    const html = '<main><h2>Fuel data unavailable</h2><p>The section returns after refresh.</p></main>';

    expect(countRenderedTables(html)).toBe(0);
    expect(hasRawTableSeparator(visibleTextFromHtml(html))).toBe(false);
  });

  it('counts rendered tables and rejects a visible raw Markdown separator', () => {
    const rendered = '<main><table><tbody><tr><td>Fuel</td></tr></tbody></table></main>';
    const broken = '<main><p>| Fuel | Price |</p><p>| --- | --- |</p></main>';

    expect(countRenderedTables(rendered)).toBe(1);
    expect(hasRawTableSeparator(visibleTextFromHtml(rendered))).toBe(false);
    expect(countRenderedTables(broken)).toBe(0);
    expect(hasRawTableSeparator(visibleTextFromHtml(broken))).toBe(true);
  });

  it('ignores Markdown-looking text in scripts and styles', () => {
    const html = '<script>const fixture = "| --- |";</script><style>/* | --- | */</style><main>OK</main>';

    expect(hasRawTableSeparator(visibleTextFromHtml(html))).toBe(false);
  });
});

describe('daily brief live publication readiness', () => {
  const editionId = dailyBriefEditionId('2026-11-16');

  it('recognizes an exact publisher registry entry', () => {
    expect(classifyDailyBriefPublication({ blog: { [editionId]: { it: editionId } } }, editionId)).toBe('published');
    expect(shouldSkipUnpublishedDailyBrief(503, 'published')).toBe(false);
  });

  it('skips a non-200 only when the publisher confirms the edition is absent', () => {
    expect(classifyDailyBriefPublication({ blog: { 'bollettino-frontaliere-2026-11-15': { it: 'ieri' } } }, editionId))
      .toBe('not-published');
    expect(shouldSkipUnpublishedDailyBrief(503, 'not-published')).toBe(true);
    expect(shouldSkipUnpublishedDailyBrief(404, 'not-published')).toBe(true);
  });

  it('fails closed for an unreadable or malformed publisher registry', () => {
    expect(classifyDailyBriefPublication(null, editionId)).toBe('unknown');
    expect(classifyDailyBriefPublication({ blog: { [editionId]: null } }, editionId)).toBe('unknown');
    expect(shouldSkipUnpublishedDailyBrief(503, 'unknown')).toBe(false);
    expect(shouldSkipUnpublishedDailyBrief(undefined, 'not-published')).toBe(false);
  });
});
