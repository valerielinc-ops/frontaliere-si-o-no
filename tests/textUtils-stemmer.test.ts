import { describe, it, expect } from 'vitest';
import {
  normalizeSearchText,
  stemSearchToken,
  buildStemmedHaystack,
} from '@/services/textUtils';
import { professionSynonymText } from '@/services/professionSynonyms';

/** Repro of the matching used in JobBoard.indexedQueryMatch. */
function matches(haystack: string, query: string): boolean {
  const tokens = normalizeSearchText(query).split(' ').filter(Boolean).map(stemSearchToken);
  return tokens.length === 0 || tokens.every((t) => haystack.includes(` ${t} `));
}

describe('stemSearchToken — Italian plural / gender collapse', () => {
  it('collapses pulizie ↔ pulizia to the same stem', () => {
    // Greedy strip of up to 2 trailing vowels: "pulizie" → "puliz", "pulizia" → "puliz"
    expect(stemSearchToken('pulizie')).toBe('puliz');
    expect(stemSearchToken('pulizia')).toBe('puliz');
  });

  it('collapses infermieri / infermiere / infermiera', () => {
    expect(stemSearchToken('infermieri')).toBe('infermier');
    expect(stemSearchToken('infermiere')).toBe('infermier');
    expect(stemSearchToken('infermiera')).toBe('infermier');
  });

  it('collapses sviluppatori / sviluppatore', () => {
    expect(stemSearchToken('sviluppatori')).toBe('sviluppator');
    expect(stemSearchToken('sviluppatore')).toBe('sviluppator');
  });

  it('keeps short tokens untouched (≤ 3 chars)', () => {
    expect(stemSearchToken('the')).toBe('the');
    expect(stemSearchToken('ai')).toBe('ai');
  });

  it('keeps short stems intact when stripping would over-shorten', () => {
    // "uso" has only 3 chars → unchanged
    expect(stemSearchToken('uso')).toBe('uso');
  });

  it('keeps cassa and casa distinct (cas vs cass)', () => {
    expect(stemSearchToken('casa')).toBe('cas');
    expect(stemSearchToken('cassa')).toBe('cass');
  });
});

describe('stemSearchToken — derivational root reduction (deeper than vowel strip)', () => {
  it('collapses the -istic-/-ist- adjectival family onto the noun root', () => {
    // The reported case: a query token "infermieristiche" must reach the same
    // root as the job word "infermiere" so nursing jobs match on the domain
    // word, not just on generic co-occurring words.
    expect(stemSearchToken('infermieristiche')).toBe('infermier');
    expect(stemSearchToken('infermieristico')).toBe('infermier');
    expect(stemSearchToken('infermieristica')).toBe('infermier');
    // …and the plain noun forms already collapse there via the vowel strip.
    expect(stemSearchToken('infermiere')).toBe('infermier');
    expect(stemSearchToken('infermieri')).toBe('infermier');
  });

  it('strips -zione / -aggio / -mento nominalizations to a shared prefix', () => {
    expect(stemSearchToken('educazione')).toBe('educ');
    expect(stemSearchToken('magazzinaggio')).toBe('magazzin');
    expect(stemSearchToken('allenamento')).toBe('allen');
  });

  it('guards against over-stemming short words (residual ≥ 4)', () => {
    // "vita" must NOT lose "-ita" → "v"; the residual-length guard skips it.
    expect(stemSearchToken('vita')).toBe('vit');
    // "uso" (≤3) untouched.
    expect(stemSearchToken('uso')).toBe('uso');
  });

  it('does not merge distinct consonant stems after derivational strip', () => {
    // casa/cassa still distinct (no derivational suffix applies).
    expect(stemSearchToken('casa')).not.toBe(stemSearchToken('cassa'));
  });
});

describe('buildStemmedHaystack — word-boundary anchored stemmed haystack', () => {
  it('wraps result in spaces and stems each word', () => {
    // ufficio → uffic (greedy strip 'io'), centrale → central
    expect(buildStemmedHaystack('Infermiera ufficio centrale')).toBe(' infermier uffic central ');
  });

  it('returns empty string for empty input', () => {
    expect(buildStemmedHaystack('')).toBe('');
    expect(buildStemmedHaystack('   ')).toBe('');
  });
});

