/**
 * SERP snippet clause-integrity regression suite (issues #4356/#4357/#4358).
 *
 * The three CTR-under-target template families (`/articoli-frontaliere/`,
 * `/guida-frontaliere/`, `/tasse-e-pensione/`) all shipped SERP text that
 * stopped mid-word or on a dangling preposition. Measured on the live site and
 * the shipped corpus at the time of the fix:
 *
 *   - `<title>` "Confine Italia-Svizzera: 6 regole doganali per frontalier"
 *     (54 of 56 damaged stored titles sit at exactly 57 chars — a hard budget
 *     cut, not editorial intent)
 *   - `<meta description>` "…Giorni di chiusura uffici, impatto su perme…"
 *     (raw 152-code-unit slice in the article render path)
 *   - `<meta description>` "…Confronta requisiti e costi con B, C e…"
 *     (the 160-char clamp peeled separators but not function words)
 *   - 2 936 stored corpus descriptions ending on a dangling function word,
 *     1 844 of them on the literal tail "Dati aggiornati 2026 per"
 *
 * These assertions fail against the pre-fix implementation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  peelDanglingClauseTail,
  repairSerpSnippet,
  truncateHeadline,
  clampMetaDescription,
  truncateTitleAtClauseBoundary,
  buildTitleWithBrand,
  TITLE_MAX_CHARS,
  META_DESCRIPTION_MAX_CHARS,
  endsOnWordBoundary,
  truncateClauseAware,
} from '../build-plugins/shared/titleSuffix';
// Imported directly, not only via titleSuffix.ts: issue #5452 measured that this
// suite — despite being titled after the clause-truncation fix — never once
// named the function every generator actually calls (create-article.mjs,
// newsletter-template.mjs, repair-truncated-article-titles.mjs all delegate to
// it). `endsOnWordBoundary`/`truncateClauseAware` above were covered; this
// wasn't, which is exactly how the mid-word-cut half of #5452 shipped behind a
// green suite after #5474 fixed only the overshoot half.
import { truncateToClause, truncateToClauseNonEmpty } from '../build-plugins/shared/clauseTail.mjs';

/** Function words that must never end a SERP string. Kept small on purpose — the
 *  authoritative list lives in titleSuffix.ts; this is an independent spot-check. */
const DANGLING = /\s(?:e|ed|o|di|del|della|dei|delle|da|dal|in|nel|con|per|tra|fra|su|sul|al|alla|ai|che|come|and|or|the|of|to|for|with|by|from|und|der|die|das|von|zu|im|mit|für|et|ou|le|les|des|du|en|dans|pour|avec|par|qui|que)…?$/iu;

/** A snippet is "clause-complete" when it ends on a content word (optionally
 *  followed by an ellipsis or terminal punctuation), never on a function word. */
