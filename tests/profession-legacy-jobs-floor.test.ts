/**
 * Legacy Ticino profession landings — the job floor (#5322).
 *
 * Until this fix the legacy TI family (`/lavoro-ticino-{role}/`) decided
 * indexability on `MIN_INDEXABLE_WORDS` alone — the word count of prose that
 * is templated per profession and therefore ALWAYS present. A profession with
 * zero live openings cleared that gate on every build, so pages titled
 * "Lavoro Cameriere Ticino — offerte e stipendio" shipped indexable, carrying
 * 0 JSON-LD JobPosting and body copy reading "nessuna offerta".
 *
 * These tests pin the three behaviours the fix has to have at once:
 *   1. below floor  → the shared noindex,follow bridge, at BOTH served paths
 *   2. above floor  → the full page, untouched
 *   3. hysteresis   → a profession whose live count dips to zero but that had
 *                     real openings inside the grace window stays indexed
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as np from 'node:path';

import {
  emitProfessionLandingPages,
} from '../build-plugins/professionLandingsPlugin';
import {
  MIN_JOBS,
  PROFESSION_FLOOR_GRACE_DAYS,
  meetsJobsFloor,
  renderProfessionBelowFloorBridge,
} from '../build-plugins/shared/professionJobsFloor';
import {
  _resetProfessionJobsAggregateCache,
  aggregateRecentlyExpiredProfessionCounts,
} from '../build-plugins/professionJobsAggregate';
import {
  PROFESSION_LOCALES,
  buildProfessionLandingPath,
} from '../build-plugins/professionLandingsData';

const NOW = Date.parse('2026-08-08T00:00:00.000Z');
const DAY = 86_400_000;

/** A TI job whose title matches the `infermiere` matcher. */
function tiNurse(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `job-${n}`,
    slug: `infermiere-ticino-${n}`,
    title: `Infermiere SSS ${n}`,
    company: `Clinica ${n}`,
    canton: 'TI',
    location: 'Lugano',
    addressLocality: 'Lugano',
    postedDate: new Date(NOW - 3 * DAY).toISOString(),
    ...extra,
  };
}

/** A TI job whose title matches the `cameriere` matcher. */
function tiWaiter(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `w-${n}`,
    slug: `cameriere-ticino-${n}`,
    title: `Cameriere di sala ${n}`,
    company: `Ristorante ${n}`,
    canton: 'TI',
    location: 'Lugano',
    addressLocality: 'Lugano',
    postedDate: new Date(NOW - 3 * DAY).toISOString(),
    ...extra,
  };
}

function makeRoot(jobs: unknown[], expired: unknown[] | null): string {
  const tmp = fs.mkdtempSync(np.join(os.tmpdir(), 'proflegacy-floor-'));
  fs.mkdirSync(np.join(tmp, 'data'), { recursive: true });
  fs.writeFileSync(np.join(tmp, 'data', 'jobs.json'), JSON.stringify(jobs), 'utf-8');
  if (expired !== null) {
    fs.writeFileSync(np.join(tmp, 'data', 'expired-jobs.json'), JSON.stringify(expired), 'utf-8');
  }
  fs.mkdirSync(np.join(tmp, 'dist'), { recursive: true });
  return tmp;
}

/**
 * An indexable page carries the enhanced directive
 * (`index, follow, max-snippet:-1, …` — ROBOTS_INDEX_ENHANCED_CONTENT), which
 * `normalizeRobotsDirective` upgrades the plugin's plain `index,follow` into at
 * the single emission point. Matching the literal the plugin passes in would
 * pass for the wrong reason.
 *
 * The attribute-name quoting is deliberately optional: full landings go through
 * the HTML minifier (`name=robots`) while the bridge template does not
 * (`name="robots"`), and the assertion has to hold for whichever one it is
 * handed.
 */
const ROBOTS_META_RE = (value: string) =>
  new RegExp(`name=["']?robots["']?\\s+content=\\\\?["']${value}`);

function expectIndexable(html: string | null): void {
  expect(html).not.toBeNull();
  expect(html!).toMatch(ROBOTS_META_RE('index, follow'));
  expect(html!).not.toContain('noindex');
}

function readEmitted(distDir: string, locale: 'it' | 'en' | 'de' | 'fr', id: string) {
  const urlPath = buildProfessionLandingPath(locale, id as never);
  const indexHtml = np.join(distDir, urlPath, 'index.html');
  const flatHtml = np.join(distDir, urlPath.replace(/\/+$/, '') + '.html');
  return {
    index: fs.existsSync(indexHtml) ? fs.readFileSync(indexHtml, 'utf-8') : null,
    flat: fs.existsSync(flatHtml) ? fs.readFileSync(flatHtml, 'utf-8') : null,
  };
}

