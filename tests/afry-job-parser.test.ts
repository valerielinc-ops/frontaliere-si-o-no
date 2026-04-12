import { describe, expect, it } from 'vitest';
import {
  parseAfryApiResponse,
  parseAfryDetailPage,
  parseSmartRecruitersPage,
  isAfryTicinoRelevant,
  inferAfryCanton,
  inferAfryCategory,
  buildAfryLocalizedContent,
} from '../scripts/lib/afry-job-parser.mjs';

describe('afry-job-parser', () => {
  describe('parseAfryDetailPage', () => {
    it('extracts description from advert--body container', () => {
      const html = `
        <div class="advert--detail__container">
          <div class="advert--body">
            <h3>Descrizione del lavoro</h3>
            <p>Nel settore <strong>GEOLOGIA</strong> concepiamo e progettiamo soluzioni per committenti privati ed enti pubblici.</p>
            <p><strong>COMPITI:</strong></p>
            <ul>
              <li>Analisi e sintesi di prove geotecniche</li>
              <li>Elaborazione di modelli geologici</li>
              <li>Supporto alla direzione lavori</li>
            </ul>
            <h3>Descrizione dell'azienda</h3>
            <p>AFRY offre servizi di ingegneria e consulenza con 18.000 esperti nel mondo.</p>
          </div>
          <div class="additional--info__wrapper">
            <div class="advert--apply__button_container">
              <a href="https://jobs.smartrecruiters.com/AFRY/744000110186376-test?oga=true">Apply</a>
            </div>
          </div>
        </div>`;
      const result = parseAfryDetailPage(html);
      expect(result.description).toContain('GEOLOGIA');
      expect(result.description).toContain('Analisi e sintesi');
      expect(result.description).toContain('18.000 esperti');
      expect(result.description.split(/\s+/).length).toBeGreaterThan(30);
      expect(result.applyUrl).toContain('smartrecruiters.com/AFRY/');
    });

    it('falls back to advert--description for older layouts', () => {
      const html = `
        <div class="advert--description">
          <p>Old layout description with enough content to be meaningful for the test.</p>
        </div>
        <div class="advert--apply">
          <a href="https://jobs.smartrecruiters.com/AFRY/old-layout">Apply</a>
        </div>`;
      const result = parseAfryDetailPage(html);
      expect(result.description).toContain('Old layout description');
      expect(result.applyUrl).toContain('smartrecruiters.com/AFRY/');
    });

    it('returns empty description when no matching container exists', () => {
      const html = '<html><body><p>No job content here</p></body></html>';
      const result = parseAfryDetailPage(html);
      expect(result.description).toBe('');
    });
  });

  describe('parseAfryApiResponse', () => {
    it('filters Swiss jobs from global listings', () => {
      const data = {
        Adverts: [
          { Id: '1', Title: 'Engineer', Countries: [{ Id: 'CH' }], Cities: [{ Name: 'Zurich', CountryId: 'CH' }], CompetenceAreas: [] },
          { Id: '2', Title: 'Analyst', Countries: [{ Id: 'SE' }], Cities: [{ Name: 'Stockholm', CountryId: 'SE' }], CompetenceAreas: [] },
        ],
      };
      const result = parseAfryApiResponse(data) as { items: Array<{ title: string }>; totalGlobal: number; totalSwiss: number };
      expect(result.totalGlobal).toBe(2);
      expect(result.totalSwiss).toBe(1);
      expect(result.items[0].title).toBe('Engineer');
    });
  });

  describe('isAfryTicinoRelevant', () => {
    it('matches Ticino cities', () => {
      expect(isAfryTicinoRelevant({ cities: ['Airolo'], title: 'Geologo', location: 'Airolo' })).toBe(true);
      expect(isAfryTicinoRelevant({ cities: ['Bellinzona'], title: 'Ingegnere', location: 'Bellinzona' })).toBe(true);
    });

    it('matches Gottardo keywords in title', () => {
      expect(isAfryTicinoRelevant({ cities: [], title: 'Geologo - San Gottardo', location: '' })).toBe(true);
    });

    it('rejects non-Ticino locations', () => {
      expect(isAfryTicinoRelevant({ cities: ['Stockholm'], title: 'Developer', location: 'Stockholm' })).toBe(false);
    });
  });

  describe('inferAfryCanton', () => {
    it('infers GR for Chur', () => {
      expect(inferAfryCanton({ cities: ['Chur'], location: 'Chur' })).toBe('GR');
    });

    it('defaults to TI', () => {
      expect(inferAfryCanton({ cities: ['Bellinzona'], location: 'Bellinzona' })).toBe('TI');
    });
  });

  describe('inferAfryCategory', () => {
    it('maps geology to engineering', () => {
      expect(inferAfryCategory('Civil and Structural Engineering', 'Geologo Junior')).toBe('engineering');
    });

    it('maps software to it', () => {
      expect(inferAfryCategory('Digital', 'Software Developer')).toBe('it');
    });
  });

  describe('buildAfryLocalizedContent', () => {
    it('uses crawled description when rich enough', () => {
      const richDesc = Array(60).fill('word').join(' ');
      const result = buildAfryLocalizedContent({
        title: 'Test Job',
        location: 'Airolo',
        description: richDesc,
        competenceArea: 'Engineering',
      });
      expect(result.descriptionByLocale.it).toContain(richDesc);
    });

    it('generates fallback when description is thin', () => {
      const result = buildAfryLocalizedContent({
        title: 'Test Job',
        location: 'Airolo',
        description: 'Short desc',
        competenceArea: 'Engineering',
      });
      expect(result.descriptionByLocale.it).toContain('AFRY cerca Test Job');
      expect(result.descriptionByLocale.it).toContain("19.000 collaboratori");
    });
  });
});
