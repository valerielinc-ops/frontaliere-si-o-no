/**
 * hasTrafficEvidence: keep-if-trafficked answer from traffic-set membership
 * alone. Guards the expired-job prose gate (jobsSeoPagesPlugin __slKeepProse):
 * `decideMulti(...).reason === 'has-traffic'` is never true for a class with
 * no approved pattern (soft-landing-expired has none), which stripped the
 * frontalier prose from trafficked expired pages and pushed short ones under
 * MIN_INDEXABLE_WORDS -> noindex.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import np from 'node:path';
import os from 'node:os';

import { TrafficEvidenceFilter } from '../build-plugins/shared/trafficEvidenceFilter';

const SOFT_LANDING = 'soft-landing-expired';
const TRAFFICKED = '/cerca-lavoro-ticino/responsabile-logistica-orior-stabio/';
const SILENT = '/cerca-lavoro-ticino/nessun-traffico-qui/';

let tmpRoot: string;

function write(patterns: unknown[], gscPages: Record<string, number>): void {
  const dataDir = np.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    np.join(dataDir, 'url-pruning-approved-patterns.json'),
    JSON.stringify({ version: 1, patterns }),
  );
  fs.writeFileSync(
    np.join(dataDir, 'evidence-index.json'),
    JSON.stringify({ gsc: { pages: gscPages } }),
  );
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(np.join(os.tmpdir(), 'traffic-evidence-has-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('TrafficEvidenceFilter.hasTrafficEvidence', () => {
  const OTHER_PATTERN = [{ id: 'gsc-keyword-landing-thin', urlClass: 'gsc-keyword-landing', action: 'thin' }];

  it('is true for a class with NO approved pattern while decideMulti reports no-pattern', () => {
    write(OTHER_PATTERN, { [TRAFFICKED]: 370 });
    const f = new TrafficEvidenceFilter(tmpRoot);
    expect(f.decideMulti([TRAFFICKED], SOFT_LANDING).reason).toBe('no-pattern');
    expect(f.hasTrafficEvidence([TRAFFICKED])).toBe(true);
  });

  it('is false for a path without traffic (strip stays in force)', () => {
    write(OTHER_PATTERN, { [TRAFFICKED]: 370 });
    const f = new TrafficEvidenceFilter(tmpRoot);
    expect(f.hasTrafficEvidence([SILENT])).toBe(false);
    expect(f.hasTrafficEvidence([])).toBe(false);
  });

  it('matches ANY candidate path, normalising slash form like decideMulti', () => {
    write(OTHER_PATTERN, { [TRAFFICKED]: 5 });
    const f = new TrafficEvidenceFilter(tmpRoot);
    expect(f.hasTrafficEvidence([SILENT, TRAFFICKED.replace(/\/$/, '')])).toBe(true);
  });

  it('dormant filter (no patterns): loaded traffic is still positive evidence', () => {
    write([], { [TRAFFICKED]: 5 });
    const f = new TrafficEvidenceFilter(tmpRoot);
    expect(f.decideMulti([TRAFFICKED], SOFT_LANDING).reason).toBe('filter-dormant');
    expect(f.hasTrafficEvidence([TRAFFICKED])).toBe(true);
    expect(f.hasTrafficEvidence([SILENT])).toBe(false);
  });

  it('released filter: set is cleared, answer is false (no evidence, not proof of zero)', () => {
    write(OTHER_PATTERN, { [TRAFFICKED]: 5 });
    const f = new TrafficEvidenceFilter(tmpRoot);
    f.releaseRetainedEvidence();
    expect(f.hasTrafficEvidence([TRAFFICKED])).toBe(false);
  });

  it('does not change decideMulti for a class with a pattern', () => {
    write([{ id: 'p', urlClass: SOFT_LANDING, action: 'thin' }], { [TRAFFICKED]: 5 });
    const f = new TrafficEvidenceFilter(tmpRoot);
    expect(f.decideMulti([TRAFFICKED], SOFT_LANDING).reason).toBe('has-traffic');
    expect(f.decideMulti([SILENT], SOFT_LANDING).action).toBe('thin');
  });
});

describe('expired-job prose wiring', () => {
  it('jobsSeoPagesPlugin derives __slKeepProse from hasTrafficEvidence, not decideMulti reason', () => {
    const src = fs.readFileSync(np.join(__dirname, '../build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
    expect(src).toMatch(/const __slKeepProse = trafficFilter\.hasTrafficEvidence\(__slProsePaths\);/);
    expect(src).not.toMatch(/decideMulti\(__slProsePaths/);
  });
});
