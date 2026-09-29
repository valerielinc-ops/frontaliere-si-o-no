import { describe, it, expect } from 'vitest';
import { dropIdenticalPostings, identicalPostingKey } from '../scripts/lib/identical-posting-dedupe.mjs';

// Shapes minimised from the 2026-09-29 dataset (audit run 36528331656,
// duplicate-descriptions): Hirslanden re-posts a requisition under a second
// SuccessFactors job id with the same Referenznummer; Lonza opens a second
// Workday req with the same ad; Otis and Selecta publish two reqs whose texts
// differ only past the audit's 500-character window (kept).
const BODY = 'Arbeitsort: Salem-Spital, Klinik Beau-Site oder Klinik Permanence\n\nBesetzung per: nach Vereinbarung\n\nReferenznummer: 43018\n\nSuchst du eine neue Herausforderung in der Pflege?';

// Grouping needs a fully resolved workplace (locality, postal code, street),
// so the fixtures carry all three; the dataset rows of these crawlers do not
// always have them, and then nothing is grouped (last case below).
const VISP = { location: 'Visp', addressLocality: 'Visp', postalCode: '3930', streetAddress: 'Lonzastrasse' };

function job(url: string, overrides: Record<string, unknown> = {}) {
  return {
    title: 'Dipl. Pflegefachfrau / Pflegefachmann Hirslanden Bern (a) 20-100%',
    location: 'Bern',
    addressLocality: 'Bern',
    postalCode: '3013',
    streetAddress: 'Schänzlistrasse 39',
    sourceLang: 'de',
    description: BODY,
    descriptionByLocale: { de: BODY },
    url,
    ...overrides,
  };
}

