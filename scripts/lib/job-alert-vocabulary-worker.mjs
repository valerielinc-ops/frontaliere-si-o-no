// scripts/lib/job-alert-vocabulary-worker.mjs
//
// Worker thread che costruisce il vocabolario di ricerca di UN locale
// (perf-plan W2). Riceve, a blocchi di righe, i testi gia' risolti per il suo
// locale (`searchHaystackInputs` del matcher: stringhe e basta) e li compone con
// `searchHaystackText` — la STESSA composizione dell'haystack che usano lo
// scorer e `buildSearchVocabulary` — poi accumula con lo stesso costruttore del
// vocabolario (`createVocabularyBuilder`).
//
// Protocollo (main -> worker): {type:'rows', start, inputs: {campo: valori[]}}
// e {type:'finish'}; (worker -> main): {type:'ack'} per ogni blocco,
// {type:'done', vocabulary, buildMs} (offsets e postings in transfer),
// {type:'error', message}. Nessun dato per riga esce dal worker: solo il
// vocabolario finito.

import { parentPort } from 'node:worker_threads';
import { searchHaystackText } from '../../services/jobAlertMatching.mjs';
import { VOCABULARY_INPUT_FIELDS, createVocabularyBuilder } from './job-alert-vocabulary.mjs';

const builder = createVocabularyBuilder();
let busyMs = 0;

parentPort.on('message', (message) => {
  try {
    if (message.type === 'rows') {
      const startedAt = performance.now();
      const { start, inputs } = message;
      const count = inputs.titleText.length;
      const row = {};
      for (let k = 0; k < count; k++) {
        for (const field of VOCABULARY_INPUT_FIELDS) row[field] = inputs[field][k];
        builder.addHaystack(start + k, searchHaystackText(row));
      }
      busyMs += performance.now() - startedAt;
      parentPort.postMessage({ type: 'ack' });
    } else if (message.type === 'finish') {
      const startedAt = performance.now();
      const vocabulary = builder.finish();
      busyMs += performance.now() - startedAt;
      parentPort.postMessage(
        { type: 'done', vocabulary, buildMs: Math.round(busyMs) },
        [vocabulary.offsets.buffer, vocabulary.postings.buffer],
      );
    }
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: String(error?.message || error) });
  }
});
