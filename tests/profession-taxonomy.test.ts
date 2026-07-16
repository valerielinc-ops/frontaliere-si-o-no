import { describe, expect, it } from 'vitest';
import {
  PROFESSION_TAXONOMY,
  classifySearchTerm,
  matchProfession,
  normalizeText,
  stemToken,
} from '../scripts/lib/profession-taxonomy.mjs';

describe('normalizeText', () => {
  it('lowercases, strips accents and punctuation', () => {
    expect(normalizeText('Dipl. Pflegefachfrau 80–100% (Zürich)')).toBe('dipl pflegefachfrau 80 100 zurich');
    expect(normalizeText('  Logopädin / Logopäde  ')).toBe('logopadin logopade');
  });
});

describe('stemToken', () => {
  it('collapses Italian gender/number variants onto one stem', () => {
    expect(stemToken('infermiere')).toBe('infermier');
    expect(stemToken('infermieri')).toBe('infermier');
    expect(stemToken('infermiera')).toBe('infermier');
    expect(stemToken('psicologo')).toBe(stemToken('psicologa'));
  });
  it('leaves short words untouched (oss stays oss)', () => {
    expect(stemToken('oss')).toBe('oss');
  });
});

describe('matchProfession', () => {
  it('matches exact IT terms and gender variants', () => {
    expect(matchProfession('psicologo')).toBe('psicologo');
    expect(matchProfession('psicologa psicologo 40')).toBe('psicologo');
    expect(matchProfession('fisioterapista')).toBe('fisioterapista');
  });

  it('absorbs on-site typing prefixes ≥5 chars, rejects shorter noise', () => {
    expect(matchProfession('inferm')).toBe('infermiere');
    expect(matchProfession('infermier')).toBe('infermiere');
    // 1-4 char fragments are typing noise, never a match
    expect(matchProfession('inf')).toBeNull();
    expect(matchProfession('i')).toBeNull();
  });

  it('matches multi-word aliases order-free and prefers the longest alias', () => {
    expect(matchProfession('operatore socio')).toBe('oss');
    expect(matchProfession('operatore socio sanitario')).toBe('oss');
    expect(matchProfession('ottico optometrista w m d')).toBe('ottico-optometrista');
    expect(matchProfession('assistente dentale lugano')).toBe('assistente-dentale');
  });

  it('matches DE/FR/EN crawler job titles', () => {
    expect(matchProfession('Dipl. Pflegefachfrau/-mann 80-100%')).toBe('infermiere');
    expect(matchProfession('Physiotherapeut/in 100%')).toBe('fisioterapista');
    expect(matchProfession('Sage-femme diplômée')).toBe('ostetrica');
    expect(matchProfession('Fachfrau Gesundheit EFZ')).toBe('oss');
  });

  it('returns null for localities and generic terms', () => {
    expect(matchProfession('lugano')).toBeNull();
    expect(matchProfession('ticino')).toBeNull();
    expect(matchProfession('offerte di lavoro')).toBeNull();
  });
});

describe('classifySearchTerm', () => {
  it('separates the profession and locality dimensions', () => {
    expect(classifySearchTerm('lugano')).toMatchObject({ professionId: null, isPureLocality: true });
    expect(classifySearchTerm('psicologo lugano')).toMatchObject({
      professionId: 'psicologo',
      isPureLocality: false,
      localityTokens: ['lugano'],
    });
    // stop words alone never make a term "pure locality"
    expect(classifySearchTerm('offerte di lavoro').isPureLocality).toBe(false);
  });
});

describe('taxonomy invariants', () => {
  it('has unique ids and a single-substring feedFilter per entry', () => {
    const ids = PROFESSION_TAXONOMY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of PROFESSION_TAXONOMY) {
      // feedFilter becomes jobsSeoPagesPlugin filterKeywords (ANDed):
      // exactly one non-empty lowercase substring per profession.
      expect(entry.feedFilter, entry.id).toBeTruthy();
      expect(entry.feedFilter).toBe(entry.feedFilter.toLowerCase());
      expect(entry.aliases.length, entry.id).toBeGreaterThan(0);
      for (const alias of entry.aliases) {
        expect(alias, `${entry.id} alias "${alias}" must be pre-normalized`).toBe(normalizeText(alias));
      }
    }
  });

  it('covers every PROFESSION_IDS dedicated-landing profession', () => {
    // Mirror of build-plugins/professionLandingsData.ts PROFESSION_IDS: the
    // opportunities script relies on these matching so dedicated landings
    // land in the covered section instead of the unmapped list.
    const dedicated = ['infermiere', 'operaio', 'impiegato', 'ingegnere', 'educatore', 'autista', 'muratore', 'cuoco', 'cameriere', 'elettricista',
      'psicologo', 'fisioterapista', 'logopedista', 'farmacista', 'ostetrica', 'assistente-dentale', 'tecnico-radiologia', 'oss',
      'ottico-optometrista', 'contabile', 'assistente-sociale', 'macellaio', 'saldatore', 'architetto'];
    for (const id of dedicated) {
      expect(matchProfession(id), id).toBe(id);
    }
  });

  it('every alias resolves back to its own entry (collision guard)', () => {
    // Regression guard: an alias added to one entry can silently steal a
    // query from another entry via tokenMatchesAlias's typing-prefix rule
    // (a ≥5-char token fuzzy-matches any alias whose stem starts with the
    // token's stem) combined with the longest-alias tie-break. Feeding
    // every alias back through matchProfession catches that shape whenever
    // the taxonomy changes, not just at authoring time.
    //
    // 'zimmermann' and 'carpenter' are literally listed as aliases of BOTH
    // falegname and carpentiere — German "Zimmermann"/English "carpenter"
    // legitimately span wood-carpentry and metal-carpentry trades, and
    // falegname (declared first) wins the tie. Pre-existing curated
    // ambiguity, unrelated to any change in this file — allowlisted rather
    // than resolved, since picking a single owner is a domain judgment
    // call outside this test's scope.
    const KNOWN_AMBIGUOUS_ALIASES = new Set(['zimmermann', 'carpenter']);
    for (const entry of PROFESSION_TAXONOMY) {
      for (const alias of entry.aliases) {
        if (KNOWN_AMBIGUOUS_ALIASES.has(alias)) continue;
        expect(matchProfession(alias), `${entry.id} alias "${alias}"`).toBe(entry.id);
      }
    }
  });
});
