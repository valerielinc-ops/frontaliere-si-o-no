/**
 * Write-time upstream normalization (writeJobsCrawlerSlice funnel).
 *
 * Verifies that crawler output is hardened into the assembler's "best match"
 * shape BEFORE the slice is written, so corrupted locations never reach the
 * assemble-time Swiss whitelist and required metadata defaults are present —
 * without ever forging postalCode/streetAddress (the Swatch incident).
 */
import { describe, it, expect } from 'vitest';
import { normalizeParsedJobsForSlice } from '../../scripts/assemble-jobs-dataset.mjs';

interface JobLike {
  location?: string;
  url?: string;
  canton?: string;
  addressLocality?: string;
  addressCountry?: string;
  country?: string;
  addressRegion?: string;
  postalCode?: string;
  streetAddress?: string;
}

describe('normalizeParsedJobsForSlice', () => {
  it('cleans leaked body text out of location (mirrors assemble-time net)', () => {
    // Sentence-boundary cut at the first '.'; "Availability" prose is dropped.
    const jobs = [{ location: 'Location: Ticino, Switzerland.Availability to work flexible hours' }];
    const report = normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].location).toBe('Ticino, Switzerland');
    expect(report.locationFixed).toBe(1);
  });

  it('falls back to Ticino when the location is unsalvageable prose', () => {
    const jobs = [{ location: 'Location: ottima conoscenza della lingua italiana e disponibilità' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].location).toBe('Ticino');
  });

  it('preserves a clean city location', () => {
    const jobs: JobLike[] = [{ location: 'Lugano', addressLocality: 'Lugano' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].location).toBe('Lugano');
    expect(jobs[0].addressLocality).toBe('Lugano');
  });

  it('backfills addressLocality from location when missing', () => {
    const jobs: JobLike[] = [{ location: 'Bellinzona' }];
    const report = normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressLocality).toBe('Bellinzona');
    expect(report.localityBackfilled).toBe(1);
  });

  it('backfills addressLocality from location when it is an empty/whitespace string', () => {
    const empty: JobLike[] = [{ location: 'Lugano', addressLocality: '' }];
    const ws: JobLike[] = [{ location: 'Locarno', addressLocality: '   ' }];
    const r1 = normalizeParsedJobsForSlice(empty);
    const r2 = normalizeParsedJobsForSlice(ws);
    expect(empty[0].addressLocality).toBe('Lugano');
    expect(ws[0].addressLocality).toBe('Locarno');
    expect(r1.localityBackfilled).toBe(1);
    expect(r2.localityBackfilled).toBe(1);
  });

  it('defaults addressRegion to canton but leaves addressCountry/country undeclared (#5384)', () => {
    const jobs: JobLike[] = [{ location: 'Sion', canton: 'vs' }];
    const report = normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressCountry).toBeUndefined();
    expect(jobs[0].country).toBeUndefined();
    expect(jobs[0].addressRegion).toBe('VS');
    expect(report.regionDefaulted).toBe(1);
  });

  it('never forges postalCode or streetAddress', () => {
    const jobs: JobLike[] = [{ location: 'Lugano', canton: 'TI' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].postalCode).toBeUndefined();
    expect(jobs[0].streetAddress).toBeUndefined();
  });

  it('does not overwrite an existing addressCountry/addressRegion', () => {
    const jobs: JobLike[] = [{ location: 'Genève', canton: 'GE', addressCountry: 'FR', addressRegion: 'XX' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressCountry).toBe('FR');
    expect(jobs[0].addressRegion).toBe('XX');
  });

  it('is idempotent', () => {
    const jobs = [{ location: 'Location: Ticino.Requirements: x', canton: 'TI' }];
    normalizeParsedJobsForSlice(jobs);
    const snapshot = JSON.stringify(jobs[0]);
    const report2 = normalizeParsedJobsForSlice(jobs);
    expect(JSON.stringify(jobs[0])).toBe(snapshot);
    expect(report2.locationFixed).toBe(0);
    expect(report2.regionDefaulted).toBe(0);
  });

  it('tolerates non-object entries without throwing', () => {
    const jobs = [null, undefined, 'x', { location: 'Locarno' }] as unknown[];
    expect(() => normalizeParsedJobsForSlice(jobs)).not.toThrow();
    expect((jobs[3] as { addressLocality?: string }).addressLocality).toBe('Locarno');
  });
  it('rewrites a scheme-less url to its absolute form before the slice is written', () => {
    // Persisted scheme-less, `med-ipersonal.ch/jobs/1` becomes an href that
    // resolves relative to frontaliereticino.ch (broken apply CTA) and a
    // liveness probe that fails on the shape, not on the listing (#7769).
    const jobs: JobLike[] = [
      { url: 'med-ipersonal.ch/jobs/1' },
      { url: 'med-ipersonal.ch:8080/jobs/1' },
      { url: 'https://med-ipersonal.ch/jobs/2' },
      { url: 'mailto:jobs@med-ipersonal.ch' },
    ];
    const report = normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].url).toBe('https://med-ipersonal.ch/jobs/1');
    expect(jobs[1].url).toBe('https://med-ipersonal.ch:8080/jobs/1');
    expect(jobs[2].url).toBe('https://med-ipersonal.ch/jobs/2');
    expect(jobs[3].url).toBe('mailto:jobs@med-ipersonal.ch');
    expect(report.urlNormalized).toBe(2);
  });

  it('leaves a missing or blank url alone (no invented https:// row)', () => {
    const jobs: JobLike[] = [{ location: 'Lugano' }, { url: '   ' }];
    const report = normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].url).toBeUndefined();
    expect(jobs[1].url).toBe('   ');
    expect(report.urlNormalized).toBe(0);
  });
});
