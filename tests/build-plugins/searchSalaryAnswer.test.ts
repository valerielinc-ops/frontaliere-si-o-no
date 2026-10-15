import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { searchSalaryMedian, buildSalaryAnswer } from '../../build-plugins/shared/searchSalaryAnswer';
import { renderClusterBelowFloorBridge } from '../../build-plugins/relatedSearchClustersPlugin';
import { __renderOrphanLandingPage } from '../../build-plugins/orphanQueryLandingPlugin';
import { CALC_HREF } from '../../build-plugins/shared/calcHref';

const reported = { salarySource: 'reported', salaryMin: 70000, salaryMax: 90000, currency: 'CHF' };

describe('documented salary answer', () => {
  it('requires five identified CHF ranges and excludes estimates, foreign currencies and unknown provenance', () => {
    expect(searchSalaryMedian(Array(5).fill(reported))).toBe(80000);
    const mixed = [...Array(4).fill(reported),
      { ...reported, salarySource: 'estimated' }, { ...reported, salarySource: 'existing' }, { ...reported, salarySource: undefined },
      { ...reported, currency: 'EUR' }, { ...reported, currency: 'USD' },
      { ...reported, salaryMax: 10000000 }, { ...reported, salaryMax: 10000 },
      { ...reported, salaryMax: undefined }, { ...reported, salaryMax: Number.NaN }];
    expect(searchSalaryMedian(mixed)).toBe(0);
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('gives an honest missing-data answer and calculator on a sparse salary query in %s', locale => {
    const page = renderClusterBelowFloorBridge(locale, '/sample/', 'https://frontaliereticino.ch/sample/', 'salary customs specialist');
    expect(page.html).toContain(buildSalaryAnswer(locale, '').slice(0, 30));
    expect(page.html).toContain(`href="${CALC_HREF[locale]}"`);
    const orphan = __renderOrphanLandingPage({
      cluster: { clusterId: 'salary', locale, canonicalQuery: 'salary customs specialist', canonicalSlug: 'salary-customs', roleTokens: ['custom'], regionTokens: [], totalImpressions: 20, totalClicks: 0, queries: [] },
      matchingJobs: [], strings: {}, dateStamp: new Date().toISOString().slice(0, 10), knownSlugsByLocale: new Map(),
    });
    expect(orphan.html).toContain(`href="${CALC_HREF[locale]}"`);
    expect(orphan.html).not.toContain('CHF 80');
  });

  it.each([
    ['it', 'infermiere Lugano', 'infermiere Lugano stipendio'],
    ['en', 'nurse Lugano', 'nurse Lugano salary'],
    ['de', 'Pflegefachperson Lugano', 'Pflegefachperson Lugano Gehalt'],
    ['fr', 'infirmier Lugano', 'infirmier Lugano salaire'],
  ] as const)('limits the salary explanation to salary intent in %s', (locale, ordinaryQuery, salaryQuery) => {
    const render = (canonicalQuery: string) => __renderOrphanLandingPage({
      cluster: { clusterId: 'intent', locale, canonicalQuery, canonicalSlug: 'intent', roleTokens: [], regionTokens: [], totalImpressions: 20, totalClicks: 0, queries: [] },
      matchingJobs: [], strings: {}, dateStamp: new Date().toISOString().slice(0, 10), knownSlugsByLocale: new Map(),
    }).html;
    const answer = buildSalaryAnswer(locale, '').slice(0, 30);
    // Salary FAQs remain useful on ordinary job searches; only the direct
    // answer above the results is conditional on the query's salary intent.
    const directAnswers = (query: string) => {
      const dom = new JSDOM(render(query));
      const answerText = [...dom.window.document.querySelectorAll('p.s-WzYXnb')].map(node => node.textContent).join('\n');
      dom.window.close();
      return answerText;
    };
    expect(directAnswers(ordinaryQuery)).not.toContain(answer);
    expect(directAnswers(salaryQuery)).toContain(answer);
  });
});
