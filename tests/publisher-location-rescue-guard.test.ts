/**
 * Regression guard for the publisher-intake location rescue.
 *
 * assemble-jobs-dataset.mjs's Swiss-city whitelist filter dropped any job
 * whose `addressLocality`/`location` was neither a known BFS municipality
 * nor a canton-only label ("Ticino", "TI") — with no second chance, even
 * when the job carried a valid structured `canton` field. Publisher-intake
 * jobs default `location` to the company name when the submitter leaves the
 * city field free-text-garbage (e.g. "Fisiocare Sagl" instead of "Lugano"),
 * so a job with a real Swiss city named in its description and a correct
 * canton was silently dropped from the search index — while its `/lavoro/`
 * SSG page stayed live via safe structured-data defaults, making the job
 * page reachable but unsearchable. `acceptBadLocalityViaCanton()` gives the
 * canton field the same second-chance anchor a canton-only label already
 * got: a Swiss postal code on record, or a real Swiss city in the
 * description text.
 */
import { describe, expect, it } from 'vitest';
import { acceptBadLocalityViaCanton, isSwissPostalCode } from '../scripts/assemble-jobs-dataset.mjs';

describe('acceptBadLocalityViaCanton', () => {
  it('rescues via a Swiss city named in the description (Fisiocare Sagl case)', () => {
    const haystack = 'Cerchiamo un fisioterapista per il nostro studio nel Luganese. Contatto: fisiocare.lugano@gmail.com';
    expect(acceptBadLocalityViaCanton('TI', '', haystack)).toBe(true);
  });

  it('rescues via a valid Swiss postal code even with no city in the description', () => {
    expect(acceptBadLocalityViaCanton('TI', '6900', 'Azienda leader nel settore')).toBe(true);
  });

  it('rejects when canton is not a target canton', () => {
    expect(acceptBadLocalityViaCanton('', '6900', 'Cerchiamo a Lugano')).toBe(false);
    expect(acceptBadLocalityViaCanton('ZZ', '6900', 'Cerchiamo a Lugano')).toBe(false);
  });

  it('rejects when canton is valid but neither postal code nor description city anchor it', () => {
    expect(acceptBadLocalityViaCanton('TI', '', 'Azienda leader nel settore, ottimo stipendio')).toBe(false);
  });
});

describe('isSwissPostalCode', () => {
  it('accepts BFS-range 4-digit codes', () => {
    expect(isSwissPostalCode('6900')).toBe(true);
    expect(isSwissPostalCode(6900)).toBe(true);
  });

  it('rejects out-of-range or malformed codes', () => {
    expect(isSwissPostalCode('99999')).toBe(false);
    expect(isSwissPostalCode('abc')).toBe(false);
    expect(isSwissPostalCode('')).toBe(false);
    expect(isSwissPostalCode(null)).toBe(false);
  });
});
