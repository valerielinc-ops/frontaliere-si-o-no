import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL8AttributionExport,
  buildL8AttributionQuery,
  buildUnavailableL8AttributionExport,
  exportL8Attribution,
} from '../scripts/ci/export-l8-affiliate-outcomes.mjs';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const WINDOW = { start: '2026-09-07T00:00:00.000Z', end: '2026-09-15T00:00:00.000Z' };

const AGGREGATE = {
  webExposures: 120,
  emailExposures: 4,
  webClicks: 15,
  emailClicks: 2,
  sourceEvents: 141,
};

describe('L8 affiliate attribution exporter', () => {
  it('queries only categorical exposure/click events and excludes identity fields', () => {
    const query = buildL8AttributionQuery(WINDOW);
    expect(query).toContain('affiliate_experiment_exposure');
    expect(query).toContain('affiliate_click');
    expect(query).toContain('properties.surface');
    expect(query).not.toMatch(/distinct_id|person_id|properties\.email|uuid|pathname|url/i);
  });

  it('keeps live attribution separate from the missing commercial ledger', () => {
    const outcome = buildL8AttributionExport({
      aggregate: AGGREGATE,
      generatedAt: NOW,
      telemetryWindow: WINDOW,
    });
    expect(outcome).toMatchObject({
      loopId: 'L8',
      independent: false,
      generatedAt: NOW.toISOString(),
      exposures: { web: 120, email: 4 },
      clicks: { web: 15, email: 2, relevant: 17, total: 17 },
      transactions: null,
      attribution: { identityFieldsSelected: [], publishedDataUntouched: true },
    });
    expect(outcome.evidence.commercialLedger).toBe('missing');
  });

  it('preserves the authorised network timestamp and rows when an explicit export exists', () => {
    const outcome = buildL8AttributionExport({
      aggregate: AGGREGATE,
      generatedAt: NOW,
      telemetryWindow: WINDOW,
      commercial: {
        generatedAt: '2026-09-14T11:00:00.000Z',
        independent: true,
        evidence: { source: 'network-export', sourceRefs: ['authorised-network'] },
        transactions: [{ transactionId: 'approved-1', status: 'approved', amount: 10, currency: 'CHF', occurredAt: '2026-09-14T10:00:00.000Z' }],
      },
    });
    expect(outcome).toMatchObject({
      independent: true,
      generatedAt: '2026-09-14T11:00:00.000Z',
      transactions: [{ transactionId: 'approved-1' }],
      evidence: { source: 'network-export', commercialLedger: 'supplied-by-authorised-export' },
    });
    expect(outcome.evidence.sourceRefs).toContain('authorised-network');
    expect(outcome.evidence.sourceRefs).toContain('posthog.affiliate_click');
  });

  it('creates a fail-closed unavailable input', () => {
    const outcome = buildUnavailableL8AttributionExport({
      generatedAt: NOW,
      telemetryWindow: WINDOW,
      reason: 'credentials unavailable',
    });
    expect(outcome).toMatchObject({
      loopId: 'L8',
      independent: false,
      exposures: { web: null, email: null },
      transactions: null,
      evidence: { status: 'missing', commercialLedger: 'missing' },
    });
  });

  it('writes a runner-local live export through an injectable PostHog response', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-l8-attribution-test-'));
    const outputPath = path.join(dir, 'outcome.json');
    const outcome = await exportL8Attribution({
      outputPath,
      now: NOW,
      days: 8,
      posthogRunner: async (query) => {
        expect(query).toContain("timestamp >= '2026-09-07T00:00:00.000Z'");
        return {
          columns: ['webExposures', 'emailExposures', 'webClicks', 'emailClicks', 'sourceEvents'],
          results: [[120, 4, 15, 2, 141]],
        };
      },
    });
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toMatchObject({
      loopId: 'L8',
      exposures: { web: 120, email: 4 },
      independent: false,
    });
    expect(outcome.attribution.sourceEvents).toBe(141);
  });
});
