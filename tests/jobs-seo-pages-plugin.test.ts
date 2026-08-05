import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JOB_SEO_LOCALES,
  pickSearchLandingFallbackJobs,
  capSearchStatsLandingTitle,
  deriveJobCanton,
  deriveJobAddressLocality,
} from '../build-plugins/jobsSeoPagesPlugin';
import { TITLE_MAX_CHARS, MIN_PEELED_TITLE_CHARS } from '../build-plugins/shared/titleSuffix';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('jobsSeoPagesPlugin search landing fallback', () => {
  it('falls back to the first locale with matching jobs instead of assuming italian exists', () => {
    const matchingJobsByLocale = {
      it: [],
      en: [{ slug: 'search-retail-specialist' }],
      de: [],
      fr: [],
    };

    const fallback = pickSearchLandingFallbackJobs(matchingJobsByLocale);

    expect(fallback).toEqual([{ slug: 'search-retail-specialist' }]);
  });

  it('returns italian jobs first when they exist', () => {
    const matchingJobsByLocale = {
      it: [{ slug: 'ricerca-infermiere' }],
      en: [{ slug: 'search-nurse' }],
      de: [],
      fr: [],
    };

    const fallback = pickSearchLandingFallbackJobs(matchingJobsByLocale);

    expect(fallback).toEqual([{ slug: 'ricerca-infermiere' }]);
    expect(JOB_SEO_LOCALES).toEqual(['it', 'en', 'de', 'fr']);
  });
});

describe('jobsSeoPagesPlugin static payload budget', () => {
  it('does not inline the remote Google Fonts loader on every job detail page', () => {
    const source = readFileSync(resolve(__dirname, '../build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');

    expect(source).not.toContain('fonts.googleapis.com/css2?family=Manrope');
    expect(source).not.toContain('fonts.gstatic.com');
  });
});

describe('capSearchStatsLandingTitle (#3589 sibling: same escape-unaware title-budget class as eventDetailMetaTitle)', () => {
  it('leaves a short title untouched', () => {
    expect(capSearchStatsLandingTitle('Offerte di lavoro Infermiere in Svizzera')).toBe(
      'Offerte di lavoro Infermiere in Svizzera',
    );
  });

  it('rejects a too-short peel, not just an empty one, and degrades through the shared ladder', () => {
    // truncateTitleAtClauseBoundary's contract is that a result under
    // MIN_PEELED_TITLE_CHARS must be refused. Testing only `peeled || fallback`
    // honoured the emptiness half alone: with this input the budget lands inside
    // a run of stopwords, the peel strips them all, and the 6-char fragment
    // "Lavoro" was shipped as the indexed <title> — verified by reverting the
    // guard, at which point this test fails with "expected 6 to be >= 10".
    const rawTitle = 'Lavoro: e di il la per con in su tra fra Svizzera italiana';
    const capped = capSearchStatsLandingTitle(rawTitle, 20);

    expect(capped.length).toBeGreaterThanOrEqual(MIN_PEELED_TITLE_CHARS);
    // Still a real prefix of the title, and still inside the budget.
    expect(rawTitle.startsWith(capped)).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(20);
    expect(capped).not.toContain('…');
  });

  it('keeps the peel when it clears the floor', () => {
    // Guard against "fix" by always hard-cutting: a healthy peel must still win,
    // otherwise the clause-aware truncation this file exists for is dead code.
    const rawTitle = 'Offerte di lavoro Infermiere qualificato in Svizzera italiana';
    const capped = capSearchStatsLandingTitle(rawTitle, 40);
    expect(capped.length).toBeGreaterThanOrEqual(MIN_PEELED_TITLE_CHARS);
    expect(capped.length).toBeLessThanOrEqual(40);
    // A peel never ends on a separator or a dangling function word.
    expect(capped).not.toMatch(/[\s:,;.!?—–·-]$/);
    expect(capped).not.toMatch(/\b(di|in|per|con|il|la|e)$/);
  });

  it('caps an overlong title on a whitespace boundary with NO ellipsis (titleSuffix.ts no-`…` policy)', () => {
    const rawTitle =
      'Offerte di lavoro Responsabile Amministrativo e Finanziario Senior in Svizzera';
    const capped = capSearchStatsLandingTitle(rawTitle);
    expect(capped.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(capped).not.toContain('…');
    expect(rawTitle.startsWith(capped)).toBe(true);
  });

  it('budgets on the ESCAPED length so a raw `&`/`<`/`>`/`"` in a crawled job-title keyword cannot push the rendered <title> past the cap', () => {
    // 41 raw chars, one `&` — fits the pre-fix raw-length budget (<=66)
    // untouched, but `&` -> `&amp;` on escape (the render layer applies
    // `esc(title)` exactly once), so the escaped length must still be
    // re-checked and truncated if it overflows.
    const rawTitle = 'Offerte di lavoro Sales & Marketing in Svizzera';
    expect(rawTitle.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    const capped = capSearchStatsLandingTitle(rawTitle);
    const escapedLength = capped
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').length;
    expect(escapedLength).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it('converges (does not loop forever / return empty) for a title with no whitespace to cut on', () => {
    const rawTitle = 'A'.repeat(120);
    const capped = capSearchStatsLandingTitle(rawTitle);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });
});

describe('deriveJobCanton — visible-page canton resolution', () => {
  it('trusts an explicit canton code that is a real Swiss canton', () => {
    expect(deriveJobCanton({ canton: 'BE' })).toBe('BE');
    expect(deriveJobCanton({ addressRegion: 'zh' })).toBe('ZH');
  });

  it('rejects a well-formed-but-fake canton code and infers from location text instead', () => {
    expect(deriveJobCanton({ canton: 'XX', location: 'Lugano' })).toBe('TI');
  });

  it('infers canton from addressLocality/location when no explicit canton is set', () => {
    expect(deriveJobCanton({ addressLocality: 'Bern' })).toBe('BE');
    expect(deriveJobCanton({ location: 'Winterthur' })).toBe('ZH');
  });

  it('falls back to the default canton (TI) when nothing resolves', () => {
    expect(deriveJobCanton({})).toBe('TI');
    expect(deriveJobCanton({ location: 'not a real place' })).toBe('TI');
  });
});

describe('deriveJobAddressLocality — visible-page locality sanitization (Hirslanden Bern leak)', () => {
  it('garbage/leaked free-text addressLocality never reaches the rendered page', () => {
    const locality = deriveJobAddressLocality(
      { addressLocality: 'Bern - Futsal Minerva Besetzung per: 1', location: 'Bern' },
      'BE',
    );
    expect(locality).not.toBe('Bern - Futsal Minerva Besetzung per: 1');
    expect(locality).toBe('Bern');
  });

  it('a real city from the WRONG canton is rejected, falling through to job.location then the canton capital', () => {
    const locality = deriveJobAddressLocality({ addressLocality: 'Bellinzona' }, 'BE');
    expect(locality).not.toBe('Bellinzona');
    expect(locality).toBe('Bern'); // BE canton-capital, no coherent location fallback available
  });

  it('accepts a real city that agrees with the resolved region', () => {
    expect(deriveJobAddressLocality({ addressLocality: 'Lugano' }, 'TI')).toBe('Lugano');
  });

  it('falls through to job.location when addressLocality is empty/invalid but location is coherent', () => {
    expect(deriveJobAddressLocality({ location: 'Winterthur' }, 'ZH')).toBe('Winterthur');
  });
});
