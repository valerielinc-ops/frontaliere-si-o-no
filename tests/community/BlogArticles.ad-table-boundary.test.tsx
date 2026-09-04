/**
 * Regression gate for issue #7337 — an inline ad must never land between a `## `
 * heading and the table that opens its section.
 *
 * `docs/ads-placement-longform.md` §2 ("mai a cavallo di tabella/mappa") and
 * `docs/editorial-longform-audit.md` §6 both call that straddle out; before this
 * gate `tryEmitAd` decided on the word gap alone, without looking at the block
 * the heading was about to introduce. Measured on the `it` corpus: 28 real
 * `## heading` → table adjacencies in 25 articles.
 *
 * The second assertion is the one that protects revenue (AGENTS.md #7): the fix
 * DEFERS the ad to the first boundary after the table, so the per-article ad
 * count must be identical to the same body without the table.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderFormattedContent, isTableBlock } from '@/components/community/BlogArticles';

const AD_MARKER = 'data-testid="inline-ad"';
const adRenderer = (keyPrefix: string) => <div key={keyPrefix} data-testid="inline-ad" />;

/** Long enough to clear AD_MIN_WORD_GAP (200) on its own. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `parola${i}`).join(' ');

const TABLE = '| Voce | Valore |\n|---|---|\n| Imposta | 100 |\n| Contributo | 200 |';

const bodyWithTable = `${words(250)}\n\n## Sezione con dati\n\n${TABLE}\n\n${words(250)}`;
const bodyWithoutTable = `${words(250)}\n\n## Sezione con dati\n\n${words(40)}\n\n${words(250)}`;

/**
 * `TABLE` is ~15 tokens — two orders of magnitude under AD_MIN_WORD_GAP, so it
 * cannot expose what happens when the deferral spans MORE than a full gap.
 * `countWordsIn` splits on whitespace, so pipes and separators count as tokens.
 */
const BIG_TABLE = [
  '| Voce | Valore | Nota |',
  '|---|---|---|',
  ...Array.from({ length: 40 }, (_, i) => `| Voce${i} | Valore${i} | Nota${i} |`),
].join('\n');
/** Same tokenizer as `countWordsIn`, so the prose control is gap-equivalent. */
const BIG_TABLE_WORDS = BIG_TABLE.trim().split(/\s+/).filter(Boolean).length;

const render = (body: string) =>
  renderToStaticMarkup(renderFormattedContent(body, undefined, adRenderer));

const countAds = (html: string) => html.split(AD_MARKER).length - 1;

describe('isTableBlock', () => {
  it('accepts a markdown table with header, separator and body rows', () => {
    expect(isTableBlock(TABLE)).toBe(true);
  });

  it('rejects prose that merely contains a pipe, and a header without body rows', () => {
    expect(isTableBlock('Il valore | la soglia sono diversi.')).toBe(false);
    expect(isTableBlock('| Voce | Valore |\n|---|---|')).toBe(false);
    expect(isTableBlock('| solo | una | riga |')).toBe(false);
  });
});

describe('inline ads around a table that opens a section (#7337)', () => {
  it('emits no ad between the H2 and the table it introduces', () => {
    const html = render(bodyWithTable);
    const h2 = html.indexOf('<h2');
    const table = html.indexOf('<table');
    expect(h2).toBeGreaterThanOrEqual(0);
    expect(table).toBeGreaterThan(h2);
    expect(html.slice(h2, table)).not.toContain(AD_MARKER);
  });

  it('defers that ad to after the table instead of dropping it', () => {
    const html = render(bodyWithTable);
    const afterTable = html.indexOf('</table>');
    expect(html.slice(afterTable)).toContain(AD_MARKER);
  });

  it('keeps the per-article ad count identical to the same body without a table', () => {
    expect(countAds(render(bodyWithTable))).toBe(countAds(render(bodyWithoutTable)));
    expect(countAds(render(bodyWithoutTable))).toBeGreaterThan(0);
  });

  /**
   * The deferral must not bank the table's own words against the deferred ad:
   * those words used to feed the NEXT slot. If the deferred ad consumes them,
   * a downstream ad that the un-deferred body emits is silently lost — the
   * count invariant of AGENTS.md #7 breaks for the ad AFTER the deferred one.
   */
  it('carries the words accumulated over the table to the next slot (table is last block)', () => {
    const withTable = `${words(250)}\n\n## Sezione con dati\n\n${BIG_TABLE}`;
    const control = `${words(250)}\n\n## Sezione con dati\n\n${words(BIG_TABLE_WORDS)}`;
    expect(countAds(render(control))).toBeGreaterThan(1);
    expect(countAds(render(withTable))).toBe(countAds(render(control)));
  });

  it('carries those words to the next slot when the table is followed by prose', () => {
    const withTable = `${words(250)}\n\n## Sezione con dati\n\n${BIG_TABLE}\n\n${words(10)}`;
    const control = `${words(250)}\n\n## Sezione con dati\n\n${words(BIG_TABLE_WORDS)}\n\n${words(10)}`;
    expect(countAds(render(control))).toBeGreaterThan(1);
    expect(countAds(render(withTable))).toBe(countAds(render(control)));
  });

  it('still emits the ad before an H2 whose section opens with prose', () => {
    const html = render(bodyWithoutTable);
    const h2 = html.indexOf('<h2');
    expect(html.slice(0, h2)).toContain(AD_MARKER);
  });
});
