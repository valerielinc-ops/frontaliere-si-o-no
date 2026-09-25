/**
 * Issue #5168 — the inert band: `noindex,follow` on the provably-dead tail of
 * the search-cluster surface.
 *
 * Context. `sitemap-search-clusters-001…008` carried 292 795 URLs on
 * 2026-08-05: 77,8 % of everything Google had indexed for the site, every one
 * of them served by Auto Ads, median 141 words, the same paragraph with a
 * query token swapped. A 90-day Search Console pull over the page dimension
 * put 286 958 of them (98,0 %) at ZERO impressions. That is the shape Google
 * policy calls scaled content abuse, and it was earning nothing to offset the
 * risk.
 *
 * What is under test is the GATE, not the number. The band is sized by one
 * field — `noindexMinAgeDays` in `data/url-pruning-approved-patterns.json` —
 * and the whole point of routing it through config is that widening it,
 * narrowing it or switching it off never touches this code. So these tests pin
 * the three properties that make that knob safe to turn:
 *
 *   1. it is OFF unless the pattern asks for it (no silent de-indexation),
 *   2. it never fires on a URL with evidence, from ANY source,
 *   3. it never fires on a URL too young to have taken part in the window the
 *      measurement covers — including the case where we simply do not know how
 *      old the URL is, which must not read as "old".
 *
 * (3) is the expensive direction and the one with no natural alarm: a page
 * wrongly left thin looks like a smaller page, while a page wrongly de-indexed
 * looks like nothing at all until the traffic is gone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import np from 'node:path';
import os from 'node:os';

import { TrafficEvidenceFilter } from '../build-plugins/shared/trafficEvidenceFilter';

const CLUSTER = 'gsc-keyword-landing';
const URL_PATH = '/cerca-lavoro-svizzera/ricerca-formazione-basel/';
const MIRROR = '/cerca-lavoro-ticino/ricerca-formazione-basel/';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

let tmpRoot: string;

/**
 * `noindexMinAgeDays: undefined` writes the pattern WITHOUT the field, which is
 * the pre-#5168 shape of the file and must stay a no-op.
 */
function writeData(opts: {
  noindexMinAgeDays?: number;
  minAgeDays?: number;
  firstSeen?: Record<string, string>;
  evidence?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): void {
  const dataDir = np.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const pattern: Record<string, unknown> = {
    id: 'zero-traffic-gsc-keyword-landing',
    urlClass: CLUSTER,
    action: 'thin',
    minAgeDays: opts.minAgeDays ?? 15,
  };
  if (opts.noindexMinAgeDays !== undefined) pattern.noindexMinAgeDays = opts.noindexMinAgeDays;
  fs.writeFileSync(
    np.join(dataDir, 'url-pruning-approved-patterns.json'),
    JSON.stringify({ version: 1, patterns: [pattern] }),
  );
  // The filter only activates with a non-empty traffic set, so every scenario
  // needs at least one unrelated path in evidence.
  fs.writeFileSync(
    np.join(dataDir, 'evidence-index.json'),
    JSON.stringify(opts.evidence ?? { gsc: { pages: { '/unrelated-page/': 42 } } }),
  );
  fs.writeFileSync(
    np.join(dataDir, 'url-first-seen.json'),
    JSON.stringify(opts.firstSeen ?? { [URL_PATH]: daysAgo(200) }),
  );
  for (const [name, value] of Object.entries(opts.extra ?? {})) {
    fs.writeFileSync(np.join(dataDir, name), JSON.stringify(value));
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(np.join(os.tmpdir(), 'traffic-evidence-inert-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('inert band — the threshold is the only thing that turns it on', () => {
  it('is inert when the pattern omits noindexMinAgeDays (pre-#5168 config)', () => {
    // The file shipped before #5168 has no such field. Reading it must not
    // start de-indexing 137 k URLs, so absence is OFF and not "default 0".
    writeData({});
    const d = new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER);
    expect(d.action).toBe('thin');
    expect(d.noindex).toBeUndefined();
  });

  it('is inert when the threshold is negative — the documented way to switch it off', () => {
    writeData({ noindexMinAgeDays: -1 });
    const d = new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER);
    expect(d.noindex).toBeUndefined();
  });

  it('marks a zero-evidence URL older than the threshold noindex', () => {
    writeData({ noindexMinAgeDays: 90, firstSeen: { [URL_PATH]: daysAgo(200) } });
    const d = new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER);
    expect(d.action).toBe('thin');
    expect(d.noindex).toBe(true);
    expect(d.noindexReason).toBe('inert-90d');
  });

  it('the threshold alone moves the band: 200-day-old URL in at 90, out at 365', () => {
    // The reversibility claim in the PR body reduced to a test. Same URL, same
    // evidence, same code — only the number in the JSON changes.
    writeData({ noindexMinAgeDays: 90, firstSeen: { [URL_PATH]: daysAgo(200) } });
    expect(new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER).noindex).toBe(true);

    writeData({ noindexMinAgeDays: 365, firstSeen: { [URL_PATH]: daysAgo(200) } });
    expect(new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER).noindex).toBeUndefined();
  });
});

