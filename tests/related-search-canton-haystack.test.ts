import { describe, it, expect } from 'vitest';
import { cantonSearchTokens } from '../services/cantonList';
import { buildStemmedHaystack, stemSearchToken, normalizeSearchText } from '../services/textUtils';

// Regression for issue #2967: a search query that carries the canton NAME
// ("fust bellinzona ticino" — a real related-search cluster slug) used to fail
// the strict AND-match because a job stores only its city ("Bellinzona") and
// the 2-letter canton code ("TI") — never the canton name. The page then fell
// into the "Nessun risultato esatto" fuzzy fallback even though the source job
// (a Fust vacancy in Bellinzona/Ticino) clearly matched. cantonSearchTokens()
// enriches the search haystack with the localized canton name(s) so the canton
// token becomes a first-class match term.

// Mirror of the strict AND-match the SPA index + the static cluster build plugin
// apply: every stemmed query token must appear as a word-prefix in the haystack.
function andMatches(haystack: string, query: string): boolean {
  const tokens = normalizeSearchText(query).split(' ').filter(Boolean).map(stemSearchToken);
  if (tokens.length === 0) return true;
  return tokens.every((token) => haystack.includes(` ${token}`));
}

describe('cantonSearchTokens', () => {
  it('resolves TI to both Italian and German canton names', () => {
    const tokens = cantonSearchTokens('TI');
    expect(tokens).toContain('ticino');
    expect(tokens).toContain('tessin');
  });

  it('is case-insensitive on the input code', () => {
    expect(cantonSearchTokens('ti')).toBe(cantonSearchTokens('TI'));
  });

  it('returns empty for empty / unknown codes (no junk token)', () => {
    expect(cantonSearchTokens('')).toBe('');
    expect(cantonSearchTokens('XX')).toBe('');
  });

  it('resolves a half-canton code via its URL group', () => {
    // BL is grouped under BASILEA in the URL slug table.
    expect(cantonSearchTokens('BL').toLowerCase()).toContain('basilea');
  });
});

describe('issue #2967 — canton-name query AND-matches a city-only job', () => {
  // A Fust vacancy in Bellinzona, canton TI — the job stores no "Ticino" text.
  const job = {
    title: 'Montatore/trice di impianti sanitari per cucine, bagni',
    company: 'Fust',
    location: 'Bellinzona',
    canton: 'TI',
  };

  it('fails WITHOUT the canton tokens (the bug)', () => {
    const haystack = buildStemmedHaystack(`${job.title} ${job.company} ${job.location}`);
    expect(andMatches(haystack, 'fust bellinzona ticino')).toBe(false);
  });

  it('succeeds WITH the canton tokens (the fix)', () => {
    const haystack = buildStemmedHaystack(
      `${job.title} ${job.company} ${job.location} ${cantonSearchTokens(job.canton)}`,
    );
    expect(andMatches(haystack, 'fust bellinzona ticino')).toBe(true);
    // The German canton name matches too (cross-locale cluster pages).
    expect(andMatches(haystack, 'fust bellinzona tessin')).toBe(true);
  });

  it('does not make an unrelated canton name match', () => {
    const haystack = buildStemmedHaystack(
      `${job.title} ${job.company} ${job.location} ${cantonSearchTokens(job.canton)}`,
    );
    // "zurigo" (Zürich) must not match a Ticino job.
    expect(andMatches(haystack, 'fust bellinzona zurigo')).toBe(false);
  });
});
