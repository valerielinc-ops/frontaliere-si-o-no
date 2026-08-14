/**
 * cross-section-dedup.mjs — una FONTE non può produrre un articolo in due
 * sezioni.
 *
 * ## Il difetto che chiude (issue #251, residuo di #246)
 *
 * Dopo #246 il classificatore «frontaliere» accetta anche le statistiche
 * AGGREGATE Italia-Svizzera, non solo le notizie che nominano il Ticino. Lo
 * stesso dato aggregato passa però anche il classificatore della sezione
 * nazionale, quindi la stessa pagina di fonte poteva generare un articolo in
 * ENTRAMBE le sezioni, pubblicati come contenuti distinti.
 *
 * MISURATO su `origin/main` il 2026-08-13: **0 meccanismi di dedup
 * cross-sezione**. Il ledger URL→id esisteva già ma era LETTO PER SEZIONE —
 * `loadSourceUrls()` apre `SECTION.sourceUrlsFile`, cioè
 * `data/article-source-urls.json` per frontaliere e
 * `data/swiss-article-source-urls.json` per svizzera. Il ramo `exact_url` di
 * `isSourceUrlAlreadyUsed` non poteva quindi vedere la sezione gemella, e
 * l'unico ramo che attraversava le sezioni (`url_slug_match`, Jaccard fra le
 * parole dello slug della fonte e quelle degli id esistenti) è un'euristica di
 * TEMA che ha lasciato passare tutti e 5 i duplicati reali — p.es.
 * `sa-lavoro-vallemaggia-posti-matrimonio-vale` contro
 * `matrimonio-aziendale-vallemaggia-100`.
 *
 * ## Su COSA si confronta, e perché non sullo slug
 *
 * La chiave è l'**URL normalizzato della fonte** — l'identità del documento di
 * partenza, non quella dell'articolo prodotto. Gli slug dei due articoli sono
 * diversi per costruzione (li scrive un LLM, uno per sezione, con due tagli
 * diversi): confrontarli non avrebbe trovato niente. I due ledger sono già
 * scritti su URL normalizzato (`recordSourceUrl` → `normalizeNewsUrl`), quindi
 * la chiave esiste già: mancava solo di leggerli TUTTI.
 *
 * ## Il caso legittimo che NON va rotto
 *
 * Uno stesso TEMA può meritare due articoli con tagli davvero diversi — una
 * riforma AVS letta per chi vive in Svizzera e letta per chi fa il frontaliere
 * sono due pezzi, non un duplicato. Il blocco qui è al livello più stretto
 * possibile: **stesso documento di fonte**, cioè lo stesso URL. Due pezzi sullo
 * stesso tema scritti da due fonti diverse (due URL diversi) passano entrambi,
 * in entrambe le sezioni. Ciò che viene fermato è la ri-scrittura dello STESSO
 * materiale, che è duplicazione di contenuto e non copertura dello stesso tema.
 *
 * È una scelta con un verso: il gate è volutamente stretto, quindi può lasciar
 * passare due articoli sulla stessa notizia da due URL diversi. Quel caso resta
 * agli strati di TEMA che esistono già (`preFlightHeadlineCheck`,
 * `checkForDuplicates`, `checkSemanticNearDuplicate`), che a differenza di
 * questo hanno una soglia e quindi dei falsi positivi — ed è il motivo per cui
 * non è a loro che si affida la garanzia cross-sezione.
 *
 * Il modulo è puro (i ledger arrivano come argomento) perché
 * `create-article.mjs` non è importabile in test senza `node_modules`.
 * Vedi `generator/tests/cross-section-source-dedup.test.mjs`.
 */

/** Segnale di un riuso della fonte DENTRO la sezione attiva (comportamento storico). */
export const SIGNAL_SAME_SECTION = 'exact_url';
/** Segnale di un riuso della fonte NELL'ALTRA sezione — ciò che #251 aggiunge. */
export const SIGNAL_CROSS_SECTION = 'exact_url_cross_section';

/**
 * Il documento di fonte ha già prodotto un articolo, in questa o in un'altra
 * sezione?
 *
 * La sezione ATTIVA si guarda per prima, così il segnale storico `exact_url`
 * resta quello e non cambia significato per chi lo legge nei log o nel run
 * report; solo un riscontro nell'altra sezione produce il segnale nuovo.
 *
 * @param {string} normalizedUrl URL della fonte già passato da `normalizeNewsUrl`.
 * @param {Record<string, Record<string, string>>} ledgersBySection mappa sezione → (URL normalizzato → id articolo).
 * @param {string} activeSection nome della sezione che sta generando.
 * @returns {{used: true, articleId: string, section: string, signal: string, crossSection: boolean}
 *          |{used: false}}
 */
export function findCrossSectionSourceDuplicate(normalizedUrl, ledgersBySection, activeSection) {
  const url = String(normalizedUrl ?? '');
  if (!url) return { used: false };
  const ledgers = ledgersBySection && typeof ledgersBySection === 'object' ? ledgersBySection : {};

  const names = Object.keys(ledgers);
  const ordered = names.includes(activeSection)
    ? [activeSection, ...names.filter((n) => n !== activeSection)]
    : names;

  for (const section of ordered) {
    const ledger = ledgers[section];
    if (!ledger || typeof ledger !== 'object') continue;
    // `Object.prototype.hasOwnProperty` e non `ledger[url]`: un URL che
    // normalizza a "constructor" o "__proto__" risolverebbe a una funzione
    // ereditata e verrebbe letto come un id di articolo.
    if (!Object.prototype.hasOwnProperty.call(ledger, url)) continue;
    const articleId = ledger[url];
    if (typeof articleId !== 'string' || !articleId) continue;
    const crossSection = section !== activeSection;
    return {
      used: true,
      articleId,
      section,
      signal: crossSection ? SIGNAL_CROSS_SECTION : SIGNAL_SAME_SECTION,
      crossSection,
    };
  }
  return { used: false };
}

/**
 * Gli URL che compaiono in PIÙ di un ledger, cioè i duplicati cross-sezione
 * già pubblicati.
 *
 * Serve al ratchet sul registro pubblicato: il gate sopra impedisce che ne
 * nascano di nuovi, questo dice se serve anche una bonifica di quelli vecchi.
 *
 * @returns {Array<{url: string, sections: Array<{section: string, articleId: string}>}>}
 */
export function listCrossSectionDuplicates(ledgersBySection) {
  const ledgers = ledgersBySection && typeof ledgersBySection === 'object' ? ledgersBySection : {};
  const byUrl = new Map();
  for (const [section, ledger] of Object.entries(ledgers)) {
    if (!ledger || typeof ledger !== 'object') continue;
    for (const [url, articleId] of Object.entries(ledger)) {
      if (typeof articleId !== 'string' || !articleId) continue;
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push({ section, articleId });
    }
  }
  return [...byUrl.entries()]
    .filter(([, sections]) => new Set(sections.map((s) => s.section)).size > 1)
    .map(([url, sections]) => ({ url, sections }))
    .sort((a, b) => a.url.localeCompare(b.url));
}
