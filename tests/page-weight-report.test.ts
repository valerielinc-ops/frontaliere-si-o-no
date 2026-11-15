import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPageWeightReporter } from '../build-plugins/shared/pageWeightReport';

const JOBS_SEO_PLUGIN_SOURCE = readFileSync(new URL('../build-plugins/jobsSeoPagesPlugin.ts', import.meta.url), 'utf8');

describe('page-weight reporter', () => {
  it('counts pages below the warning threshold without warning', () => {
    const warn = vi.fn();
    const reporter = createPageWeightReporter({ warnBytes: 100, warn });

    reporter.observe('city-hub', '/city/', 100);

    expect(warn).not.toHaveBeenCalled();
    expect(reporter.summary()).toMatchObject({ total: 1, overCount: 0 });
  });

  it('warns with the page path and size above the threshold', () => {
    const warn = vi.fn();
    const reporter = createPageWeightReporter({ warnBytes: 100, warn });

    reporter.observe('intent-landing', '/search/jobs/', 2048);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('/search/jobs/');
    expect(warn.mock.calls[0][0]).toContain('2.0 KB');
    expect(reporter.summary()).toMatchObject({ total: 1, overCount: 1 });
  });

  it('never throws for NaN, Infinity, or negative byte counts', () => {
    const reporter = createPageWeightReporter({ warnBytes: 100 });

    expect(() => {
      reporter.observe('invalid', '/nan/', Number.NaN);
      reporter.observe('invalid', '/infinity/', Number.POSITIVE_INFINITY);
      reporter.observe('invalid', '/negative/', -1);
    }).not.toThrow();
    expect(reporter.summary()).toMatchObject({ total: 3, overCount: 0 });
  });

  it('keeps only topN pages, ordered by bytes descending then path ascending', () => {
    const reporter = createPageWeightReporter({ warnBytes: 10_000, topN: 3, warn: vi.fn() });

    reporter.observe('hub', '/zeta/', 2048);
    reporter.observe('hub', '/beta/', 4096);
    reporter.observe('hub', '/alpha/', 4096);
    reporter.observe('hub', '/delta/', 1024);

    expect(reporter.summary().top).toEqual([
      { kind: 'hub', path: '/alpha/', bytes: 4096 },
      { kind: 'hub', path: '/beta/', bytes: 4096 },
      { kind: 'hub', path: '/zeta/', bytes: 2048 },
    ]);
  });

  it('retains at most five entries while observing 10,000 pages', () => {
    const reporter = createPageWeightReporter({ warnBytes: 20_000_000, warn: vi.fn() });

    for (let index = 0; index < 10_000; index++) {
      reporter.observe('hub', `/page-${index}/`, index);
    }

    expect(reporter.summary().total).toBe(10_000);
    expect(reporter.summary().top).toHaveLength(5);
  });

  it('caps warnings while preserving the full over-threshold count', () => {
    const warn = vi.fn();
    const reporter = createPageWeightReporter({ warnBytes: 100, maxWarnings: 20, warn });

    for (let index = 0; index < 50; index++) {
      reporter.observe('hub', `/page-${index}/`, 101);
    }

    expect(warn).toHaveBeenCalledTimes(20);
    expect(warn.mock.calls.at(-1)?.[0]).toContain('Further page-weight warnings are summarised at the end.');
    expect(reporter.summary()).toMatchObject({ total: 50, overCount: 50 });
  });

  it('reset clears counters and retained pages', () => {
    const warn = vi.fn();
    const reporter = createPageWeightReporter({ warnBytes: 100, warn });
    reporter.observe('hub', '/city/', 101);

    reporter.reset();

    expect(reporter.summary()).toEqual({ total: 0, overCount: 0, top: [] });
  });
});

describe('jobs SEO page-weight observation contract', () => {
  it('observes exactly the five page families without retaining hard budgets', () => {
    const legacyBudgets = [
      ['CITY', 'HUB', 'HARD', 'BUDGET', 'BYTES'].join('_'),
      ['SECTOR', 'CANTON', 'HARD', 'BUDGET'].join('_'),
      ['COMPANY', 'CITY', 'HARD', 'BUDGET'].join('_'),
    ];
    for (const legacyBudget of legacyBudgets) {
      expect(JOBS_SEO_PLUGIN_SOURCE).not.toContain(legacyBudget);
    }
    expect(JOBS_SEO_PLUGIN_SOURCE).not.toContain(['195', '*', '1024'].join(' '));
    expect(JOBS_SEO_PLUGIN_SOURCE.match(/pageWeight\.observe\(/g) ?? []).toHaveLength(5);

    for (const kind of [
      'intent-landing',
      'city-editorial-landing',
      'city-hub',
      'sector-canton-hub',
      'company-city-hub',
    ]) {
      expect(JOBS_SEO_PLUGIN_SOURCE).toContain(`pageWeight.observe('${kind}',`);
    }
  });

  it('has no throw new Error within six lines after Buffer.byteLength', () => {
    const lines = JOBS_SEO_PLUGIN_SOURCE.split(/\r?\n/);
    const violations = lines.flatMap((line, index) => {
      if (!line.includes('Buffer.byteLength(')) return [];
      const followingSixLines = lines.slice(index + 1, index + 7);
      return followingSixLines.some((nextLine) => nextLine.includes('throw new Error('))
        ? [index + 1]
        : [];
    });

    expect(violations).toEqual([]);
  });
});
