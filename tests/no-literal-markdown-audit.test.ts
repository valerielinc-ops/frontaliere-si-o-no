/**
 * audit:no-literal-markdown is 0-tolerance (AGENTS.md rule #1), so its
 * PRECISION matters as much as its recall: one false positive and the only
 * ways out are corrupting real content or weakening the gate.
 *
 * Measured on the 2026-08-06 deploy: 25 offenders, 24 of them one genuinely
 * mangled title, and the 25th a detector artifact. Globus brands its food
 * hall `***delicatessa` — verified on the employer's own page (12
 * occurrences, `<title>` and `og:title` included). Two such cards on one
 * search page, tags flattened to spaces, and the bold regex matched from the
 * second star of one brand to the first two of the next, across two different
 * jobs. These tests pin both halves down.
 */
import { describe, it, expect } from 'vitest';
import { createAuditor } from '../scripts/audit-no-literal-markdown.mjs';
import { sanitizeJobTitleField } from '../scripts/assemble-jobs-dataset.mjs';

const JOB_PAGE = 'dist/cerca-lavoro-ticino/offerta/index.html';

function page(inner: string): string {
  return `<html><body><main class="seo-static-content">${inner}</main></body></html>`;
}

function runOn(html: string) {
  const auditor = createAuditor();
  auditor.collect(JOB_PAGE, html);
  return auditor.report();
}

describe('audit-no-literal-markdown — what it must FLAG', () => {
  it('flags a bold run rendered literally inside one element', () => {
    const r = runOn(page('<h3>**Partner Comercial de Recursos Humanos**</h3>'));
    expect(r.passed).toBe(false);
    expect(r.offenders[0].literalBoldSamples[0]).toContain('Partner Comercial');
  });

  it('flags a separator run', () => {
    expect(runOn(page('<p>Requisiti ______ Benefit</p>')).passed).toBe(false);
  });
});

describe('audit-no-literal-markdown — what it must NOT flag', () => {
  it('does not pair a brand asterisk run in one card with another card\'s', () => {
    const r = runOn(page(
      '<a><h3>Verkaufsberater:in ***delicatessa 40-60% (w/m/d)</h3><span>Globus · Luzern</span></a>'
      + '<a><h3>Mitarbeiter:in ***delicatessa 80% (w/m/d)</h3><span>Globus · Bern</span></a>',
    ));
    expect(r.offendersTotal).toBe(0);
  });

  it('does not flag the German gender star', () => {
    expect(runOn(page('<h3>Verkäufer*in Detailhandel 100%</h3>')).passed).toBe(true);
  });

  it('does not flag a trailing decoration run on its own', () => {
    expect(runOn(page('<h3>Un chargé ou une chargée de communication ***</h3>')).passed).toBe(true);
  });
});

describe('sanitizeJobTitleField — strips the wrapper, never real content', () => {
  it('unwraps a whole-title markdown bold', () => {
    expect(sanitizeJobTitleField('**Partner Comercial de Recursos Humanos**'))
      .toBe('Partner Comercial de Recursos Humanos');
  });

  it('leaves the Globus brand alone — asterisks mid-title are content', () => {
    const t = 'Verkaufsberater:in ***delicatessa 40-60% (w/m/d)';
    expect(sanitizeJobTitleField(t)).toBe(t);
  });

  it('leaves the German gender star alone', () => {
    expect(sanitizeJobTitleField('Verkäufer*in Detailhandel')).toBe('Verkäufer*in Detailhandel');
  });

  it.each([
    ['a trailing run', 'Un chargé ou une chargée de communication ***'],
    ['a leading run', '***Klassenlehrperson 1./2. Klasse'],
    ['an interior run', 'Postdoctoral Researcher (100%) *** Assistant ou assistante'],
  ])('leaves %s as the employer published it', (_label, title) => {
    expect(sanitizeJobTitleField(title)).toBe(title);
  });

  it('is idempotent and total', () => {
    const once = sanitizeJobTitleField('**Titolo**');
    expect(sanitizeJobTitleField(once)).toBe(once);
    expect(() => sanitizeJobTitleField(undefined as unknown as string)).not.toThrow();
    expect(sanitizeJobTitleField('')).toBe('');
  });
});
