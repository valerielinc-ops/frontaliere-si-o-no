/**
 * Regression: SuccessFactors CSB (HOCH Health, Mobiliar, …) appends a trailing
 * inline stylesheet as plain text inside the description container — sometimes
 * after a `/* … *​/` build marker, sometimes when `readPropertyBlock` truncates
 * the opening `<style>` tag so the `<style>…</style>` stripper can't reach it.
 * `htmlToText` → `stripInlineJsCode` must truncate at that leaked CSS so the
 * `validate:jobs-quality` `code_in_description` gate stays green.
 */
import { describe, expect, it } from 'vitest';
import { htmlToText, stripInlineJsCode } from '@/scripts/lib/hospital-custom-html-helpers.mjs';

const REAL_PROSE =
  'Ihre Aufgaben und Perspektiven\n\nBetreuung und Führung von Notfällen im grössten ' +
  'Notfallzentrum der Ostschweiz mit breitem internistischem Spektrum und allen Fachdisziplinen.';

describe('stripInlineJsCode — leaked CSS', () => {
  it('truncates a trailing CSS dump preceded by a build marker (HOCH SF CSB)', () => {
    const leaked =
      REAL_PROSE +
      '\n\n/*f20250516*/.Job.application p{margin:0 0 10px 0;clear:none}' +
      '.Job.benefits{display:flex;flex-wrap:wrap}.Job.benefits [title] span{display:none}' +
      '.Job.benefits [title=\'Fitness\']{background-image:url(https://jobs/images/icons/herzhand.svg)}';
    const out = stripInlineJsCode(leaked);
    expect(out).toBe(REAL_PROSE);
    expect(out).not.toMatch(/background-image:\s*url\(/i);
    expect(out).not.toMatch(/display\s*:\s*(?:none|flex)/i);
  });

  it('truncates a leaked CSS dump with !important color/font rules (Mobiliar)', () => {
    const leaked =
      REAL_PROSE +
      ' .fontcolorb6a533a1 h2 { color: #da2323 !important;}@media (min-width:768px)' +
      '{.fontcolorb6a533a1 h2{font-size: 48px!important; line-height: 70px!important;}}';
    const out = stripInlineJsCode(leaked);
    expect(out).toBe(REAL_PROSE);
    expect(out).not.toMatch(/\{[^}]*font-size/i);
  });

  it('survives htmlToText end-to-end when the opening <style> tag is missing', () => {
    // readPropertyBlock can clip the opening tag, leaving CSS body + `</style>`.
    const html =
      `<p>${REAL_PROSE}</p>.Job.benefits{display:flex}.Job.benefits a:hover{filter:brightness(0.9)}</style>`;
    const out = htmlToText(html);
    expect(out).toContain('Ihre Aufgaben');
    expect(out).not.toMatch(/display\s*:\s*flex/i);
  });

  it('leaves clean prose untouched (no false positive on inline punctuation)', () => {
    const clean = 'Stelle 80-100% in St. Gallen. Eintritt: per sofort. Lohn nach Vereinbarung (Stufe 2.0).';
    expect(stripInlineJsCode(clean)).toBe(clean);
  });
});
