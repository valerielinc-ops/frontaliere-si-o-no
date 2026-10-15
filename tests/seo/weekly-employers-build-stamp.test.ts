import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWeeklyEmployersDate,
  getIsoWeekAndYear,
} from '../../build-plugins/weeklyEmployersData';

describe('weekly employers build date', () => {
  it('rehydrates an explicit UTC stamp across an ISO-week boundary', () => {
    const buildDate = buildWeeklyEmployersDate('2026-09-14');

    expect(buildDate.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(getIsoWeekAndYear(buildDate)).toEqual({ week: 38, year: 2026 });
  });

  it('does not read the shard process wall clock in closeBundle', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'build-plugins/weeklyEmployersPlugin.ts'),
      'utf8',
    );

    expect(source).toContain(
      'const today = buildWeeklyEmployersDate(BUILD_DATE_STAMP);',
    );
  });
});
