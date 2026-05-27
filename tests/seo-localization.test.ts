import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPath, getSeoSection, type AppRoute } from '@/services/router';
import { loadAllLocaleChunks, setLocale } from '@/services/i18n';

const { updateMetaTags } = await vi.importActual<typeof import('@/services/seoService')>('@/services/seoService');

describe('SEO localization', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('localizes title/meta/JSON-LD for DE stats page', async () => {
    const route: AppRoute = { activeTab: 'stats', statsSubTab: 'livability' as any };
    const section = getSeoSection(route);
    const path = buildPath(route, 'de');

    await loadAllLocaleChunks('de');
    setLocale('de');
    window.history.replaceState({}, '', path);
    await updateMetaTags(section);

    expect(document.title).toContain('Frontaliere Ticino');
    expect(document.title.toLowerCase()).toContain('lebens');
    expect(document.title).not.toContain('Indice di Vivibilità');

    const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    expect(description.toLowerCase()).toContain('grenz');
    expect(description).not.toContain('Scopri');

    const ogLocale = document.querySelector('meta[property="og:locale"]')?.getAttribute('content');
    expect(ogLocale).toBe('de_CH');

    const jsonLd = document.querySelector('#dynamic-structured-data')?.textContent || '';
    expect(jsonLd).toContain('"inLanguage":"de"');
  });

  it('resolves localized job detail slugs when building runtime SEO tags', async () => {
    const route: AppRoute = {
      activeTab: 'job-board',
      jobSlug: 'responsabile-fondi-pensione-efg-international-ag-lugano',
    };
    const section = getSeoSection(route);
    const path = buildPath(route, 'it');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/data/jobs.json') {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'efg-5967',
              slug: 'foundation-manager-efg-lugano',
              slugByLocale: {
                it: 'responsabile-fondi-pensione-efg-international-ag-lugano',
                en: 'foundation-manager-efg-international-ag-lugano',
                de: 'leiter-pensionskasse-efg-international-ag-lugano',
                fr: 'responsable-de-la-fondation-de-prevoyance-efg-international-ag-lugano',
              },
              title: 'Foundation Manager',
              titleByLocale: {
                it: 'Responsabile Fondazione',
                en: 'Foundation Manager',
                de: 'Stiftungsleiter',
                fr: 'Responsable de Fondation',
              },
              description: 'Default description',
              descriptionByLocale: {
                it: 'Gestione e amministrazione del fondo pensione aziendale a Lugano.',
              },
              company: 'EFG International AG',
              location: 'Lugano',
              contract: 'permanent',
              postedDate: '2026-03-06',
            },
          ]),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchMock);

    await loadAllLocaleChunks('it');
    setLocale('it');
    window.history.replaceState({}, '', path);
    await updateMetaTags(section);

    expect(document.title).toContain('Responsabile Fondazione');
    expect(document.title).toContain('EFG International AG');

    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    expect(canonical).toContain('/cerca-lavoro-ticino/responsabile-fondi-pensione-efg-international-ag-lugano/');

    const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    expect(description).toContain('fondo pensione aziendale');

    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });
});
