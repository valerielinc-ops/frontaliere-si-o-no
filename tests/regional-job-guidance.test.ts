import { describe, expect, it } from 'vitest';
import {
  isRegionalJobGuidanceTarget,
  renderRegionalJobGuidance,
} from '../build-plugins/shared/regionalJobGuidance';
import { buildCantonHubEditorial } from '../build-plugins/shared/cantonHubEditorial';

const archiveNavigationFor = (archiveHref: string) => {
  const paginatedArchiveHref = archiveHref.replace(/\/$/, '') + '/page-2/';
  return `<details data-archive-nav><summary>Archivio</summary><nav><a href="${paginatedArchiveHref}">2</a></nav></details>`;
};

describe('regional canton job guidance', () => {
  it('targets only the requested canton and locale pairs', () => {
    expect(isRegionalJobGuidanceTarget('GR', 'it')).toBe(true);
    expect(isRegionalJobGuidanceTarget('GE', 'fr')).toBe(true);
    expect(isRegionalJobGuidanceTarget('VD', 'fr')).toBe(true);
    expect(isRegionalJobGuidanceTarget('NE', 'fr')).toBe(true);
    expect(isRegionalJobGuidanceTarget('GR', 'fr')).toBe(false);
    expect(isRegionalJobGuidanceTarget('GE', 'it')).toBe(false);
    expect(isRegionalJobGuidanceTarget('ZH', 'fr')).toBe(false);
  });

  it.each([
    ['GR', 'it', 'Val Mesolcina', 'https://www.gr.ch/IT/cantone/Seiten/Bevoelkerung.aspx', '/cerca-lavoro-grigioni/tutti/', '/cerca-lavoro-grigioni/'],
    ['GE', 'fr', 'TPG', 'https://www.tpg.ch/fr/voyager/planifier-votre-voyage/itineraires', '/fr/trouver-emploi-geneve/tous/', '/fr/trouver-emploi-geneve/'],
    ['VD', 'fr', 'TPN', 'https://www.vd.ch/mobilite/loffre-de-mobilite-a-votre-disposition/bus', '/fr/trouver-emploi-vaud/tous/', '/fr/trouver-emploi-vaud/'],
    ['NE', 'fr', 'Val-de-Travers', 'https://offresemploi.ne.ch/', '/fr/trouver-emploi-neuchatel/tous/', '/fr/trouver-emploi-neuchatel/'],
  ] as const)('renders regional guidance for %s in %s', (canton, locale, localDetail, officialHref, archiveHref, cityHubBaseHref) => {
    const archiveNavigation = archiveNavigationFor(archiveHref);
    const html = renderRegionalJobGuidance({
      canton,
      locale,
      display: canton === 'GR' ? 'Grigioni' : canton === 'GE' ? 'Genève' : canton === 'VD' ? 'Vaud' : 'Neuchâtel',
      jobs: [
        { company: 'Employeur A', location: canton === 'GR' ? 'Poschiavo' : 'Genève' },
        { company: 'Employeur B', location: canton === 'GR' ? 'Coira' : 'Lausanne' },
      ],
      archiveHref,
      cityHubBaseHref,
      cityHubs: [{ slug: canton === 'GR' ? 'poschiavo' : 'geneve', label: canton === 'GR' ? 'Poschiavo' : 'Genève' }],
      archiveNavigationHtml: archiveNavigation,
    });

    expect(html).toContain('data-regional-job-guidance');
    expect(html).toContain(`data-regional-canton="${canton}"`);
    expect(html).toContain(`data-regional-locale="${locale}"`);
    expect(html).toContain(archiveNavigation);
    expect(html).toContain(`href="${archiveHref}"`);
    expect(html).toContain(`href="${officialHref}"`);
    expect(html).toContain(localDetail);
    expect(html).toContain('data-regional-job-inventory');
    expect(html).toMatch(/2 (annunci|annonces|offres)/);
    expect(html).toMatch(/exigences explicites|requisiti linguistici espliciti/);
    expect(html).not.toMatch(/CHF\s?\d|salary|salaire|stipendio|fiscal|steuer|permesso G|permis G/i);
  });

  it('derives employer and city counts from jobs and links only emitted city hubs', () => {
    const archiveHref = '/fr/trouver-emploi-geneve/tous/';
    const html = renderRegionalJobGuidance({
      canton: 'GE',
      locale: 'fr',
      display: 'Genève',
      jobs: [
        { company: 'A&B <img src=x onerror=alert(1)>', location: 'Genève' },
        { company: 'A&B <img src=x onerror=alert(1)>', location: 'Nyon' },
        { company: '<script>alert(2)</script>', location: 'Lausanne' },
      ],
      archiveHref,
      cityHubBaseHref: '/fr/trouver-emploi-geneve/',
      cityHubs: [
        { slug: 'geneve', label: 'Genève' },
        { slug: 'nyon', label: 'Nyon <svg onload=alert(3)>' },
      ],
      archiveNavigationHtml: archiveNavigationFor(archiveHref),
    });

    expect(html).toContain('3 annonces recueillies');
    expect(html).toContain('A&amp;B &lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).toContain('Nyon &lt;svg onload=alert(3)&gt;');
    expect(html).toContain('href="/fr/trouver-emploi-geneve/geneve/"');
    expect(html).toContain('href="/fr/trouver-emploi-geneve/nyon/"');
    expect(html).not.toContain('href="/fr/trouver-emploi-geneve/lausanne/"');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img ');
    expect(html).not.toContain('<svg ');
  });

  it('escapes the display label and renders an empty inventory without fabricated employers or cities', () => {
    const html = renderRegionalJobGuidance({
      canton: 'GE',
      locale: 'fr',
      display: 'Genève <script>alert(4)</script>',
      jobs: [],
      archiveHref: '/fr/trouver-emploi-geneve/tous/',
      cityHubBaseHref: '/fr/trouver-emploi-geneve/',
      cityHubs: [{ slug: 'geneve', label: 'Genève' }],
      archiveNavigationHtml: '',
    });

    expect(html).toContain('Genève &lt;script&gt;alert(4)&lt;/script&gt;');
    expect(html).toContain('Aucune annonce recueillie');
    expect(html).not.toContain('data-regional-job-inventory');
    expect(html).not.toContain('Employeurs mentionnés');
    expect(html).not.toContain('href="/fr/trouver-emploi-geneve/geneve/"');
    expect(html).not.toContain('<script>');
  });

  it('uses localized neutral copy for non-target canton hubs in all four locales', () => {
    const cases = [
      { locale: 'it' as const, display: 'Zurigo', heading: 'Offerte di lavoro nel Canton Zurigo' },
      { locale: 'en' as const, display: 'Zurich', heading: 'Job listings in the canton of Zurich' },
      { locale: 'de' as const, display: 'Zürich', heading: 'Stellenangebote im Kanton Zürich' },
      { locale: 'fr' as const, display: 'Zurich', heading: 'Offres d’emploi dans le canton de Zurich' },
    ];

    for (const { locale, display, heading } of cases) {
      const html = buildCantonHubEditorial({
        canton: 'ZH',
        locale,
        display,
        jobsCount: 12,
        totalPages: 3,
        archiveBaseHref: `/${locale}/jobs-zurich/all/`,
      }).join('');
      expect(html).toContain(heading);
      expect(html).toContain('data-canton-context-prose');
      expect(html).toContain('data-canton-editorial');
      expect(html).toContain('href="');
      expect(html).not.toMatch(/permesso G|permis G|CHF\s?\d|stipendio medio|revenu moyen|salary estimate|imposta alla fonte|Quellensteuer/i);
      if (locale === 'fr') {
        expect(html).not.toMatch(/Offerte di lavoro|Ticino|permesso|annunci raccolti/);
      }
    }
  });
});
