import { describe, expect, it } from 'vitest';

import { __internals as lonzaInternals } from '../scripts/lib/lonza-job-parser.mjs';
import { __internals as ubsInternals } from '../scripts/lib/ubs-job-parser.mjs';

function ubsTaleoJob(reqid: string, title: string, region: string, city = '') {
  return {
    Questions: [
      { QuestionName: 'reqid', Value: reqid },
      { QuestionName: 'jobtitle', Value: title },
      { QuestionName: 'jobdescription', Value: '<p>UBS role</p>' },
      { QuestionName: 'formtext23', Value: region },
      { QuestionName: 'formtext2', Value: city },
      { QuestionName: 'department', Value: 'Personal & Corporate Banking' },
      { QuestionName: 'formtext21', Value: 'Kundenberatung' },
      { QuestionName: 'lastupdated', Value: '01-Jun-2026' },
      { QuestionName: 'jobreqlanguage', Value: '23' },
    ],
  };
}

describe('CH-wide crawler scope guards', () => {
  it('keeps UBS Swiss-region Taleo rows and derives canton/location', () => {
    const job = ubsInternals.buildJobFromTaleo(
      ubsTaleoJob('347001', 'Privatkundenberater/in Retail Zürich', 'Schweiz - Zürich')
    );

    expect(job).toMatchObject({
      companyKey: 'ubs',
      location: 'Zürich',
      canton: 'ZH',
      country: 'CH',
    });
  });

  it('rejects UBS global Taleo rows from non-Swiss regions', () => {
    expect(
      ubsInternals.buildJobFromTaleo(
        ubsTaleoJob('347002', 'Client Associate', 'United States - New York')
      )
    ).toBeNull();
  });

  it('uses non-Ticino safe defaults for UBS Swiss macro-regions', () => {
    const job = ubsInternals.buildJobFromTaleo(
      ubsTaleoJob('347003', 'Spécialiste Crédits 80-100%', 'Suisse - Suisse romande')
    );

    expect(job).toMatchObject({
      location: 'Suisse romande',
      canton: 'VD',
      country: 'CH',
    });
  });

  it('does not turn Lonza country-only CH locations into Visp', () => {
    expect(
      lonzaInternals.resolveWorkdayLocation(
        { location: 'CH', additionalLocations: [] },
        { locationsText: 'CH' }
      )
    ).toBeNull();
  });

  it('uses Lonza additional Swiss locations when the primary field is generic', () => {
    expect(
      lonzaInternals.resolveWorkdayLocation(
        { location: '2 Locations', additionalLocations: [{ descriptor: 'Stein - Switzerland' }] },
        { locationsText: 'CH' }
      )
    ).toEqual({ city: 'Stein', canton: 'AG' });
  });
});
