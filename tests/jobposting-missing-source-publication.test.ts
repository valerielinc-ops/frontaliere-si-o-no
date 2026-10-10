import { describe, expect, it } from 'vitest';
import { identifiedPostingPublication } from '../scripts/lib/identified-posting-publication.mjs';

const script = (value: object) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

describe('jobposting-missing source publication observer', () => {
  it('accepts one title-matched source date and rejects mismatched or ambiguous evidence', () => {
    const datePosted = new Date(Date.now() - 86_400_000).toISOString();
    const posting = { '@type': 'JobPosting', title: 'Source role', datePosted };
    expect(identifiedPostingPublication(script(posting), 'https://source.example/job/1', 'Source role')).toMatchObject({
      datePosted, postedDate: datePosted, postingDateSource: 'reported',
    });
    expect(identifiedPostingPublication(script(posting), 'https://source.example/job/1', 'Different role').postingDateSource).toBe('unknown');
    expect(identifiedPostingPublication(script([posting, posting]), 'https://source.example/job/1', 'Source role').postingDateSource).toBe('unknown');
  });

  it('normalizes the compact ISO offset emitted by Migros JobPosting pages', () => {
    const html = script({ '@type': 'JobPosting', title: 'Source role', datePosted: '2026-10-05T00:01:01+0200' });
    expect(identifiedPostingPublication(html, 'https://source.example/job/1', 'Source role')).toMatchObject({
      datePosted: '2026-10-05T00:01:01+02:00', postingDateSource: 'reported',
    });
  });
});