function expectClauseComplete(s: string) {
  expect(s, `"${s}" ends on a dangling function word`).not.toMatch(DANGLING);
  expect(s, `"${s}" ends on a bare separator`).not.toMatch(/[,;:|&(\-–—·]\s*…?$/u);
}

describe('peelDanglingClauseTail — the shared primitive', () => {
  it('peels trailing function words until the text ends on content', () => {
    expect(peelDanglingClauseTail('Stipendio netto frontaliere 2026: come')).toBe('Stipendio netto frontaliere 2026');
    expect(peelDanglingClauseTail('Confronta requisiti e costi con B, C e')).toBe('Confronta requisiti e costi con B, C');
    expect(peelDanglingClauseTail('alcol e sigarette. Dati aggiornati 2026 per')).toBe('alcol e sigarette. Dati aggiornati 2026');
  });

  it('leaves complete text untouched', () => {
    for (const s of ['Imposta alla Fonte Ticino 2026', 'Permesso G Svizzera: requisiti', 'Tabelle A B C H']) {
      expect(peelDanglingClauseTail(s)).toBe(s);
    }
  });

  it('peels the multi-locale function words, not just the Italian ones', () => {
    expect(peelDanglingClauseTail('Cross-border guide for')).toBe('Cross-border guide');
    expect(peelDanglingClauseTail('Grenzgänger Ratgeber für')).toBe('Grenzgänger Ratgeber');
    expect(peelDanglingClauseTail('Guide frontalier pour')).toBe('Guide frontalier');
  });
});

describe('truncateToClause — the function every generator actually calls (#5452)', () => {
  it('returns short input verbatim', () => {
    expect(truncateToClause('Tasse frontalieri 2026', 60)).toBe('Tasse frontalieri 2026');
  });

  it('cuts on the reachable space and peels the dangling stopword', () => {
    const out = truncateToClause('Stipendio netto frontaliere 2026: come si calcola', 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect('Stipendio netto frontaliere 2026: come si calcola'.startsWith(out)).toBe(true);
    expectClauseComplete(out);
  });

  it('never overshoots maxLen when a space sits exactly at the budget (#5474 regression)', () => {
    // 'Stipendio netto frontaliere' is exactly 27 chars — a space lands at
    // index 27, i.e. exactly at maxLen. The `+ 1` lookahead exists so this
    // still counts as reachable instead of falling to the no-boundary branch.
    const s = 'Stipendio netto frontaliere 2026';
    expect(s.indexOf(' ', 20)).toBe(27);
    expect(truncateToClause(s, 27)).toBe('Stipendio netto frontaliere');
  });

  it('never overshoots maxLen NOR cuts mid-word when the first token alone exceeds the budget (#5452)', () => {
    // Reproduction measured in the issue: the first token is 59 chars, past
    // maxLen 57, so no space is reachable within the budget at all.
    const text = 'Krankenversicherungspflichtbefreiungsantragsformularvorlage fuer Grenzgaenger';
    const out = truncateToClause(text, 57);
    expect(out.length).toBeLessThanOrEqual(57);
    // The pre-#5474 bug returned 58 chars ("…vorlage" cut inside the word).
    // The pre-this-fix (#5474-only) state returned exactly 57 chars, ALSO cut
    // inside the word ("…vorlag"). Neither is a valid word: the token itself
    // is one unbroken run of letters, so any non-empty prefix that fits the
    // budget necessarily stops inside it. '' is the only value that is both
    // <= maxLen and never mid-word.
    expect(out).toBe('');
  });

  it('same defect, maxLen 30, a single 63-char token with no spaces anywhere', () => {
    const singleToken = 'Grenzgaengerbewilligungsverfahrensantragsformularvorlageblattes';
    expect(singleToken.length).toBe(63);
    expect(singleToken).not.toMatch(/\s/);
    const out = truncateToClause(singleToken, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).toBe('');
  });

  it('does not degrade to the empty-string fallback when a reachable space exists', () => {
    // Guard against an overly-eager fallback: "no space within budget" is the
    // ONLY trigger for the empty result, not "the text is long" in general —
    // here a space sits right at the budget, so this must take the normal
    // space-based branch, never the no-boundary one.
    expect(truncateToClause('Guida pratica frontalieri Ticino', 13)).toBe('Guida pratica');
  });
});

/**
 * The `<title>`-safe half of the pair (PR #5515 review).
 *
 * `truncateToClause` refuses with `''` rather than cut mid-word. That is right
 * for a field a caller may leave unset and WRONG for a `<title>`, because every
 * title generator here interpolates the result into the brand suffix: `''` does
 * not yield "no title", it yields `" | Frontaliere Ticino"` as the whole tag,
 * plus an empty `ogTitle` and an empty JSON-LD `headline`.
 *
 * Measured on the live corpus while closing that review: of the 3 166 published
 * article ids, 62 are longer than 57 chars, 450 are longer than 42, and NONE of
 * the 3 166 contains a space — so on every slug-fallback path the refusal fires
 * routinely, not as an edge case.
 */
describe('truncateToClauseNonEmpty — never returns an empty <title> (#5515 review)', () => {
  it('agrees with truncateToClause whenever a clean clause is reachable', () => {
    for (const [text, max] of [
      ['Stipendio netto frontaliere 2026: come si calcola', 40],
      ['Guida pratica frontalieri Ticino', 13],
      ['Tasse frontalieri 2026', 60],
      ['Stipendio netto frontaliere 2026', 27],
    ] as const) {
      const clause = truncateToClause(text, max);
      expect(clause, `precondition: "${text}" @${max} should have a clean clause`).not.toBe('');
      expect(truncateToClauseNonEmpty(text, max)).toBe(clause);
    }
  });

  it('keeps a within-budget hard cut where truncateToClause refuses (first token overflows)', () => {
    const text = 'Krankenversicherungspflichtbefreiungsantragsformularvorlage fuer Grenzgaenger';
    // The refusal this helper exists to absorb.
    expect(truncateToClause(text, 57)).toBe('');
    const out = truncateToClauseNonEmpty(text, 57);
    expect(out, 'a <title> generator must never receive an empty string').not.toBe('');
    expect(out.length).toBeLessThanOrEqual(57);
    expect(text.startsWith(out)).toBe(true);
  });

  it('prefers the word boundary over a mid-word cut when the budget held only stopwords', () => {
    // The SECOND way truncateToClause can return '': a space IS reachable, but
    // everything inside the budget is a function word and the peel eats it all.
    // The three plugins that used to inline this ladder had the same hole.
    expect(truncateToClause('per il di la con qualcosa', 10)).toBe('');
    expect(truncateToClauseNonEmpty('per il di la con qualcosa', 10)).toBe('per il di');
  });

  it('is empty only when the input is', () => {
    expect(truncateToClauseNonEmpty('', 20)).toBe('');
    expect(truncateToClauseNonEmpty('   ', 20)).toBe('');
    expect(truncateToClauseNonEmpty(null as unknown as string, 20)).toBe('');
    expect(truncateToClauseNonEmpty(undefined as unknown as string, 20)).toBe('');
  });

  it('never exceeds maxLen, on any rung of the ladder', () => {
    const inputs = [
      'Krankenversicherungspflichtbefreiungsantragsformularvorlage fuer Grenzgaenger',
      'Grenzgaengerbewilligungsverfahrensantragsformularvorlageblattes',
      'per il di la con qualcosa',
      'Incidente mortale a porlezza muore un frontaliere di 38 anni 2026',
      'Guida pratica frontalieri Ticino',
    ];
    for (const text of inputs) {
      for (let max = 1; max <= 70; max++) {
        const out = truncateToClauseNonEmpty(text, max);
        expect(out.length, `"${text}" @${max} overshot the budget`).toBeLessThanOrEqual(max);
        expect(out, `"${text}" @${max} returned empty for non-empty input`).not.toBe('');
      }
    }
  });

  it('turns the hyphen slug that regressed create-article into a real title', () => {
    // `data.id` is a slug: no spaces, so truncateToClause refuses outright.
    const id = 'incidente-mortale-a-porlezza-muore-un-frontaliere-di-38-anni-2026';
    expect(id).not.toMatch(/\s/);
    expect(truncateToClause(id, 57)).toBe('');
    // De-hyphenated first (what create-article.mjs now does), the budget has
    // real boundaries and the brand suffix gets something to sit next to.
    const prose = id.replace(/[-_]+/g, ' ').trim();
    const title = truncateToClauseNonEmpty(prose.charAt(0).toUpperCase() + prose.slice(1), 57);
    expect(title.length).toBeLessThanOrEqual(57);
    expect(`${title} | Frontaliere Ticino`).not.toBe(' | Frontaliere Ticino');
    expectClauseComplete(title);
  });
});

/**
 * The three `<title>` generators the #5515 review flagged must not re-inline
 * the ladder. Each had its own copy of
 * `peelDanglingClauseTail(lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced)`
 * — AGENTS.md Non-Negotiable #6 — and all three had already drifted from the
 * shared implementation the same way: they sliced at `max` rather than
 * `max + 1`, losing a whole word when a space sat exactly at the budget.
 */
describe('no <title> generator re-inlines the clause ladder (#5515 review)', () => {
  const TITLE_GENERATORS = [
    'build-plugins/relatedSearchClustersPlugin.ts',
    'build-plugins/orphanQueryLandingPlugin.ts',
    'build-plugins/borderWaitPagesPlugin.ts',
  ];

  it('none of them keeps the hand-rolled no-boundary fallback', () => {
    const root = resolve(__dirname, '..');
    for (const rel of TITLE_GENERATORS) {
      const src = readFileSync(resolve(root, rel), 'utf8');
      expect(
        src,
        `${rel} re-inlined the ladder — it will drift from clauseTail.mjs again`,
      ).not.toMatch(/lastSpace\s*>\s*0\s*\?/);
      expect(
        src,
        `${rel} no longer routes through the shared non-empty helper`,
      ).toContain('truncateToClauseNonEmpty');
    }
  });

  it('the drift the copies had: a space exactly at the budget must keep the word', () => {
    // What every inlined copy returned for this input was "Guida" — the shared
    // ladder's `maxLen + 1` lookahead is the whole difference.
    const s = 'Guida pratica frontalieri Ticino';
    expect(s.indexOf(' ', 6)).toBe(13);
    expect(truncateToClauseNonEmpty(s, 13)).toBe('Guida pratica');
    expect(s.slice(0, 13).lastIndexOf(' ')).toBe(5); // what the copies saw
  });
});

describe('truncateHeadline — no mid-word, no dangling tail', () => {
  it('replaces the raw 152-code-unit slice that shipped "impatto su perme…"', () => {
    const desc =
      'Tutte le date delle festività in Canton Ticino per il 2026: Capodanno, Pasqua, '
      + 'Pentecoste, Natale e i ponti. Giorni di chiusura uffici, impatto su permessi e stipendio';
    // The defect being regression-tested: a raw slice cuts inside "permessi".
    expect(desc.slice(0, 152) + '…').toMatch(/perme…$/);
    const out = truncateHeadline(desc, 155);
    expect(out.length).toBeLessThanOrEqual(155);
    expect(out).not.toMatch(/perme…$/);
    expectClauseComplete(out);
  });

  it('never ends a truncated snippet on a function word', () => {
    const samples = [
      'Permesso G frontaliere 2026: residenza entro 20 km dal confine, contratto svizzero, rientro settimanale, durata 5 anni. Confronta requisiti e costi con B, C e permesso L.',
      'Aliquote imposta alla fonte Ticino 2026: tabelle A, B, C e H con gli scaglioni completi e il calcolo del netto per i frontalieri residenti in Italia e in Svizzera.',
      'Disoccupazione frontalieri Svizzera: quando serve il PD U1, come chiedere la NASpI in Italia, importi aggiornati e i passaggi da seguire subito dopo il licenziamento.',
    ];
    for (const s of samples) {
      for (const max of [100, 120, 140, 155, 160]) {
        expectClauseComplete(truncateHeadline(s, max));
      }
    }
  });

  it('keeps the budget after peeling', () => {
    const s = 'a'.repeat(40) + ' parola ' + 'b'.repeat(40) + ' per il';
    expect(truncateHeadline(s, 60).length).toBeLessThanOrEqual(60);
  });

  it('returns short input verbatim', () => {
    expect(truncateHeadline('Tasse frontalieri', 60)).toBe('Tasse frontalieri');
  });
});

describe('clampMetaDescription inherits the peel', () => {
  it('no longer leaves "con B, C e…" on the guida-frontaliere permessi page', () => {
    const live =
      'Permesso G frontaliere 2026: residenza entro 20 km dal confine, contratto svizzero, '
      + 'rientro settimanale, durata 5 anni. Confronta requisiti e costi con B, C e permesso L.';
    const out = clampMetaDescription(live);
    expect(out.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
    expect(out).not.toMatch(/\bC e…$/);
    expectClauseComplete(out);
  });
});

describe('repairSerpSnippet — heals text truncated upstream', () => {
  it('repairs the shipped corpus tail "Dati aggiornati <year> per"', () => {
    // Year built from the clock, never a literal — AGENTS.md: no absolute dates
    // in fixtures (a hardcoded year here would silently pass into next year).
    const year = new Date().getFullYear();
    const stored =
      'Dal limite di 10.000 euro per il contante alle franchigie su alcol e sigarette: '
      + `cosa cambia per chi viaggia tra Ticino e Lombardia. Dati aggiornati ${year} per`;
    const out = repairSerpSnippet(stored);
    expect(out).toBe(
      'Dal limite di 10.000 euro per il contante alle franchigie su alcol e sigarette: '
      + `cosa cambia per chi viaggia tra Ticino e Lombardia. Dati aggiornati ${year}.`,
    );
    expectClauseComplete(out);
  });

  it('no-ops on text that already reads as complete', () => {
    const complete = [
      'Guida completa per i frontalieri in Ticino.',
      'Permesso G Svizzera 2026',
      'Quanto si paga di tasse? Scoprilo subito!',
      'Calcola il netto…',
    ];
    for (const s of complete) expect(repairSerpSnippet(s)).toBe(s);
  });

  it('never invents text — output is always a prefix of the input (plus terminal stop)', () => {
    const stored = 'Analisi dell impatto per i frontalieri e il mercato del';
    const out = repairSerpSnippet(stored);
    expect(stored.startsWith(out.replace(/\.$/, ''))).toBe(true);
  });

  it('refuses to gut a string when the peel would remove more than half', () => {
    const stored = 'Guida per il che come di';
    expect(repairSerpSnippet(stored)).toBe(stored);
  });

  it('omits the terminal stop for titles when asked', () => {
    expect(repairSerpSnippet('Tasse frontalieri 2026 per', '')).toBe('Tasse frontalieri 2026');
  });

  it('handles empty / whitespace input', () => {
    expect(repairSerpSnippet('')).toBe('');
    expect(repairSerpSnippet('   ')).toBe('');
  });
});

describe('title invariants for the three CTR families', () => {
  it('brand suffix never pushes the title past the SERP cap', () => {
    const headlines = [
      'Imposta alla Fonte Ticino 2026: Tabelle A B C H',
      'Mappa Confine Italia Svizzera: 9 Valichi Ticino',
      'Disoccupazione Frontalieri Svizzera: NASpI e PD U1',
    ];
    for (const h of headlines) {
      const t = buildTitleWithBrand(h);
      expect(t.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expectClauseComplete(t);
    }
  });

  it('truncateTitleAtClauseBoundary still peels (shared primitive, no behaviour drift)', () => {
    expect(truncateTitleAtClauseBoundary('Stipendio netto frontaliere 2026: come | Frontaliere Ticino', 40))
      .toBe('Stipendio netto frontaliere 2026');
  });
});

describe('single source of truth for the clause tail (AGENTS.md Non-Negotiable #6)', () => {
  it('declares the stopword list exactly once in the repo', () => {
    // Before this fix the same list existed in 3 places with different contents
    // (titleSuffix.ts, jobsSeoPagesPlugin.ts's inline regex, create-article.mjs)
    // and had already drifted. Exactly one declaration may exist.
    const root = resolve(__dirname, '..');
    const files = [
      'build-plugins/shared/clauseTail.mjs',
      'build-plugins/shared/titleSuffix.ts',
      'build-plugins/jobsSeoPagesPlugin.ts',
      'scripts/create-article.mjs',
      'services/newsletter-template.mjs',
    ];
    // `(?::\s*[^=;]+)?` between the name and the `=`: two of the files above
    // are `.ts`, where a redeclaration reads
    // `const TRAILING_STOPWORDS_SET: ReadonlySet<string> = new Set([…])`.
    // Without it, what follows the name is `:` and not `=`, the regex misses
    // the declaration, and this guard reports a single source of truth while
    // the list has quietly drifted into a second one — the failure it exists
    // to prevent. Same gap, and same fix, as
    // tests/seo/jobs-dataset-read-once.test.ts (#5447).
    const declaring = files.filter((rel) =>
      /(?:const|let|var)\s+\w*(?:TRAILING_STOPWORDS|STOPWORDS)\w*\s*(?::\s*[^=;]+)?=\s*new Set\(\[/
        .test(readFileSync(resolve(root, rel), 'utf8')));
    expect(declaring).toEqual(['build-plugins/shared/clauseTail.mjs']);
  });

  it('no call site re-implements the preposition peel with its own inline list', () => {
    const root = resolve(__dirname, '..');
    // The exact construct removed from jobsSeoPagesPlugin.ts::truncMetaDesc.
    const inlinePrepositionAlternation = /\(\s*di\s*\|\s*da\s*\|\s*per\b/;
    for (const rel of [
      'build-plugins/jobsSeoPagesPlugin.ts',
      'build-plugins/shared/titleSuffix.ts',
      'services/seoService.ts',
      'services/newsletter-template.mjs',
      'scripts/create-article.mjs',
    ]) {
      expect(inlinePrepositionAlternation.test(readFileSync(resolve(root, rel), 'utf8')), rel)
        .toBe(false);
    }
  });

  it('the .mjs implementation and the typed .ts re-export are the same function', async () => {
    const mjs = await import('../build-plugins/shared/clauseTail.mjs');
    expect(peelDanglingClauseTail).toBe(mjs.peelDanglingClauseTail);
    // Same for the non-empty variant: the TS render layer and the raw-node
    // generators must share one implementation, not two that agree today.
    const ts = await import('../build-plugins/shared/titleSuffix');
    expect(ts.truncateToClauseNonEmpty).toBe(mjs.truncateToClauseNonEmpty);
  });

  it('no hardcoded year in the freshness lever or the truncation helpers', () => {
    const root = resolve(__dirname, '..');
    for (const rel of [
      'build-plugins/shared/titleSuffix.ts',
      'packages/articles/engine/shared/ctrBoostDescription.ts',
    ]) {
      const src = readFileSync(resolve(root, rel), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${rel} hardcodes a calendar year`).not.toMatch(/(?<![\w.])20[2-9]\d(?![\w.])/);
    }
  });
});

describe('endsOnWordBoundary — the second half of "ends cleanly" (review round 4)', () => {
  it('rejects a cut inside a word and accepts one at a real boundary', () => {
    expect(endsOnWordBoundary('Amministrazione contabile', 'Amministraz')).toBe(false);
    expect(endsOnWordBoundary('Amministrazione contabile', 'Amministrazione')).toBe(true);
    expect(endsOnWordBoundary('Amministrazione contabile', 'Amministrazione contabile')).toBe(true);
  });

  it('treats punctuation as a boundary, not just whitespace', () => {
    // A whitespace-only test would reject this valid cut.
    expect(endsOnWordBoundary('Lavoro: Ticino', 'Lavoro')).toBe(true);
  });

  it('does not mistake a split emoji for a boundary', () => {
    // charAt() here returns a lone surrogate, which matches neither \p{L} nor \p{N} — so a
    // charAt-based check would call this clean. Reading the code point does not.
    const source = 'Lavoro 🇨🇭 Ticino';
    const half = source.slice(0, 8); // lands between the two halves of the flag's first pair
    expect(endsOnWordBoundary(source, half)).toBe(false);
  });

  it('refuses a candidate that is not a prefix of the source', () => {
    expect(endsOnWordBoundary('Lavoro Ticino', 'Ticino')).toBe(false);
  });
});

describe('truncateClauseAware — requireWordBoundary (review round 4)', () => {
  it('returns the mid-word slice by default, so truncateHeadline keeps its behaviour', () => {
    // The ellipsis truncateHeadline appends IS the signal that the text was cut, which is
    // why the default stays permissive: "Amministraz…" is legible.
    expect(truncateClauseAware('Amministrazione contabile', 11)).toBe('Amministraz');
    expect(truncateHeadline('Amministrazione contabile', 12)).toBe('Amministraz…');
  });

  it('refuses the same slice when the caller cannot signal truncation', () => {
    // A <title> takes no ellipsis, so the identical string would read as a typo.
    expect(truncateClauseAware('Amministrazione contabile', 11, 11, true)).toBe('');
  });

  it('still returns a clean cut when one exists', () => {
    expect(truncateClauseAware('Amministrazione contabile', 20, 20, true)).toBe('Amministrazione');
  });
});
