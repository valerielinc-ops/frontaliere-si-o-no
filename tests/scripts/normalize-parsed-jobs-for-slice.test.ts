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
    const jobs = [{ location: 'Lugano', addressLocality: 'Lugano' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].location).toBe('Lugano');
    expect(jobs[0].addressLocality).toBe('Lugano');
  });

  it('backfills addressLocality from location when missing', () => {
    const jobs = [{ location: 'Bellinzona' }];
    const report = normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressLocality).toBe('Bellinzona');
    expect(report.localityBackfilled).toBe(1);
  });

  it('defaults addressCountry/country to CH and addressRegion to canton', () => {
    const jobs = [{ location: 'Sion', canton: 'vs' }];
    const report = normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressCountry).toBe('CH');
    expect(jobs[0].country).toBe('CH');
    expect(jobs[0].addressRegion).toBe('VS');
    expect(report.countryDefaulted).toBe(1);
    expect(report.regionDefaulted).toBe(1);
  });

  it('never forges postalCode or streetAddress', () => {
    const jobs = [{ location: 'Lugano', canton: 'TI' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].postalCode).toBeUndefined();
    expect(jobs[0].streetAddress).toBeUndefined();
  });

  it('does not overwrite an existing addressCountry/addressRegion', () => {
    const jobs = [{ location: 'Genève', canton: 'GE', addressCountry: 'FR', addressRegion: 'XX' }];
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
    expect(report2.countryDefaulted).toBe(0);
  });

  it('tolerates non-object entries without throwing', () => {
    const jobs = [null, undefined, 'x', { location: 'Locarno' }] as unknown[];
    expect(() => normalizeParsedJobsForSlice(jobs)).not.toThrow();
    expect((jobs[3] as { addressLocality?: string }).addressLocality).toBe('Locarno');
  });
});
