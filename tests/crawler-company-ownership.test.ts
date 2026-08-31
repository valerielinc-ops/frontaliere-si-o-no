import { describe, expect, it } from 'vitest';
import {
  dedicatedFribourgOwner,
  dedicatedMigrosOwner,
  dedicatedPostOwner,
  isCantonTicinoOscPosting,
  isDedicatedFribourgEmployer,
  isDedicatedPostBrand,
} from '../scripts/lib/crawler-company-ownership.mjs';

describe('shared career-board ownership', () => {
  it('keeps Denner and migrolino out of the Migros umbrella slice', () => {
    expect(dedicatedMigrosOwner('https://jobs.migros.ch/de/unsere-unternehmen/job/denner-ag/title/id')).toBe('denner');
    expect(dedicatedMigrosOwner('https://jobs.migros.ch/de/unsere-unternehmen/job/denner-partner-betriebe/title/id')).toBe('denner');
    expect(dedicatedMigrosOwner('https://jobs.migros.ch/de/unsere-unternehmen/job/migrolino/title/id')).toBe('migrolino');
    expect(dedicatedMigrosOwner('https://jobs.migros.ch/de/unsere-unternehmen/job/fitnesspark/title/id')).toBeNull();
  });

  it('recognises dedicated Swiss Post brands in all published languages', () => {
    expect(dedicatedPostOwner('PostAuto AG')).toBe('postauto');
    expect(dedicatedPostOwner('CarPostal')).toBe('postauto');
    expect(dedicatedPostOwner('PostBus Ltd')).toBe('postauto');
    expect(dedicatedPostOwner('AutoPostale SA')).toBe('postauto');
    expect(dedicatedPostOwner('PostFinance')).toBe('postfinance');
    expect(dedicatedPostOwner('Die Schweizerische Post')).toBeNull();
    expect(isDedicatedPostBrand('PostAuto AG')).toBe(true);
    expect(isDedicatedPostBrand('CarPostal')).toBe(true);
    expect(isDedicatedPostBrand('PostFinance')).toBe(true);
    expect(isDedicatedPostBrand('Die Schweizerische Post')).toBe(false);
  });

  it('separates RFSM/FNPG and HFR from the Fribourg administration', () => {
    expect(dedicatedFribourgOwner({ title: 'Infirmier-ère HES/ES, RFSM Marsens' })).toBe('rfsm-fribourg');
    expect(dedicatedFribourgOwner({ title: 'Pflegefachperson FNPG' })).toBe('rfsm-fribourg');
    expect(dedicatedFribourgOwner({ title: 'Infirmier-ère, HFR Fribourg' })).toBe('hfr-hopital-fribourgeois');
    expect(dedicatedFribourgOwner({ title: 'Greffier-ère stagiaire' })).toBeNull();
    expect(isDedicatedFribourgEmployer({ title: 'Infirmier-ère HES/ES, RFSM Marsens' })).toBe(true);
    expect(isDedicatedFribourgEmployer({ title: 'Pflegefachperson FNPG' })).toBe(true);
    expect(isDedicatedFribourgEmployer({ title: 'Infirmier-ère, HFR Fribourg' })).toBe(true);
    expect(isDedicatedFribourgEmployer({ title: 'Greffier-ère stagiaire' })).toBe(false);
  });

  it('assigns only explicit OSC vacancies to the specialist Ticino crawler', () => {
    expect(isCantonTicinoOscPosting({ title: 'Medico capo clinica presso l’Organizzazione sociopsichiatrica cantonale (OSC)' })).toBe(true);
    expect(isCantonTicinoOscPosting({ title: 'Assistente di farmacia presso l’Ufficio del farmacista cantonale' })).toBe(false);
    expect(isCantonTicinoOscPosting({ title: 'Medico AI presso il Servizio medico regionale' })).toBe(false);
  });
});
