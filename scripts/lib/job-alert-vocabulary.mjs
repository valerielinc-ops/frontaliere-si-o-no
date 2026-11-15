// scripts/lib/job-alert-vocabulary.mjs
//
// Accumulatore del vocabolario di prefissi per la ricerca (`parola → righe`).
// Estratto da `buildSearchVocabulary` perche' lo usano tre chiamanti con lo
// STESSO codice: il percorso a un locale (`buildSearchVocabulary`), la passata
// unica sui locali (perf-plan W1) e il worker thread di un locale (W2).
//
// La dimostrazione di esattezza del vocabolario sta in
// `buildSearchVocabulary` (scripts/lib/job-alert-candidate-index.mjs); questo
// modulo ne e' solo la meccanica: riceve l'haystack stemmato di una riga e
// registra le sue parole, poi `finish()` ordina e impacchetta in array tipizzati.
//
// Nessuna dipendenza: il worker lo importa senza portarsi dietro il matcher.

/**
 * I campi di `searchHaystackInputs` (services/jobAlertMatching.mjs) che un worker
 * riceve per riga. Un test li confronta con le chiavi che quella funzione
 * produce davvero: un campo nuovo nell'haystack non puo' sfuggire al worker.
 */
export const VOCABULARY_INPUT_FIELDS = Object.freeze([
  'titleText', 'description', 'company', 'jobLoc', 'contract', 'category', 'jobSector', 'cantonNames', 'title',
]);

/**
 * @returns {{
 *   addHaystack: (rowIndex: number, haystack: string) => void,
 *   finish: () => {words: string[], offsets: Int32Array, postings: Int32Array, bytes: {words: number, wordChars: number, postings: number, typed: number, total: number}},
 * }}
 */
export function createVocabularyBuilder() {
  const ids = new Map();
  let pairWord = new Int32Array(1 << 16);
  let pairRow = new Int32Array(1 << 16);
  let pairs = 0;
  let lastRowOfWord = [];

  return {
    /** Le righe vanno registrate in ordine crescente di `rowIndex` (le posting escono crescenti). */
    addHaystack(rowIndex, haystack) {
      for (const word of haystack.split(' ')) {
        if (word === '') continue;
        let id = ids.get(word);
        if (id === undefined) { id = ids.size; ids.set(word, id); lastRowOfWord.push(-1); }
        if (lastRowOfWord[id] === rowIndex) continue;
        lastRowOfWord[id] = rowIndex;
        if (pairs === pairWord.length) {
          const grownWord = new Int32Array(pairs * 2); grownWord.set(pairWord); pairWord = grownWord;
          const grownRow = new Int32Array(pairs * 2); grownRow.set(pairRow); pairRow = grownRow;
        }
        pairWord[pairs] = id;
        pairRow[pairs] = rowIndex;
        pairs += 1;
      }
    },

    finish() {
      lastRowOfWord = null;

      const sortedWords = [...ids.keys()].sort();
      const rankOf = new Int32Array(sortedWords.length);
      for (let rank = 0; rank < sortedWords.length; rank++) rankOf[ids.get(sortedWords[rank])] = rank;
      ids.clear();

      const offsets = new Int32Array(sortedWords.length + 1);
      for (let k = 0; k < pairs; k++) offsets[rankOf[pairWord[k]] + 1] += 1;
      for (let rank = 0; rank < sortedWords.length; rank++) offsets[rank + 1] += offsets[rank];
      const cursor = offsets.slice(0, sortedWords.length);
      const postings = new Int32Array(pairs);
      for (let k = 0; k < pairs; k++) postings[cursor[rankOf[pairWord[k]]]++] = pairRow[k];

      let wordChars = 0;
      for (const word of sortedWords) wordChars += word.length;
      // Stima: ~1 byte/carattere (stringhe a un byte di V8) + ~24 byte di intestazione
      // e puntatore per parola. I tipizzati sono esatti.
      const wordBytes = wordChars + sortedWords.length * 24;
      const typed = offsets.byteLength + postings.byteLength;
      return {
        words: sortedWords,
        offsets,
        postings,
        bytes: { words: sortedWords.length, wordChars, postings: pairs, typed, total: typed + wordBytes },
      };
    },
  };
}
