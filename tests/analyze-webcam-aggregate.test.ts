/**
 * Unit tests for the multi-feed webcam aggregation that backs queue detection.
 *
 * `analyzeWebcamForCrossing` now sanity-checks a crossing's wait estimate against
 * EVERY camera that sees it (at-booth + approach-corridor), not just one primary.
 * These tests pin the pure aggregation logic (no network / no sharp):
 *  - a queue on ANY good-visibility feed ⇒ queueDetected (err toward warning);
 *  - "all clear" requires EVERY good feed clear (conservative suppress path);
 *  - night/poor feeds don't vote;
 *  - the crossing→feeds map is derived from the WEBCAM_FEEDS `crossings` arrays.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateWebcamResults,
  CROSSING_TO_FEEDS,
  WEBCAM_FEEDS,
} from '../scripts/analyze-webcam-frame.mjs';

const good = (queueDetected: boolean, congestionScore: number, feedKey: string) => ({
  visibility: 'good',
  queueDetected,
  congestionScore,
  feedKey,
});

describe('aggregateWebcamResults', () => {
  it('returns null when there are no results', () => {
    expect(aggregateWebcamResults([])).toBeNull();
    expect(aggregateWebcamResults([null, null])).toBeNull();
  });

  it('flags queueDetected when ANY good feed sees a queue', () => {
    const out = aggregateWebcamResults([
      good(false, 0.1, '00.3S'),
      good(true, 0.7, '03.3S'),
    ]);
    expect(out?.queueDetected).toBe(true);
    expect(out?.visibility).toBe('good');
    expect(out?.congestionScore).toBeCloseTo(0.7);
    expect(out?.feeds).toEqual(['00.3S', '03.3S']);
  });

  it('reports clear only when EVERY good feed is clear', () => {
    const out = aggregateWebcamResults([
      good(false, 0.1, '02.0N'),
      good(false, 0.2, '06.8S'),
      good(false, 0.05, '07.2N'),
    ]);
    expect(out?.queueDetected).toBe(false);
    expect(out?.congestionScore).toBeCloseTo(0.2);
  });

  it('ignores night/poor feeds when a good feed is present', () => {
    const out = aggregateWebcamResults([
      { visibility: 'night', queueDetected: false, congestionScore: null, feedKey: '00.3S' },
      good(true, 0.6, '03.3S'),
    ]);
    expect(out?.queueDetected).toBe(true);
    expect(out?.feeds).toEqual(['03.3S']);
  });

  it('no-ops (queueDetected=false) when every feed is night/poor', () => {
    const out = aggregateWebcamResults([
      { visibility: 'night', queueDetected: false, congestionScore: null, feedKey: '00.3S' },
      { visibility: 'poor', queueDetected: false, congestionScore: null, feedKey: '03.3S' },
    ]);
    expect(out?.queueDetected).toBe(false);
    expect(out?.feeds).toEqual([]);
  });
});

describe('CROSSING_TO_FEEDS registry', () => {
  it('derives multiple feeds for the high-traffic crossings', () => {
    expect(CROSSING_TO_FEEDS['chiasso-brogeda']).toEqual(
      expect.arrayContaining(['00.3S', '00.3N', '00.3O', '03.3S']),
    );
    expect(CROSSING_TO_FEEDS['gaggiolo']).toEqual(
      expect.arrayContaining(['02.0N', '06.8S', '07.2N']),
    );
    expect(CROSSING_TO_FEEDS['san-pietro']).toEqual(
      expect.arrayContaining(['02.0N', '06.8S']),
    );
  });

  it('gives Campione d\'Italia-Bissone its first queue-detection feed', () => {
    expect(CROSSING_TO_FEEDS['campione-d-italia-bissone']).toEqual(['17.84S']);
  });

  it('every feed key in the map exists in WEBCAM_FEEDS', () => {
    for (const keys of Object.values(CROSSING_TO_FEEDS)) {
      for (const k of keys) {
        expect(WEBCAM_FEEDS[k], `feed ${k}`).toBeDefined();
      }
    }
  });
});
