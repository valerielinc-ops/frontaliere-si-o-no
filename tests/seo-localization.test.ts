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

  it.each(['unknown', 'reported', undefined] as const)('resolves localized runtime SEO with publication provenance %s', async (postingDateSource) => {
    const suffix = postingDateSource || 'legacy';
    const publicationDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const route: AppRoute = {
      activeTab: 'job-board',
      jobSlug: `responsabile-fondi-pensione-efg-international-ag-lugano-${suffix}`,
    };
    const section = getSeoSection(route);
    const path = buildPath(route, 'it');

    // After the jobs-{locale}.json → slim-index + job-detail migration the SEO
    // loader fetches the slim listing index for the slug→id mapping, then the
    // per-job `job-detail/<id>.json` for the description + structured-data
    // fields. The index carries listing fields only (no description); the
    // detail file carries the prose. `slug` is flattened to the active locale.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/data/jobs-it-index.json') {
        return {
          ok: true,
          json: async () => (['unknown', 'reported', undefined].map((source) => ({
            id: `efg-5967-${source || 'legacy'}`,
            slug: `responsabile-fondi-pensione-efg-international-ag-lugano-${source || 'legacy'}`,
            title: 'Responsabile Fondazione', company: 'EFG International AG', location: 'Lugano',
            contract: 'permanent', postedDate: publicationDate, postingDateSource: source,
          }))),
        } as Response;
      }
      if (String(input) === `/data/job-detail/efg-5967-${suffix}.json`) {
        return {
          ok: true,
          json: async () => ({
            id: `efg-5967-${suffix}`,
            postingDateSource, postedDate: publicationDate,
            title: 'Responsabile Fondazione',
            description: 'Gestione e amministrazione del fondo pensione aziendale a Lugano.',
            company: 'EFG International AG',
            location: 'Lugano',
            employmentType: 'FULL_TIME',
          }),
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
    expect(canonical).toContain(`/cerca-lavoro-ticino/responsabile-fondi-pensione-efg-international-ag-lugano-${suffix}/`);

    const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    expect(description).toContain('fondo pensione aziendale');

    // Explicit unknown retains the marker while the schema uses a valid
    // collection-clock fallback for its mandatory datePosted field.
    const graph = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((script) => JSON.parse(script.textContent || '{}'));
    const types = JSON.stringify(graph);
    expect(types).toContain('"@type":"JobPosting"');
    expect(types).toContain('"@type":"FAQPage"');


    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('canton job-board pages reflect their OWN canton, not a hardcoded Ticino fallback', async () => {
    const route: AppRoute = { activeTab: 'job-board', jobBoardCanton: 'ZH' };
    const section = getSeoSection(route);
    const path = buildPath(route, 'de');

    await loadAllLocaleChunks('de');
    setLocale('de');
    window.history.replaceState({}, '', path);
    await updateMetaTags(section);

    expect(document.title).toContain('Zurich');
    expect(document.title).not.toContain('Tessin');

    const structuredDataScripts = Array.from(document.querySelectorAll('script[data-dynamic-ld]'));
    const breadcrumbList = structuredDataScripts
      .map((el) => JSON.parse(el.textContent || '{}'))
      .find((schema) => schema['@type'] === 'BreadcrumbList');
    const breadcrumbCrumb = breadcrumbList.itemListElement.find((item: any) => item.position === 2);
    expect(breadcrumbCrumb.item).toBe(`https://frontaliereticino.ch${path}`);
    expect(breadcrumbCrumb.name).toContain('Zurich');
    expect(breadcrumbCrumb.item).not.toContain('/cerca-lavoro-ticino');
    expect(breadcrumbCrumb.name).not.toContain('Tessin');
  });
});
