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
});
