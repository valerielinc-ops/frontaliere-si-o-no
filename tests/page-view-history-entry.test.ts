import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logEvent } from 'firebase/analytics';
import { captureEvent as posthogCapture } from '@/services/posthog';
import { collapseTechnicalDuplicates } from '../scripts/build-employer-insights.mjs';
import { createAnalyticsEmissionId } from '../services/analyticsEmissionId';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/services/posthog', () => ({ captureEvent: vi.fn() }));
vi.mock('@/services/firebase', () => ({
  getAnalytics: vi.fn(async () => ({ name: 'test-analytics' })),
  resetAnalytics: vi.fn(async () => ({ name: 'test-analytics' })),
}));

const analyticsSource = readFileSync(resolve(__dirname, '../services/analytics.ts'), 'utf8');
const emissionIdSource = readFileSync(resolve(__dirname, '../services/analyticsEmissionId.ts'), 'utf8');
const routerSource = readFileSync(resolve(__dirname, '../services/router.ts'), 'utf8');
const authServiceSource = readFileSync(resolve(__dirname, '../services/authService.ts'), 'utf8');
const uiStateSource = readFileSync(resolve(__dirname, '../hooks/useUIState.ts'), 'utf8');
const seoTrackingSource = readFileSync(resolve(__dirname, '../hooks/useSeoPageTracking.ts'), 'utf8');
const capture = vi.mocked(posthogCapture);
const firebaseLog = vi.mocked(logEvent);

async function loadAnalytics() {
  vi.resetModules();
  return vi.importActual<typeof import('@/services/analytics')>('@/services/analytics');
}

function posthogPageViews() {
  return capture.mock.calls.filter(([eventName]) => eventName === '$pageview');
}

function firebasePageViews() {
  return firebaseLog.mock.calls.filter(([, eventName]) => eventName === 'page_view');
}

async function waitForProviders(expected: number): Promise<void> {
  await vi.waitFor(() => {
    expect(posthogPageViews()).toHaveLength(expected);
    expect(firebasePageViews()).toHaveLength(expected);
  });
}