describe('meetsJobsFloor — the shared predicate', () => {
  it('uses the same MIN_JOBS the per-canton family has always used', () => {
    expect(MIN_JOBS).toBe(3);
  });

  it('counts live + recently-expired against the floor', () => {
    expect(meetsJobsFloor({ liveCount: 3, recentlyExpiredCount: 0 }).meetsFloor).toBe(true);
    expect(meetsJobsFloor({ liveCount: 0, recentlyExpiredCount: 3 }).meetsFloor).toBe(true);
    expect(meetsJobsFloor({ liveCount: 1, recentlyExpiredCount: 2 }).meetsFloor).toBe(true);
    expect(meetsJobsFloor({ liveCount: 1, recentlyExpiredCount: 1 }).meetsFloor).toBe(false);
    expect(meetsJobsFloor({ liveCount: 2, recentlyExpiredCount: 0 }).effectiveCount).toBe(2);
  });

  it('defaults to no grace, so the per-canton family keeps its exact behaviour', () => {
    // professionCantonLandings.ts calls this with liveCount only.
    expect(meetsJobsFloor({ liveCount: 2 }).meetsFloor).toBe(false);
    expect(meetsJobsFloor({ liveCount: 3 }).meetsFloor).toBe(true);
  });

  it('FAILS OPEN when the grace signal is unavailable, never flipping on a missing file', () => {
    // A build that cannot read data/expired-jobs.json knows nothing about
    // persistence, and wrongly noindexing a ranking page costs far more than
    // one extra build of a thin one.
    const verdict = meetsJobsFloor({ liveCount: 0, recentlyExpiredCount: null });
    expect(verdict.meetsFloor).toBe(true);
    expect(verdict.graceUnavailable).toBe(true);
  });
});