describe('inert band — evidence always wins', () => {
  it('does not noindex a URL with GSC page impressions', () => {
    writeData({
      noindexMinAgeDays: 90,
      evidence: { gsc: { pages: { [URL_PATH]: 3 } } },
    });
    const d = new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER);
    expect(d.action).toBe('full');
    expect(d.reason).toBe('has-traffic');
    expect(d.noindex).toBeUndefined();
  });

  it('does not noindex a URL whose only evidence is GA4 sessions', () => {
    // Humans landing on the page is evidence even when Search Console is
    // silent — de-indexing it would throw away traffic we can see.
    writeData({
      noindexMinAgeDays: 90,
      evidence: { gsc: { pages: { '/unrelated-page/': 1 } }, ga4: { pages: { [URL_PATH]: { sessions: 4 } } } },
    });
    expect(new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER).noindex).toBeUndefined();
  });

  it('does not noindex a URL promoted by the hourly thin_page_view feedback loop', () => {
    writeData({
      noindexMinAgeDays: 90,
      extra: { 'thin-page-promotions-active.json': { urls: [URL_PATH] } },
    });
    expect(new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER).noindex).toBeUndefined();
  });

  it('does not noindex the canonical when only a legacy canton MIRROR has traffic', () => {
    // PR #743's lesson, carried into the new gate: GSC attributes cluster
    // traffic to `/cerca-lavoro-ticino/…`, not to the Svizzera canonical the
    // page was later promoted to. Judging the canonical alone would report
    // zero traffic for essentially every cluster that actually has some.
    writeData({
      noindexMinAgeDays: 90,
      evidence: { gsc: { pages: { [MIRROR]: 12 } } },
    });
    const d = new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH, MIRROR], CLUSTER, {
      primaryPath: URL_PATH,
    });
    expect(d.action).toBe('full');
    expect(d.noindex).toBeUndefined();
  });
});

describe('inert band — age is proved, never assumed', () => {
  it('does not noindex a URL younger than the threshold', () => {
    writeData({ noindexMinAgeDays: 90, firstSeen: { [URL_PATH]: daysAgo(40) } });
    const d = new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER);
    expect(d.action).toBe('thin');
    expect(d.noindex).toBeUndefined();
  });

  it('does not noindex a URL missing from url-first-seen.json', () => {
    // url-first-seen.json is populated lazily, so "absent" overwhelmingly
    // means the stamper has not caught up — not that the URL predates it. The
    // action-level grace window resolves absence the other way on purpose;
    // getting it wrong there costs a thinner page, getting it wrong here costs
    // an indexed one, so this branch must NOT copy that default.
    writeData({ noindexMinAgeDays: 90, firstSeen: { '/some-other-url/': daysAgo(400) } });
    const d = new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER);
    expect(d.action).toBe('thin');
    expect(d.noindex).toBeUndefined();
  });

  it('judges age on primaryPath, not on an older evidence probe', () => {
    // `decideMulti` receives mirrors and cross-locale probes so that evidence
    // found anywhere protects the cluster. Age is the opposite kind of
    // question: a sibling URL that has been live for a year says nothing about
    // how long THIS URL has been discoverable, and borrowing it would de-index
    // a two-week-old page on someone else's history.
    writeData({
      noindexMinAgeDays: 90,
      firstSeen: { [URL_PATH]: daysAgo(10), [MIRROR]: daysAgo(400) },
    });
    const d = new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH, MIRROR], CLUSTER, {
      primaryPath: URL_PATH,
    });
    expect(d.noindex).toBeUndefined();
  });

  it('respects the action-level grace window before considering the band at all', () => {
    // minAgeDays returns `full`; a `full` page is never a candidate for the
    // band, so a fresh URL cannot be both un-thinned and de-indexed.
    writeData({
      noindexMinAgeDays: 0,
      minAgeDays: 15,
      firstSeen: { [URL_PATH]: daysAgo(3) },
    });
    const d = new TrafficEvidenceFilter(tmpRoot).decideMulti([URL_PATH], CLUSTER);
    expect(d.action).toBe('full');
    expect(d.reason).toBe('grace');
    expect(d.noindex).toBeUndefined();
  });
});
