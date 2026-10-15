import { aggregateCityJobs, _resetCityJobsAggregateCache } from '../build-plugins/cityJobsAggregate';
import { aggregateHealthFacilityJobs, _resetHealthFacilityJobsAggregateCache } from '../build-plugins/healthFacilitiesJobsAggregate';
import { aggregateNursingJobs, _resetNursingJobsAggregateCache } from '../build-plugins/nursingJobsAggregate';
import { HEALTH_FACILITIES } from '../build-plugins/healthFacilitiesData';
import { buildSnapshotProseBlock } from '../build-plugins/shared/cantonSnapshotProse';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateProfessionJobsByCanton, _resetProfessionJobsAggregateCache } from '../build-plugins/professionJobsAggregate';
import { renderProfessionCantonPage } from '../build-plugins/professionCantonLandings';
import { ALL_CANTON_PROFESSION_IDS } from '../build-plugins/professionLandingsData';
import type { ProfessionJobsSnapshot } from '../build-plugins/professionJobsAggregate';
import { renderCantonSeoProse } from '../build-plugins/shared/cantonSeoProse';
import { describe, expect, it } from 'vitest';
import { renderJobBoardCommuterContext, renderSearchQueryIntro } from '../build-plugins/shared/jobBoardCommuterContext';

describe('permit information in job landing pages', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`qualifies Ticino fees and links the cantonal source (${locale})`, () => {
      const html = renderJobBoardCommuterContext({ locale, location: 'Ticino', omitCommute: true });
      expect(html).toContain('CHF 75');
      expect(html).toContain('A1');
      expect(html).toMatch(/49[,.]9%/);
      expect(html).toContain('href="https://www.bsv.admin.ch/it/telelavoro"');
      expect(html).toContain('href="https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/"');
      expect(html).not.toMatch(/è gratuito|is free of charge|ist kostenlos|est gratuit|rinnovato annualmente|yearly renewal/);
    });
    for (const location of ['Ticino', 'Svizzera']) {
      it(`explains withholding rather than an Italian credit cap (${locale}, ${location})`, () => {
        const html = renderJobBoardCommuterContext({ locale, location, omitCommute: true });
        expect(html).toContain('80%');
        expect(html).toContain('href="https://www.recognition.swiss/en"');
        expect(html).toContain('2018');
        expect(html).toContain('href="https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"');
        expect(html).not.toMatch(/3-6 mesi|3-6 months|3-6 Monate|3-6 mois|18-28|12-22|200-280|30-40 %|municipal refund|rimborso del comune|Gemeinderückerstattung|remboursement communal|fino all&#39;80|up to 80/);
      });
    }
    it(`keeps profession-city permit and fiscal rules distinct (${locale})`, () => {
      const html = renderCantonSeoProse({ locale, cantonDisplay: 'Ticino', slot: 'city-landing', entityName: 'Lugano' });
      expect(html).toContain('href="https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"');
      expect(html).toContain('href="https://www.estv.admin.ch/dam/it/sd-web/Zbr5Jb-40aYm/int-laender-it-faktenblatt-faqs-it.pdf"');
      expect(html).not.toMatch(/38[,.]8|rinnovo annuale|yearly renewal|jährliche Verlängerung|renouvellement annuel/);
      expect(html).toContain('2018');
    });
    it(`does not apply Ticino fees to a nationwide query (${locale})`, () => {
      const html = renderSearchQueryIntro(locale, 'software engineer', 5, [], [], 'svizzera');
      expect(html).not.toContain('CHF 75');
      expect(html).not.toMatch(/è gratuito|is free of charge|ist kostenlos|est gratuit/);
    });
  }
});


describe('canton fiscal and salary prose siblings', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    for (const slot of ['canton-hub', 'editorial-part-time', 'editorial-nursing'] as const) {
      it(`uses verified conditions and actual offer inputs (${locale}, ${slot})`, () => {
        const html = renderCantonSeoProse({ locale, cantonDisplay: 'Zurich', slot });
        expect(html).toContain('href="https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"');
        expect(html).toContain('href="https://www.bsv.admin.ch/it/telelavoro"');
        expect(html).toContain('href="https://www.recognition.swiss/en/"');
        expect(html).toContain('A1');
        expect(html).toContain('50%');
        expect(html).not.toMatch(/3-6|25-40|200-500|350-650|600-1[’', ]?200|municipal refund|rimborso del comune|remboursement de la commune|Rückerstattung.*Gemeinde/);
        expect(html).not.toMatch(/netSingleLow|netCoupleHigh|CHF 90[’', ]?000|CHF 115[’', ]?000/);
        expect(html).not.toMatch(/weekend per month satisfies|week-end par mois satisfait|week-end par mois suffit|Wochenende pro Monat genügt|weekend al mese soddisfa/);
        if (slot === 'editorial-part-time') expect(html).toMatch(/33[,.]3%/);
      });
    }
  }
});


