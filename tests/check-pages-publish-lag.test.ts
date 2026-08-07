/**
 * Unit tests for the pure decision logic in
 * scripts/check-pages-publish-lag.mjs (the Pages publish-lag watchdog).
 *
 * No network and no IO for parsePathsIgnore/globToRegExp/isIgnoredPath/
 * filterUnignored: exercised through injected fixtures. The parsePathsIgnore
 * test also reads the REAL deploy.yml so the two never drift apart silently.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parsePathsIgnore,
  globToRegExp,
  isIgnoredPath,
  filterUnignored,
  evaluatePublishLag,
  // @ts-expect-error — plain .mjs, no type declarations
} from '../scripts/check-pages-publish-lag.mjs';

describe('parsePathsIgnore', () => {
  it('extracts a flat glob list under paths-ignore:', () => {
    const yaml = [
      'on:',
      '  push:',
      '    branches:',
      '      - main',
      '    paths-ignore:',
      "      - 'data/border-wait-current.json'",
      "      - 'docs/**'",
      '    workflow_dispatch:',
    ].join('\n');
    expect(parsePathsIgnore(yaml)).toEqual(['data/border-wait-current.json', 'docs/**']);
  });

  it('returns an empty array when the key is absent', () => {
    expect(parsePathsIgnore('on:\n  push:\n    branches:\n      - main\n')).toEqual([]);
  });

  it('reads the real deploy.yml and includes the known-ignored paths', () => {
    const deployYmlPath = path.resolve(__dirname, '../.github/workflows/deploy.yml');
    const globs = parsePathsIgnore(fs.readFileSync(deployYmlPath, 'utf8'));
    expect(globs).toEqual(
      expect.arrayContaining(['data/weather-snapshot.json', 'docs/**', '.github/**', 'tests/**', '.claude/**']),
    );
  });
});

describe('globToRegExp / isIgnoredPath', () => {
  it('matches a literal path exactly', () => {
    expect(globToRegExp('data/weather-snapshot.json').test('data/weather-snapshot.json')).toBe(true);
    expect(globToRegExp('data/weather-snapshot.json').test('data/weather-snapshot2.json')).toBe(false);
  });

  it('`**` crosses directory boundaries', () => {
    const re = globToRegExp('docs/**');
    expect(re.test('docs/a.md')).toBe(true);
    expect(re.test('docs/nested/b.md')).toBe(true);
    expect(re.test('other/docs/a.md')).toBe(false);
  });

  it('a bare `*.md` matches only at the root, not nested paths', () => {
    const re = globToRegExp('*.md');
    expect(re.test('README.md')).toBe(true);
    expect(re.test('public/press-kit/README.md')).toBe(false);
  });

  it('isIgnoredPath is true if any glob in the list matches', () => {
    const globs = ['data/weather-snapshot.json', 'docs/**'];
    expect(isIgnoredPath('docs/CI-CD-PIPELINE.md', globs)).toBe(true);
    expect(isIgnoredPath('data/jobs.json', globs)).toBe(false);
  });
});

describe('filterUnignored', () => {
  it('keeps only dist-affecting files', () => {
    const globs = ['data/weather-snapshot.json', 'docs/**', '*.md'];
    const changed = ['data/weather-snapshot.json', 'docs/GITNEXUS.md', 'README.md', 'data/blog-articles/foo.json'];
    expect(filterUnignored(changed, globs)).toEqual(['data/blog-articles/foo.json']);
  });

  it('returns an empty array when every changed file is ignored', () => {
    const globs = ['data/weather-snapshot.json'];
    expect(filterUnignored(['data/weather-snapshot.json'], globs)).toEqual([]);
  });

  it('returns everything unfiltered when there are no globs', () => {
    expect(filterUnignored(['a.ts', 'b.ts'], [])).toEqual(['a.ts', 'b.ts']);
  });
});

/**
 * These pin the CRITERION, not just the current numbers: the threshold must
 * sit ABOVE the system's worst legitimate merge→live latency, so a normally
 * serialized pipeline never pages. See the DEFAULT_LAG_HOURS comment in
 * scripts/check-pages-publish-lag.mjs for the measurements these encode.
 *
 * Both directions, always: a latency inside the normal envelope must NOT
 * alarm, one outside it MUST. A test that only checks the firing direction
 * would stay green for a threshold of zero.
 */
