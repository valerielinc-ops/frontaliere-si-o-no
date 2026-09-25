import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadJobPopularity,
  JOB_POPULARITY_DATA_URL,
  EMPTY_JOB_POPULARITY,
  __resetJobPopularityCache,
} from '../services/jobPopularityService';
import { COPIED_DATA_FILES } from '../build-plugins/adminDataPlugin';

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
        const src = fs.readFileSync(p, 'utf8');
        if (/^\s*import\s+[^;]*from\s+['"][^'"]*job-popularity\.json['"]/m.test(src)) {
          offenders.push(path.relative(ROOT, p));
        }
      }
    };
    for (const d of dirs) walk(path.join(ROOT, d));
    expect(offenders).toEqual([]);
  });
});

describe('the map is shipped as a runtime data file', () => {
  it('adminDataPlugin copies data/job-popularity.json to dist/data/', () => {
    expect(COPIED_DATA_FILES).toContain('data/job-popularity.json');
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
