import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { factory } from '../scripts/audit-page-weight.mjs';

describe('audit:page-weight company hubs', () => {
  it('allows oversized company hubs but still rejects other job-board pages', () => {
    const auditor = factory();
    const html = '<html><body><img width="1" height="1" loading="lazy">' +
      'x'.repeat(300 * 1024) + '</body></html>';

    auditor.collect(
      resolve('dist/cerca-lavoro-argovia/azienda-sta-personal-ag/index.html'),
      html,
    );
    auditor.collect(
      resolve('dist/en/find-jobs-geneva/company-acme/index.html'),
      html,
    );
    auditor.collect(
      resolve('dist/cerca-lavoro-argovia/azienda-sta-personal-ag.html'),
      html,
    );
    auditor.collect(
      resolve('dist/cerca-lavoro-argovia/categoria-it/index.html'),
      html,
    );

    const report = auditor.report();
    expect(report.passed).toBe(false);
    expect(report.extra.oversizedCount).toBe(1);
    expect(report.offenders.map((offender: { path: string }) => offender.path)).toEqual([
      'dist/cerca-lavoro-argovia/categoria-it/index.html',
    ]);
  });
});
