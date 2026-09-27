import { describe, expect, it } from 'vitest';
import { buildWeeklyPath, type JobMarketSnapshotLocale } from '@/build-plugins/jobMarketSnapshotData';
import { buildCantonSnapshotPath } from '@/build-plugins/jobMarketSnapshotChCantonPathsData';
import { factory as createInformationGainAuditor } from '@/scripts/audit-information-gain.mjs';
import { isWeeklyJobMarketSnapshotPath } from '@/scripts/lib/weeklyJobMarketSections.mjs';

const LOCALES: readonly JobMarketSnapshotLocale[] = ['it', 'en', 'de', 'fr'];

const snapshotPage = (label: string): string => `<!doctype html>
<html><head><title>${label}</title></head><body>
  <main><h1>${label}</h1>
  <p>Snapshot strutturato con conteggi, periodo di osservazione e distribuzione delle offerte attive.</p>
  <p>La pagina descrive i dati pubblicati dalla raccolta verificata del mercato del lavoro.</p>
  </main>
</body></html>`;

function distIndexPath(pathname: string): string {
  return `/virtual/dist${pathname}index.html`;
}

function relativeDistIndexPath(pathname: string): string {
  return `${pathname.replace(/^\/+/, '')}index.html`;
}

describe('information-gain: weekly job-market snapshot pages are data-driven', () => {
  it('recognises weekly roots emitted for every locale', () => {
    for (const locale of LOCALES) {
      const path = buildWeeklyPath(locale, 2026, 16);
      expect(isWeeklyJobMarketSnapshotPath(path), path).toBe(true);
      expect(isWeeklyJobMarketSnapshotPath(relativeDistIndexPath(path)), `${path} dist`).toBe(true);
    }
  });

  it('recognises canton snapshot paths emitted for every locale', () => {
    for (const locale of LOCALES) {
      const path = buildCantonSnapshotPath(locale, 'argovia');
      expect(isWeeklyJobMarketSnapshotPath(path), path).toBe(true);
      expect(isWeeklyJobMarketSnapshotPath(relativeDistIndexPath(path)), `${path} dist`).toBe(true);
    }
  });

  it('does not broaden the exemption to hubs, monthly, sector or normal job-board pages', () => {
    expect(isWeeklyJobMarketSnapshotPath('/mercato-lavoro-ticino/')).toBe(false);
    expect(isWeeklyJobMarketSnapshotPath('/mercato-lavoro-ticino/aprile-2026/')).toBe(false);
    expect(isWeeklyJobMarketSnapshotPath('/en/ticino-job-market/sector/infermieri/')).toBe(false);
    expect(isWeeklyJobMarketSnapshotPath('/cerca-lavoro-argovia/')).toBe(false);
    expect(isWeeklyJobMarketSnapshotPath('/cerca-lavoro-argovia/azienda-eoc/')).toBe(false);
  });

  it('keeps all weekly and canton snapshot pages out of editorial scoring', () => {
    const auditor = createInformationGainAuditor({ dist: '/virtual/dist', sampleRate: 1 });
    const paths = [
      ...LOCALES.map((locale) => buildWeeklyPath(locale, 2026, 16)),
      ...LOCALES.map((locale) => buildCantonSnapshotPath(locale, 'argovia')),
    ];

    for (const path of paths) {
      auditor.collect(distIndexPath(path), snapshotPage(path));
    }

    const report = auditor.report();
    expect(report.passed).toBe(true);
    expect(report.extra.pagesScored).toBe(0);
    expect(report.offendersTotal).toBe(0);
  });
});