describe('profession-canton recent-listing comparison', () => {
  const headings = {
    it: 'Quanto sono recenti le offerte delle professioni vicine?',
    en: 'How recent are the openings in nearby professions?',
    de: 'Wie aktuell sind die Angebote benachbarter Berufe?',
    fr: 'Quelle est la récence des offres des professions voisines ?',
  };
  const ids = ALL_CANTON_PROFESSION_IDS.slice(0, 3);
  const snapshot = (fresh30Count: number): ProfessionJobsSnapshot => ({
    liveCount: 8, fresh30Count, medianSalaryChf: null, featured: [], topEmployers: [],
  });
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`shows actual zero, counts and denominator (${locale})`, () => {
      const cohort = Object.fromEntries(ids.map((id, i) => [id, snapshot(i * 2)]));
      const { html } = renderProfessionCantonPage({
        locale, cantonKey: 'ZH', id: ids[0], snapshot: cohort[ids[0]], cantonProfessions: cohort, distDir: '',
      });
      expect(html).toContain(headings[locale]);
      expect(html).toContain('(0/8)');
      expect(html).toContain('(2/8)');
      expect(html).toContain('(4/8)');
      expect(html).toContain('0.0%');
      expect(html).toContain('25.0%');
      expect(html).toContain('50.0%');
    });
    it(`does not invent a comparison for absent peers or missing recency (${locale})`, () => {
      const render = (cantonProfessions?: Partial<Record<typeof ids[number], ProfessionJobsSnapshot>>) => renderProfessionCantonPage({
        locale, cantonKey: 'ZH', id: ids[0], snapshot: snapshot(0), cantonProfessions, distDir: '',
      }).html;
      expect(render()).not.toContain(headings[locale]);
      const missing = { ...snapshot(0), fresh30Count: undefined } as unknown as ProfessionJobsSnapshot;
      expect(render({ [ids[0]]: missing, [ids[1]]: snapshot(2), [ids[2]]: snapshot(4) })).not.toContain(headings[locale]);
    });
  }
});


describe('recent-listing period boundary', () => {
  it('counts verified publication boundaries and falls back only to another reported date', () => {
    const root = mkdtempSync(join(tmpdir(), 'profession-recency-'));
    const now = Date.now();
    const day = 86_400_000;
    const at = (offset: number) => new Date(now + offset * day).toISOString();
    const facility = HEALTH_FACILITIES.find((entry) => entry.companyKeys.length > 0)!;
    const reset = () => {
      _resetProfessionJobsAggregateCache();
      _resetCityJobsAggregateCache();
      _resetHealthFacilityJobsAggregateCache();
      _resetNursingJobsAggregateCache();
    };
    const dates = [
      { postingDateSource: 'reported', postedDate: at(1), firstSeenAt: at(-1) },
      { postingDateSource: 'reported', postedDate: at(-31) },
      { postingDateSource: 'reported', postedDate: at(-30) },
      { postingDateSource: 'reported', postedDate: at(0) },
      { postingDateSource: 'reported', datePosted: 'invalid', postedDate: at(-2), firstSeenAt: at(-40) },
      { postingDateSource: 'reported', datePosted: at(-3), postedDate: 'invalid' },
      { postingDateSource: 'reported', postedDate: 'invalid', firstSeenAt: at(-2) },
      { postingDateSource: 'unknown', firstSeenAt: at(-3) },
      { postingDateSource: 'unknown', postedDate: at(-1), firstSeenAt: at(-1) },
      { postingDateSource: 'reported', postedDate: 'invalid', firstSeenAt: 'invalid' },
    ];
    try {
      mkdirSync(join(root, 'data'));
      writeFileSync(join(root, 'data', 'jobs.json'), JSON.stringify(dates.map((date, i) => ({
        id: `nurse-${i}`, title: 'Infermiere', canton: 'TI', addressLocality: 'Lugano', companyKey: facility.companyKeys[0], ...date,
      }))));
      reset();
      const samples = [
        aggregateProfessionJobsByCanton(root, now).TI.infermiere,
        aggregateCityJobs(root, 'lugano', now),
        aggregateHealthFacilityJobs(root, now).get(facility.slug)!,
        aggregateNursingJobs(root, now).nurses,
      ];
      for (const sample of samples) {
        expect(sample.liveCount).toBe(dates.length);
        expect(sample.fresh30Count).toBe(4);
      }
    } finally {
      reset();
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('canton snapshot factual siblings', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`uses supplied sample and qualified permit/health facts (${locale})`, () => {
      const html = buildSnapshotProseBlock({
        locale, cantonDisplay: '<Zurich>', totalJobs: 0, ctaHref: '/jobs/', ctaLabel: 'Jobs',
      });
      expect(html).toContain('&lt;Zurich&gt;');
      expect(html).not.toContain('<Zurich>');
      expect(html).toContain('0');
      expect(html).toContain('href="https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera"');
      expect(html).toContain('href="https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html"');
      expect(html).not.toMatch(/90-150|90 minuti|90 min|80\+|1[., ]500|3[., ]000|accordo fiscale 2026|2026 fiscal agreement|Steuerabkommen 2026|accord fiscal 2026/);
      expect(html).not.toMatch(/insurance abroad|assicurazione all.estero|Auslandsversicherung|assurance à l.étranger/);
    });
  }
});
