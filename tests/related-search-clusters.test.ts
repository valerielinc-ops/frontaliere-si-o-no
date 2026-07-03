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
  pickBestRelatedSearchForPrompt,
  DEFAULT_CANTON_DISPLAY,
  stripSearchQueryBoilerplate,
  isJunkSearchKeyword,
} from '@/services/relatedSearchClusters';
import { renderSearchQueryIntro } from '../build-plugins/shared/jobBoardCommuterContext';

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

describe('parseSearchSlugFilter — strips job-search boilerplate from seeded query', () => {
  // GSC queries prepend "offerte (di) lavoro" / "lavoro" etc. Those words
  // appear in no job title, so they can never satisfy the strict AND-match and
  // would otherwise force every such landing into the fuzzy "no exact match"
  // fallback. The parsed query must drop the leading boilerplate.
  it('strips "offerte lavoro" prefix (the reported addetto-a-cucina case)', () => {
    expect(parseSearchSlugFilter('ricerca-offerte-lavoro-addetto-a-cucina')).toBe('addetto a cucina');
  });

  it('strips "offerte di lavoro" prefix', () => {
    expect(parseSearchSlugFilter('ricerca-offerte-di-lavoro-infermiere')).toBe('infermiere');
  });

  it('strips a bare leading "lavoro" / "offerte" token', () => {
    expect(parseSearchSlugFilter('ricerca-lavoro-cuoco')).toBe('cuoco');
    expect(parseSearchSlugFilter('ricerca-offerte-cuoco')).toBe('cuoco');
  });

  it('strips locale boilerplate (DE stellenangebote, FR offres (d) emploi)', () => {
    expect(parseSearchSlugFilter('suche-stellenangebote-koch')).toBe('koch');
    expect(parseSearchSlugFilter('recherche-offres-emploi-cuisinier')).toBe('cuisinier');
    // Canonical FR "offres d'emploi" → slug strips the apostrophe to a hyphen
    // (`offres-d-emploi`), reaching the parser as "offres d emploi".
    expect(parseSearchSlugFilter('recherche-offres-d-emploi-cuisinier')).toBe('cuisinier');
  });

  it('never empties the query for a boilerplate-only slug (no blank search box)', () => {
    // "offerte lavoro" → leading "offerte " stripped, "lavoro" kept (non-blank).
    expect(parseSearchSlugFilter('ricerca-offerte-lavoro')).toBe('lavoro');
    // "lavoro" alone has no trailing token to strip → returned verbatim.
    expect(parseSearchSlugFilter('ricerca-lavoro')).toBe('lavoro');
  });

  it('does not strip boilerplate words that appear mid-query', () => {
    expect(parseSearchSlugFilter('ricerca-agente-immobiliare')).toBe('agente immobiliare');
    expect(parseSearchSlugFilter('ricerca-cuoco-offerte')).toBe('cuoco offerte');
  });
});

