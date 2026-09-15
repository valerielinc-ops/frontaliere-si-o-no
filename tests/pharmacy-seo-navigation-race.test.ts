// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../services/i18n';

const runtimeImportGate = vi.hoisted(() => {
  let releaseImport!: () => void;
  const pendingImport = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  return { pendingImport, releaseImport: () => releaseImport() };
});

vi.mock('../services/pharmacies/runtimeSeo', async () => {
  await runtimeImportGate.pendingImport;
  return {
    resolvePharmacySeoMetadata: () => ({
      title: 'Stale pharmacy title',
      description: 'Stale pharmacy description',
      keywords: 'stale pharmacy keywords',
      ogTitle: 'Stale pharmacy title',
      ogDescription: 'Stale pharmacy description',
      canonicalPath: '/farmacie/ticino/lugano/farmacia-stale/',
      robots: 'index,follow' as const,
      structuredData: {
        '@context': 'https://schema.org',
        '@type': 'Pharmacy',
        name: 'Stale pharmacy',
      },
    }),
  };
});

vi.doUnmock('@/services/seoService');
vi.doUnmock('../services/seoService');

let seo: typeof import('../services/seoService');

beforeAll(async () => {
  seo = await import('../services/seoService');
});

beforeEach(() => {
  setLocale('it');
  document.documentElement.lang = 'it';
  document.head.innerHTML = '<title>Initial title</title><meta name="robots" content="index,follow">';
  window.history.replaceState({}, '', '/');
});

describe('pharmacy SEO lazy-load navigation race', () => {
  it('does not let a deferred pharmacy import overwrite a newer navigation', async () => {
    window.history.replaceState({}, '', '/farmacie/ticino/lugano/farmacia-stale/');
    const staleNavigation = seo.updateMetaTags('pharmacy');

    window.history.replaceState({}, '', '/');
    await seo.updateMetaTags('calculator');
    const currentTitle = document.title;
    const currentCanonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');

    runtimeImportGate.releaseImport();
    await staleNavigation;

    expect(document.title).toBe(currentTitle);
    expect(document.title).not.toBe('Stale pharmacy title');
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(currentCanonical);
    expect(document.querySelector('script[type="application/ld+json"]')?.textContent).not.toContain('Stale pharmacy');
  });
});
