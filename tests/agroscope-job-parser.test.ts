import { describe, expect, it } from 'vitest';

import {
  cleanAgroscopeCity,
  extractAgroscopeDetailLocation,
  isAgroscopeSwissRelevant,
  reconcileAgroscopeDetailLocation,
  resolveAgroscopeCanton,
} from '../scripts/lib/agroscope-job-parser.mjs';

describe('agroscope job parser location normalization', () => {
  it('accepts one PLZ-city hyphen but keeps separator-only input fail-closed', () => {
    expect(cleanAgroscopeCity('6593 Cadenazzo')).toBe('Cadenazzo');
    expect(cleanAgroscopeCity('6593-Cadenazzo')).toBe('Cadenazzo');
    expect(resolveAgroscopeCanton({ city: '6593-Cadenazzo' })).toBe('TI');

    expect(cleanAgroscopeCity('6593--')).toBe('6593--');
    expect(cleanAgroscopeCity('6593--Cadenazzo')).toBe('6593--Cadenazzo');
    expect(resolveAgroscopeCanton({ city: '6593--' })).toBe('');
  });

  it('requires a concrete Swiss city instead of trusting a canton-only label', () => {
    expect(isAgroscopeSwissRelevant({ city: 'Zürich', canton: 'ZH' })).toBe(true);
    expect(isAgroscopeSwissRelevant({ city: 'Posieux', canton: 'FR' })).toBe(true);
    expect(isAgroscopeSwissRelevant({ city: 'Milano', region: 'BE', canton: 'BE' })).toBe(false);
    expect(isAgroscopeSwissRelevant({ city: '', region: 'ZH', canton: 'ZH' })).toBe(false);
  });

  it('uses the detail JobPosting workplace when the listing carries a stale station', () => {
    const posting = {
      '@type': 'JobPosting',
      jobLocation: {
        address: {
          addressLocality: 'Wädenswil',
          addressRegion: 'Wädenswil',
          postalCode: '8820',
          addressCountry: 'CH',
        },
      },
    };

    expect(extractAgroscopeDetailLocation(posting)).toEqual({
      city: 'Wädenswil',
      location: 'Wädenswil',
      canton: 'ZH',
      postalCode: '8820',
    });
    expect(reconcileAgroscopeDetailLocation({
      title: 'Praktikum',
      city: 'Reckenholz',
      description: 'Forschungsaufgabe',
      language: 'de',
    }, posting)).toMatchObject({
      city: 'Wädenswil',
      canton: 'ZH',
      slug: 'praktikum-agroscope-wadenswil',
    });
  });
});