describe('stripSearchQueryBoilerplate — UNDER-strip guard (shared by SPA seed + static cluster matching)', () => {
  // Both parseSearchSlugFilter (SPA) and buildClusterContext (build-plugin job
  // matching) call this function, so a future narrowing of the phrase list that
  // stopped stripping a real boilerplate form would silently reintroduce the
  // static/SPA divergence. These assertions lock that each canonical form is
  // still removed — the inverse direction of the corpus over-strip guard in
  // tests/seo/related-search-clusters-emitted.test.ts.
  it('removes the canonical IT job-search prefixes', () => {
    expect(stripSearchQueryBoilerplate('offerte lavoro medico')).toBe('medico');
    expect(stripSearchQueryBoilerplate('offerte di lavoro infermiere')).toBe('infermiere');
    expect(stripSearchQueryBoilerplate('posti di lavoro saldatore')).toBe('saldatore');
    expect(stripSearchQueryBoilerplate('lavoro cuoco')).toBe('cuoco');
    expect(stripSearchQueryBoilerplate('offerte cadro lugano')).toBe('cadro lugano');
  });

  it('removes the canonical DE prefixes', () => {
    expect(stripSearchQueryBoilerplate('stellenangebote koch')).toBe('koch');
    expect(stripSearchQueryBoilerplate('stellen pflege')).toBe('pflege');
    expect(stripSearchQueryBoilerplate('jobs verkauf')).toBe('verkauf');
  });

  it('removes FR offre(s) (d) emploi(s) — full parity with the prior regex', () => {
    for (const form of [
      'offres d emploi cuisinier',
      'offre d emploi cuisinier',
      'offres emploi cuisinier',
      'offre emploi cuisinier',
      'offres d emplois cuisinier',
      'offres emplois cuisinier',
      'recherche emploi cuisinier',
    ]) {
      expect(stripSearchQueryBoilerplate(form), `not stripped: "${form}"`).toBe('cuisinier');
    }
  });

  it('leaves a non-boilerplate term untouched (matching path stays intact)', () => {
    expect(stripSearchQueryBoilerplate('tecnico data center')).toBe('tecnico data center');
    expect(stripSearchQueryBoilerplate('responsabile neurologia')).toBe('responsabile neurologia');
  });

  // N4 (2026-06-02): trailing nation/salary/requirements template suffixes are
  // now stripped too. This is the fix for the reported
  // recherche-pizzaiolo-pizzaiola-salary-switzerland landing, whose lone
  // "switzerland" token OR-matched every job mentioning the nation.
  it('removes trailing nation / salary / requirements template suffixes', () => {
    expect(stripSearchQueryBoilerplate('pizzaiolo pizzaiola salary switzerland')).toBe('pizzaiolo pizzaiola');
    expect(stripSearchQueryBoilerplate('infermiere requirements')).toBe('infermiere');
    expect(stripSearchQueryBoilerplate('cuoco svizzera')).toBe('cuoco');
    expect(stripSearchQueryBoilerplate('koch gehalt schweiz')).toBe('koch');
    expect(stripSearchQueryBoilerplate('cuisinier salaire suisse')).toBe('cuisinier');
    // combined leading + trailing
    expect(stripSearchQueryBoilerplate('stipendio infermiere svizzera')).toBe('infermiere');
  });

  it('does NOT strip a trailing job-word that is not a template suffix (cuoco offerte stays)', () => {
    // "offerte" is a LEADING prefix, never a trailing suffix — preserves the
    // documented `ricerca-cuoco-offerte` → "cuoco offerte" contract.
    expect(stripSearchQueryBoilerplate('cuoco offerte')).toBe('cuoco offerte');
    // "switzerland" mid-query (not trailing) is a content word here, untouched.
    expect(stripSearchQueryBoilerplate('switzerland tourism manager')).toBe('switzerland tourism manager');
  });

  it('never empties a query that is only boilerplate / a bare suffix term', () => {
    expect(stripSearchQueryBoilerplate('switzerland')).toBe('switzerland');
    expect(stripSearchQueryBoilerplate('lavoro')).toBe('lavoro');
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

// ── isJunkSearchKeyword — thin-doorway keyword denylist ─────────────────

describe('isJunkSearchKeyword — drops generic filler / noise, keeps real intents', () => {
  it('flags single generic-filler / connective / scraped-noise keywords as junk', () => {
    // These produced thin doorway landings like /…/ricerca-cookie-bern/.
    for (const junk of ['cookie', 'sowie', 'pazienti', 'patienten', 'unterstutzung',
      'gestione', 'sviluppo', 'professionale', 'qualita', 'oltre', 'nell', 'dati',
      'requirements', 'responsibilities', 'skills']) {
      expect(isJunkSearchKeyword(junk)).toBe(true);
    }
  });

  it('treats case / diacritics / surrounding punctuation uniformly', () => {
    expect(isJunkSearchKeyword('Cookie')).toBe(true);
    expect(isJunkSearchKeyword('Qualità')).toBe(true);
    expect(isJunkSearchKeyword('  Sowie  ')).toBe(true);
  });

  it('flags an all-junk multi-word keyword (e.g. boilerplate salary padding)', () => {
    expect(isJunkSearchKeyword('stipendio')).toBe(true);
  });

  it('keeps "stipendio <role...>" as legitimate salary+role intent (issue #2764)', () => {
    // "stipendio" is a generic filler catch, but "stipendio <role>" ("salary
    // <role>") is a real, SEO-valuable search intent — audited against the
    // live candidates file: ~4.8k "stipendio <role> svizzera" keywords were
    // being wholesale dropped by the blanket first-token-junk rule.
    expect(isJunkSearchKeyword('stipendio infermiere')).toBe(false);
    expect(isJunkSearchKeyword('stipendio manager')).toBe(false);
    expect(isJunkSearchKeyword('stipendio infermiere lugano')).toBe(false);
    expect(isJunkSearchKeyword('Stipendio Senior Associate')).toBe(false);
    // But the bare token alone, or the token followed only by other junk
    // (city-leftover filler), still drops — the original PR #2756 fix for
    // genuinely junk-led single-token-after-strip cases is unweakened.
    expect(isJunkSearchKeyword('stipendio')).toBe(true);
    expect(isJunkSearchKeyword('stipendio nella')).toBe(true);
  });

  it('keeps real single-word job-search intents (role nouns)', () => {
    for (const real of ['ospedale', 'medico', 'infermiere', 'vendita', 'stage',
      'manager', 'formazione', 'assistenza', 'sicurezza', 'cuoco']) {
      expect(isJunkSearchKeyword(real)).toBe(false);
    }
  });

  it('keeps multi-word keywords led by a real intent token', () => {
    // Title-derived candidates lead with a real role, so they stay indexable
    // even when a trailing token is generic or a city.
    expect(isJunkSearchKeyword('data center technician')).toBe(false);
    expect(isJunkSearchKeyword('senior associate')).toBe(false);
    expect(isJunkSearchKeyword('ospedale lugano')).toBe(false);
    expect(isJunkSearchKeyword('infermiere baden')).toBe(false);
  });

  it('flags junk-led "term city" keywords even when the city is NOT stripped', () => {
    // Regression: detectCity only strips KNOWN_CITIES, so unrecognized cities
    // (Baden/Gossau/Meyrin/Solothurn) leave keywords like "pazienti baden"
    // intact. A leading junk token must still drop them — these were the thin
    // doorways /…/ricerca-pazienti-baden/, /…/ricerca-cura-baden/ that leaked.
    expect(isJunkSearchKeyword('pazienti baden')).toBe(true);
    expect(isJunkSearchKeyword('cura baden')).toBe(true);
    expect(isJunkSearchKeyword('capacita gossau')).toBe(true);
    expect(isJunkSearchKeyword('professionale solothurn')).toBe(true);
    expect(isJunkSearchKeyword('compiti solothurn')).toBe(true);
  });

  it('flags empty / whitespace-only / numeric-only as junk', () => {
    expect(isJunkSearchKeyword('')).toBe(true);
    expect(isJunkSearchKeyword('   ')).toBe(true);
    expect(isJunkSearchKeyword('1234')).toBe(true);
  });
});

describe('buildRelatedSearches — drops junk body tokens', () => {
  function makeJunkJob(): JobListing {
    return {
      id: 'job-junk',
      title: 'Software Engineer',
      company: 'TechCo',
      location: 'Bellinzona',
    } as unknown as JobListing;
  }

  it('never emits a junk-token landing (cookie / sowie / pazienti)', () => {
    const out = buildRelatedSearches({
      job: makeJunkJob(),
      locale: 'it',
      summary: ['Cookie cookie cookie sowie sowie pazienti pazienti gestione gestione.'],
      requirements: ['Cookie e gestione dei pazienti.'],
      aiKeywords: [],
    });
    for (const term of out) {
      const lower = term.toLowerCase();
      expect(lower).not.toContain('cookie');
      expect(lower).not.toContain('sowie');
      expect(lower).not.toContain('pazienti');
    }
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

  // N4 (2026-06-02): the boilerplate-laden template candidates were removed and
  // every term is now run through stripSearchQueryBoilerplate. No proposed
  // related search may carry a leading job-search prefix or a trailing
  // nation/salary/requirements suffix.
  it('does NOT emit IT boilerplate templates ("offerte lavoro …", "stipendio … svizzera")', () => {
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'it',
      summary: baseSummary,
      requirements: baseRequirements,
      aiKeywords: [],
    });
    expect(out.some((t) => t.toLowerCase().startsWith('offerte lavoro '))).toBe(false);
    expect(out.some((t) => t.toLowerCase().includes('stipendio'))).toBe(false);
    expect(out.some((t) => t.toLowerCase().endsWith(' svizzera'))).toBe(false);
  });

  it('does NOT emit non-IT boilerplate templates ("… salary switzerland", "… requirements")', () => {
    const out = buildRelatedSearches({
      job: makeJob(),
      locale: 'en',
      summary: baseSummary,
      requirements: baseRequirements,
      aiKeywords: [],
    });
    expect(out.some((t) => t.toLowerCase().includes('salary switzerland'))).toBe(false);
    expect(out.some((t) => t.toLowerCase().endsWith('switzerland'))).toBe(false);
    expect(out.some((t) => t.toLowerCase().endsWith('requirements'))).toBe(false);
    // Bare title still surfaces — only the boilerplate padding is gone.
    expect(out).toContain('Software Engineer');
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

// ── pickBestRelatedSearchForPrompt — post-login alert fallback ──────────

describe('pickBestRelatedSearchForPrompt — keyword resolution for post-login prompt on detail view', () => {
  function makeJob(overrides: Partial<JobListing> = {}): JobListing {
    return {
      id: 'job-1',
      slug: 'software-engineer-techco-bellinzona',
      company: 'TechCo',
      title: 'Software Engineer',
      location: 'Bellinzona',
      canton: 'Ticino',
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

  // Simple matcher that mirrors indexedQueryMatch's semantics: every space-
  // separated query token must appear as a substring of the job's haystack.
  function makeMatcher(haystackOf: (job: JobListing) => string) {
    return (job: JobListing, term: string): boolean => {
      const haystack = haystackOf(job).toLowerCase();
      return term
        .toLowerCase()
        .split(' ')
        .filter(Boolean)
        .every((token) => haystack.includes(token));
    };
  }

  it('returns the candidate with the most matching jobs', () => {
    const selected = makeJob();
    // Corpus: 5 jobs match "software engineer", 2 match "software engineer bellinzona".
    // The broader term should win.
    const jobs = [
      makeJob({ id: 'j1', title: 'Software Engineer', location: 'Lugano' }),
      makeJob({ id: 'j2', title: 'Software Engineer', location: 'Bellinzona' }),
      makeJob({ id: 'j3', title: 'Software Engineer', location: 'Mendrisio' }),
      makeJob({ id: 'j4', title: 'Software Engineer', location: 'Bellinzona' }),
      makeJob({ id: 'j5', title: 'Software Engineer', location: 'Locarno' }),
      makeJob({ id: 'j6', title: 'Project Manager', location: 'Lugano' }),
    ];
    const matches = makeMatcher((j) => `${j.title} ${j.location} ${j.company}`);
    const result = pickBestRelatedSearchForPrompt({
      job: selected,
      locale: 'it',
      jobs,
      matches,
    });
    expect(result).toBe('Software Engineer');
  });

  it('returns null when no candidate matches any job in the corpus', () => {
    const selected = makeJob({ title: 'Quantum Cryomagnetic Operator', location: 'Atlantis' });
    const jobs = [
      makeJob({ id: 'j1', title: 'Bartender', location: 'Lugano', company: 'Bar Roma' }),
    ];
    const matches = makeMatcher((j) => `${j.title} ${j.location} ${j.company}`);
    const result = pickBestRelatedSearchForPrompt({
      job: selected,
      locale: 'it',
      jobs,
      matches,
    });
    expect(result).toBeNull();
  });

  it('returns null when the corpus is empty', () => {
    const result = pickBestRelatedSearchForPrompt({
      job: makeJob(),
      locale: 'it',
      jobs: [],
      matches: () => true,
    });
    expect(result).toBeNull();
  });

  it('picks the bare-title candidate when it matches the most jobs (N4: no template padding)', () => {
    // N4 (2026-06-02): boilerplate templates ("offerte lavoro <title>") were
    // removed, so the bare title is the broadest candidate. Confirms the
    // function still resolves a real intent keyword from the corpus.
    const selected = makeJob({ title: 'Infermiere' });
    const jobs = [
      makeJob({ id: 'j1', title: 'Offerte Lavoro Infermiere Bellinzona', location: 'Bellinzona' }),
      makeJob({ id: 'j2', title: 'Offerte Lavoro Infermiere Lugano', location: 'Lugano' }),
      makeJob({ id: 'j3', title: 'Bartender', location: 'Locarno' }),
    ];
    const matches = makeMatcher((j) => `${j.title} ${j.location}`);
    const result = pickBestRelatedSearchForPrompt({
      job: selected,
      locale: 'it',
      jobs,
      matches,
    });
    // "Infermiere" matches both j1 and j2 (substring) → broadest → wins.
    expect(result?.toLowerCase()).toContain('infermiere');
  });

  it('skips candidates with zero matches even if higher-priority in the candidate order', () => {
    // Force a case where shortTitle is unmatched but a longer template hits.
    const selected = makeJob({ title: 'Zzz Unique Title', company: 'TechCo', location: 'Bellinzona' });
    const jobs = [
      // None of these contain the title verbatim, but they DO contain "TechCo"
      // and "Bellinzona" — so the "<title> <company>" or generated candidates
      // that include those tokens would fail because they still need the title.
      makeJob({ id: 'j1', title: 'Bartender', location: 'Bellinzona', company: 'TechCo' }),
      makeJob({ id: 'j2', title: 'Bartender', location: 'Lugano', company: 'TechCo' }),
    ];
    const matches = makeMatcher((j) => `${j.title} ${j.location} ${j.company}`);
    const result = pickBestRelatedSearchForPrompt({
      job: selected,
      locale: 'it',
      jobs,
      matches,
    });
    // All candidates require "Zzz" in the haystack — none match → null.
    expect(result).toBeNull();
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

  it('strips dangling gender-suffix slash remnants ("/-a", bare " /")', () => {
    // Source titles like "Responsabile Neurologia /-a, 100%" leaked a bare " /"
    // into the cluster term shown in <title>/H1/description. Clean it.
    expect(sanitizeJobTitle('Responsabile Neurologia /-a, 100%')).toBe('Responsabile Neurologia, 100%');
    expect(sanitizeJobTitle('Responsabile Neurologia /')).toBe('Responsabile Neurologia');
    expect(sanitizeJobTitle('Infermiere /-in')).toBe('Infermiere');
  });

  it('leaves legitimate mid-token slashes intact', () => {
    expect(sanitizeJobTitle('Disponibilità 24/7')).toBe('Disponibilità 24/7');
    expect(sanitizeJobTitle('Manager (m/w/d)')).toBe('Manager (m/w/d)');
    // A real " / " separator (not a dangling gender remnant) must survive —
    // the strip only fires at end / before punctuation.
    expect(sanitizeJobTitle('Manager / Director')).toBe('Manager / Director');
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

// ── renderSearchQueryIntro — geo scope (honest region label) ──────────────

describe('renderSearchQueryIntro — geo scope', () => {
  // The intro picks one of 3 opening angles via a stable hash; only angles 0/1
  // carry a region phrase, so assert angle-independent invariants across a
  // fixed query set (hash is pure → deterministic for these exact inputs).
  const QUERIES = ['Responsabile Neurologia', 'Infermiere', 'Cuoco', 'Ingegnere Civile', 'Magazziniere', 'Operaio Edile'];
  const render = (q: string, scope: 'ticino' | 'svizzera') =>
    renderSearchQueryIntro('it', q, 3, ['EOC'], ['Lugano'], scope);

  it('never mislabels the scope on any angle', () => {
    for (const q of QUERIES) {
      expect(render(q, 'svizzera')).not.toContain('in Ticino');
      expect(render(q, 'ticino')).not.toContain('in Svizzera');
    }
  });

  it('emits the national label on region-bearing angles', () => {
    expect(QUERIES.some((q) => render(q, 'svizzera').includes('in Svizzera'))).toBe(true);
    expect(QUERIES.some((q) => render(q, 'ticino').includes('in Ticino'))).toBe(true);
  });

  it('defaults to ticino scope (other callers unchanged)', () => {
    for (const q of QUERIES) {
      expect(renderSearchQueryIntro('it', q, 3, ['EOC'], ['Lugano'])).toBe(render(q, 'ticino'));
    }
  });

  it('localizes the national label per locale on region-bearing angles', () => {
    const someEn = QUERIES.some((q) => renderSearchQueryIntro('en', q, 3, ['EOC'], ['Lugano'], 'svizzera').includes('Switzerland'));
    const someDe = QUERIES.some((q) => renderSearchQueryIntro('de', q, 3, ['EOC'], ['Lugano'], 'svizzera').includes('in der Schweiz'));
    const someFr = QUERIES.some((q) => renderSearchQueryIntro('fr', q, 3, ['EOC'], ['Lugano'], 'svizzera').includes('en Suisse'));
    expect(someEn && someDe && someFr).toBe(true);
  });
});
