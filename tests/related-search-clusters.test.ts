/**
 * Unit tests for `services/relatedSearchClusters.ts`.
 *
 * The module is the pure-helper layer behind related-search cluster URL
 * canonicalization (phase 2). It powers both:
 *   - The runtime SPA JobBoard widget (via `buildSearchSlug` re-export)
 *   - The Vite build-time plugin that emits ~1500 cluster landing pages
 *
 * These tests cover the public surface only — slug encode/decode round-trip,
 * stopword filtering, validity gates, and `buildRelatedSearches` end-to-end
 * shape against a synthetic JobListing. No network, no filesystem, no AI.
 */

import { describe, it, expect } from 'vitest';
import type { JobListing } from '@/components/community/JobBoard';
import {
  slugifyJobPart,
  buildSearchSlug,
  parseSearchSlugFilter,
  getSearchSlugPrefix,
  getJobBoardSectionSlug,
  RELATED_SEARCH_STOPWORDS,
  extractRelatedTopicTokens,
  isValidRelatedSearchTerm,
  cleanCanonicalItems,
  sanitizeJobTitle,
  buildRelatedSearches,
  DEFAULT_CANTON_DISPLAY,
} from '@/services/relatedSearchClusters';

// ── Slug round-trip ─────────────────────────────────────────────────────

describe('buildSearchSlug + parseSearchSlugFilter — round-trip', () => {
  const ASCII_CASES = [
    'data center technician',
    'software engineer',
    'hr specialist',
    'project manager',
  ] as const;

  it('IT round-trip preserves ASCII terms (hyphenated → spaced)', () => {
    for (const term of ASCII_CASES) {
      const slug = buildSearchSlug(term, 'it');
      expect(slug.startsWith('ricerca-')).toBe(true);
      expect(parseSearchSlugFilter(slug)).toBe(term);
    }
  });

  it('EN round-trip preserves ASCII terms', () => {
    for (const term of ASCII_CASES) {
      const slug = buildSearchSlug(term, 'en');
      expect(slug.startsWith('search-')).toBe(true);
      expect(parseSearchSlugFilter(slug)).toBe(term);
    }
  });

  it('DE round-trip preserves ASCII terms', () => {
    for (const term of ASCII_CASES) {
      const slug = buildSearchSlug(term, 'de');
      expect(slug.startsWith('suche-')).toBe(true);
      expect(parseSearchSlugFilter(slug)).toBe(term);
    }
  });

  it('FR round-trip preserves ASCII terms', () => {
    for (const term of ASCII_CASES) {
      const slug = buildSearchSlug(term, 'fr');
      expect(slug.startsWith('recherche-')).toBe(true);
      expect(parseSearchSlugFilter(slug)).toBe(term);
    }
  });

  it('parseSearchSlugFilter returns null for non-prefixed slugs', () => {
    expect(parseSearchSlugFilter(undefined)).toBeNull();
    expect(parseSearchSlugFilter('')).toBeNull();
    expect(parseSearchSlugFilter('software-engineer')).toBeNull();
    expect(parseSearchSlugFilter('ricerca-')).toBeNull();
  });

  it('parseSearchSlugFilter accepts every locale prefix', () => {
    expect(parseSearchSlugFilter('ricerca-data-center')).toBe('data center');
    expect(parseSearchSlugFilter('search-data-center')).toBe('data center');
    expect(parseSearchSlugFilter('suche-data-center')).toBe('data center');
    expect(parseSearchSlugFilter('recherche-data-center')).toBe('data center');
  });
});

// ── Stopword expansion / token extraction ───────────────────────────────

