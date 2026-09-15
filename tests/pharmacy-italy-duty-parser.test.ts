import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  localDateTimeToItalyIso,
  parseItalyDutySource,
  resolveItalyDutyProvince,
} from '../scripts/lib/pharmacy-italy-duty-parser.mjs';

const sources = JSON.parse(readFileSync(new URL('../data/pharmacy-duties-italy-sources.json', import.meta.url), 'utf8'));
const catalogue = JSON.parse(readFileSync(new URL('../data/pharmacies-italy-border.json', import.meta.url), 'utf8'));
const FIXTURE_DIR = new URL('./fixtures/pharmacy-duties/italy/', import.meta.url);
const FETCHED_AT = '2026-09-15T10:00:00.000Z';

describe('Italian official duty parser', () => {
  it('parses the three official provincial fixture formats and keeps the province', () => {
    const results = sources.sources.map((source: { key: string; fixturePath: string }) => {
      const raw = readFileSync(new URL(`${source.fixturePath}/source.txt`, FIXTURE_DIR), 'utf8');
      return parseItalyDutySource(raw, source, { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue });
    });

    expect(results.map((result: { province: string }) => result.province)).toEqual(['CO', 'VA', 'VB']);
    expect(results.every((result: { duties: unknown[]; observedDuties: unknown[]; errors: string[]; freshness: string; coverage: string }) => (
      result.duties.length === 0
      && result.observedDuties.length > 0
      && result.errors.some((error) => error.includes('coverage is incomplete'))
      && result.freshness === 'fresh'
      && result.coverage === 'partial'
    ))).toBe(true);
    expect(results.flatMap((result: { observedDuties: Array<{ province: string }> }) => result.observedDuties).every((duty) => ['CO', 'VA', 'VB'].includes(duty.province))).toBe(true);
  });

  it('uses Europe/Rome, including the autumn DST boundary', () => {
    expect(localDateTimeToItalyIso('15/09/2026', '08:30')).toBe('2026-09-15T06:30:00.000Z');
    expect(localDateTimeToItalyIso('25/10/2026', '08:30')).toBe('2026-10-25T07:30:00.000Z');
  });

  it('evaluates validity windows on the Europe/Rome calendar date', () => {
    const como = sources.sources.find((source: { province: string }) => source.province === 'CO');
    const result = parseItalyDutySource(
      'PROVINCIA DI COMO\n05/09/2026 Appiano Cavour',
      como,
      { fetchedAt: '2026-06-01T00:30:00.000Z', asOf: '2026-05-31T22:30:00.000Z', catalogue },
    );
    expect(result.errors).not.toContain('official calendar is outside its declared validity window');
  });

  it('fails closed when province evidence is conflicting or an explicit row omits it', () => {
    const como = sources.sources.find((source: { province: string }) => source.province === 'CO');
    expect(resolveItalyDutyProvince('Calendario Provincia di Como e Provincia di Varese', 'CO').error).toContain('outside CO');

    const result = parseItalyDutySource(
      'DUTY|date=15/09/2026|label=Appiano Cavour|pharmacyId=it-msal-2088|province=',
      como,
      { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue },
    );
    expect(result.duties).toEqual([]);
    expect(result.warnings.join(' ')).toContain('missing or conflicting province');
  });

  it('does not publish an unknown or ambiguous source province', () => {
    const result = parseItalyDutySource(
      'DUTY|date=15/09/2026|label=Appiano Cavour|pharmacyId=it-msal-2088|province=VA',
      { ...sources.sources[0], province: 'CO' },
      { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue },
    );
    expect(result.duties).toEqual([]);
    expect(result.errors).toContain('source contains a province marker outside CO');
  });

  it('drops the whole province when one otherwise valid feed row is malformed', () => {
    const como = sources.sources.find((source: { province: string }) => source.province === 'CO');
    const result = parseItalyDutySource(
      [
        'PROVINCIA DI COMO',
        'DUTY|date=15/09/2026|label=Albese|pharmacyId=it-msal-2192|province=CO',
        'DUTY|date=not-a-date|label=Albavilla|pharmacyId=it-msal-2166|province=CO',
      ].join('\n'),
      como,
      { fetchedAt: FETCHED_AT, asOf: FETCHED_AT, catalogue },
    );
    expect(result.duties).toEqual([]);
    expect(result.errors.some((error: string) => error.includes('invalid date'))).toBe(true);
  });
});
