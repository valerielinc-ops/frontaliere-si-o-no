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

  /**
   * Issue #7414 item 1. `flushPendingAd` clears `pendingAdKey` BEFORE calling
   * `tryEmitAd`, so a deferred ad gets exactly one attempt; the review asked
   * whether that loses an ad when `adRenderer` hits the per-article cap and
   * returns null mid-article, and noted it had never exercised a capped
   * renderer on a body with more than one deferral.
   *
   * It cannot: `flushPendingAd()` is the FIRST statement of the block loop and
   * runs again before the end-of-segment `post-end` slot, so between the `## `
   * that defers and the flush that retries there is no other `tryEmitAd` call
   * — the deferred ad is the very next ad REQUESTED, in the same order the
   * un-deferred body would have requested it. A request-ordered cap therefore
   * answers both bodies identically. This exercises that with a cap that bites
   * mid-article, over two deferrals, which is what the review left untested.
   */
  it('loses no ad to a per-article cap that runs out mid-article (two deferrals)', () => {
    const cappedRenderer = (cap: number) => {
      let used = 0;
      return (keyPrefix: string) => {
        if (used >= cap) return null;
        used += 1;
        return <div key={keyPrefix} data-testid="inline-ad" />;
      };
    };
    const section = (n: number) => `## Sezione ${n}\n\n${TABLE}\n\n${words(250)}`;
    const control = (n: number) => `## Sezione ${n}\n\n${words(40)}\n\n${words(250)}`;
    const deferred = `${words(250)}\n\n${section(1)}\n\n${section(2)}\n\n${words(250)}`;
    const undeferred = `${words(250)}\n\n${control(1)}\n\n${control(2)}\n\n${words(250)}`;

    // Uncapped both bodies emit the same number of ads (the invariant above);
    // the cap has to bite strictly inside that number to test anything.
    const uncapped = countAds(render(undeferred));
    expect(uncapped).toBeGreaterThan(2);
    for (let cap = 1; cap < uncapped; cap += 1) {
      const withTables = renderToStaticMarkup(
        renderFormattedContent(deferred, undefined, cappedRenderer(cap)),
      );
      const withoutTables = renderToStaticMarkup(
        renderFormattedContent(undeferred, undefined, cappedRenderer(cap)),
      );
      expect(countAds(withTables)).toBe(countAds(withoutTables));
      expect(countAds(withTables)).toBe(cap);
    }
  });

  it('still emits the ad before an H2 whose section opens with prose', () => {
    const html = render(bodyWithoutTable);
    const h2 = html.indexOf('<h2');
    expect(html.slice(0, h2)).toContain(AD_MARKER);
  });
});
