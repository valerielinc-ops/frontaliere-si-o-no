// tests/seo/structured-data.test.ts
import { describe, it, expect } from 'vitest';
import {
  jobPostingLd,
  articleLd,
  faqPageLd,
  breadcrumbListLd,
  webPageLd,
} from '../../services/seo/structuredData';

describe('jobPostingLd', () => {
  it('emits JSON-LD with all rule #3 mandatory fields', () => {
    const ld = jobPostingLd({
      id: 'x-1',
      stableId: '550e8400-e29b-41d4-a716-446655440000',
      slug: 'x',
      url: 'https://x.ch/x',
      title: 'Sviluppatore',
      company: 'X',
      hiringOrganization: { name: 'X' },
      location: 'Lugano',
      addressLocality: 'Lugano',
      postalCode: '6900',
      streetAddress: 'Via Test 1',
      description: 'D'.repeat(60),
      datePosted: '2026-05-15',
      employmentType: 'FULL_TIME',
      jobLocation: { addressLocality: 'Lugano', postalCode: '6900', addressCountry: 'CH' },
      baseSalary: { currency: 'CHF', value: { minValue: 80000, maxValue: 110000, unitText: 'YEAR' } },
    });
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.baseSalary).toBeDefined();
    expect(ld.hiringOrganization?.name).toBe('X');
    expect(ld.jobLocation?.address?.postalCode).toBe('6900');
  });

  it('throws if job fails JobSchema (impossible nested scripts, impossible thin)', () => {
    // @ts-expect-error intentionally invalid
    expect(() => jobPostingLd({ id: 'bad' })).toThrow();
  });
});

describe('faqPageLd', () => {
  it('emits FAQPage with non-empty mainEntity', () => {
    const ld = faqPageLd([
      { question: 'Q1?', answer: 'A1' },
      { question: 'Q2?', answer: 'A2' },
    ]);
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity.length).toBe(2);
    expect(ld.mainEntity[0].acceptedAnswer.text).toBe('A1');
  });
  it('throws if mainEntity would be empty', () => {
    expect(() => faqPageLd([])).toThrow();
  });
});

describe('breadcrumbListLd', () => {
  it('emits BreadcrumbList with position 1..N', () => {
    const ld = breadcrumbListLd([
      { name: 'Home', url: 'https://x.ch/' },
      { name: 'Articoli', url: 'https://x.ch/articoli/' },
    ]);
    expect(ld.itemListElement.map((i: any) => i.position)).toEqual([1, 2]);
  });
});

describe('webPageLd + articleLd', () => {
  it('webPageLd emits canonical url', () => {
    const ld = webPageLd({ url: 'https://frontaliereticino.ch/x', name: 'X', description: 'D'.repeat(60) });
    expect(ld.url).toBe('https://frontaliereticino.ch/x');
  });
  it('articleLd emits Article with author + datePublished', () => {
    // Body must clear ArticleLocaleBodySchema (>=50 words). Category 'fiscale'
    // matches real-data enum (Task 5 alignment).
    const bodyWords = 'word '.repeat(60);
    const ld = articleLd({
      id: 'x',
      category: 'fiscale',
      date: '2026-01-15',
      image: '/i.webp',
      hasCalculator: false,
      locale: 'it',
      title: 'Titolo articolo valido lungo abbastanza',
      excerpt: 'E'.repeat(80),
      bodyHtml: '<p>' + bodyWords + '</p>',
      authorSlug: 'valerie-linc',
      authorName: 'Valerie Linc',
    });
    expect(ld['@type']).toBe('Article');
    expect(ld.author.name).toBe('Valerie Linc');
    expect(ld.datePublished).toBe('2026-01-15');
  });
});