describe('evaluatePublishLag — age signal', () => {
  const LAG_HOURS = 9; // must track DEFAULT_LAG_HOURS
  // Measured worst legitimate merge→live: build queue+exec max 276 min,
  // + one superseded-publish penalty of one build cycle (166 min), + ~15 min
  // publish tail ≈ 457 min. A build in flight keeps the queue signal quiet.
  const MOVING = { buildInFlight: true, buildIdleMinutes: 0 };

  it('does NOT alarm at the worst LEGITIMATE latency (457 min ≈ 7.6h)', () => {
    expect(evaluatePublishLag({ ageMinutes: 457, pendingCount: 5, lagHours: LAG_HOURS, ...MOVING })).toEqual({
      degraded: false,
      reason: null,
    });
  });

  it('does NOT alarm at the historical false-alarm peaks (250-306 min), which all self-resolved', () => {
    for (const ageMinutes of [250, 252, 255, 258, 264, 273, 306]) {
      expect(evaluatePublishLag({ ageMinutes, pendingCount: 3, lagHours: LAG_HOURS, ...MOVING }).degraded).toBe(false);
    }
  });

  it('DOES alarm past the threshold, and on every historical real stall', () => {
    expect(evaluatePublishLag({ ageMinutes: 541, pendingCount: 1, lagHours: LAG_HOURS, ...MOVING })).toEqual({
      degraded: true,
      reason: 'lag',
    });
    // Peaks of the episodes that were genuine multi-hour stalls.
    for (const ageMinutes of [676, 1013, 1105, 1745, 4001]) {
      expect(evaluatePublishLag({ ageMinutes, pendingCount: 1, lagHours: LAG_HOURS, ...MOVING }).degraded).toBe(true);
    }
  });

  it('is strictly greater-than: exactly at the threshold is still healthy', () => {
    expect(evaluatePublishLag({ ageMinutes: 540, pendingCount: 1, lagHours: LAG_HOURS, ...MOVING }).degraded).toBe(false);
    expect(evaluatePublishLag({ ageMinutes: 541, pendingCount: 1, lagHours: LAG_HOURS, ...MOVING }).degraded).toBe(true);
  });

  it('never alarms with nothing pending, however old the last publish is', () => {
    // A quiet main is not a fault: no content is waiting, so a large age and a
    // silent build queue are both the correct state.
    expect(
      evaluatePublishLag({
        ageMinutes: 10_000,
        pendingCount: 0,
        lagHours: LAG_HOURS,
        buildInFlight: false,
        buildIdleMinutes: 9_000,
      }),
    ).toEqual({ degraded: false, reason: null });
  });
});

describe('evaluatePublishLag — stalled-queue signal', () => {
  const LAG_HOURS = 9;
  const young = { ageMinutes: 60, pendingCount: 4, lagHours: LAG_HOURS, stalledQueueMinutes: 240 };

  it('alarms when content is pending and the build queue has gone silent', () => {
    // This is the compensation for the tolerant age threshold: a STOPPED
    // pipeline is caught at ~4h of build silence, not at 9h of content age.
    expect(evaluatePublishLag({ ...young, buildInFlight: false, buildIdleMinutes: 241 })).toEqual({
      degraded: true,
      reason: 'stalled-queue',
    });
  });

  it('does NOT alarm while a build is in flight, however long it has been running', () => {
    // A build legitimately holds the pages-build-run slot for ~2h; during that
    // time nothing else is created and timestamps stop advancing.
    expect(evaluatePublishLag({ ...young, buildInFlight: true, buildIdleMinutes: 900 }).degraded).toBe(false);
  });

  it('does NOT alarm on build silence still inside the normal cadence', () => {
    // Build runs are created ~10 min apart at the median, p99 201 min.
    expect(evaluatePublishLag({ ...young, buildInFlight: false, buildIdleMinutes: 201 }).degraded).toBe(false);
  });

  it('is disabled, not fired, when the build history is unreadable (fail open)', () => {
    // null = the deploy.yml runs API errored. An indeterminate read must not
    // page — but it must not suppress the age signal either.
    expect(evaluatePublishLag({ ...young, buildInFlight: false, buildIdleMinutes: null }).degraded).toBe(false);
    expect(
      evaluatePublishLag({ ...young, ageMinutes: 600, buildInFlight: false, buildIdleMinutes: null }),
    ).toEqual({ degraded: true, reason: 'lag' });
  });

  it('reports the age reason when both signals would fire', () => {
    expect(
      evaluatePublishLag({ ...young, ageMinutes: 600, buildInFlight: false, buildIdleMinutes: 500 }),
    ).toEqual({ degraded: true, reason: 'lag' });
  });
});
