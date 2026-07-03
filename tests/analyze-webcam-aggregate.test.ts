/**
 * Unit tests for the multi-feed webcam aggregation that backs queue detection.
 *
 * `analyzeWebcamForCrossing` now sanity-checks a crossing's wait estimate against
 * EVERY camera that sees it (at-booth + approach-corridor), not just one primary.
 * These tests pin the pure aggregation logic (no network / no sharp):
 *  - MAJORITY VOTE: queueDetected requires a majority of good feeds to agree
 *    (single false trip among many cameras no longer flags the crossing);
 *  - "all clear" when the majority is not met (conservative suppress path);
 *  - night/poor feeds don't vote;
 *  - WARMUP: newly-introduced feeds (`introducedAt` within WARMUP_DAYS) are
 *    reported 'warming-up' and excluded from the trusted vote;
 *  - the crossing→feeds map is derived from the WEBCAM_FEEDS `crossings` arrays.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateWebcamResults,
  CROSSING_TO_FEEDS,
  envNumber,
  isFeedWarmingUp,
  queueVoteThreshold,
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

  it('flags queueDetected when a majority of good feeds see a queue (2 of 2)', () => {
    const out = aggregateWebcamResults([
      good(true, 0.6, '00.3S'),
      good(true, 0.7, '03.3S'),
    ]);
    expect(out?.queueDetected).toBe(true);
    expect(out?.visibility).toBe('good');
    expect(out?.congestionScore).toBeCloseTo(0.7);
    expect(out?.feeds).toEqual(['00.3S', '03.3S']);
  });

  it('with 2 good feeds, 1 vote meets the majority threshold (ceil(2*0.5)=1)', () => {
    const out = aggregateWebcamResults([
      good(false, 0.1, '00.3S'),
      good(true, 0.7, '03.3S'),
    ]);
    expect(out?.queueDetected).toBe(true);
    expect(out?.congestionScore).toBeCloseTo(0.7);
  });

  it('does NOT flag a queue on a single camera out of 4 (majority not met)', () => {
    // chiasso-brogeda now votes on 4 cameras; one false trip must not flag it.
    const out = aggregateWebcamResults([
      good(true, 0.7, '00.3S'),
      good(false, 0.1, '03.3S'),
      good(false, 0.05, '04.4N'),
      good(false, 0.2, '17.84S'),
    ]);
    expect(out?.queueDetected).toBe(false);
    // congestionScore stays the worst-camera headline.
    expect(out?.congestionScore).toBeCloseTo(0.7);
  });

  it('flags a queue when a majority of 4 cameras agree (>=2)', () => {
    const out = aggregateWebcamResults([
      good(true, 0.7, '00.3S'),
      good(true, 0.6, '03.3S'),
      good(false, 0.05, '04.4N'),
      good(false, 0.2, '17.84S'),
    ]);
    expect(out?.queueDetected).toBe(true);
  });

  it('reports clear when no good feed sees a queue', () => {
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

  it('warming-up feed does not vote and is excluded from the feeds list', () => {
    const out = aggregateWebcamResults([
      { visibility: 'warming-up', queueDetected: false, congestionScore: null, feedKey: '03.3S' },
      good(false, 0.1, '00.3S'),
    ]);
    expect(out?.queueDetected).toBe(false);
    expect(out?.visibility).toBe('good');
    expect(out?.feeds).toEqual(['00.3S']);
  });

  it('surfaces warming-up visibility (no-op) when ALL feeds are warming up', () => {
    const out = aggregateWebcamResults([
      { visibility: 'warming-up', queueDetected: false, congestionScore: null, feedKey: '03.3S' },
      { visibility: 'warming-up', queueDetected: false, congestionScore: null, feedKey: '07.2N' },
    ]);
    expect(out?.queueDetected).toBe(false);
    expect(out?.visibility).toBe('warming-up');
    expect(out?.feeds).toEqual([]);
  });
});

describe('queueVoteThreshold (majority vote)', () => {
  it('floors at 1 so a single good feed still decides', () => {
    expect(queueVoteThreshold(0)).toBe(1);
    expect(queueVoteThreshold(1)).toBe(1);
  });

  it('requires a strict majority (ceil(n/2)) at the default 0.5 fraction', () => {
    expect(queueVoteThreshold(2)).toBe(1); // ceil(2*0.5)=1
    expect(queueVoteThreshold(3)).toBe(2); // ceil(3*0.5)=2
    expect(queueVoteThreshold(4)).toBe(2); // ceil(4*0.5)=2
    expect(queueVoteThreshold(5)).toBe(3);
  });

  it('honours a custom fraction', () => {
    expect(queueVoteThreshold(4, 0.75)).toBe(3); // ceil(4*0.75)=3
    expect(queueVoteThreshold(4, 1)).toBe(4);    // unanimous
  });

  it('falls back to the default fraction for an invalid one', () => {
    expect(queueVoteThreshold(4, 0)).toBe(2);
    expect(queueVoteThreshold(4, -1)).toBe(2);
    expect(queueVoteThreshold(4, Number.NaN)).toBe(2);
  });
});

describe('isFeedWarmingUp', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-06-20T00:00:00Z');

  it('is false for a feed without introducedAt', () => {
    expect(isFeedWarmingUp({}, now)).toBe(false);
    expect(isFeedWarmingUp(undefined, now)).toBe(false);
  });

  it('is true within the warmup window', () => {
    expect(isFeedWarmingUp({ introducedAt: '2026-06-16' }, now)).toBe(true); // 4 days old
  });

  it('is false once the window has elapsed', () => {
    expect(isFeedWarmingUp({ introducedAt: '2026-06-01' }, now)).toBe(false); // 19 days old
  });

  it('flips exactly at the WARMUP_DAYS boundary', () => {
    const intro = '2026-06-06T00:00:00Z'; // exactly 14 days before `now`
    expect(isFeedWarmingUp({ introducedAt: intro }, now, 14)).toBe(false); // age == window ⇒ trusted
    expect(isFeedWarmingUp({ introducedAt: intro }, now - DAY, 14)).toBe(true); // 13 days ⇒ warming
  });

  it('treats an unparseable introducedAt as not warming (fail-trusted, never silences forever)', () => {
    expect(isFeedWarmingUp({ introducedAt: 'not-a-date' }, now)).toBe(false);
  });
});

describe('CROSSING_TO_FEEDS registry', () => {
  it('derives multiple detection feeds for the high-traffic crossings', () => {
    expect(CROSSING_TO_FEEDS['chiasso-brogeda']).toEqual(
      expect.arrayContaining(['00.3S', '03.3S']),
    );
    // '07.2N' was removed (issue #3372): the upstream www4.ti.ch feed 404s and
    // has no replacement; 'gaggiolo' now votes on the two remaining feeds.
    expect(CROSSING_TO_FEEDS['gaggiolo']).toEqual(
      expect.arrayContaining(['02.0N', '06.8S']),
    );
    expect(CROSSING_TO_FEEDS['gaggiolo']).not.toContain('07.2N');
    expect(CROSSING_TO_FEEDS['san-pietro']).toEqual(
      expect.arrayContaining(['02.0N', '06.8S']),
    );
  });

  it('EXCLUDES cvDetect:false feeds (commercial / high-texture views) from queue detection', () => {
    // 00.3N (Brogeda interchange gantries) + 00.3O (commercial-customs trucks)
    // are display-only: they must NOT participate in queue detection.
    expect(WEBCAM_FEEDS['00.3N'].cvDetect).toBe(false);
    expect(WEBCAM_FEEDS['00.3O'].cvDetect).toBe(false);
    expect(CROSSING_TO_FEEDS['chiasso-brogeda']).not.toContain('00.3N');
    expect(CROSSING_TO_FEEDS['chiasso-brogeda']).not.toContain('00.3O');
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

  it('new A2-corridor feeds (PR #2286) carry introducedAt for warmup gating', () => {
    // '07.2N' removed (issue #3372) — dead upstream feed, no replacement.
    for (const k of ['03.3S', '17.84S', '04.4N']) {
      expect(WEBCAM_FEEDS[k].introducedAt, `feed ${k}`).toBeDefined();
    }
  });

  it('pre-existing feeds have no introducedAt (they vote unconditionally)', () => {
    for (const k of ['01.2S', '00.3S', '00.3N', '00.3O', '02.0N', '06.8S']) {
      expect(WEBCAM_FEEDS[k].introducedAt, `feed ${k}`).toBeUndefined();
    }
  });
});

describe('envNumber (empty-string env guard for WARMUP_DAYS / QUEUE_VOTE_FRACTION)', () => {
  it('returns the fallback for an empty or whitespace-only string (the silent-disable bug)', () => {
    // The bug: Number('') === 0 and Number.isFinite(0) === true, so the old
    // `Number.isFinite(Number(process.env.X))` guard accepted '' as 0 →
    // WARMUP_DAYS=0 (warmup never active) / fraction=0 (vote floored to 1 =
    // any-one-camera regression). '' / '   ' must now fall back to the default.
    expect(envNumber('', 14)).toBe(14);
    expect(envNumber('   ', 14)).toBe(14);
    expect(envNumber('', 0.5)).toBe(0.5);
  });

  it('returns the fallback when the var is unset', () => {
    expect(envNumber(undefined, 14)).toBe(14);
    expect(envNumber(undefined, 0.5)).toBe(0.5);
  });

  it('returns the fallback for non-numeric strings', () => {
    expect(envNumber('abc', 14)).toBe(14);
  });

  it('parses a valid numeric string (trimming surrounding whitespace)', () => {
    expect(envNumber('7', 14)).toBe(7);
    expect(envNumber(' 0.75 ', 0.5)).toBe(0.75);
  });

  it('parses an explicit 0 at the env layer (range handling is the consumer guard, see below)', () => {
    expect(envNumber('0', 14)).toBe(0);
  });
});

describe('degenerate-but-finite env values fall back to the REAL default (non-circular guard)', () => {
  // Reviewer 🟡 (PR #2391/#2445): the in-range guards must NOT fall back to the
  // module constant (which IS the degenerate value when set via env) — they fall
  // back to the literal DEFAULT_* so e.g. WEBCAM_QUEUE_VOTE_FRACTION='0' or '-1'
  // does not collapse the majority vote to any-one-camera.
  it('queueVoteThreshold(0)/negative/>1 fraction → strict majority via 0.5 default, not 1 (any-one-camera)', () => {
    // 4 good feeds: a strict 0.5 majority needs 2; a degenerate fraction must NOT
    // floor to 1 (the old any-one-camera regression).
    expect(queueVoteThreshold(4, 0)).toBe(2);
    expect(queueVoteThreshold(4, -1)).toBe(2);
    expect(queueVoteThreshold(4, 1.5)).toBe(2);
    // A valid in-range fraction is honoured.
    expect(queueVoteThreshold(4, 0.75)).toBe(3);
  });

  it('isFeedWarmingUp with warmupDays<=0 → uses the 14-day default, warmup stays active', () => {
    const now = new Date('2026-06-20T00:00:00Z').getTime();
    // 4-day-old feed: with a degenerate warmupDays=0 it must still be considered
    // warming (falls back to 14), not trusted immediately.
    expect(isFeedWarmingUp({ introducedAt: '2026-06-16' }, now, 0)).toBe(true);
    expect(isFeedWarmingUp({ introducedAt: '2026-06-16' }, now, -5)).toBe(true);
  });
});
