/**
 * Regression test for the inline-style-strip behavior in
 * `build-plugins/shared/jobDescription/toHtml.ts:inlineTextToHtml`.
 *
 * Bachem (and similar) crawler imports contain MS-Word-paste HTML:
 *
 *   <span style="font-family:"Times New Roman", serif;">…</span>
 *
 * The inner double-quoted CSS string `"Times New Roman"` closes the
 * outer `style="..."` attribute early; the rest of the styles leak
 * into the HTML body as raw text. html-minifier-terser parse-errored
 * on 28 such pages in runs #26250403558 + #26255102850. The fix
 * strips ALL attributes from passthrough <span>/<br>/<strong>/<em>
 * tags and keeps ONLY href on <a> — they have zero SEO value and
 * break the minifier.
 */
import { describe, expect, it } from 'vitest';
import { inlineTextToHtml } from '../../build-plugins/shared/jobDescription/toHtml';

describe('inlineTextToHtml — passthrough HTML attribute sanitization', () => {
  it('strips inline style="..." with inner double quotes (MS Word pattern)', () => {
    const input =
      '<span style="font-size:12.0pt;line-height:107%;font-family:"Times New Roman", serif;">x</span>';
    const out = inlineTextToHtml(input);
    expect(out).toContain('<span>');
    expect(out).toContain('</span>');
    expect(out).toContain('x');
    expect(out).not.toMatch(/style=/);
    expect(out).not.toMatch(/font-family/);
  });

  it('strips inline class="..." from <span>', () => {
    const input = '<span class="cls">y</span>';
    const out = inlineTextToHtml(input);
    expect(out).toBe('<span>y</span>');
  });

  it('preserves plain text + markdown via parseInline path', () => {
    expect(inlineTextToHtml('hello **world**')).toBe('hello <strong>world</strong>');
  });

  it('keeps href on <a>, drops class/style/target/rel', () => {
    const input = '<a href="https://example.com/" class="link" style="color:red" target="_blank">x</a>';
    const out = inlineTextToHtml(input);
    expect(out).toBe('<a href="https://example.com/">x</a>');
  });

  it('handles single-quoted style attributes', () => {
    const input = "<span style='color:red'>x</span>";
    const out = inlineTextToHtml(input);
    expect(out).toBe('<span>x</span>');
  });

  it('strips attributes from <br> (Word also paste-bombs these)', () => {
    expect(inlineTextToHtml('a<br style="margin:0">b'))
      .toBe('a<br>b');
    // `<br />` (XHTML) and `<br>` (HTML5) are equivalent; we normalize
    // to HTML5 to match the rest of the dist output.
    expect(inlineTextToHtml('a<br />b')).toBe('a<br>b');
  });

  it('strips attributes from <strong>/<em>', () => {
    expect(inlineTextToHtml('<strong style="x">y</strong>'))
      .toBe('<strong>y</strong>');
    expect(inlineTextToHtml('<em class="x">y</em>'))
      .toBe('<em>y</em>');
  });

  it('handles <a> with no href (no crash)', () => {
    expect(inlineTextToHtml('<a class="x">link</a>'))
      .toBe('<a>link</a>');
  });

  it('multiple offenders in one string', () => {
    const input =
      '<span style="color:red">a</span> ' +
      '<a href="/x" class="y">b</a> ' +
      '<br style="margin:0">';
    const out = inlineTextToHtml(input);
    expect(out).toBe('<span>a</span> <a href="/x">b</a> <br>');
  });

  // Regression: HFR-style flattened bilingual descriptions where the
  // original paragraph break became a 60+ underscore divider.
  // audit:no-literal-markdown (0-tolerance) failed on 4 job pages in
  // workflow run #26264463075 because `inlineTextToHtml` left these
  // separator runs in the body of `<main class="seo-static-content">`.
  // See build-plugins/shared/jobDescription/toHtml.ts.
  describe('separator-run scrub (audit:no-literal-markdown 0-tol)', () => {
    it('drops 6+ underscore runs (HFR pattern)', () => {
      const sixtyThree = '_'.repeat(63);
      const input = `Ref.: HFR-M-251801 ${sixtyThree} Le Département`;
      const out = inlineTextToHtml(input);
      expect(out).not.toMatch(/_{3,}/);
      expect(out).toContain('Ref.: HFR-M-251801');
      expect(out).toContain('Le Département');
    });
    it('drops 6+ equals/tilde runs', () => {
      expect(inlineTextToHtml('a =========== b')).not.toMatch(/={3,}/);
      expect(inlineTextToHtml('a ~~~~~~~~~~ b')).not.toMatch(/~{3,}/);
    });
    it('leaves short underscore tokens alone (real text, not dividers)', () => {
      expect(inlineTextToHtml('snake_case identifier')).toContain('snake_case');
      expect(inlineTextToHtml('a __b__ c')).toContain('__b__');
    });
  });

  it('Bachem real-world fixture', () => {
    const input =
      'Ihre Aufgaben:\n\n<span style="font-size:12.0pt;line-height:107%;font-family:"Times New Roman", serif;">' +
      'Compliance & Governance' +
      '</span>';
    const out = inlineTextToHtml(input);
    expect(out).not.toMatch(/style=/);
    expect(out).not.toMatch(/font-family/);
    expect(out).toContain('Compliance');
  });
});