function stubBrowser(): void {
  vi.stubGlobal('window', {
    location: { origin: 'https://example.test', pathname: '/' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', { title: 'test page' });
}

describe('page-view emission identity', () => {
  beforeEach(() => {
    capture.mockClear();
    firebaseLog.mockClear();
    stubBrowser();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the identity leaf independent from History', () => {
    expect(emissionIdSource).not.toContain('window.history');
    expect(emissionIdSource).not.toContain('pushState');
    expect(emissionIdSource).not.toContain('replaceState');
    expect(analyticsSource).toContain('emissionId === undefined ? createAnalyticsEmissionId() : emissionId');
  });

  it('returns distinct non-empty ids when Web Crypto is unavailable', () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234);
    const random = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.2);

    try {
      const first = createAnalyticsEmissionId();
      const second = createAnalyticsEmissionId();

      expect(first).toBe('1234-3lllllllllm');
      expect(second).toBe('1234-77777777778');
      expect(second).not.toBe(first);
    } finally {
      random.mockRestore();
      now.mockRestore();
      vi.stubGlobal('crypto', originalCrypto);
    }
  });

  it('passes one generated id to Firebase and PostHog for one act', async () => {
    const { Analytics } = await loadAnalytics();
    const first = Analytics.trackPageView('/atto-unico/', 'Atto unico');

    expect(first).toEqual(expect.any(String));
    await waitForProviders(1);

    expect(posthogPageViews()[0][1]).toMatchObject({ emission_id: first });
    expect(firebasePageViews()[0][2]).toMatchObject({ emission_id: first });
    expect(collapseTechnicalDuplicates([
      { event: '$pageview', observed: 1, emissionId: posthogPageViews()[0][1].emission_id },
      { event: 'page_view', observed: 1, emissionId: firebasePageViews()[0][2].emission_id },
    ])).toMatchObject({ observed: 1, removed: 1, dedupUnavailable: 0 });
  });

  it('gives two distinct trackPageView calls two distinct ids', async () => {
    const { Analytics } = await loadAnalytics();
    const first = Analytics.trackPageView('/atto-a/', 'Atto A');
    const second = Analytics.trackPageView('/atto-b/', 'Atto B');

    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    await waitForProviders(2);
    expect(posthogPageViews()[1][1].emission_id).not.toBe(posthogPageViews()[0][1].emission_id);
    expect(firebasePageViews()[1][2].emission_id).not.toBe(firebasePageViews()[0][2].emission_id);
  });

  it('reuses the original id only when the retry passes it explicitly', async () => {
    const { Analytics } = await loadAnalytics();
    const original = Analytics.trackPageView('/retry/', undefined, { employerKey: 'before' });
    const retry = Analytics.trackPageView('/retry/', undefined, { employerKey: 'after' }, original);

    expect(original).toEqual(expect.any(String));
    expect(retry).toBe(original);
    await waitForProviders(2);
    expect(posthogPageViews()[1][1].emission_id).toBe(original);
    expect(firebasePageViews()[1][2].emission_id).toBe(original);
    expect(collapseTechnicalDuplicates(posthogPageViews().map(([, params]) => ({
      event: '$pageview',
      observed: 1,
      emissionId: params.emission_id,
    })))).toMatchObject({ observed: 1, removed: 1, dedupUnavailable: 0 });
  });

  it('propagates null as dedup unavailable to both providers', async () => {
    const { Analytics } = await loadAnalytics();
    const emissionId = Analytics.trackPageView('/non-determinabile/', undefined, null, null);

    expect(emissionId).toBeNull();
    await waitForProviders(1);
    expect(posthogPageViews()[0][1].emission_id).toBeNull();
    expect(firebasePageViews()[0][2].emission_id).toBeNull();
    expect(emissionId).not.toBe(0);
  });

  it('keeps the locale change and auth restores as distinct acts after replaceState/popstate', async () => {
    expect(routerSource.split('\n')[3990]).toContain(
      "history.replaceState({ route: nextRoute }, '', newPath + search);",
    );
    expect(authServiceSource).toContain("window.history.replaceState(null, '', savedPath);");
    expect(authServiceSource.match(/window\.history\.replaceState\(null, '', savedPath\);/g)).toHaveLength(2);

    const { Analytics } = await loadAnalytics();
    const localeBefore = Analytics.trackPageView('/it/statistiche/', 'Statistiche');
    const localeAfter = Analytics.trackPageView('/de/statistiken/', 'Statistiken');
    const authBefore = Analytics.trackPageView('/accedi/', 'Accedi');
    const authAfter = Analytics.trackPageView('/cerca-lavoro-ticino/azienda-x/', 'Azienda X');

    expect(localeAfter).not.toBe(localeBefore);
    expect(authAfter).not.toBe(authBefore);
    expect(new Set([localeBefore, localeAfter, authBefore, authAfter]).size).toBe(4);
    await waitForProviders(4);
  });

  it('covers every current page-view owner without a History identity dependency', async () => {
    expect(emissionIdSource).not.toMatch(/WeakMap|Symbol\.for|window\.history|history\.state/);
    expect(analyticsSource).not.toMatch(/window\.history|history\.state|ensureCurrentPageViewHistoryEntryId/);
    expect(uiStateSource).not.toContain('ensureCurrentPageViewHistoryEntryId');
    expect(seoTrackingSource).not.toContain('ensureCurrentPageViewHistoryEntryId');

    const ownerPaths = [
      '/initial/', '/route/', '/statistiche/', '/statistiche/prezzi-benzina-confine/',
      '/statistiche/disoccupazione-svizzera/', '/pubblica-offerta/', '/per-le-aziende/',
      '/contatti/', '/faq/', '/consulenza/', '/i-miei-annunci/',
      '/statistiche/occupazione/', '/simulatori/ral-comparator/', '/dialetto-ticinese/',
      '/offerte-di-lavoro-ticino/azienda-x/',
    ];
    expect(ownerPaths).toHaveLength(15);

    const { Analytics } = await loadAnalytics();
    const ids = ownerPaths.map((path) => Analytics.trackPageView(path));
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(15);
    await waitForProviders(15);
    expect(posthogPageViews().map(([, params]) => params.emission_id)).toEqual(ids);
    expect(firebasePageViews().map(([, , params]) => params.emission_id)).toEqual(ids);
  });
});
