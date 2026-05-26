/**
 * Tests for the non-Italian script detector that gates fallback-model output.
 *
 * Background — run 26446721285 (2026-05-26): the fallback chain rotated to
 * nvidia/llama-3.3-nemotron-super-49b-v1 which produced a 100%-Chinese
 * headline ("AVS超過2.6百万人领取老年金"). The validator rejected it as
 * "1 parola, range 2-22" but only AFTER consuming the entire headline-
 * retry budget — the run hard-failed with no article. The detector now
 * catches this drift at the JSON-validation layer so the chain rotates
 * to a different model without burning the budget.
 */

import { describe, expect, it } from 'vitest';
import {
  isNonItalianScript,
  nonItalianScriptRatio,
} from '../scripts/lib/itLanguageCheck.mjs';

describe('non-Italian script detector', () => {
  it('flags the run 26446721285 CJK headline', () => {
    const headline = 'AVS超過2.6百万人领取老年金';
    expect(isNonItalianScript(headline)).toBe(true);
    expect(nonItalianScriptRatio(headline)).toBeGreaterThan(0.5);
  });

  it('flags full-CJK body content', () => {
    const body = '日本の高齢者年金システムは複雑です。';
    expect(isNonItalianScript(body)).toBe(true);
  });

  it('flags Cyrillic body content', () => {
    const body = 'Швейцария — это страна в Европе.';
    expect(isNonItalianScript(body)).toBe(true);
  });

  it('accepts pure Italian editorial content', () => {
    const headlines = [
      'AVS 2030: cosa cambia per i frontalieri del Ticino',
      'Ristorni frontalieri: il Ticino propone una soluzione',
      "L'imposta alla fonte salirà nel 2026",
      'LAMal 2026, premi in aumento del 6% in Ticino',
      'Lavorare in Svizzera, vivere in Italia: la guida 2026',
    ];
    for (const h of headlines) {
      expect(isNonItalianScript(h), `should accept IT: ${h}`).toBe(false);
      expect(nonItalianScriptRatio(h)).toBeLessThan(0.1);
    }
  });

  it('accepts Italian with German/French/English borrowings (accented Latin only)', () => {
    const samples = [
      'Berna alle banche: tutti devono contribuire',
      'AHV-Renten — un confronto Italia-Svizzera',
      'Frontaliere résident en France: le cas particulier',
      'È vero che la Svizzera è membro dell’UE?',
    ];
    for (const s of samples) {
      expect(isNonItalianScript(s), `should accept Latin-extended: ${s}`).toBe(false);
    }
  });

  it('tolerates occasional CJK brand/quote tokens below threshold', () => {
    // "TikTok" name in Chinese 抖音 appears inside a longer Italian title.
    // 2 CJK chars vs ~50 Latin → ~4% ratio, below the 10% threshold.
    const headline = 'Frontalieri e TikTok (抖音): la piattaforma divide il mercato del lavoro ticinese';
    expect(isNonItalianScript(headline)).toBe(false);
  });

  it('handles edge cases safely', () => {
    expect(isNonItalianScript('')).toBe(false);
    expect(isNonItalianScript(null as unknown as string)).toBe(false);
    expect(isNonItalianScript(undefined as unknown as string)).toBe(false);
    expect(nonItalianScriptRatio('')).toBe(0);
    expect(nonItalianScriptRatio('12345.67')).toBe(0); // no letters → ratio 0
  });

  it('honours a custom threshold', () => {
    const halfHalf = 'Ticino 北京 Lugano 上海 Bellinzona 广州 Mendrisio';
    // ~6 CJK letters vs ~30 Latin letters → ~20% ratio.
    expect(isNonItalianScript(halfHalf, 0.5)).toBe(false);
    expect(isNonItalianScript(halfHalf, 0.05)).toBe(true);
  });

  it('flags Arabic and Hebrew too (less common but observed in some Cerebras models)', () => {
    expect(isNonItalianScript('السلام عليكم — frontaliere è una parola italiana')).toBe(true);
    expect(isNonItalianScript('שלום — ciao in ebraico')).toBe(true);
  });
});
