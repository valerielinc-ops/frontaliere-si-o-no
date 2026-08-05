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
} from '../build-plugins/shared/titleSuffix';

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
    const declaring = files.filter((rel) =>
      /(?:const|let|var)\s+\w*(?:TRAILING_STOPWORDS|STOPWORDS)\w*\s*=\s*new Set\(\[/
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
