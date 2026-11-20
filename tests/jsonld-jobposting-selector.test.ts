import { describe, expect, it } from 'vitest';

import { selectJobPostingLd } from '../scripts/lib/jsonld-jobposting.mjs';

describe('selectJobPostingLd', () => {
  it('fails closed when several postings share the requested title', () => {
    const postings = [
      { title: 'Operatore', url: 'https://jobs.example.test/one' },
      { title: 'Operatore', url: 'https://jobs.example.test/two' },
    ];

    expect(selectJobPostingLd(postings, { title: 'Operatore' })).toBeNull();
  });

  it('uses a unique URL match before considering a duplicated title', () => {
    const expected = { title: 'Operatore', url: 'https://jobs.example.test/two' };
    const postings = [
      { title: 'Operatore', url: 'https://jobs.example.test/one' },
      expected,
    ];

    expect(selectJobPostingLd(postings, {
      title: 'Operatore',
      url: 'https://jobs.example.test/two/',
    })).toEqual(expected);
  });
});
