import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveReportedPostingDate } from '../scripts/lib/job-posting-date.mjs';
import { mergeSourcePostingDates, sourcePostingDateFields } from '../scripts/lib/source-posting-date.mjs';

// Explicit reference clocks keep recorded employer evidence independent of wall time.
const now = new Date('2026-07-11T00:00:00Z');
const resolve = (datePosted: string, reference = now) =>
  resolveReportedPostingDate({ postingDateSource: 'reported', datePosted }, reference);

describe('lossless employer publication microseconds', () => {
  it('preserves the exact datePosted from the recorded McDonald’s JobPosting', () => {
    const html = readFileSync(new URL('./fixtures/mcdonalds-job-p8-317484-1.html', import.meta.url), 'utf8');
    const script = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(script).not.toBeNull();
    const node = JSON.parse(script![1]);
    expect(node.url).toBe('https://jobs.mcdonalds.ch/fr-ch/agent-e-de-maintenance/job/P8-317484-1');
    expect(node.datePosted).toBe('2026-07-10T08:12:10.733560+00:00');
    expect(resolve(node.datePosted)).toBe(node.datePosted);
    expect(sourcePostingDateFields(node.datePosted, now)).toEqual({
      datePosted: node.datePosted, postedDate: node.datePosted, postingDateSource: 'reported',
    });
  });

  it.each(['7', '73', '733', '7335', '73356', '733560'])('preserves %s fractional digits and the offset', (fraction) => {
    const value = `2026-07-10T10:12:10.${fraction}+02:00`;
    expect(resolve(value)).toBe(value);
  });

  it.each([
    '2026-07-10T08:12:10.733001Z',
    '2026-07-10T10:12:10.733001+02:00',
    '2026-07-10T03:12:10.733001-05:00',
  ])('rejects a submillisecond future instant: %s', (value) => {
    const boundary = new Date('2026-07-10T08:12:10.733Z');
    expect(Date.parse(value)).toBe(boundary.getTime());
    expect(resolve(value, boundary)).toBeNull();
  });

  it('accepts trailing zero precision at the exact reference instant without rewriting it', () => {
    const value = '2026-07-10T10:12:10.733000+02:00';
    expect(resolve(value, new Date('2026-07-10T08:12:10.733Z'))).toBe(value);
  });

  it.each(['7335600', '733560001'])('leaves unsupported precision %s unknown without truncating', (fraction) => {
    const value = `2026-07-10T08:12:10.${fraction}Z`;
    expect(resolve(value)).toBeNull();
    expect(sourcePostingDateFields(value, now)).toEqual({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  });

  it.each([false, true])('keeps the earlier microsecond across recrawls (reversed=%s)', (reversed) => {
    const earlier = sourcePostingDateFields('2026-07-10T08:12:10.733560+00:00', now);
    const later = sourcePostingDateFields('2026-07-10T08:12:10.733561+00:00', now);
    expect(mergeSourcePostingDates(reversed ? later : earlier, reversed ? earlier : later, now)).toEqual(earlier);
  });

  it('compares the instant rather than local clock text or timezone spelling', () => {
    const earlier = sourcePostingDateFields('2026-07-10T10:12:10.733560+02:00', now);
    const later = sourcePostingDateFields('2026-07-10T03:12:10.733561-05:00', now);
    expect(mergeSourcePostingDates(later, earlier, now)).toEqual(earlier);
  });

  it('does not relax calendar validation for a microsecond timestamp', () => {
    expect(resolve('2026-02-30T08:12:10.733560+00:00')).toBeNull();
  });

  it('does not promote an unmarked microsecond date during a merge', () => {
    const datePosted = '2026-07-10T08:12:10.733560+00:00';
    expect(mergeSourcePostingDates({ datePosted }, {}, now)).toEqual({
      datePosted: '', postedDate: '', postingDateSource: 'unknown',
    });
  });
});