describe('JobBoard search — sector keyword matching (regression for ?q=Pulizie / ?q=Sviluppatori software)', () => {
  it('?q=Pulizie matches a "Pulizia" job (Italian plural collapses)', () => {
    const haystack = buildStemmedHaystack('Addetto pulizia uffici Lugano');
    expect(matches(haystack, 'Pulizie')).toBe(true);
  });

  it('?q=Pulizia matches a "Pulizie" job (singular query, plural body)', () => {
    const haystack = buildStemmedHaystack('Servizi di pulizie industriali');
    expect(matches(haystack, 'Pulizia')).toBe(true);
  });

  it('?q=Sviluppatori software matches a "Sviluppatore Software" job', () => {
    const haystack = buildStemmedHaystack('Sviluppatore Software Senior Lugano');
    expect(matches(haystack, 'Sviluppatori software')).toBe(true);
  });

  it('?q=Case anziani matches a "Casa anziani" job', () => {
    const haystack = buildStemmedHaystack('Operatore casa anziani Mendrisio');
    expect(matches(haystack, 'Case anziani')).toBe(true);
  });

  it('?q=Infermieri matches "Infermiera" / "Infermiere" / "Infermieri" alike', () => {
    expect(matches(buildStemmedHaystack('Infermiera reparto cardiologia'), 'Infermieri')).toBe(true);
    expect(matches(buildStemmedHaystack('Infermiere strumentista sala operatoria'), 'Infermieri')).toBe(true);
    expect(matches(buildStemmedHaystack('Infermieri pediatrici'), 'Infermieri')).toBe(true);
  });

  it('does NOT match unrelated words even after stemming (case ≠ cassa)', () => {
    // ?q=Case (stem 'cas') must not match a "cassa malati" job (stem 'cass')
    const cassa = buildStemmedHaystack('Impiegato cassa malati Lugano');
    expect(matches(cassa, 'Case')).toBe(false);
    // sanity: does match a real "casa" job
    const casa = buildStemmedHaystack('Casa anziani Lugano');
    expect(matches(casa, 'Case')).toBe(true);
  });

  it('multi-token AND: every query token must match', () => {
    const haystack = buildStemmedHaystack('Sviluppatore software senior');
    expect(matches(haystack, 'Sviluppatori software')).toBe(true);
    expect(matches(haystack, 'Sviluppatori marketing')).toBe(false);
  });

  it('prefix-anchored (no false positives mid-word)', () => {
    // 'banana' stems to 'banan'; query 'ana' (3 chars, untouched) must NOT match
    const haystack = buildStemmedHaystack('Lavoro produzione banana');
    expect(matches(haystack, 'ana')).toBe(false);
  });
});

describe('JobBoard search — cross-locale profession synonyms (issue #4253)', () => {
  /** Mirrors how JobBoard's haystack builders append professionSynonymText(title). */
  function haystackWithSynonyms(title: string, rest: string): string {
    return buildStemmedHaystack(`${title} ${rest} ${professionSynonymText(title)}`);
  }

  it('?q=nurse (EN) matches an Italian-titled "Infermiera" job', () => {
    const haystack = haystackWithSynonyms('Infermiera SSR', 'EOC Lugano TI reparto cardiologia');
    expect(matches(haystack, 'nurse')).toBe(true);
  });

  it('?q=pflegefachfrau (DE) matches an Italian-titled "Infermiere" job', () => {
    const haystack = haystackWithSynonyms('Infermiere di reparto', 'Casa anziani Bellinzona TI');
    expect(matches(haystack, 'pflegefachfrau')).toBe(true);
  });

  it('?q=infirmier (FR) matches an English-titled "Registered Nurse" job', () => {
    const haystack = haystackWithSynonyms('Registered Nurse', 'Lugano Regional Hospital TI');
    expect(matches(haystack, 'infirmier')).toBe(true);
  });

  it('does not introduce false positives for a title matching no known profession', () => {
    const haystack = haystackWithSynonyms('Addetto imballaggio stagionale', 'Mendrisio TI');
    expect(matches(haystack, 'nurse')).toBe(false);
    expect(matches(haystack, 'pflegefachfrau')).toBe(false);
  });
});
