/**
 * Vocabolario di prefissi per la ricerca (`searchMask` dell'indice candidati).
 *
 * Contratto di esattezza: per ogni locale, ogni query e ogni riga aperta
 *
 *     prefixIndex(query)[riga]  ===  matchesSearchQuery(compile(query), riga, features, locale)
 *
 * L'haystack stemmato di una riga non dipende dalla query; `matchesSearchQuery`
 * con token chiede `haystack.includes(' ' + t)` per ogni token `t`, cioè che
 * esista una parola dell'haystack che INIZIA con `t`. Qui lo si verifica su un
 * inventario con haystack volutamente vari (accenti, sinonimi di professione,
 * nomi di cantone, prefissi parziali, parole ripetute, query di uno o più token,
 * alfabeti non latini) e lo si confronta riga per riga con l'implementazione
 * originale. Nessun dato reale: azienda e testi sintetici.
 */
import { describe, expect, it } from 'vitest';
import {
  compileSearchQuery,
  jobMatchFeatures,
  matchesSearchQuery,
  searchHaystack,
} from '../services/jobAlertMatching.mjs';
import {
  buildSearchVocabulary,
  createJobAlertCandidateIndex,
} from '../scripts/lib/job-alert-candidate-index.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-10T05:00:00Z');
const LOCALES = ['it', 'de', 'fr', 'en'];

function job(i: number, patch: Record<string, unknown>) {
  return {
    id: `v-${i}`,
    slug: `v-${i}`,
    title: 'Impiegato',
    description: '',
    company: 'Azienda Esempio SA',
    category: '',
    sector: '',
    location: 'Lugano',
    canton: 'TI',
    contract: 'full-time',
    firstSeenAt: new Date(NOW - DAY).toISOString(),
    crawledAt: new Date(NOW - DAY / 2).toISOString(),
    ...patch,
  };
}

// Haystack variati: ogni riga porta una caratteristica che stressa lo stemming
// o la tokenizzazione.
const INVENTORY = [
  job(0, { title: 'Infermiere diplomato', description: 'Cerchiamo infermieri e infermiera per reparto di cure.' }),
  job(1, { title: 'Pflegefachfrau HF', description: 'Wir suchen Pflegefachpersonen für Zürich und Genève.', location: 'Zürich', canton: 'ZH' }),
  job(2, { title: 'Ingénieur logiciel', description: 'Développeur Java et ingénieurs système à Genève.', location: 'Genève', canton: 'GE' }),
  job(3, { title: 'Cuoco di partita', description: 'Cuoco cuochi cucina cucina cucina ristorante' }),
  job(4, { title: 'Software Engineer', description: 'Engineering engineers engineered software softwares.', category: 'informatica', sector: 'it' }),
  job(5, { title: 'Contabile', description: 'Contabilità contabili bilancio. Più città: Chur, Coira, Basel.', location: 'Coira', canton: 'GR' }),
  job(6, { title: 'Müller & Söhne – Elektriker', description: 'Elektriker Elektrikerin Elektroinstallateur', location: 'St. Gallen', canton: 'SG' }),
  job(7, { title: 'Autista', description: 'Patente C, e CQC; camion. 80-100%' }),
  job(8, { title: 'Магазинер склад', description: 'Работа на складе. Москва' }),
  job(9, { title: '看護師', description: '看護師を募集しています。東京' }),
  job(10, { title: 'Chef de projet', description: 'Chef chef chef de projet informatique, chefs et cheffes', canton: 'VD', location: 'Lausanne' }),
  job(11, { title: 'Receptionist', description: '', location: '', canton: '' }),
  job(12, { title: 'Data Analyst', description: 'a b c d e f g h i j k l m n o p', contract: 'part-time' }),
  job(13, { title: 'Ticino', description: 'Il Canton Ticino offre molte opportunità; ticinese, ticinesi.' }),
  job(14, { title: 'Infermiere', description: 'infermiere infermiere infermiere', titleByLocale: { de: 'Krankenpfleger', en: 'Nurse', fr: 'Infirmier' } }),
  job(15, { title: 'Sales Manager', description: 'Responsabile vendite. Manager, managers, management.', category: 'vendite marketing', sector: 'finance' }),
  job(16, { title: 'Chef cuisinier', description: "L'équipe cherche un chef cuisinier à l'hôtel", location: 'Montreux', canton: 'VD', sector: 'hospitality' }),
  job(17, { title: 'Apprendista', description: 'Apprendistato apprendisti', contract: 'apprenticeship' }),
  // Confine dell'intervallo di prefisso: `zrzq` segue subito `zqa` nell'ordine ma
  // CONTIENE `zq` senza iniziare con `zq` (non deve contare come prefisso).
  job(18, { title: 'Prova confine', description: 'zqa' }),
  job(19, { title: 'Prova confine due', description: 'zrzq' }),
];

