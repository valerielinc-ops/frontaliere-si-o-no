import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadJobPopularity,
  JOB_POPULARITY_DATA_URL,
  EMPTY_JOB_POPULARITY,
  __resetJobPopularityCache,
} from '../services/jobPopularityService';
import {
  adminDataPlugin,
  COPIED_DATA_FILES,
  EXPERIMENTAL_CANDIDATE_FEED_FILE_PATH,
  JOB_POPULARITY_MIN_VIEWS,
  projectExperimentalCandidateFeed,
  trimJobPopularity,
} from '../build-plugins/adminDataPlugin';

// Issue #5001 — /cerca-lavoro-ticino/ measured Lighthouse mobile perf 0.03, the
// worst template on the site. Cause: components/community/JobBoard.tsx STATICALLY
// imported data/job-popularity.json, so Rollup inlined the map into the JobBoard
// chunk (measured on prod 2026-08-07: 3,598,764 B of a 4,103,109 B chunk = 88%,
// 812 KB transferred) — and build-plugins/staticPagesPlugin.ts modulepreloads
// that chunk at high priority from the page's static shell.
//
// These tests pin the three halves of the fix so it cannot silently regress:
//   1. no static JSON import in JobBoard.tsx (the bundle-size invariant),
//   2. the file is copied to dist/data/ so the runtime fetch has a target,
//   3. the loader is fail-soft and cached.

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://cdn.frontaliereticino.ch';

function setBase(v: string | undefined): void {
  if (v === undefined) {
    delete (window as unknown as { __CDN_DATA_BASE__?: string }).__CDN_DATA_BASE__;
  } else {
    (window as unknown as { __CDN_DATA_BASE__?: string }).__CDN_DATA_BASE__ = v;
  }
}

describe('the runtime copy of job-popularity is trimmed', () => {
  it('drops single-view entries and keeps everything that can rank', () => {
    const trimmed = JSON.parse(trimJobPopularity(JSON.stringify({ a: 1, b: 2, c: 40 })));
    expect(trimmed).toEqual({ b: 2, c: 40 });
    expect(JOB_POPULARITY_MIN_VIEWS).toBe(2);
  });

  it('leaves a non-numeric value for the loader sanitizer to judge', () => {
    expect(JSON.parse(trimJobPopularity('{"a":"x"}'))).toEqual({ a: 'x' });
  });

  it('never rewrites a payload of another shape', () => {
    expect(trimJobPopularity('[1,2]')).toBe('[1,2]');
  });
});

describe('job-popularity is not bundled into the JobBoard chunk', () => {
  it('JobBoard.tsx has no static import of data/job-popularity.json', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/community/JobBoard.tsx'), 'utf8');
    // A static `import x from '…/job-popularity.json'` is what Rollup inlines.
    // Matching the import STATEMENT (not the bare filename) keeps the comment
    // that explains the ban from tripping this assertion.
    expect(src).not.toMatch(/^\s*import\s+[^;]*from\s+['"][^'"]*job-popularity\.json['"]/m);
  });

  it('JobBoard.tsx goes through the runtime loader instead', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/community/JobBoard.tsx'), 'utf8');
    expect(src).toMatch(/from\s+['"]@\/services\/jobPopularityService['"]/);
  });

  it('no other client module statically imports the map either', () => {
    // A static import anywhere under components/ or services/ puts the map back
    // into a shipped chunk — the exact regression this PR removes.
    const dirs = ['components', 'services', 'hooks'];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        let src: string;
        try {
          src = fs.readFileSync(p, 'utf8');
        } catch (error) {
          // Sparse agent worktrees can contain a tracked source symlink whose
          // target is intentionally outside the sparse checkout. Full CI
          // checkouts still scan that target; ordinary unreadable files fail.
          if ((error as { code?: string }).code === 'ENOENT' && fs.lstatSync(p).isSymbolicLink()) continue;
          throw error;
        }
        if (/^\s*import\s+[^;]*from\s+['"][^'"]*job-popularity\.json['"]/m.test(src)) {
          offenders.push(path.relative(ROOT, p));
        }
      }
    };
    for (const d of dirs) walk(path.join(ROOT, d));
    expect(offenders).toEqual([]);
  });

  it('starts the runtime fetch only after board interaction and near the recommendation section', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/community/JobBoard.tsx'), 'utf8');
    // The comment is deliberately asserted too: moving this request back to
    // mount-time idle reintroduces the 600 KB catalog into mobile startup.
    expect(src).toContain('Popularity only changes the below-fold recommendation order.');
    const updatedEffectStart = src.indexOf('Popularity only changes the below-fold recommendation order.');
    const updatedEffectEnd = src.indexOf('// Keep one previous-visit boundary stable', updatedEffectStart);
    const updatedEffect = src.slice(updatedEffectStart, updatedEffectEnd);
    expect(updatedEffectStart).toBeGreaterThanOrEqual(0);
    expect(updatedEffectEnd).toBeGreaterThan(updatedEffectStart);
    expect(updatedEffect).toContain('if (!enablePersonalization || !jobBoardInteractionObserved) return;');
    expect(updatedEffect).toContain('new IntersectionObserver');
    expect(updatedEffect).toContain("{ rootMargin: '400px 0px' }");
    expect(updatedEffect).toContain('waitForInitialPaintOpportunity({ waitForLargestContentfulPaint: true })');
    expect(updatedEffect.indexOf('waitForInitialPaintOpportunity')).toBeLessThan(updatedEffect.indexOf('requestIdleCallback(start'));
    expect(updatedEffect).toContain('observer.observe(target)');
    expect(updatedEffect).toContain("w.requestIdleCallback(start, { timeout: 8000 })");
    expect(updatedEffect).toMatch(/if \(idleHandle !== null\) w\.cancelIdleCallback\?\.\(idleHandle\)/);
  });
});

