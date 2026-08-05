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

  it('never ends on a dangling function word, even when that costs length', () => {
    // The degenerate case, and the one that caught TWO review rounds. This title carries a
    // single content word inside a 20-char budget, so no prefix is both >= 10 chars AND
    // ends on a content word: the options are "Lavoro" (6, clean) or "Lavoro: e di il la"
    // (18, ends on an article). The tie breaks toward the clean ending.
    //
    // The first version of this test asserted only length/prefix/no-ellipsis and therefore
    // passed while shipping "Lavoro: e di il la" as the indexed <title> — the exact defect
    // class the whole PR exists to remove. Asserting the ENDING is the point.
    const rawTitle = 'Lavoro: e di il la per con in su tra fra Svizzera italiana';
    const capped = capSearchStatsLandingTitle(rawTitle, 20);

    expect(capped).not.toMatch(/[\s:,;.!?—–·-]$/);
    expect(capped).not.toMatch(/(^|\s)(di|in|per|con|il|la|e|su|tra|fra)$/);
    expect(capped.length).toBeGreaterThan(0);
    expect(rawTitle.startsWith(capped)).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(20);
    expect(capped).not.toContain('…');
  });

  it('never ends mid-word either, even when the longer candidate looks clean', () => {
    // The stopword check alone is not enough: when no space sits before half the budget,
    // truncateClauseAware returns a raw slice, and a mid-word slice has NOTHING to peel — so
    // it passes the "clean" test unchanged. Here the ladder yields "Lavoro Amminis" (14, no
    // dangling stopword, but cut inside a word) while the peel yields "Lavoro" (6, whole
    // word). Before the boundary check the mid-word candidate won on length.
    const rawTitle = 'Lavoro Amministrazione Ticino';
    const capped = capSearchStatsLandingTitle(rawTitle, 14);

    expect(capped).toBe('Lavoro');
    // Stated as the general rule too, so a future refactor cannot satisfy it by luck.
    const nextChar = rawTitle.charAt(capped.length);
    expect(nextChar === '' || /[^\p{L}\p{N}]/u.test(nextChar)).toBe(true);
  });

  it('still prefers the longer candidate when it is BOTH long enough and unbroken', () => {
    // Guard against "fixing" this by always taking the short clean peel: the longer
    // candidate must still win whenever it ends on a real boundary. Different input and
    // budget from the cases above so this is not a subset of them.
    const rawTitle = 'Assistente amministrativa a Chiasso per studio legale';
    const capped = capSearchStatsLandingTitle(rawTitle, 28);
    expect(capped.length).toBeGreaterThan(MIN_PEELED_TITLE_CHARS);
    expect(capped.length).toBeLessThanOrEqual(28);
    expect(rawTitle.startsWith(capped)).toBe(true);
    expect(capped).not.toMatch(/(^|\s)(di|in|per|con|il|la|a|e)$/);
    const nextChar = rawTitle.charAt(capped.length);
    expect(nextChar === '' || /[^\p{L}\p{N}]/u.test(nextChar)).toBe(true);
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