describe('extractRelatedTopicTokens — stopword + length gate', () => {
  it('returns NO tokens when both inputs are <4 chars or stopword-equivalent', () => {
    // "vous" is a 4-char stopword (FR), "chur" is 4 chars but city name —
    // still emitted since not in stopword set. Test what extractor produces.
    expect(extractRelatedTopicTokens('vous')).toEqual([]);
    expect(extractRelatedTopicTokens('dans')).toEqual([]);
    expect(extractRelatedTopicTokens('eine')).toEqual([]);
    expect(extractRelatedTopicTokens('deine')).toEqual([]);
  });

  it('drops 1-3 char tokens via the length gate', () => {
    // "il" (IT), "der" (DE), "the" (EN), "le" (FR) — all <4 or stopword
    expect(extractRelatedTopicTokens('il la')).toEqual([]);
    // "chur" alone (4 chars, not a stopword) DOES survive — verify shape
    const tokens = extractRelatedTopicTokens('chur');
    expect(tokens).toEqual(['chur']);
  });

  it('returns meaningful tokens for technical descriptions', () => {
    const tokens = extractRelatedTopicTokens('data center technician');
    expect(tokens).toContain('data');
    expect(tokens).toContain('center');
    expect(tokens).toContain('technician');
  });

  it('respects the max parameter', () => {
    const tokens = extractRelatedTopicTokens(
      'alpha beta gamma delta epsilon zeta eta theta',
      3,
    );
    expect(tokens.length).toBeLessThanOrEqual(3);
  });

  it('drops digit-only tokens', () => {
    expect(extractRelatedTopicTokens('1234 5678')).toEqual([]);
  });

  it('case-folds + accent-strips before token comparison', () => {
    const tokens = extractRelatedTopicTokens('Café Café CAFÉ');
    expect(tokens).toContain('cafe');
    expect(tokens.length).toBe(1);
  });
});

// ── isValidRelatedSearchTerm boundaries ─────────────────────────────────

describe('isValidRelatedSearchTerm — boundary conditions', () => {
  it('rejects empty / whitespace-only strings', () => {
    expect(isValidRelatedSearchTerm('')).toBe(false);
    expect(isValidRelatedSearchTerm('   ')).toBe(false);
  });

  it('rejects strings <3 chars', () => {
    expect(isValidRelatedSearchTerm('a')).toBe(false);
    expect(isValidRelatedSearchTerm('ab')).toBe(false);
  });

  it('rejects strings >70 chars', () => {
    const tooLong = 'a'.repeat(71);
    expect(isValidRelatedSearchTerm(tooLong)).toBe(false);
  });

  it('rejects strings with >8 words', () => {
    expect(isValidRelatedSearchTerm('a b c d e f g h i')).toBe(false);
  });

  it('accepts a valid 3-token short term', () => {
    expect(isValidRelatedSearchTerm('data center technician')).toBe(true);
  });

  it('accepts a valid 3-char single-word term', () => {
    expect(isValidRelatedSearchTerm('seo')).toBe(true);
  });
});

// ── buildRelatedSearches — synthetic JobListing ─────────────────────────

