/**
 * Tests for multi-signal duplicate detection logic used in create-article.mjs.
 *
 * Validates that the algorithm catches near-duplicate articles including:
 *   - Surface-text duplicates (frontalieri-ticino-calo variants from 2026-02-19)
 *   - Synonym/morphological duplicates (congedo-parentale vs maternità-paternità)
 *
 * The detection pipeline: tokenize → stem (Italian suffix stripping) → synonym-normalize → Jaccard
 */

// ── Replicate the detection utilities from create-article.mjs ───────

const STOP_WORDS_IT = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'a', 'da',
  'in', 'con', 'su', 'per', 'tra', 'fra', 'e', 'o', 'ma', 'che', 'non',
  'del', 'al', 'dal', 'nel', 'sul', 'dello', 'alla', 'della', 'dei', 'degli',
  'delle', 'ai', 'dai', 'nei', 'sui', 'è', 'sono', 'come', 'più', 'anche',
  'già', 'ancora', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella',
  'molto', 'poco', 'tutto', 'tutti', 'ogni', 'altro', 'altra', 'altri', 'altre',
  'suo', 'sua', 'suoi', 'sue', 'loro', 'chi', 'cosa', 'dove', 'quando',
  'mentre', 'dopo', 'prima', 'tra', 'fino', 'solo', 'nuovo', 'nuova', 'nuovi',
  'base', 'rispetto', 'ultimo', 'ultima', 'ultimi', 'ultime',
]);

// ── Italian stemmer (suffix stripping — must match create-article.mjs) ──
function stemIt(word: string): string {
  if (word.length <= 3) return word;
  const suffixes = [
    'izzazione', 'izzazioni',
    'amento', 'amenti', 'imento', 'imenti',
    'zione', 'zioni', 'sione', 'sioni',
    'abile', 'ibili', 'mente',
    'iere', 'ieri', 'iera', 'ance', 'enza', 'enze',
    'ante', 'anti', 'ente', 'enti',
    'ario', 'aria', 'ari',
    'tore', 'tori', 'trice', 'trici',
    'ista', 'isti', 'iste',
    'oso', 'osa', 'osi', 'ose',
    'ale', 'ali', 'ile', 'ili',
    'ato', 'ata', 'ati', 'ate', 'ito', 'ita', 'iti', 'ite',
    'ano', 'ana', 'ani', 'ane',
    'ino', 'ina', 'ini', 'ine',
    'one', 'oni',
    'ore', 'ori',
    'ura', 'ure',
    'io', 'ia', 'ie',
    'à', 'tà',
    'ere', 'are', 'ire',
  ];
  for (const s of suffixes) {
    if (word.endsWith(s) && (word.length - s.length) >= 3) {
      return word.slice(0, -s.length);
    }
  }
  if (/[aeiou]$/.test(word) && word.length > 4) {
    return word.slice(0, -1);
  }
  return word;
}

// ── Domain synonym groups (must match create-article.mjs) ──
const SYNONYM_GROUPS = [
  ['maternità', 'maternita', 'paternità', 'paternita', 'congedo', 'parentale', 'genitoriale', 'nascita', 'neonato', 'gestante', 'puerperio'],
  ['imposta', 'tassa', 'tasse', 'fiscale', 'fiscali', 'fisco', 'tributario', 'tributaria', 'irpef', 'imposizione'],
  ['stipendio', 'salario', 'retribuzione', 'busta', 'paga', 'reddito', 'ral', 'compenso', 'emolumento'],
  ['frontaliere', 'frontalieri', 'frontaliera', 'transfrontaliero', 'transfrontaliera', 'pendolare', 'pendolari', 'cross-border'],
  ['assicurazione', 'assicurazioni', 'copertura', 'polizza', 'lamal', 'cassa', 'malati', 'premio', 'premi'],
  ['pensione', 'pensioni', 'pensionamento', 'previdenza', 'avs', 'lpp', 'pilastro', 'rendita', 'rendite'],
  ['permesso', 'permessi', 'autorizzazione', 'autorizzazioni', 'visto'],
  ['trasporto', 'trasporti', 'mobilità', 'mobilita', 'pendolarismo', 'treno', 'treni', 'bus', 'auto', 'traffico'],
  ['casa', 'abitazione', 'alloggio', 'affitto', 'immobiliare', 'immobile', 'appartamento'],
  ['banca', 'bancario', 'bancaria', 'conto', 'finanza', 'finanziario', 'finanziaria'],
  ['lavoro', 'lavorare', 'lavoratore', 'lavoratori', 'lavoratrice', 'occupazione', 'impiego', 'mestiere'],
  ['figlio', 'figli', 'figlia', 'figlie', 'bambino', 'bambini', 'bambina', 'bambine', 'minore', 'minori'],
  ['svizzera', 'svizzero', 'elvetico', 'elvetica', 'confederazione', 'ch'],
  ['italia', 'italiano', 'italiana', 'italiani', 'italiane', 'tricolore', 'belpaese'],
  ['cambio', 'valuta', 'tasso', 'conversione', 'forex', 'chf', 'eur', 'euro', 'franco', 'franchi'],
  ['costo', 'costi', 'spesa', 'spese', 'prezzo', 'prezzi', 'tariffa', 'tariffe'],
  ['guida', 'tutorial', 'manuale', 'istruzioni', 'procedura', 'procedure', 'howto'],
  ['scuola', 'scolastico', 'scolastica', 'istruzione', 'educazione', 'asilo', 'nido'],
  ['sanità', 'sanita', 'sanitario', 'sanitaria', 'salute', 'medico', 'medica', 'ospedale', 'clinica'],
];

