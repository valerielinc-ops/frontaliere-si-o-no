import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));

vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchHtml,
}));

import {
  CLINICA_VARINI_COMPANY_NAME,
  fetchAllClinicaVariniJobs,
  isClinicaVariniJob,
  isTrustedDomain,
  parseClinicaVariniListing,
} from '../scripts/lib/clinica-varini-job-parser.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';

const EMPTY_NEWS_PAGE = [
  '<html>',
  '  <head><title>Notizie - Clinica Fondazione Varini</title></head>',
  '  <body>',
  '    <main>',
  '      <a class="download" href="/wp-content/uploads/2026/01/comunicato_stampa_risultati.pdf">Comunicato</a>',
  '      <a data-kind="news" href="/wp-content/uploads/2026/01/vernissage_nel_respiro.pdf?download=1">Vernissage</a>',
  '      <a href="https://clinicavarini.ch/wp-content/uploads/2026/01/attestato_qualita.pdf">Attestato</a>',
  '    </main>',
  '  </body>',
  '</html>',
].join('\n');

describe('Clinica Varini crawler parser', () => {
  it('matches company identity and trusted source URLs', () => {
    expect(isClinicaVariniJob({ companyKey: 'clinica-varini' })).toBe(true);
    expect(isClinicaVariniJob({ company: 'Clinica Varini' })).toBe(true);
    expect(isClinicaVariniJob({ url: 'https://clinicavarini.ch/wp-content/uploads/job.pdf' })).toBe(true);
    expect(isClinicaVariniJob({ companyKey: 'other-company', company: 'Other', url: 'https://example.com/jobs' })).toBe(false);
    expect(isTrustedDomain('https://clinicavarini.ch/notizie/')).toBe(true);
    expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
  });

  it('proves an empty source when every discovered PDF is a known non-job document', () => {
    const jobs = parseClinicaVariniListing(EMPTY_NEWS_PAGE);

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect(Reflect.get(jobs, 'authoritativeEmptyEvidence')).toMatch(/3 PDF attachment/);
  });

  it('keeps a zero unproven when an unknown PDF could be a renamed vacancy', () => {
    const jobs = parseClinicaVariniListing(
      EMPTY_NEWS_PAGE
        + '\n<a href="/wp-content/uploads/2026/09/personale_sanitario.pdf">Documento</a>',
    );

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('ignores off-domain PDFs as empty-source evidence', () => {
    const jobs = parseClinicaVariniListing(
      '<a href="https://cdn.example/privacy.pdf">Privacy</a>',
    );

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('does not prove empty when a job-token filename also contains a non-job word', () => {
    const jobs = parseClinicaVariniListing([
      '<a href="/wp-content/uploads/2026/09/20260930_concorso_addetto_stampa.pdf">Concorso</a>',
      '<a href="/wp-content/uploads/2026/09/comunicato_stampa.pdf">Comunicato</a>',
    ].join('\n'));

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('keeps malformed percent-encoding fail-closed without throwing', () => {
    const jobs = parseClinicaVariniListing(
      "<a href='/wp-content/uploads/%E0%A4.pdf'>Documento</a>",
    );

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('keeps an unrecognised page fail-closed', () => {
    const jobs = parseClinicaVariniListing('<html><body><h1>Service unavailable</h1></body></html>');

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('preserves source-empty evidence through the fetcher', async () => {
    fetchHtml.mockResolvedValueOnce(EMPTY_NEWS_PAGE);

    const jobs = await fetchAllClinicaVariniJobs();

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
  });

  it('wires the source-proof contract into the standard runner', () => {
    const runner = readFileSync(new URL('../scripts/update-clinica-varini-jobs.mjs', import.meta.url), 'utf8');

    expect(runner).toContain('authoritativeEmptySnapshotValidator(CLINICA_VARINI_COMPANY_NAME)');
    expect(runner).toContain('allowAuthoritativeEmptySnapshot: true');
    expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");
    expect(CLINICA_VARINI_COMPANY_NAME).toBe('Clinica Varini');
  });
});
