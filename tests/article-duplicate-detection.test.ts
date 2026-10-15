/**
 * Tests for multi-signal duplicate detection logic used in create-article.mjs
 * (`checkForDuplicates`).
 *
 * Replicates the ALGORITMO ATTUALE (looking for "Thresholds" in
 * scripts/create-article.mjs), importing stopwords/stemmer/synonyms from the
 * same shared library the generator uses (`scripts/lib/it-text-similarity.mjs`)
 * instead of a hand-copied inline replica. Previously this file pinned
 * thresholds (0.60/0.45/0.35/0.40) and a flat OR condition that predates the
 * 2026-07-01 loosening (#3138) — neither exists in the live implementation
 * anymore, so a green run asserted nothing about real behavior (#5456).
 *
 * Current thresholds (create-article.mjs): ID 0.72 with title confirmation,
 * title adaptive on corpus size (computeAdaptiveEvergreenThresholds, kept in
 * sync with the evergreen pre-flight gate), excerpt 0.62 with entity
 * confirmation, entity 0.65 with combined 0.45, combined 0.55.
 *
 * Behavior MEASURED on the site fixtures below (2026-08-09):
 *   - calo-q4-2025 vs calo-2025 (trio 2026-02-19): CAUGHT (entity 1.00,
 *     combined ~0.64);
 *   - dati-q4-2025 vs calo-q4-2025: CAUGHT (combined ~0.63);
 *   - dati-q4-2025 vs calo-2025: NO LONGER caught (combined ~0.44) — the
 *     #3138 loosening traded this catch against evergreen false positives.
 *     Asserted explicitly so a future re-tune fails this test consciously
 *     instead of drifting silently in either direction;
 *   - congedo-parentale vs maternità-paternità (synonym duplicate): NO LONGER
 *     caught by the lexical check alone (title ~0.50 < adaptive ~0.81) — that
 *     class is now handled by checkSemanticNearDuplicate (embeddings) and the
 *     evergreen pre-flight gate. Synonym normalization itself is still
 *     asserted live via normalizeItWord.
 *
 * The drift guard at the bottom ties this replica to the source: if
 * checkForDuplicates' thresholds or composed conditions change again, THIS
 * file fails with instructions to realign replica and expectations, instead
 * of aging silently (the reason we're here per #5456).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jaccardSim, normalizeItWord, STOP_WORDS_IT } from '../scripts/lib/it-text-similarity.mjs';
import { computeAdaptiveEvergreenThresholds } from '../scripts/lib/scoring/constants.mjs';

const ROOT = resolve(__dirname, '..');

// Corpus size at expectation-recording time (3,768 IT titles measured
// 2026-08-09). The title threshold is adaptive but saturates at the 0.85
// ceiling, and is already ≈0.81 at this size: the expectations below stay
// valid for any larger future corpus (the threshold can only rise toward
// 0.85). Pinning it here keeps the test deterministic instead of depending
// on checkout content.
const CORPUS_SIZE_AT_RECORDING = 3768;

// ── Replica of the pure part of checkForDuplicates (create-article.mjs) ──

function getSignificantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zàáèéìíòóùú0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS_IT.has(w))
    .map((w) => normalizeItWord(w));
}

function extractKeyEntities(text: string): string[] {
  const entities = new Set<string>();
  const s = String(text || '');
  for (const m of s.matchAll(/\d[\d.'',]*\d/g)) entities.add(m[0].replace(/[.''',]/g, ''));
  for (const m of s.matchAll(/\b(\d+)[.,]?(\d*)\s*%/g)) entities.add(`${m[1]}${m[2]}%`);
  return [...entities];
}

interface ArticleSignals {
  id: string;
  title: string;
  excerpt: string;
}

function checkDuplicate(
  newArticle: ArticleSignals,
  existingArticle: ArticleSignals,
  corpusSize = CORPUS_SIZE_AT_RECORDING
): {
  isDuplicate: boolean;
  idSim: number;
  titleSim: number;
  excerptSim: number;
  entitySim: number;
  combinedScore: number;
} {
  const ID_THRESHOLD = 0.72;
  const TITLE_THRESHOLD = computeAdaptiveEvergreenThresholds(corpusSize).titleJaccard;
  const EXCERPT_THRESHOLD = 0.62;
  const COMBINED_THRESHOLD = 0.55;

  const newIdWords = newArticle.id.split('-').filter((w) => w.length > 1).map((w) => normalizeItWord(w));
  const existingIdWords = existingArticle.id.split('-').filter((w) => w.length > 1).map((w) => normalizeItWord(w));
  const idSim = jaccardSim(newIdWords, existingIdWords);
  const titleSim = jaccardSim(getSignificantWords(newArticle.title), getSignificantWords(existingArticle.title));
  const excerptSim = jaccardSim(getSignificantWords(newArticle.excerpt), getSignificantWords(existingArticle.excerpt));
  const entitySim = jaccardSim(
    extractKeyEntities(newArticle.title + ' ' + newArticle.excerpt),
    extractKeyEntities(existingArticle.title + ' ' + existingArticle.excerpt)
  );

  const combinedScore = 0.25 * idSim + 0.3 * titleSim + 0.25 * excerptSim + 0.2 * entitySim;

  const isDuplicate =
    (idSim >= ID_THRESHOLD && titleSim >= 0.4) ||
    titleSim >= TITLE_THRESHOLD ||
    (excerptSim >= EXCERPT_THRESHOLD && entitySim >= 0.2) ||
    (entitySim >= 0.65 && combinedScore >= 0.45) ||
    combinedScore >= COMBINED_THRESHOLD;

  return { isDuplicate, idSim, titleSim, excerptSim, entitySim, combinedScore };
}

// ── The three known duplicates from 2026-02-19 ─────────────────────

const ARTICLE_1: ArticleSignals = {
  id: 'frontalieri-ticino-calo-2025',
  title: 'Frontalieri in calo in Ticino: i dati del 2025',
  excerpt:
    "Mentre la Svizzera segna un record di 411.000 frontalieri, il Ticino va in controtendenza: -1,0% nell'ultimo trimestre. Analisi dei dati UST e cosa significa per il mercato.",
};

const ARTICLE_2: ArticleSignals = {
  id: 'frontalieri-ticino-calo-q4-2025',
  title: 'Frontalieri: Ticino in calo, Svizzera in crescita',
  excerpt:
    "Gli ultimi dati UST per il Q4 2025 mostrano un Ticino in controtendenza: -1.0% di frontalieri su base trimestrale, mentre la Svizzera tocca quota 411'000.",
};

const ARTICLE_3: ArticleSignals = {
  id: 'frontalieri-ticino-dati-q4-2025',
  title: 'Frontalieri: la Svizzera cresce, il Ticino frena',
  excerpt:
    'Mentre la Svizzera tocca un nuovo record con 411.000 frontalieri, il Ticino va in controtendenza. A fine 2025 i permessi G scendono a 78.809 (-1,0%).',
};

// ── Tests ───────────────────────────────────────────────────────────

describe('Article duplicate detection (multi-signal, algoritmo attuale)', () => {
  describe('the 2026-02-19 trio against current thresholds', () => {
    it('detects article 2 as duplicate of article 1 (entity 1.00 + combined)', () => {
      const result = checkDuplicate(ARTICLE_2, ARTICLE_1);
      expect(result.isDuplicate).toBe(true);
      expect(result.entitySim).toBeGreaterThanOrEqual(0.65);
    });

    it('detects article 3 as duplicate of article 2 (combined above threshold)', () => {
      const result = checkDuplicate(ARTICLE_3, ARTICLE_2);
      expect(result.isDuplicate).toBe(true);
      expect(result.combinedScore).toBeGreaterThanOrEqual(0.55);
    });

    it('no longer detects article 3 as duplicate of article 1 — measured cost of the #3138 loosening', () => {
      // Combined ~0.44: below the entity-0.65-plus-combined-0.45 gate by a
      // hair, and below the flat 0.55 combined threshold. If this starts
      // failing with dup=true, the tuning has changed — update the
      // expectation CONSCIOUSLY, don't widen the replica to compensate.
      const result = checkDuplicate(ARTICLE_3, ARTICLE_1);
      expect(result.isDuplicate).toBe(false);
      expect(result.entitySim).toBeGreaterThanOrEqual(0.65);
      expect(result.combinedScore).toBeGreaterThan(0.4);
    });
  });

  describe('does NOT flag genuinely different articles', () => {
    const DIFFERENT_ARTICLE: ArticleSignals = {
      id: 'guida-assicurazione-malattia-lamal',
      title: "Assicurazione malattia LAMal: guida completa per frontalieri",
      excerpt:
        'Come scegliere la cassa malati in Svizzera. Confronto franchigie, modelli e premi 2026.',
    };

    const ANOTHER_DIFFERENT: ArticleSignals = {
      id: 'terzo-pilastro-frontalieri-2026',
      title: 'Terzo pilastro 3a: conviene ai frontalieri nel 2026?',
      excerpt:
        'Vantaggi fiscali del pilastro 3a per frontalieri italiani. Limiti di deduzione e migliori offerte bancarie.',
    };

    it('does not flag LAMal article vs frontalieri-calo article', () => {
      expect(checkDuplicate(DIFFERENT_ARTICLE, ARTICLE_1).isDuplicate).toBe(false);
    });

    it('does not flag pillar-3 vs frontalieri-calo article', () => {
      expect(checkDuplicate(ANOTHER_DIFFERENT, ARTICLE_1).isDuplicate).toBe(false);
    });

    it('does not flag LAMal vs pillar-3 articles (identical entities, everything else different)', () => {
      // Both only cite "2026": entitySim 1.00. This is exactly the case the
      // entity gate requires paired with combined ≥ 0.45 — here it's ~0.23.
      const result = checkDuplicate(DIFFERENT_ARTICLE, ANOTHER_DIFFERENT);
      expect(result.isDuplicate).toBe(false);
    });

    it('does not flag articles with same source data but very different framing', () => {
      const newArt: ArticleSignals = {
        id: 'statistiche-permesso-g-fine-anno',
        title: 'Permessi G: i numeri di fine 2025 in Ticino',
        excerpt:
          'I dati UST mostrano 78.809 frontalieri in Ticino (-1,0%). La Svizzera raggiunge quota 411.000.',
      };
      const result = checkDuplicate(newArt, ARTICLE_1);
      expect(result.isDuplicate).toBe(false);
      expect(result.entitySim).toBeGreaterThan(0.5);
    });

    it('does not flag articles sharing only common words like "frontalieri" and "ticino"', () => {
      const genericNew: ArticleSignals = {
        id: 'frontalieri-ticino-trasporti-2026',
        title: 'Trasporti per frontalieri in Ticino: novità 2026',
        excerpt:
          'Nuovi orari FFS e TILO per i pendolari transfrontalieri. Abbonamenti Arcobaleno in arrivo.',
      };
      expect(checkDuplicate(genericNew, ARTICLE_1).isDuplicate).toBe(false);
    });
  });

  // ── Synonym/morphological duplicates: tokenizer stays alive even when the threshold no longer fires ──

  describe('synonyms: alive in the tokenizer even where the threshold no longer fires', () => {
    const MATERNITY_ARTICLE: ArticleSignals = {
      id: 'congedo-parentale-frontalieri-svizzera',
      title: 'Congedo parentale per frontalieri in Svizzera: guida completa',
      excerpt:
        'Tutto sul congedo di maternità e paternità per i lavoratori frontalieri. Durata, indennità giornaliera e diritti dei genitori.',
    };

    const PARENTAL_LEAVE_ARTICLE: ArticleSignals = {
      id: 'maternita-paternita-frontalieri-diritti',
      title: 'Maternità e paternità: diritti dei frontalieri in Svizzera',
      excerpt:
        'Guida ai diritti delle gestanti e dei neo-genitori transfrontalieri. Congedo nascita, indennità e protezione dal licenziamento.',
    };

    it('the lexical check alone no longer catches them (used to be the site\'s cardinal case)', () => {
      // Title ~0.50 against adaptive threshold ~0.81, combined ~0.33. Today
      // this class is the job of checkSemanticNearDuplicate (embeddings) and
      // the evergreen pre-flight gate. Asserted so a future reader doesn't
      // infer a lexical protection from the file name that isn't there.
      const result = checkDuplicate(PARENTAL_LEAVE_ARTICLE, MATERNITY_ARTICLE);
      expect(result.isDuplicate).toBe(false);
    });

    it('but synonym normalization stays alive: similarity is high, not zero', () => {
      const result = checkDuplicate(PARENTAL_LEAVE_ARTICLE, MATERNITY_ARTICLE);
      expect(result.titleSim).toBeGreaterThan(0.3);
      expect(result.excerptSim).toBeGreaterThan(0.2);
    });
  });

  describe('Jaccard similarity (shared jaccardSim)', () => {
    it('returns 0 for empty arrays', () => {
      expect(jaccardSim([], [])).toBe(0);
    });

    it('returns 1 for identical sets', () => {
      expect(jaccardSim(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    });

    it('returns 0 for disjoint sets', () => {
      expect(jaccardSim(['a', 'b'], ['c', 'd'])).toBe(0);
    });

    it('handles partial overlap', () => {
      // {a,b,c} ∩ {b,c,d} = {b,c} → 2/4 = 0.5
      expect(jaccardSim(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5);
    });
  });

  describe('entity extraction', () => {
    it('extracts numbers from text', () => {
      const entities = extractKeyEntities('Il Ticino ha 78.809 frontalieri su 411.000 totali');
      expect(entities).toContain('78809');
      expect(entities).toContain('411000');
    });

    it('extracts percentages', () => {
      const entities = extractKeyEntities('Calo del -1,0% e crescita del 3.2%');
      expect(entities.some((e) => e.includes('%'))).toBe(true);
    });
  });

  // ── Synonym mapping tests (normalizeItWord — what the generator really uses) ──

  describe('synonym normalization (normalizeItWord, the map the generator actually uses)', () => {
    it('maps maternità and congedo to same canonical', () => {
      expect(normalizeItWord('maternità')).toBe(normalizeItWord('congedo'));
    });

    it('maps paternità and parentale to same canonical', () => {
      expect(normalizeItWord('paternità')).toBe(normalizeItWord('parentale'));
    });

    it('maps frontalieri and pendolari to same canonical', () => {
      expect(normalizeItWord('frontalieri')).toBe(normalizeItWord('pendolari'));
    });

    it('maps imposta and tassa to same canonical', () => {
      expect(normalizeItWord('imposta')).toBe(normalizeItWord('tassa'));
    });

    it('maps stipendio and salario to same canonical', () => {
      expect(normalizeItWord('stipendio')).toBe(normalizeItWord('salario'));
    });

    it('does not map unrelated words to same canonical', () => {
      expect(normalizeItWord('pensione')).not.toBe(normalizeItWord('trasporto'));
    });
  });
});

// ── Drift guard: the replica above must match the real source ──

describe('drift guard — checkForDuplicates in create-article.mjs', () => {
  it('the thresholds and composed conditions replicated here exist verbatim in the source', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/create-article.mjs'), 'utf-8');

    expect(src).toContain('function checkForDuplicates(data)');
    expect(src).toContain('const ID_THRESHOLD = 0.72;');
    expect(src).toContain('computeAdaptiveEvergreenThresholds(existingArticles.length).titleJaccard');
    expect(src).toContain('const EXCERPT_THRESHOLD = 0.62;');
    expect(src).toContain('const COMBINED_THRESHOLD = 0.55;');
    expect(src).toContain('(idSim >= ID_THRESHOLD && titleSim >= 0.40) ||');
    expect(src).toContain('(excerptSim >= EXCERPT_THRESHOLD && entitySim >= 0.20) ||');
    expect(src).toContain('(entitySim >= 0.65 && combinedScore >= 0.45) ||');
    expect(src).toContain('.map(w => normalizeItWord(w))');

    // The combined score weights, line by line as they stand in the source.
    expect(src).toContain('0.25 * idSim +');
    expect(src).toContain('0.30 * titleSim +');
    expect(src).toContain('0.25 * excerptSim +');
    expect(src).toContain('0.20 * entitySim;');
  });

  it('the adaptive title threshold saturates at the ceiling: expectations stay valid on larger corpora', () => {
    const at3768 = computeAdaptiveEvergreenThresholds(3768).titleJaccard;
    const at10000 = computeAdaptiveEvergreenThresholds(10000).titleJaccard;
    expect(at3768).toBeGreaterThan(0.8);
    expect(at10000).toBeGreaterThanOrEqual(at3768);
    expect(at10000).toBeLessThan(0.86);
  });
});
