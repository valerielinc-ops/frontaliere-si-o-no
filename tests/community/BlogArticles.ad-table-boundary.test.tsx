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

import { renderFormattedContent, isTableBlock, isAdStraddleBlock } from '@/components/community/BlogArticles';

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

/**
 * Issue #7647 — the same straddle protection for the two blocks the audit
 * (`docs/editorial-longform-audit.md` §6) still listed as unprotected: a
 * citation and an operative list. Both are read as one unit, so an ad emitted
 * between the `## ` and the block splits the reader mid-procedure.
 */
const QUOTE = '> Il frontaliere che supera i 45 giorni di non-rientro perde lo statuto.';
const BULLET_LIST = ['- Raccogli il modulo', '- Compila la sezione B', '- Invia entro il 31 marzo'].join('\n');
const NUMBERED_LIST = ['1. Raccogli il modulo', '2. Compila la sezione B', '3. Invia entro il 31 marzo'].join('\n');

describe('isAdStraddleBlock', () => {
  it('accepts a table, a citation, a bulleted list and a numbered procedure', () => {
    expect(isAdStraddleBlock(TABLE)).toBe(true);
    expect(isAdStraddleBlock(QUOTE)).toBe(true);
    expect(isAdStraddleBlock(BULLET_LIST)).toBe(true);
    expect(isAdStraddleBlock(NUMBERED_LIST)).toBe(true);
  });

  it('rejects prose and the empty block (a `## ` with no block after it)', () => {
    expect(isAdStraddleBlock(words(20))).toBe(false);
    expect(isAdStraddleBlock('')).toBe(false);
    expect(isAdStraddleBlock('   ')).toBe(false);
    // A paragraph that merely opens with a digit is not a procedure.
    expect(isAdStraddleBlock('45 giorni sono il limite di non-rientro previsto.')).toBe(false);
  });
});

describe('inline ads around a citation or an operative list (#7647)', () => {
  /** Big enough that the deferral spans more than a full gap, as BIG_TABLE does. */
  const bigList = (marker: (i: number) => string) =>
    Array.from({ length: 30 }, (_, i) => `${marker(i)} passo ${i} della procedura completa`).join('\n');
  const BIG_QUOTE = `> ${words(260)}`;
  const BIG_BULLETS = bigList(() => '-');
  const BIG_NUMBERS = bigList(i => `${i + 1}.`);
  const tokens = (block: string) => block.trim().split(/\s+/).filter(Boolean).length;

  /**
   * The ad an H2 boundary emits is pushed BEFORE the heading element, so the
   * straddle is visible in the markup as an ad sitting between the end of the
   * previous section and the block the heading introduces. `INTRO_END` marks
   * where that window opens; `blockEnd` is the last text the block renders.
   */
  const INTRO_END = 'fineintroduzione';
  const body = (block: string) =>
    `${words(250)}\n\n${INTRO_END}\n\n## Sezione operativa\n\n${block}\n\n${words(250)}`;

  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['citazione', BIG_QUOTE, 'parola259'],
    ['lista puntata', BIG_BULLETS, 'passo 29'],
    ['procedura numerata', BIG_NUMBERS, 'passo 29'],
  ];

  for (const [label, block, blockEndText] of cases) {
    it(`defers the ad past the ${label} the H2 introduces instead of straddling it`, () => {
      const html = render(body(block));
      const introEnd = html.indexOf(INTRO_END);
      const blockEnd = html.indexOf(blockEndText, introEnd);
      expect(introEnd).toBeGreaterThanOrEqual(0);
      expect(blockEnd).toBeGreaterThan(introEnd);
      expect(html.slice(introEnd, blockEnd)).not.toContain(AD_MARKER);
      expect(html.slice(blockEnd)).toContain(AD_MARKER);
    });

    it(`keeps the per-article ad count identical with a ${label} as with prose`, () => {
      const control = body(words(tokens(block)));
      expect(countAds(render(control))).toBeGreaterThan(1);
      expect(countAds(render(body(block)))).toBe(countAds(render(control)));
    });
  }

  /**
   * The straddle unit is often more than one block: a citation introducing the
   * procedure, then the list itself. The deferral has to survive the whole run,
   * not just its first block.
   */
  it('keeps the ad deferred across a run of citation + list, then emits it after', () => {
    const html = render(body(`${QUOTE}\n\n${BULLET_LIST}`));
    const introEnd = html.indexOf(INTRO_END);
    const listEnd = html.indexOf('</ul>', introEnd);
    expect(listEnd).toBeGreaterThan(introEnd);
    expect(html.slice(introEnd, listEnd)).not.toContain(AD_MARKER);
    expect(html.slice(listEnd)).toContain(AD_MARKER);
  });

  it('still emits the ad before an H2 whose section opens with prose', () => {
    const html = render(bodyWithoutTable);
    expect(html.slice(0, html.indexOf('<h2'))).toContain(AD_MARKER);
  });
});