describe('dropIdenticalPostings', () => {
  it('keeps one posting per double publication, the one with the lowest stable id', () => {
    const newer = job('https://careers.mediclinic.com/Hirslanden/job/Hirslanden-Salem-Spital-Dipl_-Pflegefachfrau/1124147801/');
    const older = job('https://careers.mediclinic.com/Hirslanden/job/Hirslanden-Salem-Spital-Dipl_-Pflegefachfrau/1123876301/');
    const { jobs, dropped } = dropIdenticalPostings([newer, older]);
    expect(jobs).toEqual([older]);
    expect(dropped).toEqual([newer]);
    // Order of the input does not change the choice.
    expect(dropIdenticalPostings([older, newer]).jobs).toEqual([older]);
  });

  it('compares the whole text case- and whitespace-insensitively', () => {
    const a = job('https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers/job/CH---Visp/Elektroinstallateur-EFZ-80-100---m-w-d-_R76184-1', { title: 'Elektroinstallateur EFZ 80-100% (m/w/d)', ...VISP });
    const b = job('https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers/job/CH---Visp/Elektroinstallateur-EFZ-80-100---m-w-d-_R76397', {
      title: 'Elektroinstallateur EFZ 80-100% (m/w/d)', ...VISP,
      description: BODY.replace(/\n\n/g, '\n  \n'), descriptionByLocale: { de: BODY.replace(/\n\n/g, '\n  \n') },
    });
    expect(identicalPostingKey(a)).toBe(identicalPostingKey(b));
    expect(dropIdenticalPostings([b, a]).jobs).toEqual([a]);
  });

  it('treats titles that differ only by the gender marker as the same title', () => {
    // Lonza, Visp, 2026-09-29: R76163-1 "(m/f/d)" and R76165-1 "(m/w/d)", same text.
    const mf = job('https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers/job/CH---Visp/Biotechnologist-100---m-f-d-_R76163-1', { title: 'Biotechnologist 100% (m/f/d)', ...VISP });
    const mw = job('https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers/job/CH---Visp/Biotechnologist-100----m-w-d-_R76165-1', { title: 'Biotechnologist 100% (m/w/d)', ...VISP });
    expect(dropIdenticalPostings([mw, mf]).jobs).toEqual([mf]);
    // Any other word of the title still tells two roles apart.
    const senior = job('https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers/job/CH---Visp/Senior-Biotechnologist_R76199', { title: 'Senior Biotechnologist 100% (m/w/d)', ...VISP });
    expect(dropIdenticalPostings([mw, senior]).jobs).toHaveLength(2);
  });

  it('ignores recruiting-campaign hashtag lines when comparing the text', () => {
    // Hirslanden Referenznummer 43018, 2026-09-29: the re-post only appends
    // "#ebkampagne #pflege".
    const tagged = `${BODY}\n\n#ebkampagne #pflege`;
    const a = job('https://careers.mediclinic.com/Hirslanden/job/Hirslanden-Salem-Spital/1007595601/', { description: tagged, descriptionByLocale: { de: tagged } });
    const b = job('https://careers.mediclinic.com/Hirslanden/job/Hirslanden-Salem-Spital/1123876301/');
    expect(dropIdenticalPostings([b, a]).jobs).toEqual([a]);
    // A hashtag inside a sentence is text, not a tag line.
    const inline = `${BODY}\nWir suchen #Pflegefachpersonen mit Herz.`;
    const c = job('https://careers.mediclinic.com/Hirslanden/job/Hirslanden-Salem-Spital/1200000001/', { description: inline, descriptionByLocale: { de: inline } });
    expect(dropIdenticalPostings([b, c]).jobs).toHaveLength(2);
  });

  it('keeps postings whose text differs anywhere, even far past the first 500 characters', () => {
    const shiftA = `${'Einleitung. '.repeat(80)}Arbeitsort Kirchberg BE - (Montag bis Freitag von 12:00 Uhr bis 22:00 Uhr)`;
    const shiftB = `${'Einleitung. '.repeat(80)}Arbeitsort Kirchberg BE - (Montag bis Freitag von 05:00 Uhr bis 15:00 Uhr)`;
    const a = job('https://careers.selecta.ch/Job/4601', { title: 'Chauffeur Kat. C und E (m/w/d)', location: 'Kirchberg BE', description: shiftA, descriptionByLocale: { de: shiftA } });
    const b = job('https://careers.selecta.ch/Job/4600', { title: 'Chauffeur Kat. C und E (m/w/d)', location: 'Kirchberg BE', description: shiftB, descriptionByLocale: { de: shiftB } });
    expect(dropIdenticalPostings([a, b]).jobs).toHaveLength(2);
  });

  it('keeps the same ad at different workplaces (locality or postal code) and never groups empty bodies', () => {
    const bern = job('https://careers.mediclinic.com/Hirslanden/job/x/1/');
    const aarau = job('https://careers.mediclinic.com/Hirslanden/job/x/2/', { location: 'Aarau', addressLocality: 'Aarau' });
    expect(dropIdenticalPostings([bern, aarau]).jobs).toHaveLength(2);
    // Denner, 2026-09-29: the same store role in two Zürich stores.
    const store8048 = job('https://jobs.migros.ch/de/unsere-unternehmen/job/denner-ag/stv-filialleiterin/055dc2ed-900f-49a7-91cd-d259678cd1db', { location: 'Zürich', addressLocality: 'Zürich', postalCode: '8048', streetAddress: 'Denner Zürich' });
    const store8050 = job('https://jobs.migros.ch/de/unsere-unternehmen/job/denner-ag/stv-filialleiterin/db0efd20-5349-410c-ad6f-def6d41c05d8', { location: 'Zürich', addressLocality: 'Zürich', postalCode: '8050', streetAddress: 'Denner Zürich' });
    expect(dropIdenticalPostings([store8048, store8050]).jobs).toHaveLength(2);
    const emptyA = job('https://careers.mediclinic.com/Hirslanden/job/x/3/', { description: '', descriptionByLocale: {} });
    const emptyB = job('https://careers.mediclinic.com/Hirslanden/job/x/4/', { description: '', descriptionByLocale: {} });
    expect(dropIdenticalPostings([emptyA, emptyB]).jobs).toHaveLength(2);
  });

  it('never groups postings whose workplace is not fully resolved', () => {
    // Otis leaves the locality blank when a req names none: two reqs with the
    // same title and text but no locality, postal code or street may be two
    // workplaces, so both are kept.
    const unresolved = { location: '', addressLocality: '', postalCode: '', streetAddress: '' };
    const a = job('https://otis.wd5.myworkdayjobs.com/en-US/REC_Ext_Gateway/job/Servicetechniker_20001', unresolved);
    const b = job('https://otis.wd5.myworkdayjobs.com/en-US/REC_Ext_Gateway/job/Servicetechniker_20002', unresolved);
    expect(identicalPostingKey(a)).toBe('');
    expect(dropIdenticalPostings([a, b]).jobs).toHaveLength(2);
    // A partial workplace is not resolved either: locality alone, or locality
    // and postal code without the street.
    const localityOnly = { postalCode: '', streetAddress: '' };
    expect(dropIdenticalPostings([job('https://c/job/x/5/', localityOnly), job('https://c/job/x/6/', localityOnly)]).jobs).toHaveLength(2);
    const noStreet = { streetAddress: '' };
    expect(dropIdenticalPostings([job('https://c/job/x/7/', noStreet), job('https://c/job/x/8/', noStreet)]).jobs).toHaveLength(2);
  });
});
