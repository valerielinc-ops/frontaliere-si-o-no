import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { factory } from '../scripts/audit-page-weight.mjs';
import { EMPLOYER_PROFILE_PATH_RX } from '../scripts/lib/jobBoardSections.mjs';

describe('audit:page-weight company result pages', () => {
  it('allows oversized company hubs and employer profiles but still rejects other pages', () => {
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
      resolve('dist/aziende/roche/index.html'),
      html,
    );
    auditor.collect(
      resolve('dist/en/aziende/fachkraft-ch-gmbh/index.html'),
      html,
    );
    auditor.collect(
      resolve('dist/de/aziende/stellentreff-ag.html'),
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

  it('matches only the single-segment employer profile route', () => {
    expect(EMPLOYER_PROFILE_PATH_RX.test('/aziende/roche/')).toBe(true);
    expect(EMPLOYER_PROFILE_PATH_RX.test('/en/aziende/fachkraft-ch-gmbh.html')).toBe(true);
    expect(EMPLOYER_PROFILE_PATH_RX.test('/de/aziende/')).toBe(false);
    expect(EMPLOYER_PROFILE_PATH_RX.test('/aziende/roche/jobs/')).toBe(false);
  });
});
