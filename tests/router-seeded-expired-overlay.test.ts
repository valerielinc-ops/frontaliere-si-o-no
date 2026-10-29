// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const EXPIRED_PATH = '/cerca-lavoro-ticino/crew-mcdonalds-switzerland-morbio-inferiore-p8-319611-6/';
const EXPIRED_SLUG = 'crew-mcdonalds-switzerland-morbio-inferiore-p8-319611-6';

async function loadRouterWithExpiredSeed(pathname = EXPIRED_PATH, slug = EXPIRED_SLUG) {
  window.history.replaceState(null, '', pathname);
  document.body.innerHTML = '';
  const staticBody = document.createElement('main');
  staticBody.dataset.expiredStaticBody = 'true';
  staticBody.dataset.expiredStaticPath = pathname;
  document.body.appendChild(staticBody);
  (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__ = {
    slug,
    title: 'Crew',
  };
  vi.resetModules();
  return import('@/services/router');
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__EXPIRED_JOB_DATA__;
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('router — seeded expired-job hydration handoff', () => {
  it('routes the matching expired seed through the hydrated JobExpiredView', async () => {
    const { parsePath } = await loadRouterWithExpiredSeed();
    const parsed = parsePath(EXPIRED_PATH);

    expect(parsed.route).toMatchObject({
      activeTab: 'job-board',
      jobBoardCanton: 'TI',
      jobSlug: EXPIRED_SLUG,
    });
    expect(parsed.route.staticOverlay).toBeFalsy();
    expect(parsed.notFoundPath).toBeUndefined();
  });

  it('does not let the seed leak into a later SPA navigation', async () => {
    const { parsePath } = await loadRouterWithExpiredSeed();
    window.history.pushState(null, '', '/cerca-lavoro-ticino/');

    const parsed = parsePath(window.location.pathname);
    expect(parsed.route.activeTab).toBe('job-board');
    expect(parsed.route.staticOverlay).toBeFalsy();
  });

  it('does not static-overlay a different slug on the seeded document', async () => {
    const { parsePath } = await loadRouterWithExpiredSeed(EXPIRED_PATH, 'another-expired-job');
    const parsed = parsePath(EXPIRED_PATH);

    expect(parsed.route.activeTab).toBe('job-board');
    expect(parsed.route.staticOverlay).toBeFalsy();
    expect(parsed.route.jobSlug).toBe(EXPIRED_SLUG);
  });

  it('does not revive the seed after the static body was removed and the URL returns', async () => {
    const { parsePath } = await loadRouterWithExpiredSeed();
    document.querySelector('main[data-expired-static-body]')?.remove();
    window.history.pushState(null, '', '/cerca-lavoro-ticino/');
    window.history.pushState(null, '', EXPIRED_PATH);

    const parsed = parsePath(EXPIRED_PATH);
    expect(parsed.route.staticOverlay).toBeFalsy();
    expect(parsed.route.jobSlug).toBe(EXPIRED_SLUG);
  });
});
