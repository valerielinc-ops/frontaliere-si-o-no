/**
 * SEO Phase 1D — runtime noindex + canonical for query-param filter variants.
 *
 * Replaces the previous robots.txt `Disallow: /*?canton=*` / `Disallow: /*?age=*`
 * approach (Semrush flagged 759 "blocked" pages, Issue 4) with a softer
 * runtime strategy: emit `<meta name="robots" content="noindex, follow">` and
 * a `<link rel="canonical">` pointing to the no-query URL whenever the user
 * lands on a page with `?canton=`, `?age=`, or `?q=` (internal job search).
 *
 * Google honours the canonical and consolidates signals; Semrush stops
 * surfacing the URLs as blocked (Issue 4) and the `?q=` variants stop
 * appearing as hreflang conflicts (Issue 24, 531 conflicts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPath, getSeoSection, type AppRoute } from '@/services/router';
import { loadAllLocaleChunks, setLocale } from '@/services/i18n';

const { updateMetaTags } = await vi.importActual<typeof import('@/services/seoService')>('@/services/seoService');

describe('SEO runtime noindex on filter-variant query params', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Clear residual meta tags from prior tests
    document.querySelectorAll('meta[name="robots"]').forEach((el) => el.remove());
    document.querySelectorAll('link[rel="canonical"]').forEach((el) => el.remove());
  });

  it('emits noindex,follow and clean canonical when ?canton= is present', async () => {
    const route: AppRoute = { activeTab: 'confronti', confrontiSubTab: 'health' as any };
    const section = getSeoSection(route);
    const path = buildPath(route, 'it');

    await loadAllLocaleChunks('it');
    setLocale('it');
    window.history.replaceState({}, '', `${path}?canton=AG&age=26-30`);
    await updateMetaTags(section);

    const robots = document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
    expect(robots).toContain('noindex');
    expect(robots).toContain('follow');

    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    expect(canonical).not.toContain('canton=');
    expect(canonical).not.toContain('age=');
    expect(canonical).not.toContain('?');
    expect(canonical.endsWith(path) || canonical.endsWith(`${path}/`) || canonical.includes(path)).toBe(true);
  });

  it('emits noindex,follow and clean canonical when ?age= is present alone', async () => {
    const route: AppRoute = { activeTab: 'confronti', confrontiSubTab: 'health' as any };
    const section = getSeoSection(route);
    const path = buildPath(route, 'it');

    await loadAllLocaleChunks('it');
    setLocale('it');
    window.history.replaceState({}, '', `${path}?age=46-50`);
    await updateMetaTags(section);

    const robots = document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
    expect(robots).toContain('noindex');

    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    expect(canonical).not.toContain('age=');
    expect(canonical).not.toContain('?');
  });

  it('emits noindex,follow and clean canonical when ?q= internal-search is present', async () => {
    const route: AppRoute = { activeTab: 'job-board' };
    const section = getSeoSection(route);
    const path = buildPath(route, 'it');

    await loadAllLocaleChunks('it');
    setLocale('it');
    window.history.replaceState({}, '', `${path}?q=ingegnere+lugano`);
    await updateMetaTags(section);

    const robots = document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
    expect(robots).toContain('noindex');
    expect(robots).toContain('follow');

    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    expect(canonical).not.toContain('q=');
    expect(canonical).not.toContain('?');
  });

  it('emits index,follow when no filter query params are present', async () => {
    const route: AppRoute = { activeTab: 'confronti', confrontiSubTab: 'health' as any };
    const section = getSeoSection(route);
    const path = buildPath(route, 'it');

    await loadAllLocaleChunks('it');
    setLocale('it');
    window.history.replaceState({}, '', path);
    await updateMetaTags(section);

    const robots = document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
    expect(robots).toContain('index');
    expect(robots).not.toContain('noindex');
  });
});
