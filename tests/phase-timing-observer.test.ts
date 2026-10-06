// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatPhaseTimingSummary,
  observePhaseTimings,
  parsePhaseMarkers,
} from '../scripts/ci/phase-timing-observer.mjs';

const HISTORY = [
  { kind: 'build-profile', locale: 'de', build_status: 'success', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 100000 }, { marker: 'jobs-seo-pages:closeBundle', ms: 200000 }] },
  { kind: 'build-profile', locale: 'de', build_status: 'success', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 110000 }, { marker: 'jobs-seo-pages:closeBundle', ms: 210000 }] },
  { kind: 'build-profile', locale: 'de', build_status: 'success', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 100000 }, { marker: 'jobs-seo-pages:closeBundle', ms: 220000 }] },
  { kind: 'build-profile', locale: 'de', build_status: 'cancelled', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 999999 }] },
  { kind: 'build-profile', locale: 'it', build_status: 'success', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 999999 }] },
].map((row) => JSON.stringify(row)).join('\n');

describe('phase-timing-observer', () => {
  it('parses only exact phase markers and orders the current table by cost', () => {
    const phases = parsePhaseMarkers([
      '[phase-timing-top] 1. ignored 9.00s',
      '[phase-timing] cheap:closeBundle 5ms calls=1',
      '[phase-timing] slow:closeBundle 1400ms calls=1',
    ].join('\n'));
    expect(phases).toEqual([
      { marker: 'slow:closeBundle', ms: 1400 },
      { marker: 'cheap:closeBundle', ms: 5 },
    ]);
  });

  it('raises an advisory only after the same-locale median is established', () => {
    const observation = observePhaseTimings({
      locale: 'de',
      history: HISTORY,
      log: [
        '[phase-timing] related-search-clusters:closeBundle 140000ms calls=1',
        '[phase-timing] jobs-seo-pages:closeBundle 230000ms calls=1',
      ].join('\n'),
    });
    expect(observation.historySamples).toBe(3);
    expect(observation.regressions.map((row) => row.marker)).toEqual(['related-search-clusters:closeBundle']);
    expect(observation.rows.find((row) => row.marker === 'jobs-seo-pages:closeBundle')?.regression).toBe(false);
    expect(formatPhaseTimingSummary(observation)).toContain('| `related-search-clusters:closeBundle` | 140.00s | 100.00s | +40.0% | ⚠️ oltre soglia |');
  });

  it('does not compare another locale or an insufficient baseline', () => {
    const observation = observePhaseTimings({
      locale: 'fr',
      history: HISTORY,
      log: '[phase-timing] related-search-clusters:closeBundle 999999ms calls=1',
    });
    expect(observation.historySamples).toBe(0);
    expect(observation.regressions).toEqual([]);
    expect(formatPhaseTimingSummary(observation)).toContain('baseline insufficiente');
  });

  it('ignores cancelled and failed build-profile rows', () => {
    const rows = observePhaseTimings({
      locale: 'de',
      history: [
        JSON.stringify({ kind: 'build-profile', locale: 'de', build_status: 'failure', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 1 }] }),
        JSON.stringify({ kind: 'build-profile', locale: 'de', build_status: 'cancelled', phases: [{ marker: 'related-search-clusters:closeBundle', ms: 2 }] }),
      ].join('\n'),
      log: '[phase-timing] related-search-clusters:closeBundle 100ms calls=1',
    });
    expect(rows.historySamples).toBe(0);
    expect(rows.regressions).toEqual([]);
  });
});
