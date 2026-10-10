import { describe, expect, it } from 'vitest';
import { matchingJobPostingPublication } from '../scripts/lib/jobposting-source-publication.mjs';

const script = (value: object) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

describe('jobposting-missing source publication observer', () => {
  it('accepts one title-matched source date and rejects mismatched or ambiguous evidence', () => {
    const datePosted = new Date(Date.now() - 86_400_000).toISOString();
    const posting = { '@type': 'JobPosting', title: 'Source role', datePosted };
    expect(matchingJobPostingPublication(script(posting), 'Source role')).toMatchObject({
      datePosted, postedDate: datePosted, postingDateSource: 'reported',
    });
    expect(matchingJobPostingPublication(script(posting), 'Different role').postingDateSource).toBe('unknown');
    expect(matchingJobPostingPublication(script([posting, posting]), 'Source role').postingDateSource).toBe('unknown');
  });

  it('normalizes the compact ISO offset emitted by Migros JobPosting pages', () => {
    const html = script({ '@type': 'JobPosting', title: 'Source role', datePosted: '2026-10-05T00:01:01+0200' });
    expect(matchingJobPostingPublication(html, 'Source role')).toMatchObject({
      datePosted: '2026-10-05T00:01:01+02:00', postingDateSource: 'reported',
    });
  });
});
