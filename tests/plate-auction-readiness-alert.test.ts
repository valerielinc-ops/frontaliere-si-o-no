import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { formatReadinessAlert, readinessAlertTitle } from '../scripts/plate-auctions/alert-ready-sources.mjs';

const GE_READY = {
  key: 'ge',
  plateCode: 'GE',
  discoveryUrl: 'https://www.ge.ch/plaques/vente-aux-encheres-plaques',
  httpStatus: 200,
  recommendation: 'ready-for-connector-check',
  geList: {
    connectorRows: 19,
    sessionStartsAt: '2026-11-01T23:00:00.000Z',
    sessionEndsAt: '2026-11-12T10:00:00.000Z',
    listPdfUrl: 'https://www.ge.ch/document/24010/telecharger',
    unknownListDocuments: ['https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres-0'],
  },
};

describe('plate-auction readiness alert', () => {
  it('keeps a stable, code-first title so github-issue-creator deduplicates each source', () => {
    const later = { ...GE_READY, geList: { ...GE_READY.geList, connectorRows: 21 } };
    expect(readinessAlertTitle(GE_READY)).toBe('GE plate-auction source is ready — review its activation');
    expect(readinessAlertTitle(later).slice(0, 60)).toBe(readinessAlertTitle(GE_READY).slice(0, 60));
    expect(readinessAlertTitle({ key: 'ne', plateCode: 'NE' }).slice(0, 60))
      .not.toBe(readinessAlertTitle(GE_READY).slice(0, 60));
    expect(readinessAlertTitle(GE_READY)).not.toMatch(/\d/);
  });

  it('writes the backlog card with the GE session, the PDF and the sitemap-only document', () => {
    const { description } = formatReadinessAlert(GE_READY, { runUrl: 'https://github.com/o/r/actions/runs/1' });
    for (const field of ['- CAUSA:', '- FIX:', '- METRICA:', '| COMANDO:', '- OSSERVATORE:']) {
      expect(description).toContain(field);
    }
    expect(description).toContain('19 targhe');
    expect(description).toContain('https://www.ge.ch/document/24010/telecharger');
    expect(description).toContain('GE_PLATE_AUCTION_SOURCE.listDocumentUrls');
    expect(description).toContain('2026-11-12T10:00:00.000Z');
    expect(description).toContain('Run: https://github.com/o/r/actions/runs/1');
    expect(description).not.toMatch(/https:\/\/www\.ricardo\.ch/);
  });

  it('points a JU/NE data link at a review, including the false-alarm exit', () => {
    const { description } = formatReadinessAlert({
      key: 'ne',
      plateCode: 'NE',
      httpStatus: 200,
      recommendation: 'manual-confirmation-needed',
      dataLinks: [{ url: 'https://www.scan-ne.ch/fileadmin/numeros.csv', text: 'Numéros aux enchères' }],
    });
    expect(description).toContain('https://www.scan-ne.ch/fileadmin/numeros.csv');
    expect(description).toContain('REVIEWED_NON_FEED_LINKS.ne');
  });

  it('wires the daily alert and the probe self-alert without writing issues in a dry run', () => {
    const source = readFileSync(new URL('../.github/workflows/refresh-plate-auctions.yml', import.meta.url), 'utf8');
    const steps = (YAML.parse(source).jobs['refresh-plate-auctions'].steps as Array<Record<string, string>>);
    const byName = (name: string) => steps.find((step) => step.name === name) ?? {};
    const probe = byName('Probe blocked source readiness');
    expect(probe.id).toBe('readiness');
    expect(probe.run).toContain('--ge-sitemap');
    expect(probe.run).toContain('"$GITHUB_OUTPUT"');
    const alert = byName('Alert on blocked sources that became ready (dedup, zero-Claude)');
    expect(alert.run).toContain('scripts/plate-auctions/alert-ready-sources.mjs');
    for (const name of [
      'Alert on blocked sources that became ready (dedup, zero-Claude)',
      'Self-alert on readiness probe crash (dedup, zero-Claude)',
      'Resolve the probe self-alert when the daily probe is healthy',
    ]) {
      expect(String(byName(name).if), name).toContain("inputs.dry_run != true && inputs.dry_run != 'true'");
    }
    expect(String(byName('Self-alert on readiness probe crash (dedup, zero-Claude)').if)).toContain("steps.readiness.outcome == 'failure'");
  });
});
