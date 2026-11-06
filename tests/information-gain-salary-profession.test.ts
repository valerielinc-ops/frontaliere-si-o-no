import { describe, expect, it } from 'vitest';
import { factory as createInformationGainAuditor } from '@/scripts/audit-information-gain.mjs';
import { SALARY_PROFESSION_CANTON_ROUTES } from '@/build-plugins/salaryProfessionCantonData';
import { isSalaryProfessionCantonPath } from '@/scripts/lib/salaryProfessionSections.mjs';

const salaryPage = (value: number): string => `<!doctype html>
<html><head><title>Salary page ${value}</title></head><body><main>
  <h1>Salary by profession and canton</h1>
  <p>Structured salary estimate with canton comparison and current job data.</p>
  <p>The published values come from the maintained salary and employment snapshot.</p>
</main></body></html>`;

describe('information-gain: salary profession×canton pages are a data vertical', () => {
  it('recognises every generated salary route and its dist index form', () => {
    expect(SALARY_PROFESSION_CANTON_ROUTES).toHaveLength(736);
    for (const path of SALARY_PROFESSION_CANTON_ROUTES) {
      expect(isSalaryProfessionCantonPath(path), path).toBe(true);
      expect(isSalaryProfessionCantonPath(`${path}index.html`), `${path}index.html`).toBe(true);
    }
  });

  it('does not broaden the matcher to similar or excluded routes', () => {
    expect(isSalaryProfessionCantonPath('/stipendio-infermiere-ticino/')).toBe(false);
    expect(isSalaryProfessionCantonPath('/de/gehalt-ingenieur-genf-extra/')).toBe(false);
    expect(isSalaryProfessionCantonPath('/guide/gehalt-ingenieur-genf/')).toBe(false);
  });

  it('keeps the structured salary payload out of editorial scoring', () => {
    const auditor = createInformationGainAuditor({ dist: '/virtual/dist', sampleRate: 1 });
    SALARY_PROFESSION_CANTON_ROUTES.forEach((path, index) => {
      auditor.collect(`/virtual/dist${path}index.html`, salaryPage(index + 1));
    });

    const report = auditor.report();
    expect(report.passed).toBe(true);
    expect(report.extra.pagesScored).toBe(0);
    expect(report.offendersTotal).toBe(0);
  });
});
