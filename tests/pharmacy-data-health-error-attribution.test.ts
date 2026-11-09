import { describe, expect, it } from 'vitest';

import { buildReport } from '../scripts/check-pharmacy-data-health.mjs';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

describe('pharmacy data health fetch attribution', () => {
  it('keeps the importer cause in both the problem list and dashboard', () => {
    const report = buildReport({
      registry: {
        sources: {
          ticino: {
            canton: 'Ticino',
            status: 'active',
            sourceType: 'official',
            fetchFrequency: 'P1D',
          },
        },
      },
      datasets: {
        ticino: {
          _fetchedAt: new Date(NOW).toISOString(),
          _errors: ['Ticino PDF unavailable; official source timed out'],
          pharmacies: [],
        },
      },
      knownCantonCount: 1,
      nowMs: NOW,
    });

    expect(report.problems).toContain(
      '1 errore/i di fetch nel dataset anagrafica ticino: Ticino PDF unavailable; official source timed out',
    );
    expect(report.dashboard.join('\n')).toContain(
      '1 errore/i di fetch nel dataset anagrafica ticino: Ticino PDF unavailable; official source timed out',
    );
  });
});
