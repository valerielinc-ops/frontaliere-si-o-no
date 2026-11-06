import { describe, expect, it } from 'vitest';
import {
  buildGipoJobs,
  canonicalizeGipoUrl,
  extractGipoDetailFields,
  isGipoEngineeringVacancy,
  isTrustedDomain,
  GIPO_KEY,
} from '../scripts/lib/gipo-job-parser.mjs';
import { loadSpec, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';

const DETAIL_URL = 'https://www.gipo.ch/de/offene_stellen/senior-system-engineer-abc123/';
const SOURCE_DESCRIPTION = [
  'Wir suchen eine erfahrene Fachperson für die Weiterentwicklung unserer Infrastruktur und Plattformen.',
  'Sie planen und betreiben stabile Systeme, begleiten technische Projekte und arbeiten eng mit internen Teams zusammen.',
  'Zu Ihren Aufgaben gehören Analyse, Dokumentation, Fehlerbehebung, Automatisierung und die laufende Verbesserung der Servicequalität.',
  'GIPO bietet eine verantwortungsvolle Tätigkeit in einem kollegialen Umfeld mit modernen Werkzeugen und kurzen Entscheidungswegen.',
].join(' ');

const DETAIL_HTML = `<html lang="de"><head><title>GIPO | Karriere</title></head><body>
  <main>
    <h1>Senior System Engineer - Infrastruktur &amp; Plattformen</h1>
    <div class="facts"><span>Festanstellung</span>
      <a href="https://www.google.com/maps/search/?api=1&amp;query=Kohlplatzstrasse%2015%2C%206462%20Seedorf">Kohlplatzstrasse 15, 6462 Seedorf</a>
    </div>
    <section class="job-description"><p>${SOURCE_DESCRIPTION}</p></section>
  </main>
</body></html>`;

describe('GIPO source-backed crawler', () => {
  it('extracts the official title, full description, employment type and UR address', () => {
    const detail = extractGipoDetailFields(DETAIL_HTML, DETAIL_URL);
    expect(detail.title).toBe('Senior System Engineer - Infrastruktur & Plattformen');
    expect(detail.description).toContain('Weiterentwicklung unserer Infrastruktur');
    expect(detail.location).toBe('Seedorf');
    expect(detail.canton).toBe('UR');
    expect(detail.addressLocality).toBe('Seedorf');
    expect(detail.addressRegion).toBe('UR');
    expect(detail.addressCountry).toBe('CH');
    expect(detail.postalCode).toBe('6462');
    expect(detail.streetAddress).toBe('Kohlplatzstrasse 15');
    expect(detail.employmentType).toBe('FULL_TIME');
  });

  it('prefers an explicit employment enum over conflicting description prose', () => {
    const detail = extractGipoDetailFields(`
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'System Engineer',
        description: 'A full-time engineering role with part-time collaboration options.',
        employmentType: 'FULL_TIME',
      })}</script>
      <main><h1>System Engineer</h1><p>The role includes part-time collaboration options.</p></main>
    `, DETAIL_URL);
    expect(detail.employmentType).toBe('FULL_TIME');
  });

  it('keeps the source-specific safe default only for an unannotated official detail page', () => {
    const detail = extractGipoDetailFields(
      `<main><h1>System Engineer - Business Applications &amp; Workplace</h1><p>${SOURCE_DESCRIPTION}</p></main>`,
      DETAIL_URL,
    );
    expect(detail.location).toBe('Seedorf');
    expect(detail.canton).toBe('UR');
    expect(detail.postalCode).toBe('6462');
    expect(detail.streetAddress).toBe('Kohlplatzstrasse 15');
  });

  it('does not classify unrelated GIPO roles from words in their descriptions', () => {
    expect(isGipoEngineeringVacancy('Senior System Engineer - Infrastruktur & Plattformen')).toBe(true);
    expect(isGipoEngineeringVacancy('System Engineer - Business Applications & Workplace')).toBe(true);
    expect(isGipoEngineeringVacancy('Projektleiter Elektro')).toBe(true);
    expect(isGipoEngineeringVacancy('Chefmonteur Anlagenbau')).toBe(false);
  });

  it('emits only canonical official UR engineering jobs with mandatory fields', () => {
    const jobs = buildGipoJobs([
      {
        title: 'Projektleiter Elektro',
        description: SOURCE_DESCRIPTION,
        url: 'https://www.gipo.ch/de/offene_stellen/projektleiter-elektro-abc123/?source=careers#job',
        locationCandidates: [{
          location: 'Seedorf',
          addressLocality: 'Seedorf',
          addressRegion: 'UR',
          addressCountry: 'CH',
          postalCode: '6462',
          streetAddress: 'Kohlplatzstrasse 15',
        }],
        employmentType: 'FULL_TIME',
      },
      {
        title: 'Chefmonteur Anlagenbau',
        description: `${SOURCE_DESCRIPTION} Das Team arbeitet mit mehreren Engineer-Profilen zusammen.`,
        url: 'https://www.gipo.ch/de/offene_stellen/chefmonteur-abc123/',
        location: 'Seedorf',
        canton: 'UR',
      },
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      companyKey: GIPO_KEY,
      category: 'Ingegneria',
      sector: 'engineering',
      employmentType: 'FULL_TIME',
      baseSalary: null,
      addressLocality: 'Seedorf',
      addressRegion: 'UR',
      addressCountry: 'CH',
      postalCode: '6462',
      streetAddress: 'Kohlplatzstrasse 15',
      datePosted: '',
      postedDate: '',
      postingDateSource: 'unknown',
    });
    expect(jobs[0].url).toBe('https://gipo.ch/de/offene_stellen/projektleiter-elektro-abc123/');
    expect(jobs[0].applyUrl).toBe(jobs[0].url);
  });

  it('accepts only the official vacancy route and preserves the learned spec contract', () => {
    const spec = loadSpec(GIPO_KEY);
    expect(spec.seedUrls).toEqual(['https://gipo.ch/de/karriere-bei-gipo/stellenangebote-bei-gipo/']);
    expect(templateToRegex(spec.detailTemplate).test('/de/offene_stellen/projektleiter-elektro-abc123/')).toBe(true);
    expect(templateToRegex(spec.detailTemplate).test('/de/karriere-bei-gipo/stellenangebote-bei-gipo/')).toBe(false);
    expect(canonicalizeGipoUrl(DETAIL_URL)).toBe('https://gipo.ch/de/offene_stellen/senior-system-engineer-abc123/');
    expect(isTrustedDomain('https://gipo.ch/de/offene_stellen/job/')).toBe(true);
    expect(isTrustedDomain('https://jobs.gipo.ch/de/offene_stellen/job/')).toBe(false);
  });
});
