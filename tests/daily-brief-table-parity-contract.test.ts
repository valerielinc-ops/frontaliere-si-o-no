import { describe, expect, it } from 'vitest';
import {
  countRenderedTables,
  hasRawTableSeparator,
  visibleTextFromHtml,
} from './helpers/dailyBriefTableParity';

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