describe('buildRelatedSearches — synthetic JobListing', () => {
  function makeJob(overrides: Partial<JobListing> = {}): JobListing {
    return {
      id: 'job-1',
      slug: 'software-engineer-techco-bellinzona',
      company: 'TechCo',
      title: 'Software Engineer',
      location: 'Bellinzona',
      canton: 'Ticino',
      // Cast through unknown — JobCategory / ContractType are not exported.
      category: 'tech' as unknown as JobListing['category'],
      contract: 'full-time' as unknown as JobListing['contract'],
      currency: 'CHF',
      description: '',
      requirements: [],
      featured: false,
      postedDate: '2026-05-01',
      ...overrides,
    } as JobListing;
  }

  const baseSummary = [
    'Modern data platform team building scalable services.',
    'You will own design, build and operate.',
  ];
  const baseRequirements = [
    'Strong system design background.',
    'Experience with distributed systems.',
  ];

  it('returns ≤10 terms', () => {
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'it',
      summary: baseSummary,
      requirements: baseRequirements,
      aiKeywords: [],
    });
    expect(out.length).toBeLessThanOrEqual(10);
  });

  it('includes the short title and shortTitle + location', () => {
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'it',
      summary: baseSummary,
      requirements: baseRequirements,
      aiKeywords: [],
    });
    expect(out).toContain('Software Engineer');
    expect(out).toContain('Software Engineer Bellinzona');
  });

  it('does NOT include "${company} ${location}" — N2 filter (azienda-* slugs already cover that intent)', () => {
    // Per services/relatedSearchClusters.ts:185 — `${company} ${location}` is
    // intentionally dropped from the candidate set because the company-hub
    // intent is already canonicalized via /azienda-{slug}/ pages. Keeping it
    // would duplicate /search-{company}-{city}/ and /azienda-{company}/.
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'en',
      summary: baseSummary,
      requirements: baseRequirements,
      aiKeywords: [],
    });
    expect(out).not.toContain('TechCo Bellinzona');
  });

  it('drops every candidate containing a stopword in body tokens', () => {
    // Description packed with "vous" (FR stopword) — should NOT leak into
    // generated `${token} ${location}` items.
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'fr',
      summary: ['Vous vous vous vous vous travaillerez ici.'],
      requirements: ['Vous avez de l\'expérience.'],
      aiKeywords: [],
    });
    for (const term of out) {
      expect(term.toLowerCase()).not.toContain('vous');
    }
  });

  it('does NOT include "<location> <Location>" duplication via body-token dedup', () => {
    // Description mentions "Bellinzona" itself — extractor would normally
    // pull it as a topic, but the location-token dedup must filter it out.
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'it',
      summary: ['Lavora a Bellinzona Bellinzona Bellinzona.'],
      requirements: ['Sede di Bellinzona.'],
      aiKeywords: [],
    });
    for (const term of out) {
      expect(term.toLowerCase()).not.toBe('bellinzona bellinzona');
    }
  });

  it('preserves AI keywords passed in (when valid)', () => {
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'en',
      summary: baseSummary,
      requirements: baseRequirements,
      aiKeywords: ['kubernetes', 'distributed systems'],
    });
    expect(out).toContain('kubernetes');
    expect(out).toContain('distributed systems');
  });

  it('emits IT-locale specific templates ("offerte lavoro", "stipendio … svizzera")', () => {
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'it',
      summary: baseSummary,
      requirements: baseRequirements,
      aiKeywords: [],
    });
    expect(out.some((t) => t.startsWith('offerte lavoro '))).toBe(true);
    expect(out.some((t) => t.includes('stipendio') && t.includes('svizzera'))).toBe(true);
  });

  it('emits non-IT templates ("salary switzerland", "requirements")', () => {
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'en',
      summary: baseSummary,
      requirements: baseRequirements,
      aiKeywords: [],
    });
    expect(out.some((t) => t.includes('salary switzerland'))).toBe(true);
    expect(out.some((t) => t.endsWith('requirements'))).toBe(true);
  });

  it('falls back to default canton in IT when location is empty', () => {
    const out = buildRelatedSearches({
      job: makeJob({ location: '' }),
      locale: 'it',
      summary: ['Dato sistema piattaforma cloud team.'],
      requirements: [],
      aiKeywords: [],
    });
    // shortTitle alone is in the list; shortTitle + '' trims to shortTitle
    expect(out).toContain('Software Engineer');
    // body-token-derived items use DEFAULT_CANTON_DISPLAY in lowercase
    expect(DEFAULT_CANTON_DISPLAY.toLowerCase()).toBe('ticino');
  });
});

// ── Section + prefix slug enums ─────────────────────────────────────────

describe('getSearchSlugPrefix — exhaustive locale coverage', () => {
  it('IT prefix is "ricerca"', () => {
    expect(getSearchSlugPrefix('it')).toBe('ricerca');
  });
  it('EN prefix is "search"', () => {
    expect(getSearchSlugPrefix('en')).toBe('search');
  });
  it('DE prefix is "suche"', () => {
    expect(getSearchSlugPrefix('de')).toBe('suche');
  });
  it('FR prefix is "recherche"', () => {
    expect(getSearchSlugPrefix('fr')).toBe('recherche');
  });
});

describe('getJobBoardSectionSlug — exhaustive locale coverage', () => {
  it('IT section is "cerca-lavoro-ticino"', () => {
    expect(getJobBoardSectionSlug('it')).toBe('cerca-lavoro-ticino');
  });
  it('EN section is "find-jobs-ticino"', () => {
    expect(getJobBoardSectionSlug('en')).toBe('find-jobs-ticino');
  });
  it('DE section is "jobs-im-tessin"', () => {
    expect(getJobBoardSectionSlug('de')).toBe('jobs-im-tessin');
  });
  it('FR section is "trouver-emploi-tessin"', () => {
    expect(getJobBoardSectionSlug('fr')).toBe('trouver-emploi-tessin');
  });
});

// ── slugifyJobPart edge cases ───────────────────────────────────────────