describe('aggregateRecentlyExpiredProfessionCounts — the grace signal', () => {
  it('counts TI jobs that expired inside the window and ignores older ones', () => {
    const expired = [
      { ...tiNurse(1), expiredAt: new Date(NOW - 2 * DAY).toISOString() },
      { ...tiNurse(2), expiredAt: new Date(NOW - 29 * DAY).toISOString() },
      // Outside the 30-day window — must not count.
      { ...tiNurse(3), expiredAt: new Date(NOW - 45 * DAY).toISOString() },
    ];
    const tmp = makeRoot([], expired);
    try {
      const counts = aggregateRecentlyExpiredProfessionCounts(tmp, PROFESSION_FLOOR_GRACE_DAYS, NOW);
      expect(counts).not.toBeNull();
      expect(counts!.infermiere).toBe(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ignores non-TI expired jobs — the legacy family is Ticino-only', () => {
    const expired = [
      { ...tiNurse(1), canton: 'ZH', location: 'Zurigo', addressLocality: 'Zurigo', expiredAt: new Date(NOW - DAY).toISOString() },
    ];
    const tmp = makeRoot([], expired);
    try {
      const counts = aggregateRecentlyExpiredProfessionCounts(tmp, PROFESSION_FLOOR_GRACE_DAYS, NOW);
      expect(counts!.infermiere).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns null (not an empty tally) when the archive is missing or corrupt', () => {
    const missing = makeRoot([], null);
    try {
      expect(aggregateRecentlyExpiredProfessionCounts(missing, 30, NOW)).toBeNull();
    } finally {
      fs.rmSync(missing, { recursive: true, force: true });
    }

    const corrupt = fs.mkdtempSync(np.join(os.tmpdir(), 'proflegacy-corrupt-'));
    try {
      fs.mkdirSync(np.join(corrupt, 'data'), { recursive: true });
      fs.writeFileSync(np.join(corrupt, 'data', 'expired-jobs.json'), '{not json', 'utf-8');
      expect(aggregateRecentlyExpiredProfessionCounts(corrupt, 30, NOW)).toBeNull();
    } finally {
      fs.rmSync(corrupt, { recursive: true, force: true });
    }
  });
});

describe('emitProfessionLandingPages — below floor emits the shared bridge', () => {
  it('bridges a zero-opening profession to noindex,follow at BOTH served paths', async () => {
    _resetProfessionJobsAggregateCache();
    // 4 nurses keep `infermiere` above floor; `cameriere` has nothing, live or
    // recently expired — the /lavoro-ticino-cameriere/ case from the issue.
    const tmp = makeRoot([tiNurse(1), tiNurse(2), tiNurse(3), tiNurse(4)], []);
    try {
      const distDir = np.join(tmp, 'dist');
      const res = await emitProfessionLandingPages({ rootDir: tmp, distDir, now: NOW });

      expect(res.professionsBelowFloor).toContain('cameriere');
      expect(res.graceUnavailable).toBe(false);

      for (const locale of PROFESSION_LOCALES) {
        const { index, flat } = readEmitted(distDir, locale, 'cameriere');
        // Both the directory index and the flat sibling must be bridged —
        // bridging one would leave the full page live at the other URL.
        expect(index).not.toBeNull();
        expect(flat).not.toBeNull();
        for (const html of [index!, flat!]) {
          expect(html).toContain('<meta name="robots" content="noindex,follow">');
          // …and it is the SHARED bridge, byte-for-byte.
          expect(html).toBe(renderProfessionBelowFloorBridge(locale, 'TI', 'cameriere'));
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      _resetProfessionJobsAggregateCache();
    }
  });

  it('keeps a bridged profession out of the sitemap', async () => {
    _resetProfessionJobsAggregateCache();
    const tmp = makeRoot([tiNurse(1), tiNurse(2), tiNurse(3), tiNurse(4)], []);
    try {
      const distDir = np.join(tmp, 'dist');
      await emitProfessionLandingPages({ rootDir: tmp, distDir, now: NOW });
      const xml = fs.readFileSync(np.join(distDir, 'sitemap-professions.xml'), 'utf-8');
      expect(xml).not.toContain('/lavoro-ticino-cameriere/');
      // The above-floor profession is still advertised.
      expect(xml).toContain('/lavoro-ticino-infermiere/');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      _resetProfessionJobsAggregateCache();
    }
  });
});

describe('emitProfessionLandingPages — above floor is untouched', () => {
  it('emits the full indexable page when the profession clears MIN_JOBS on live count alone', async () => {
    _resetProfessionJobsAggregateCache();
    const tmp = makeRoot([tiNurse(1), tiNurse(2), tiNurse(3)], []);
    try {
      const distDir = np.join(tmp, 'dist');
      const res = await emitProfessionLandingPages({ rootDir: tmp, distDir, now: NOW });

      expect(res.professionsBelowFloor).not.toContain('infermiere');
      const { index, flat } = readEmitted(distDir, 'it', 'infermiere');
      expectIndexable(index);
      // The full page, not the bridge: real employer names from the corpus.
      expect(index).toContain('Clinica 1');
      expect(flat).toBe(index);
      expect(res.pagesWritten).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      _resetProfessionJobsAggregateCache();
    }
  });
});

describe('emitProfessionLandingPages — hysteresis', () => {
  it('does NOT flip a page whose live count dipped to zero this build alone', async () => {
    _resetProfessionJobsAggregateCache();
    // The transient the fix must survive: a crawler fails one round, so every
    // `cameriere` posting drops out of jobs.json. They are in the expired
    // archive with a recent `expiredAt`, so the page stays indexed.
    const expired = [1, 2, 3].map((n) => ({
      ...tiWaiter(n),
      expiredAt: new Date(NOW - 2 * DAY).toISOString(),
    }));
    const tmp = makeRoot([tiNurse(1), tiNurse(2), tiNurse(3)], expired);
    try {
      const distDir = np.join(tmp, 'dist');
      const res = await emitProfessionLandingPages({ rootDir: tmp, distDir, now: NOW });

      expect(res.professionsBelowFloor).not.toContain('cameriere');
      const { index } = readEmitted(distDir, 'it', 'cameriere');
      expectIndexable(index);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      _resetProfessionJobsAggregateCache();
    }
  });

  it('DOES flip once the dip has outlasted the grace window', async () => {
    _resetProfessionJobsAggregateCache();
    // Same three postings, but they expired 40 days ago: the profession has
    // been empty for longer than the window, so it is genuinely empty.
    const expired = [1, 2, 3].map((n) => ({
      ...tiWaiter(n),
      expiredAt: new Date(NOW - 40 * DAY).toISOString(),
    }));
    const tmp = makeRoot([tiNurse(1), tiNurse(2), tiNurse(3)], expired);
    try {
      const distDir = np.join(tmp, 'dist');
      const res = await emitProfessionLandingPages({ rootDir: tmp, distDir, now: NOW });

      expect(res.professionsBelowFloor).toContain('cameriere');
      const { index } = readEmitted(distDir, 'it', 'cameriere');
      expect(index).toContain('noindex,follow');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      _resetProfessionJobsAggregateCache();
    }
  });

  it('flips NOTHING when the expired archive is unreadable, however empty the live set is', async () => {
    _resetProfessionJobsAggregateCache();
    // No expired-jobs.json at all → grace signal null → fail open. Without
    // this, a build that merely lost the archive would noindex the whole
    // family in one go.
    const tmp = makeRoot([tiNurse(1), tiNurse(2), tiNurse(3)], null);
    try {
      const distDir = np.join(tmp, 'dist');
      const res = await emitProfessionLandingPages({ rootDir: tmp, distDir, now: NOW });

      expect(res.graceUnavailable).toBe(true);
      expect(res.professionsBelowFloor).toEqual([]);
      expect(res.bridgesWritten).toBe(0);
      const { index } = readEmitted(distDir, 'it', 'cameriere');
      expect(index).not.toContain('noindex');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      _resetProfessionJobsAggregateCache();
    }
  });
});