describe('the map is shipped as a runtime data file', () => {
  it('adminDataPlugin copies data/job-popularity.json to dist/data/', () => {
    expect(COPIED_DATA_FILES).toContain('data/job-popularity.json');
  });

  it('projects only the allowlisted candidate fields into the versioned public feed', () => {
    const rawKeyword = `  ${'Reddit trend '.repeat(20)}  `;
    const feed = projectExperimentalCandidateFeed(JSON.stringify({
      generatedAt: '2026-11-04T00:00:00.000Z',
      sources: { redditTicino: { reason: 'private source diagnostics' } },
      candidates: [{
        id: '0123abcd',
        keyword: rawKeyword,
        normalizedKeyword: 'private normalized value',
        angle: '  Practical guide  ',
        locale: 'it',
        sources: ['redditTicino', 'googleNewsRss', 'untrusted-label'],
        demandSignals: {
          redditUrl: 'https://www.reddit.com/r/Ticino/comments/abc123/topic/?utm_source=private#comments',
          redditScore: 1234,
          redditComments: 56,
          redditSubreddit: 'Ticino',
          rawPostBody: 'private raw post content',
        },
        rationale: 'private ranking rationale',
        demandScore: 0.9,
        noveltyScore: 0.8,
        totalScore: 0.86,
        unusedField: 'must not escape',
      }],
    }));

    expect(feed).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-11-04T00:00:00.000Z',
      candidates: [{
        id: '0123abcd',
        keyword: rawKeyword.trim().replace(/\s+/gu, ' ').slice(0, 180),
        angle: 'Practical guide',
        locale: 'it',
        sources: ['reddit', 'google-news-rss'],
        totalScore: 0.86,
        redditPermalink: 'https://www.reddit.com/r/Ticino/comments/abc123/',
      }],
    });
    expect(feed.candidates[0].keyword.length).toBeLessThanOrEqual(180);
    expect(JSON.stringify(feed)).not.toMatch(/rationale|demandSignals|redditScore|redditComments|normalizedKeyword|private raw|unusedField/u);
  });

  it('returns a valid empty feed for missing or malformed miner output', () => {
    const empty = { schemaVersion: 1, generatedAt: null, candidates: [] };
    expect(projectExperimentalCandidateFeed(null)).toEqual(empty);
    expect(projectExperimentalCandidateFeed('{malformed')).toEqual(empty);
    expect(projectExperimentalCandidateFeed(JSON.stringify({ generatedAt: 'not-a-date', candidates: [] }))).toEqual(empty);
  });

  it('emits the projected feed to dist/data without copying the raw miner file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-candidates-runtime-'));
    const source = path.join(root, 'data', 'experimental-candidates.json');
    const output = path.join(root, 'dist', EXPERIMENTAL_CANDIDATE_FEED_FILE_PATH);
    const rawPayload = JSON.stringify({
      generatedAt: '2026-11-04T00:00:00.000Z',
      candidates: [{
        id: '0123abcd',
        keyword: 'Public topic',
        locale: 'it',
        sources: ['redditTicino'],
        demandSignals: { redditUrl: 'https://www.reddit.com/r/Ticino/comments/abc123/topic/', redditScore: 1234 },
        rationale: 'must not be copied',
        totalScore: 0.75,
      }],
    });
    try {
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, rawPayload);
      expect(COPIED_DATA_FILES).toContain('data/experimental-candidate-feed.json');
      expect(COPIED_DATA_FILES).not.toContain('data/experimental-candidates.json');

      const plugin = adminDataPlugin(root);
      const closeBundle = (plugin as unknown as { closeBundle: () => void }).closeBundle;
      closeBundle();

      expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({
        schemaVersion: 1,
        generatedAt: '2026-11-04T00:00:00.000Z',
        candidates: [{
          id: '0123abcd',
          keyword: 'Public topic',
          angle: null,
          locale: 'it',
          sources: ['reddit'],
          totalScore: 0.75,
          redditPermalink: 'https://www.reddit.com/r/Ticino/comments/abc123/',
        }],
      });
      expect(fs.existsSync(path.join(root, 'dist', 'data', 'experimental-candidates.json'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits an empty versioned CDN feed when the raw miner input is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-candidates-empty-'));
    const output = path.join(root, 'dist', EXPERIMENTAL_CANDIDATE_FEED_FILE_PATH);
    try {
      const plugin = adminDataPlugin(root);
      const closeBundle = (plugin as unknown as { closeBundle: () => void }).closeBundle;
      closeBundle();
      expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({ schemaVersion: 1, generatedAt: null, candidates: [] });
      expect(fs.existsSync(path.join(root, 'dist', 'data', 'experimental-candidates.json'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the loader URL matches the copied path', () => {
    expect(JOB_POPULARITY_DATA_URL).toBe('/data/job-popularity.json');
    expect(COPIED_DATA_FILES).toContain(`data${JOB_POPULARITY_DATA_URL.replace('/data', '')}`);
  });
});

describe('loadJobPopularity', () => {
  beforeEach(() => {
    __resetJobPopularityCache();
    setBase(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setBase(undefined);
    __resetJobPopularityCache();
  });

  it('fetches the same-origin path when no CDN base is injected (dev)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ a: 3 }) });
    vi.stubGlobal('fetch', fetchMock);
    await loadJobPopularity();
    expect(fetchMock).toHaveBeenCalledWith('/data/job-popularity.json');
  });

  it('fetches from the CDN when the base is injected (prod)', async () => {
    setBase(BASE);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ a: 3 }) });
    vi.stubGlobal('fetch', fetchMock);
    await loadJobPopularity();
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/data/job-popularity.json`);
  });

  it('caches the map — a second call issues no second request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ a: 3 }) });
    vi.stubGlobal('fetch', fetchMock);
    const first = await loadJobPopularity();
    const second = await loadJobPopularity();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ a: 3 }) });
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([loadJobPopularity(), loadJobPopularity()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('resolves to {} on a non-ok response, and does NOT cache the failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ a: 3 }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadJobPopularity()).toEqual({});
    expect(await loadJobPopularity()).toEqual({ a: 3 });
  });

  it('resolves to {} when fetch rejects (offline / CDN down)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await loadJobPopularity()).toEqual({});
  });

  it('resolves to {} when the body is not an object map (HTML error page, array)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [1, 2, 3] }));
    expect(await loadJobPopularity()).toEqual({});
    __resetJobPopularityCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => null }));
    expect(await loadJobPopularity()).toEqual({});
  });

  // The map was a build-time import (trusted) before #5313; fetching it makes it
  // an external payload. A truthy non-numeric value survives
  // getTrendingByLocation's `popularity[slug]` truthiness filter and then poisons
  // `b.views - a.views` with NaN — an inconsistent comparator, i.e. an arbitrary
  // "top 4" instead of a loud failure. Sanitising at the boundary covers every
  // consumer at once (reviewer adversarial check on #5313).
  it('drops non-numeric, non-finite and non-positive values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        good: 12,
        str: '34',
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        zero: 0,
        neg: -5,
        nul: null,
        obj: { views: 9 },
        bool: true,
      }),
    }));
    expect(await loadJobPopularity()).toEqual({ good: 12 });
  });

  it('resolves to {} when every value is unusable (and never yields NaN)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ a: 'x', b: Number.NaN }),
    }));
    const map = await loadJobPopularity();
    expect(map).toEqual({});
    expect(Object.values(map).some(Number.isNaN)).toBe(false);
  });

  it('exposes a frozen empty map for the pre-load state', () => {
    expect(Object.isFrozen(EMPTY_JOB_POPULARITY)).toBe(true);
    expect(Object.keys(EMPTY_JOB_POPULARITY)).toEqual([]);
  });
});