describe('slugifyJobPart — edge cases', () => {
  it('lowercases + strips diacritics', () => {
    expect(slugifyJobPart('Café Manager')).toBe('cafe-manager');
    expect(slugifyJobPart('Zürich Müller')).toBe('zurich-muller');
    expect(slugifyJobPart('São Paulo')).toBe('sao-paulo');
  });

  it('strips leading + trailing hyphens after non-alnum collapse', () => {
    expect(slugifyJobPart('  hello world  ')).toBe('hello-world');
    expect(slugifyJobPart('---hello---')).toBe('hello');
    expect(slugifyJobPart('!!!hello!!!')).toBe('hello');
  });

  it('caps length at 200 chars (pathological-input guard, not URL-budget gate)', () => {
    // The cap was lowered to 90 → raised to 200 (2026-05-11) after the
    // 90-char fallback in this slugifier turned out to be the upstream
    // driver of ~17 GSC "Indicizzata Non trovata" job-detail orphans.
    // Real slugs in jobs.json max out at ~152 chars; the 200 cap remains
    // a defensive guardrail for truly pathological titles, not a URL
    // length budget (Google handles URLs up to 2048 chars).
    const longInput = 'a'.repeat(300);
    const out = slugifyJobPart(longInput);
    expect(out.length).toBeLessThanOrEqual(200);
    // And the cap does NOT kick in for typical 150-char inputs anymore.
    expect(slugifyJobPart('a'.repeat(150)).length).toBe(150);
  });

  it('returns empty string for zero-input edge cases', () => {
    expect(slugifyJobPart('')).toBe('');
    expect(slugifyJobPart('---')).toBe('');
  });
});

// ── sanitizeJobTitle ────────────────────────────────────────────────────

describe('sanitizeJobTitle', () => {
  it('strips HTML tags', () => {
    expect(sanitizeJobTitle('<b>Software Engineer</b>')).toBe('Software Engineer');
    expect(sanitizeJobTitle('<span class="x">Foo <em>Bar</em></span>')).toBe('Foo Bar');
  });

  it('decodes the documented entity set', () => {
    expect(sanitizeJobTitle('AT&amp;T')).toBe('AT&T');
    expect(sanitizeJobTitle('foo&nbsp;bar')).toBe('foo bar');
    expect(sanitizeJobTitle('&laquo;Hi&raquo;')).toBe('«Hi»');
  });

  it('normalizes consecutive whitespace and trims', () => {
    expect(sanitizeJobTitle('  Foo    Bar   ')).toBe('Foo Bar');
    expect(sanitizeJobTitle('Foo\n\tBar')).toBe('Foo Bar');
  });

  it('strips a leading hash heading marker', () => {
    expect(sanitizeJobTitle('## Software Engineer')).toBe('Software Engineer');
    expect(sanitizeJobTitle('# Title')).toBe('Title');
  });

  it('expands "word/short" abbreviations to "word short" (inclusive form)', () => {
    // The regex matches a 3+ letter word, slash, then 1-3 letters
    expect(sanitizeJobTitle('Maintenance/IT')).toBe('Maintenance IT');
  });
});

// ── cleanCanonicalItems ────────────────────────────────────────────────

describe('cleanCanonicalItems', () => {
  it('returns [] for non-array input', () => {
    expect(cleanCanonicalItems(null)).toEqual([]);
    expect(cleanCanonicalItems(undefined)).toEqual([]);
    expect(cleanCanonicalItems('hello')).toEqual([]);
    expect(cleanCanonicalItems(123)).toEqual([]);
  });

  it('dedupes case-insensitively, keeping first occurrence', () => {
    expect(cleanCanonicalItems(['Foo', 'foo', 'FOO', 'Bar'])).toEqual(['Foo', 'Bar']);
  });

  it('drops items <3 chars', () => {
    expect(cleanCanonicalItems(['a', 'ab', 'abc', 'abcd'])).toEqual(['abc', 'abcd']);
  });

  it('respects the max parameter', () => {
    expect(cleanCanonicalItems(['one', 'two', 'three', 'four', 'five'], 3)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('default max is 12', () => {
    const input = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    expect(cleanCanonicalItems(input).length).toBe(12);
  });

  it('normalizes consecutive whitespace before dedup', () => {
    expect(cleanCanonicalItems(['foo  bar', 'foo bar'])).toEqual(['foo bar']);
  });
});

// ── Stopword sanity ────────────────────────────────────────────────────

describe('RELATED_SEARCH_STOPWORDS — sentinel entries', () => {
  it('contains documented FR/DE noise words', () => {
    expect(RELATED_SEARCH_STOPWORDS.has('vous')).toBe(true);
    expect(RELATED_SEARCH_STOPWORDS.has('eine')).toBe(true);
    expect(RELATED_SEARCH_STOPWORDS.has('deine')).toBe(true);
  });

  it('contains documented domain-noise words', () => {
    expect(RELATED_SEARCH_STOPWORDS.has('clients')).toBe(true);
    expect(RELATED_SEARCH_STOPWORDS.has('team')).toBe(true);
  });
});
