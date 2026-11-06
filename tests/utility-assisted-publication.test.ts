import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assessLegitimacy } from '../functions/src/assistedApplicationLegitimacy.js';
import { fetchJobPosting } from '../functions/src/assistedApplicationAiJob.js';
import { resolveReportedPostingDate } from '../functions/src/lib/jobPostingDate.js';
const now = new Date('2026-10-04T12:00:00Z');

describe('assisted publication provenance', () => {
  it('keeps the deployment-local validator byte-identical to the site implementation', () => {
    const local = readFileSync('functions/src/lib/jobPostingDate.js', 'utf8').split('\n').slice(1).join('\n');
    expect(local).toBe(readFileSync('scripts/lib/job-posting-date.mjs', 'utf8'));
  });
  it.each([
    { postingDateSource: 'reported', datePosted: '2026-10-02T12:00:00.000001Z', expected: 2 },
    { postingDateSource: 'unknown', postedDate: '2026-10-02', expected: null },
    { postedDate: '2026-10-02', expected: null },
    { postingDateSource: 'reported', postedDate: '2026-02-30', expected: null },
    { postingDateSource: 'reported', postedDate: '2026-10-04T12:00:00.000001Z', expected: null },
  ])('projects and assesses $postingDateSource $postedDate $datePosted', async ({ expected, ...fields }) => {
    const posting = await fetchJobPosting({ jobId: 'acme-123' }, { fetchImpl: async () => new Response(JSON.stringify({
      description: 'Real description '.repeat(50), firstSeenAt: '2026-09-01', ...fields,
    })) });
    expect(posting.postingDateSource).toBe(fields.postingDateSource === 'reported' ? 'reported' : 'unknown');
    expect(posting.datePosted).toBe(fields.datePosted || '');
    const result = assessLegitimacy({ posting, nowMs: now.getTime(), livenessResult: 'active', legitimacy: { specificity: 'specific' } });
    expect(result.ageDays).toBe(expected);
    expect(result.observedAgeDays).toBe(33);
    if (expected === null) {
      expect(result.signals).toContainEqual({ key: 'age_unknown', weight: 'neutral', reliability: 'high', detail: '' });
      expect(result.signals.some((s: { key: string }) => s.key === 'age')).toBe(false);
      expect(result.tier).toBe('caution');
    }
  });
  it('rejects unsupported fractional precision without rounding', () => {
    expect(resolveReportedPostingDate({ postingDateSource: 'reported', datePosted: '2026-10-02T12:00:00.0000001Z' }, now)).toBeNull();
  });
});
