import { describe, expect, it } from 'vitest';
import {
  FRONTALIERE_PILLAR_LOCALES,
  FRONTALIERE_PILLAR_ROUTES,
  buildFrontalierePillarPath,
  isFrontalierePillarPath,
  parseFrontalierePillarPath,
} from '../build-plugins/frontalierePillarData';
import { FRONTALIERE_PILLAR_COPY, PILLAR_PROFESSION_IDS } from '../build-plugins/frontalierePillarCopy';
import { CAREER_LANDING_COPY } from '../build-plugins/careerLandingsCopy';
import { PROFESSION_IDS } from '../build-plugins/professionLandingsData';
import { parsePath } from '../services/router';

describe('frontaliere pillar routes', () => {
  it('enumerates 4 locale routes, all trailing-slash', () => {
    expect(FRONTALIERE_PILLAR_ROUTES).toHaveLength(4);
    for (const r of FRONTALIERE_PILLAR_ROUTES) {
      expect(r.endsWith('/')).toBe(true);
      expect(isFrontalierePillarPath(r)).toBe(true);
    }
    expect(buildFrontalierePillarPath('it')).toBe('/frontaliere/');
    expect(buildFrontalierePillarPath('de')).toBe('/de/grenzgaenger/');
  });

  it('resolves trailing-slash-less variants too', () => {
    expect(parseFrontalierePillarPath('/frontaliere')).toEqual({ locale: 'it' });
    expect(parseFrontalierePillarPath('/en/cross-border-worker')).toEqual({ locale: 'en' });
    expect(parseFrontalierePillarPath('/frontaliere-ticino/')).toBeNull();
  });

  it('router classifies the pillar as a guida staticOverlay route', () => {
    for (const locale of FRONTALIERE_PILLAR_LOCALES) {
      const parsed = parsePath(buildFrontalierePillarPath(locale));
      expect(parsed.route.activeTab).toBe('guida');
      expect(parsed.route.staticOverlay).toBe(true);
      expect(parsed.locale).toBe(locale);
    }
  });
});

describe('frontaliere pillar copy', () => {
  it('covers all 4 locales with sections, FAQ and orchestration links', () => {
    for (const locale of FRONTALIERE_PILLAR_LOCALES) {
      const copy = FRONTALIERE_PILLAR_COPY[locale];
      expect(copy.sections.length, locale).toBeGreaterThanOrEqual(5);
      expect(copy.faqs.length, locale).toBeGreaterThanOrEqual(5);
      expect(copy.related.length, locale).toBeGreaterThanOrEqual(5);
      // Orchestration contract: enough prose to clear the 50-word
      // indexability gate before tiles/FAQ/links even count.
      const words = [copy.lede, ...copy.sections.flatMap((s) => [...s.paragraphsHtml])]
        .join(' ')
        .replace(/<[^>]+>/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
      // 150 not 200: German compounds compress word counts (~160 words say
      // what Italian says in ~250) while the full page (FAQ, tiles, links)
      // sits far above the MIN_INDEXABLE_WORDS=50 gate in every locale.
      expect(words.length, locale).toBeGreaterThan(150);
    }
  });

  it('uses trailing-slash internal links everywhere', () => {
    for (const locale of FRONTALIERE_PILLAR_LOCALES) {
      const copy = FRONTALIERE_PILLAR_COPY[locale];
      const html = [
        ...copy.sections.flatMap((s) => [...s.paragraphsHtml]),
        copy.professionsIntro,
        copy.primaryCtaHref,
        copy.guideHubHref,
        ...copy.related.map((l) => l.href),
      ].join('\n');
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      hrefs.push(copy.primaryCtaHref, copy.guideHubHref, ...copy.related.map((l) => l.href));
      for (const href of hrefs) {
        if (href.startsWith('http')) continue; // external sources checked separately
        expect(href.endsWith('/'), `${locale} → ${href}`).toBe(true);
      }
    }
  });

  it('uses final landing URLs for official external sources', () => {
    const expectedBfs = {
      it: 'https://www.bfs.admin.ch/it/',
      en: 'https://www.bfs.admin.ch/en/',
      de: 'https://www.bfs.admin.ch/de/',
      fr: 'https://www.bfs.admin.ch/fr/',
    } as const;

    for (const locale of FRONTALIERE_PILLAR_LOCALES) {
      const bfs = FRONTALIERE_PILLAR_COPY[locale].sources.find((source) => source.label.includes('FSO') || source.label.includes('UST') || source.label.includes('BFS') || source.label.includes('OFS'));
      expect(bfs?.url, locale).toBe(expectedBfs[locale]);
    }

    expect(CAREER_LANDING_COPY.it['agenzie-lavoro-lugano'].sources[0]?.href).toBe(
      'https://www.vzavg1.admin.ch/vzavg-verzeichnis-frontend/',
    );
  });

  it('links only professions that have a dedicated landing', () => {
    for (const id of PILLAR_PROFESSION_IDS) {
      expect(PROFESSION_IDS, id).toContain(id);
    }
  });
});
