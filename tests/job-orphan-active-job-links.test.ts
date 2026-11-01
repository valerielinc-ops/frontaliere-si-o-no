import { describe, expect, it } from 'vitest';
import { extractActiveJobLinks } from '@/components/community/JobOrphanView';

describe('extractActiveJobLinks', () => {
  it('keeps the complete location and does not infer a company from it', () => {
    expect(extractActiveJobLinks(
      '<li><a href="/jobs/example/">Titolo</a> — Lugano, Via Roma</li>',
    )).toEqual([{
      href: '/jobs/example/',
      title: 'Titolo',
      company: '',
      location: 'Lugano, Via Roma',
    }]);
  });

  it('reads the bookmark data off the link, so a job outside the dataset stays saveable', () => {
    expect(extractActiveJobLinks(
      '<li><a href="/jobs/example/" data-job-id="j1" data-job-slug="example" data-job-company="A &amp; B" data-job-canton="TI" data-job-category="it">Titolo</a> — Lugano</li>',
    )[0].save).toEqual({
      id: 'j1',
      slug: 'example',
      title: 'Titolo',
      company: 'A & B',
      canton: 'TI',
      category: 'it',
    });
  });
});
