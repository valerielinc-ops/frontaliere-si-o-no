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
    // query from another entry via matchProfession's typing-prefix rule
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

/**
 * matchProfession resolves candidates through a precomputed alias index
 * (single-word aliases bucketed by stem + sorted for the ≥5-char prefix range,
 * multi-word aliases bucketed by their FIRST word stem). That index replaced a
 * scan of all 940 aliases per call — ~596 µs → ~11 µs, which is what let
 * JobBoard build its search index in ~200 ms instead of ~2,7 s.
 *
 * The risk the index introduces is *silent incompleteness*: a bucketing bug
 * loses matches without failing anything above. So this block keeps the
 * original exhaustive scan as a reference oracle and asserts the two agree —
 * including on the inputs the index treats specially (multi-word aliases,
 * typing prefixes, sub-5-char tokens that must NOT get prefix tolerance).
 */
describe('matchProfession alias index', () => {
  /** Verbatim pre-index implementation, kept as the oracle. */
  function referenceMatchProfession(text: string): string | null {
    const norm = normalizeText(text);
    if (!norm) return null;
    const tokens = norm.split(' ').filter((t) => t.length >= 2);
    if (tokens.length === 0) return null;
    const stems = tokens.map(stemToken);
    const tokenMatchesAlias = (token: string, alias: string) => {
      const ts = stemToken(token);
      const as = stemToken(alias);
      if (ts === as) return true;
      if (token.length >= 5 && as.startsWith(ts)) return true;
      return false;
    };
    let best: { id: string; aliasLength: number } | null = null;
    for (const entry of PROFESSION_TAXONOMY) {
      for (const alias of entry.aliases) {
        const matched = alias.includes(' ')
          ? alias.split(' ').every((w) => { const ws = stemToken(w); return stems.some((s) => s === ws); })
          : tokens.some((t) => tokenMatchesAlias(t, alias));
        if (matched && (!best || alias.length > best.aliasLength)) {
          best = { id: entry.id, aliasLength: alias.length };
        }
      }
    }
    return best ? best.id : null;
  }

  /**
   * Every alias, the shapes a job title wraps it in, and the SHORT typing
   * prefixes — 2..8 chars is where the branches differ (the <5 exact-only cut,
   * and the sorted-stem range walk that serves ≥5). Longer prefixes only get
   * closer to the exact alias, which the verbatim pass already covers, so they
   * buy no branch coverage and the O(940-alias) oracle makes them expensive.
   */
  function generatedInputs(): string[] {
    const out = new Set<string>([
      '', ' ', 'a', 'ab', 'zzz', '123', 'lavoro part time', 'Infermier@ 80%',
      'Dipl. Pflegefachfrau HF 80–100% (Zürich)', 'assistente psicologo', 'psi', 'psico', 'psicol',
    ]);
    for (const entry of PROFESSION_TAXONOMY) {
      for (const alias of entry.aliases) {
        out.add(alias);
        out.add(alias.toUpperCase());
        out.add(`${alias} ticino`);
        out.add(`cerco ${alias} 80%`);
        out.add(`${alias}x`);
        out.add(alias.replace(/o$/, 'a'));
        for (let n = 2; n <= Math.min(8, alias.length); n += 1) out.add(alias.slice(0, n));
      }
    }
    return [...out];
  }

  it('agrees with the exhaustive scan on every alias, prefix and title shape', () => {
    const inputs = generatedInputs();
    // Guard the guard: a taxonomy that stopped loading would make this vacuous.
    expect(inputs.length).toBeGreaterThan(5000);
    const mismatches = inputs
      .map((input) => ({ input, oracle: referenceMatchProfession(input), actual: matchProfession(input) }))
      .filter((r) => r.oracle !== r.actual);
    expect(mismatches).toEqual([]);
    // The oracle is O(940 aliases) per input by construction; an explicit
    // budget keeps it from flaking on a contended runner at the 15 s default.
  }, 30_000);

  it('finds a multi-word alias whose first word alone is present in the input', () => {
    // Bucketed under the FIRST word's stem, so the gate must not fire on a
    // partial hit: "operatore" alone is not "operatore socio sanitario".
    expect(matchProfession('operatore di magazzino')).not.toBe('oss');
    expect(matchProfession('operatore socio sanitario 80%')).toBe('oss');
    // Order-free: the words may arrive in any order and still complete.
    expect(matchProfession('sanitario operatore socio')).toBe('oss');
  });

  it('keeps prefix tolerance a ≥5-char privilege after indexing', () => {
    expect(matchProfession('psicol')).toBe('psicologo');
    expect(matchProfession('psi')).toBeNull();
  });
});