const synonymMap = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0];
  for (const w of group) synonymMap.set(w, canonical);
}

function normalize(word: string): string {
  if (synonymMap.has(word)) return synonymMap.get(word)!;
  const stemmed = stemIt(word);
  if (synonymMap.has(stemmed)) return synonymMap.get(stemmed)!;
  return stemmed;
}

function getSignificantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zàáèéìíòóùú0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS_IT.has(w))
    .map((w) => normalize(w));
}

function jaccardSimilarity(wordsA: string[], wordsB: string[]): number {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function extractKeyEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const m of text.matchAll(/\d[\d.'',]*\d/g)) {
    entities.add(m[0].replace(/[.''',]/g, ''));
  }
  for (const m of text.matchAll(/\b(\d+)[.,]?(\d*)\s*%/g)) {
    entities.add(`${m[1]}${m[2]}%`);
  }
  return [...entities];
}

// Thresholds (must match create-article.mjs)
const ID_THRESHOLD = 0.60;
const TITLE_THRESHOLD = 0.45;
const EXCERPT_THRESHOLD = 0.35;
const COMBINED_THRESHOLD = 0.40;

interface ArticleSignals {
  id: string;
  title: string;
  excerpt: string;
}

function checkDuplicate(
  newArticle: ArticleSignals,
  existingArticle: ArticleSignals
): {
  isDuplicate: boolean;
  idSim: number;
  titleSim: number;
  excerptSim: number;
  entitySim: number;
  combinedScore: number;
} {
  const newIdWords = newArticle.id.split('-').filter((w) => w.length > 1).map((w) => normalize(w));
  const existingIdWords = existingArticle.id.split('-').filter((w) => w.length > 1).map((w) => normalize(w));
  const newTitleWords = getSignificantWords(newArticle.title);
  const existingTitleWords = getSignificantWords(existingArticle.title);
  const newExcerptWords = getSignificantWords(newArticle.excerpt);
  const existingExcerptWords = getSignificantWords(existingArticle.excerpt);
  const newEntities = extractKeyEntities(newArticle.title + ' ' + newArticle.excerpt);
  const existingEntities = extractKeyEntities(
    existingArticle.title + ' ' + existingArticle.excerpt
  );

  const idSim = jaccardSimilarity(newIdWords, existingIdWords);
  const titleSim = jaccardSimilarity(newTitleWords, existingTitleWords);
  const excerptSim = jaccardSimilarity(newExcerptWords, existingExcerptWords);
  const entitySim = jaccardSimilarity(newEntities, existingEntities);

  const combinedScore =
    0.25 * idSim + 0.30 * titleSim + 0.25 * excerptSim + 0.20 * entitySim;

  const isDuplicate =
    idSim >= ID_THRESHOLD ||
    titleSim >= TITLE_THRESHOLD ||
    excerptSim >= EXCERPT_THRESHOLD ||
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

describe('Article duplicate detection (multi-signal)', () => {
  describe('catches the 2026-02-19 duplicates', () => {
    it('detects article 2 as duplicate of article 1', () => {
      const result = checkDuplicate(ARTICLE_2, ARTICLE_1);
      expect(result.isDuplicate).toBe(true);
    });

    it('detects article 3 as duplicate of article 1', () => {
      const result = checkDuplicate(ARTICLE_3, ARTICLE_1);
      expect(result.isDuplicate).toBe(true);
    });

    it('detects article 3 as duplicate of article 2', () => {
      const result = checkDuplicate(ARTICLE_3, ARTICLE_2);
      expect(result.isDuplicate).toBe(true);
    });
  });

  describe('ID word-overlap check', () => {
    it('catches IDs sharing 80% words (calo-2025 vs calo-q4-2025)', () => {
      const result = checkDuplicate(ARTICLE_2, ARTICLE_1);
      expect(result.idSim).toBeGreaterThanOrEqual(ID_THRESHOLD);
    });

    it('catches IDs sharing 67% words (calo-q4-2025 vs dati-q4-2025)', () => {
      const result = checkDuplicate(ARTICLE_3, ARTICLE_2);
      expect(result.idSim).toBeGreaterThanOrEqual(ID_THRESHOLD);
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
      const result = checkDuplicate(DIFFERENT_ARTICLE, ARTICLE_1);
      expect(result.isDuplicate).toBe(false);
    });

    it('does not flag pillar-3 vs frontalieri-calo article', () => {
      const result = checkDuplicate(ANOTHER_DIFFERENT, ARTICLE_1);
      expect(result.isDuplicate).toBe(false);
    });

    it('does not flag LAMal vs pillar-3 articles', () => {
      const result = checkDuplicate(DIFFERENT_ARTICLE, ANOTHER_DIFFERENT);
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('Jaccard similarity', () => {
    it('returns 0 for empty arrays', () => {
      expect(jaccardSimilarity([], [])).toBe(0);
    });

    it('returns 1 for identical sets', () => {
      expect(jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    });

    it('returns 0 for disjoint sets', () => {
      expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0);
    });

    it('handles partial overlap', () => {
      // {a,b,c} ∩ {b,c,d} = {b,c} → 2/4 = 0.5
      expect(jaccardSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5);
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

  describe('edge cases', () => {
    it('does not flag articles with same source data but very different framing', () => {
      // Same UST statistics but completely different ID, title, and angle.
      // This is borderline — the programmatic check allows it, but the AI selection
      // prompt (with excerpts) should prevent choosing the same topic upstream.
      const newArt: ArticleSignals = {
        id: 'statistiche-permesso-g-fine-anno',
        title: 'Permessi G: i numeri di fine 2025 in Ticino',
        excerpt:
          'I dati UST mostrano 78.809 frontalieri in Ticino (-1,0%). La Svizzera raggiunge quota 411.000.',
      };
      const result = checkDuplicate(newArt, ARTICLE_1);
      // Not flagged because ID (0%) and title (~25%) are very different.
      // Entity overlap is high (~75%) but weighted contribution is insufficient.
      // The AI selection prompt provides excerpts to catch this case upstream.
      expect(result.isDuplicate).toBe(false);
      // But entity similarity should still be high
      expect(result.entitySim).toBeGreaterThan(0.5);
    });

    it('does not flag articles sharing only common words like "frontalieri" and "ticino"', () => {
      const genericNew: ArticleSignals = {
        id: 'frontalieri-ticino-trasporti-2026',
        title: 'Trasporti per frontalieri in Ticino: novità 2026',
        excerpt:
          'Nuovi orari FFS e TILO per i pendolari transfrontalieri. Abbonamenti Arcobaleno in arrivo.',
      };
      const result = checkDuplicate(genericNew, ARTICLE_1);
      expect(result.isDuplicate).toBe(false);
    });
  });

  // ── Synonym/morphological duplicate detection ─────────────────────

  describe('catches synonym/morphological duplicates', () => {
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

    it('detects maternità/paternità article as duplicate of congedo parentale article', () => {
      const result = checkDuplicate(PARENTAL_LEAVE_ARTICLE, MATERNITY_ARTICLE);
      expect(result.isDuplicate).toBe(true);
    });

    it('achieves meaningful title similarity via synonym normalization', () => {
      const result = checkDuplicate(PARENTAL_LEAVE_ARTICLE, MATERNITY_ARTICLE);
      // With stemming+synonyms: "congedo", "maternità", "paternità", "parentale" → same canonical
      expect(result.titleSim).toBeGreaterThan(0.3);
    });

    it('achieves meaningful excerpt similarity via synonym normalization', () => {
      const result = checkDuplicate(PARENTAL_LEAVE_ARTICLE, MATERNITY_ARTICLE);
      expect(result.excerptSim).toBeGreaterThan(0.2);
    });
  });

  // ── Stemming unit tests ───────────────────────────────────────────

  describe('Italian stemmer', () => {
    it('strips -zione/-zioni suffixes', () => {
      expect(stemIt('imposizione')).toBe('imposi');
      expect(stemIt('autorizzazioni')).toBe('autor');
    });

    it('strips -tore/-trice suffixes', () => {
      expect(stemIt('lavoratore')).toBe('lavora');
      expect(stemIt('lavoratrice')).toBe('lavora');
    });

    it('strips -mente suffix', () => {
      expect(stemIt('generalmente')).toBe('general');
    });

    it('strips -ato/-ata/-ati/-ate suffixes', () => {
      expect(stemIt('assicurato')).toBe('assicur');
      expect(stemIt('lavoratori')).toBe('lavora');
    });

    it('does not strip words shorter than 4 chars', () => {
      expect(stemIt('uno')).toBe('uno');
      expect(stemIt('due')).toBe('due');
    });

    it('strips trailing vowel from long words', () => {
      expect(stemIt('salute')).toBe('salut');
    });
  });

  // ── Synonym mapping tests ─────────────────────────────────────────

  describe('synonym normalization', () => {
    it('maps maternità and congedo to same canonical', () => {
      expect(normalize('maternità')).toBe(normalize('congedo'));
    });

    it('maps paternità and parentale to same canonical', () => {
      expect(normalize('paternità')).toBe(normalize('parentale'));
    });

    it('maps frontalieri and pendolari to same canonical', () => {
      expect(normalize('frontalieri')).toBe(normalize('pendolari'));
    });

    it('maps imposta and tassa to same canonical', () => {
      expect(normalize('imposta')).toBe(normalize('tassa'));
    });

    it('maps stipendio and salario to same canonical', () => {
      expect(normalize('stipendio')).toBe(normalize('salario'));
    });

    it('does not map unrelated words to same canonical', () => {
      expect(normalize('pensione')).not.toBe(normalize('trasporto'));
    });
  });
});
