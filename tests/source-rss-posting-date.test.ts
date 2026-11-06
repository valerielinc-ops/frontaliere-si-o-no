import { describe, expect, it } from 'vitest';
import { sourceRssPostingDateFields } from '../scripts/lib/source-posting-date.mjs';

describe('RSS publication provenance', () => {
  const year = new Date().getUTCFullYear();
  const now = new Date(`${year}-03-01T00:30:00Z`);

  it('preserves the source offset across the UTC day boundary', () => {
    const boundaryNow = new Date(Date.UTC(year, 2, 1) - 30 * 60_000);
    const result = sourceRssPostingDateFields(`01 Mar ${year} 01:00:00 +0200`, boundaryNow);
    expect(result.postingDateSource).toBe('reported');
    expect(result.datePosted).toBe(`${year}-03-01T01:00:00+02:00`);
  });

  it('rejects a future instant even when its source date is today', () => {
    expect(sourceRssPostingDateFields(`01 Mar ${year} 00:00:00 -0200`, now).postingDateSource).toBe('unknown');
  });

  it.each(['GMT', 'UTC', 'UT', 'Z'])('accepts explicit zero-offset zone %s', zone => {
    expect(sourceRssPostingDateFields(`01 Mar ${year} 00:00:00 ${zone}`, now).datePosted).toBe(`${year}-03-01T00:00:00Z`);
  });

  it.each(['30 Feb YEAR 12:00:00 GMT', '01 Mar YEAR 24:00:00 GMT', '01 Mar YEAR 00:00:00 +2560', '01 Mar YEAR 00:00:00', '', 'invalid'])('rejects invalid or ambiguous source %s', raw => {
    expect(sourceRssPostingDateFields(raw.replace('YEAR', String(year)), now)).toEqual({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  });

  it('preserves already ISO-formatted publication dates', () => {
    expect(sourceRssPostingDateFields(`${year}-02-01T12:00:00Z`, now).datePosted).toBe(`${year}-02-01T12:00:00Z`);
  });
});
