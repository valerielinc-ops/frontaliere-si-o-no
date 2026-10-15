/**
 * Reader iniettabile per i dataset su disco che la newsletter consuma.
 *
 * PRIVO DI DIPENDENZE NODE — deliberatamente (#8125). `newsletter-content.mjs`
 * sta nel grafo del bundle browser (`services/newsletterPreview.ts` lo importa
 * per la preview dell'AdminPanel), quindi non puo' importare `node:fs`: rollup
 * lo risolve a `__vite-browser-external` e il link della build muore. Il modulo
 * chiede i dataset QUI, e chi gira in Node installa il lettore vero da
 * `./newsletter-content-node.mjs`.
 *
 * Senza lettore installato la lettura rende `null` e i chiamanti ricadono sui
 * fallback che avevano gia' (manifest loghi vuoto, popolarita' vuota, metriche
 * di default): e' lo stesso esito del `try/catch` che avvolgeva
 * `fs.readFileSync`, non un comportamento nuovo.
 */

/** @type {((...segments: string[]) => unknown) | null} */
let _reader = null;

/**
 * Installa il lettore dei dataset. Idempotente: l'ultima installazione vince,
 * cosi' un test puo' sostituire il lettore con un doppio.
 */
export function setNewsletterDatasetReader(reader) {
  _reader = typeof reader === 'function' ? reader : null;
}

/** Il lettore installato, o `null` in browser. Per i test. */
export function getNewsletterDatasetReader() {
  return _reader;
}

/**
 * Legge e parsa un dataset JSON dai `segments` relativi alla radice del repo.
 * Rende `null` quando il lettore non c'e', il file non c'e' o non e' JSON
 * valido — mai un throw: ogni chiamante ha un fallback e una newsletter non
 * deve fallire per un dataset assente.
 */
export function readNewsletterDataset(...segments) {
  if (!_reader) return null;
  try {
    return _reader(...segments) ?? null;
  } catch {
    return null;
  }
}
