/**
 * Locks the SECO / arbeit.swiss unemployment-rate extractor against source
 * markup drift (issue #1729). The scheduled workflow failed because the page
 * moved from a `<div class="slide">…<p class="focusleaddescription">` layout to
 * a Nuxt SPA whose labour-market teaser carries the rate in a single sentence
 * ("…tasso di disoccupazione … al N,N%"). The fixture in
 * tests/__fixtures__/seco-unemployment-home.ts is a trimmed snapshot of the
 * CURRENT (2026-06) markup, so a future drift trips this test in CI instead of
 * only blowing up the live workflow.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain ESM script without type declarations
import {
  parseLatestUnemployment,
  extractRate,
  extractPeriod,
  isPlausibleRate,
} from '../scripts/update-switzerland-unemployment-rate.mjs';
import {
  SECO_UNEMPLOYMENT_HOME_HTML,
  SECO_UNEMPLOYMENT_EXPECTED,
  SECO_UNEMPLOYMENT_CHANGED_MONTH_HTML,
  SECO_UNEMPLOYMENT_CHANGED_MONTH_EXPECTED,
} from './__fixtures__/seco-unemployment-home';

describe('switzerland unemployment parser', () => {
  it('extracts rate + period + release URL from the current SECO markup', () => {
    const parsed = parseLatestUnemployment(SECO_UNEMPLOYMENT_HOME_HTML);
    expect(parsed).not.toBeNull();
    expect(parsed.rate).toBe(SECO_UNEMPLOYMENT_EXPECTED.rate);
    expect(parsed.period).toBe(SECO_UNEMPLOYMENT_EXPECTED.period);
    expect(parsed.href).toBe(SECO_UNEMPLOYMENT_EXPECTED.href);
  });

  it('binds the period to the rate sentence, ignoring an unrelated later-month heading', () => {
    // The fixture contains a distractor heading "…nuova veste da giugno 2026"
    // (2026-06). The parser must NOT let that month override the rate sentence's
    // own month (maggio 2026 / 2026-05).
    const parsed = parseLatestUnemployment(SECO_UNEMPLOYMENT_HOME_HTML);
    expect(parsed.period).toBe('2026-05');
    expect(parsed.period).not.toBe('2026-06');
  });

  it('binds to the rate RESULT on a changed-month sentence with two percentages', () => {
    // "…è salito dal 2,9% al 3,0%": the FIRST figure (2,9%) is the previous
    // month's rate. The extractor must persist the RESULT (3,0%), not 2,9%.
    const parsed = parseLatestUnemployment(SECO_UNEMPLOYMENT_CHANGED_MONTH_HTML);
    expect(parsed).not.toBeNull();
    expect(parsed.rate).toBe(SECO_UNEMPLOYMENT_CHANGED_MONTH_EXPECTED.rate);
    expect(parsed.rate).not.toBe(2.9);
    expect(parsed.period).toBe(SECO_UNEMPLOYMENT_CHANGED_MONTH_EXPECTED.period);
    // #1732 review #1: the release URL must still bind to the winning sentence's
    // own admin.ch link even when the anchor has to cross the previous-month %.
    expect(parsed.href).toBe(SECO_UNEMPLOYMENT_CHANGED_MONTH_EXPECTED.href);
  });

  it('cites the WINNING sentence\'s own release URL, not an earlier teaser\'s link (#1732 review #1)', () => {
    // Two teasers: an OLDER aprile teaser carries an unrelated admin.ch link
    // first in document order; the NEWER maggio teaser (the winner) carries the
    // canonical one. A loose "first admin after any rate phrase" scan would cite
    // the older link. The binding must follow the winning sentence's own result
    // figure to its adjacent URL.
    const html = `
<!doctype html><html lang="it"><body><div id="__nuxt">
<div class="u-teaser-card"><h5><span>nel mese di aprile 2026</span></h5>
<span>Nel mese di aprile 2026 il tasso di disoccupazione è rimasto invariato al 2,9%.</span></div>
<div class="u-teaser-card"><h5><span>nel mese di maggio 2026</span></h5>
<span>Nel mese di maggio 2026 il tasso di disoccupazione è salito dal 2,9% al 3,0%.</span></div>
</div>
<script>window.__NUXT__=(function(){return {data:[
{"lead":"Nel mese di aprile 2026 il tasso di disoccupazione è rimasto invariato al 2,9%.","https://www.admin.ch/it/newnsb/OLD-aprile-do-not-cite",{"x":1}},
{"lead":"Nel mese di maggio 2026 il tasso di disoccupazione è salito dal 2,9% al 3,0%.","https://www.admin.ch/it/newnsb/NEW-maggio-winner",{"x":2}}]}}})()</script>
</body></html>`;
    const parsed = parseLatestUnemployment(html);
    expect(parsed.period).toBe('2026-05');
    expect(parsed.rate).toBe(3);
    expect(parsed.href).toBe('https://www.admin.ch/it/newnsb/NEW-maggio-winner');
    expect(parsed.href).not.toContain('OLD-aprile');
  });

  it('extractRate takes the last figure when a sentence carries from→to rates', () => {
    expect(extractRate('il tasso di disoccupazione è salito dal 2,9% al 3,0%')).toBe(3);
    expect(extractRate('il tasso di disoccupazione è sceso dal 3,1% al 3,0%')).toBe(3);
    expect(extractRate('the unemployment rate rose from 2.8% to 3.0%')).toBe(3);
    expect(extractRate('le taux de chômage est passé de 2,9% à 3,1%')).toBe(3.1);
    expect(extractRate('die Arbeitslosenquote stieg von 2,9% auf 3,0%')).toBe(3);
  });

  it('returns null on genuinely broken markup (fail-loud, no silent default)', () => {
    expect(parseLatestUnemployment('<html><body><p>no data here</p></body></html>')).toBeNull();
    expect(parseLatestUnemployment('')).toBeNull();
  });

  it('extractRate handles all four locale phrasings and comma decimals', () => {
    expect(extractRate('il tasso di disoccupazione è rimasto invariato al 3,0%')).toBe(3);
    expect(extractRate('the unemployment rate stood at 2.8%')).toBe(2.8);
    expect(extractRate('die Arbeitslosenquote lag bei 3,1%')).toBe(3.1);
    expect(extractRate('le taux de chômage s’établit à 2,9%')).toBe(2.9);
    expect(extractRate('completely unrelated text 42%')).toBeNull();
  });

  it('rejects implausible rates outside the 0–15% band', () => {
    expect(isPlausibleRate(3)).toBe(true);
    expect(isPlausibleRate(0)).toBe(true);
    expect(isPlausibleRate(15)).toBe(true);
    expect(isPlausibleRate(96.4)).toBe(false); // e.g. "+9,6%" delta or a count
    expect(isPlausibleRate(2026)).toBe(false); // a year
    expect(isPlausibleRate(NaN)).toBe(false);
    // A rate phrase whose only nearby figure is implausible yields null.
    expect(extractRate('tasso di disoccupazione 2026%')).toBeNull();
  });

  it('extractPeriod maps month names across locales to ISO YYYY-MM', () => {
    expect(extractPeriod('nel mese di maggio 2026')).toBe('2026-05');
    expect(extractPeriod('in October 2022')).toBe('2022-10');
    expect(extractPeriod('im März 2026')).toBe('2026-03');
    expect(extractPeriod('en janvier 2017')).toBe('2017-01');
    expect(extractPeriod('no month here')).toBeNull();
  });

  it('findReleaseHref resolves release URL for dot-decimal figures (EN re-point, #1737)', () => {
    // Regression for figRx bug: escapeRegExp("3.0") → "3\\.0", then
    // .replace(/[.,]/g,"[.,]") rewrites the escaped dot → "3\\[.,]0" — a
    // malformed anchor.  Fix: skip escapeRegExp since rate figures are purely
    // numeric (digits + decimal separator, no other regex-special chars).
    const html = `
<!doctype html><html lang="en"><head><title>SECO</title></head><body>
<div id="__nuxt">
  <div class="u-base-card u-teaser-card u-teaser-card--list">
    <div class="u-base-card__body__text">
      <h5 class="u-heading"><span>Labour market situation in May 2026</span></h5>
      <span class="u-teaser-card__description">In May 2026 the unemployment rate stood at 3.0%.</span>
    </div>
  </div>
</div>
<script>window.__NUXT__=(function(){return {data:[{"lead":"In May 2026 the unemployment rate stood at 3.0%.","https://www.admin.ch/en/test/dot-decimal-release",{"x":1}}]}})()</script>
</body></html>`;
    const parsed = parseLatestUnemployment(html);
    expect(parsed).not.toBeNull();
    expect(parsed.rate).toBe(3);
    expect(parsed.period).toBe('2026-05');
    // With the bug: figRx = "3\\[.,]0" → anchorRe never matches → href falls back
    // to SOURCE_URL. With the fix: figRx = "3[.,]0" → admin.ch link is found.
    expect(parsed.href).toBe('https://www.admin.ch/en/test/dot-decimal-release');
  });
});
