import { describe, expect, it } from 'vitest';
import {
  MAX_PROFESSION_OFFER_INSIGHTS,
  professionOfferInsightLines,
  renderProfessionJobOfferInsights,
} from '../build-plugins/shared/professionJobOfferInsights';
import type { FeaturedJob } from '../build-plugins/professionJobsAggregate';
import { fingerprintPage, scoreCohorts } from '../scripts/lib/informationGain.mjs';

const locales = ['it', 'en', 'de', 'fr'] as const;

const job = (seed: string, age: number, index: number): FeaturedJob => ({
  id: `${seed}-${index}`,
  title: `Specialista ${seed} ${index}`,
  titleByLocale: {
    it: `Specialista ${seed} ${index}`,
    en: `${seed} specialist ${index}`,
    de: `${seed}-Spezialist ${index}`,
    fr: `Spécialiste ${seed} ${index}`,
  },
  company: `Azienda ${seed}`,
  companyKey: `azienda-${seed}`,
  companyDomain: null,
  city: `Città ${seed}`,
  addressLocality: `Città ${seed}`,
  canton: 'TI',
  contract: 'full-time',
  salaryMin: null,
  salaryMax: null,
  salarySource: undefined,
  currency: 'CHF',
  postingDateSource: undefined,
  datePosted: null,
  postedDate: '2026-10-15',
  daysAgo: age,
  slug: `${seed}-${index}`,
  slugByLocale: {},
  employmentType: 'full-time',
  url: null,
});

describe('dettaglio offerte professionali', () => {
  it('ricompone titolo, datore e località in massimo sei righe stabili', () => {
    const jobs = [
      job('Nord', 2, 1),
      job('Sud', 1, 2),
      job('Centro', 3, 3),
      job('Ovest', 4, 4),
      job('Est', 5, 5),
      job('Lago', 6, 6),
      job('Alpe', 7, 7),
    ];

    const lines = professionOfferInsightLines(jobs, 'it');
    expect(lines).toHaveLength(MAX_PROFESSION_OFFER_INSIGHTS);
    expect(lines[0]).toContain('Azienda Sud');
    expect(lines[0]).toContain('Città Sud');
    expect(lines.every((line) => line.length >= 25)).toBe(true);
    expect(lines).toEqual(professionOfferInsightLines([...jobs].reverse(), 'it'));
  });

  it('scrubba il markdown letterale e non emette un blocco senza offerte', () => {
    const marked = {
      ...job('Nord', 1, 1),
      title: '**Capo cantiere**',
      titleByLocale: {},
      company: 'Azienda___Nord',
    };
    const html = renderProfessionJobOfferInsights('it', [marked], 1);
    expect(html).toContain('data-profession-offer-insights="1"');
    expect(html).toContain('Capo cantiere');
    expect(html).toContain('Azienda Nord');
    expect(html).not.toContain('**');
    expect(renderProfessionJobOfferInsights('it', [], 0)).toBe('');
  });

  it('localizza heading e titoli delle offerte in tutti i locali', () => {
    const expected = {
      it: 'Dettaglio delle offerte attive',
      en: 'Active openings in detail',
      de: 'Aktive Stellen im Detail',
      fr: 'Détail des offres actives',
    } as const;

    for (const locale of locales) {
      const html = renderProfessionJobOfferInsights(locale, [job('Nord', 1, 1)], 1);
      expect(html).toContain(expected[locale]);
      expect(html).toContain(locale === 'it' ? 'Specialista Nord 1' : locale === 'en' ? 'Nord specialist 1' : locale === 'de' ? 'Nord-Spezialist 1' : 'Spécialiste Nord 1');
    }
  });
});

describe('information gain del payload offerte', () => {
  const professions = [
    'muratore',
    'saldatore',
    'macellaio',
    'cuoco',
    'psicologo',
    'cameriere',
    'educatore',
    'contabile',
    'fisioterapista',
    'autista',
  ] as const;

  const page = (id: string, withInsights: boolean): string => {
    const index = professions.indexOf(id);
    const specialization = ['Cantiere', 'Officina', 'Mercato', 'Cucina', 'Clinica', 'Sala', 'Servizio', 'Bilancio', 'Riabilitazione', 'Trasporto'][index];
    const offerMarkers = ['Alba', 'Borgo', 'Centrale', 'Darsena', 'Est', 'Fiume'];
    const jobs = Array.from({ length: 6 }, (_, i) => job(`${specialization}-${offerMarkers[i]}`, i + 1, i));
    const insight = withInsights ? renderProfessionJobOfferInsights('it', jobs, jobs.length) : '';
    return `<!doctype html><html lang="it"><head><title>Lavoro Ticino ${id}</title></head><body>
      <h1>Lavoro da ${id} in Ticino: guida 2026</h1>
      <section><h2>Il mestiere in Ticino</h2><p>Contesto comune della professione e informazioni operative per chi cerca lavoro in Svizzera.</p></section>
      ${insight}
    </body></html>`;
  };

  const score = (withInsights: boolean) => scoreCohorts(
    professions.map((id) => fingerprintPage(`lavoro-ticino-${id}/index.html`, page(id, withInsights))),
    { minCohortPages: professions.length },
  ).cohorts[0];

  it('porta il blocco page-specific sopra il target e il controllo senza blocco resta sotto', () => {
    const withInsights = score(true);
    const withoutInsights = score(false);
    expect(withInsights.medianIgs).toBeGreaterThanOrEqual(40);
    expect(withInsights.zeroGainPages).toBe(0);
    expect(withoutInsights.medianIgs).toBeLessThan(40);
  });
});
