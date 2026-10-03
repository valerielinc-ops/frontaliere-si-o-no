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