// Query: un token, più token, prefissi parziali, accenti, sinonimi di professione,
// nomi di cantone, parole ripetute, alfabeti non latini, rumore.
const QUERIES = [
  'infermiere', 'infermi', 'inf', 'i', 'a', 'cuoc', 'cuoco lugano', 'cuoco cucina',
  'software engineer', 'engin', 'engineer java', 'java', 'contabile bilancio', 'contab',
  'zurich', 'zürich', 'zurigo', 'genève', 'geneve', 'ginevra', 'coira chur', 'ticino ticinese',
  'cantone ticino', 'elektr', 'elektriker', 'müller', 'muller', 'söhne', 'sohne',
  'chef', 'chef projet', 'chefs cheffes', 'manager', 'management', 'responsabile vendite',
  'nurse', 'krankenpfleger', 'infirmier', 'pflegefachfrau', 'pflege', 'ingénieur', 'ingenieur',
  'healthcare', 'sanità', 'sanita', 'informatica', 'finance', 'hospitality',
  'full time', 'part-time', 'apprenticeship', 'apprendista', 'ab', 'xy zz',
  'zq', 'zr', 'zrz', 'zzzzzz', 'qqq www', 'infermiere infermiere', 'cuoco cuoco cuoco',
  'магазин', 'склад москва', '看護師', '東京', '看護師 東京', 'работа',
  '80-100%', 'c cqc', 'patente', "l'équipe", 'hôtel',
  '   ', '', '!!!', '---', 'ø', 'ß',
];

describe('vocabolario di prefissi — esattezza rispetto a matchesSearchQuery', () => {
  const index = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW });

  it('l\'inventario di prova ha tutte le righe aperte e haystack vari', () => {
    expect(index.rowCount).toBe(INVENTORY.length);
  });

  for (const locale of LOCALES) {
    it(`prefixIndex(query) coincide con matchesSearchQuery su ogni riga (${locale})`, () => {
      let compared = 0;
      let positives = 0;
      for (const query of QUERIES) {
        const compiled = compileSearchQuery(query);
        const mask = index.searchMaskForTest(locale, query);
        for (let i = 0; i < index.rowCount; i++) {
          const row = index.rowAt(i);
          const expected = matchesSearchQuery(compiled, row, jobMatchFeatures(row, locale), locale);
          const actual = index.hasBit(mask, i);
          if (actual !== expected) {
            throw new Error(`divergenza: locale=${locale} query=${JSON.stringify(query)} riga=${i} atteso=${expected} ottenuto=${actual}`);
          }
          compared += 1;
          if (expected) positives += 1;
        }
      }
      expect(compared).toBe(QUERIES.length * INVENTORY.length);
      // Il confronto non e' banale: ci sono sia riscontri sia assenze.
      expect(positives).toBeGreaterThan(40);
      expect(positives).toBeLessThan(compared);
    });
  }

  it('una query senza token (alfabeto non supportato) resta `keywordInTextParts`, mai un AND vuoto', () => {
    const compiled = compileSearchQuery('!!!');
    expect(compiled.tokens.length).toBe(0);
    const mask = index.searchMaskForTest('it', '!!!');
    for (let i = 0; i < index.rowCount; i++) {
      const row = index.rowAt(i);
      expect(index.hasBit(mask, i)).toBe(matchesSearchQuery(compiled, row, jobMatchFeatures(row, 'it'), 'it'));
    }
  });

  it('con un budget di cache minimo (evizione continua dei token) le risposte non cambiano', () => {
    const tiny = createJobAlertCandidateIndex(INVENTORY, { nowMs: NOW, budgetBytes: 16 });
    for (const locale of ['it', 'de']) {
      for (const query of QUERIES) {
        const compiled = compileSearchQuery(query);
        const mask = tiny.searchMaskForTest(locale, query);
        for (let i = 0; i < tiny.rowCount; i++) {
          const row = tiny.rowAt(i);
          expect(tiny.hasBit(mask, i)).toBe(matchesSearchQuery(compiled, row, jobMatchFeatures(row, locale), locale));
        }
      }
    }
  });
});

describe('vocabolario di prefissi — struttura', () => {
  const rows = INVENTORY;

  it('le parole sono uniche e ordinate, le posting crescenti, e coincidono con le parole dell\'haystack', () => {
    const vocabulary = buildSearchVocabulary(rows, 'it');
    const { words, offsets, postings } = vocabulary;
    expect(offsets.length).toBe(words.length + 1);
    expect(new Set(words).size).toBe(words.length);
    expect([...words]).toEqual([...words].sort());
    const expected = new Map<string, number[]>();
    rows.forEach((row, i) => {
      const haystack = searchHaystack(row, jobMatchFeatures(row, 'it'), 'it');
      for (const word of new Set(haystack.split(' ').filter(Boolean))) {
        if (!expected.has(word)) expected.set(word, []);
        expected.get(word)!.push(i);
      }
    });
    expect(words.length).toBe(expected.size);
    words.forEach((word, k) => {
      const list = Array.from(postings.subarray(offsets[k], offsets[k + 1]));
      expect(list).toEqual(expected.get(word));
    });
  });

  it('riporta i byte: tipizzati esatti, parole stimate', () => {
    const { bytes, words, offsets, postings } = buildSearchVocabulary(rows, 'it');
    expect(bytes.words).toBe(words.length);
    expect(bytes.postings).toBe(postings.length);
    expect(bytes.typed).toBe(offsets.byteLength + postings.byteLength);
    expect(bytes.total).toBeGreaterThan(bytes.typed);
  });

  it('un inventario vuoto o senza testo produce un vocabolario vuoto e valido', () => {
    const empty = buildSearchVocabulary([], 'it');
    expect(empty.words).toEqual([]);
    expect(empty.postings.length).toBe(0);
    expect(empty.offsets.length).toBe(1);
  });

  it('una funzione di haystack diversa viene usata cosi\' com\'e\' (nessuna copia della composizione)', () => {
    const vocabulary = buildSearchVocabulary(rows.slice(0, 2), 'it', () => ' alfa beta alfa ');
    expect(vocabulary.words).toEqual(['alfa', 'beta']);
    expect(Array.from(vocabulary.postings)).toEqual([0, 1, 0, 1]);
  });
});
