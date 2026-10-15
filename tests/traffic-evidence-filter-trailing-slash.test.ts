/**
 * Regression test for trailing-slash reconciliation in the
 * TrafficEvidenceFilter has-traffic lookup.
 *
 * Background (follow-up #2431 / PR #2397). The expired soft-landing builder
 * emits the legacy IT mirror WITHOUT a trailing slash
 * (`/cerca-lavoro-ticino/SLUG`), while several GSC traffic sources store the
 * same URL WITH a trailing slash (`/cerca-lavoro-ticino/SLUG/`) — and the
 * orphan-slug source builds its paths with a trailing slash on purpose.
 * The end-to-end match relies on `normalizePath` collapsing both forms to a
 * single representation BEFORE building the traffic-set and BEFORE the
 * `decideMulti` lookup. The reviewer flagged that this reconciliation was
 * never exercised by a test: if it silently broke, `decideMulti` would
 * report zero traffic for genuinely-trafficked mirror pages → AdSense
 * stripped from real-traffic pages (`__slKeepProse = false`).
 *
 * This guards the invariant from BOTH directions and across EVERY GSC
 * source that can store the slash differently from the builder's emit form:
 *   - source stores `/path/` (trailing) ↔ candidate `/path` (no trailing)
 *   - source stores `/path`  (no trailing) ↔ candidate `/path/` (trailing)
 *   - orphan-slug source (builds `/cerca-lavoro-ticino/${slug}/`)
 *   - gsc-job-urls absolute `https://www.host/path/` form
 * A negative control proves the gate still thins genuinely zero-traffic URLs
 * (so a match isn't passing vacuously).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import np from 'node:path';
import os from 'node:os';

import { TrafficEvidenceFilter } from '../build-plugins/shared/trafficEvidenceFilter';

const SOFT_LANDING = 'soft-landing-expired';

// Approved patterns: the soft-landing-expired class is thin-eligible, so a
// path that does NOT reconcile against the traffic set falls through to
// 'thin' — exactly the failure mode we are guarding against.
const APPROVED = {
  version: 1,
  patterns: [
    { id: 'zero-traffic-soft-landing-expired', urlClass: SOFT_LANDING, action: 'thin' },
  ],
};

let tmpRoot: string;

function writeData(files: Record<string, unknown>): void {
  const dataDir = np.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    np.join(dataDir, 'url-pruning-approved-patterns.json'),
    JSON.stringify(APPROVED),
  );
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(np.join(dataDir, name), JSON.stringify(value));
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(np.join(os.tmpdir(), 'traffic-evidence-slash-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('TrafficEvidenceFilter — trailing-slash reconciliation', () => {
  it('matches a no-slash candidate against a GSC source stored WITH a trailing slash', () => {
    // GSC page-level impression set stores `/path/`; builder emits `/path`.
    writeData({
      'evidence-index.json': {
        gsc: { pages: { '/cerca-lavoro-ticino/saldatore-mendrisio/': 7 } },
      },
    });
    const filter = new TrafficEvidenceFilter(tmpRoot);
    const decision = filter.decideMulti(
      ['/cerca-lavoro-ticino/saldatore-mendrisio'],
      SOFT_LANDING,
    );
    expect(decision.action).toBe('full');
    expect(decision.reason).toBe('has-traffic');
  });

  it('matches a trailing-slash candidate against a GSC source stored WITHOUT a trailing slash', () => {
    // Reverse direction: source `/path`, builder candidate `/path/`.
    writeData({
      'evidence-index.json': {
        gsc: { pages: { '/cerca-lavoro-ticino/saldatore-mendrisio': 7 } },
      },
    });
    const filter = new TrafficEvidenceFilter(tmpRoot);
    const decision = filter.decideMulti(
      ['/cerca-lavoro-ticino/saldatore-mendrisio/'],
      SOFT_LANDING,
    );
    expect(decision.action).toBe('full');
    expect(decision.reason).toBe('has-traffic');
  });

  it('matches the orphan-slug source (built with a trailing slash) against the no-slash mirror emit', () => {
    // gsc-orphan-job-slugs.json is the legacy IT mirror signal: the filter
    // synthesises `/cerca-lavoro-ticino/${slug}/` (trailing slash) while the
    // soft-landing builder emits the mirror without one.
    writeData({
      'gsc-orphan-job-slugs.json': ['fresatore-cnc-lugano'],
    });
    const filter = new TrafficEvidenceFilter(tmpRoot);
    const decision = filter.decideMulti(
      ['/cerca-lavoro-ticino/fresatore-cnc-lugano'],
      SOFT_LANDING,
    );
    expect(decision.action).toBe('full');
    expect(decision.reason).toBe('has-traffic');
  });

  it('matches an absolute www gsc-job-urls entry (trailing slash) against the path-only no-slash candidate', () => {
    writeData({
      'gsc-job-urls.json': [
        'https://www.frontaliereticino.ch/cerca-lavoro-ticino/elettricista-chiasso/',
      ],
    });
    const filter = new TrafficEvidenceFilter(tmpRoot);
    const decision = filter.decideMulti(
      ['/cerca-lavoro-ticino/elettricista-chiasso'],
      SOFT_LANDING,
    );
    expect(decision.action).toBe('full');
    expect(decision.reason).toBe('has-traffic');
  });

  it('negative control: a URL absent from every source (in either slash form) is still thinned', () => {
    writeData({
      'evidence-index.json': {
        gsc: { pages: { '/cerca-lavoro-ticino/some-other-job/': 7 } },
      },
    });
    const filter = new TrafficEvidenceFilter(tmpRoot);
    const decision = filter.decideMulti(
      ['/cerca-lavoro-ticino/zero-traffic-slug'],
      SOFT_LANDING,
    );
    expect(decision.action).toBe('thin');
    expect(decision.reason).toBe('zero-traffic-soft-landing-expired');
  });
});
