/**
 * «Non ho osservato niente» non e' «PASS».
 *
 * ─── La classe di difetto ────────────────────────────────────────────────
 *
 * Uno script che cammina il corpus per sezioni esce 0 dichiarando successo
 * dopo aver guardato ZERO articoli. Non c'e' nessun ramo d'errore da
 * sbagliare: il ciclo semplicemente non gira, la variabile `anyFailure` /
 * `anyDivergence` resta `false`, e il verdetto finale e' verde.
 *
 * E' la terza occorrenza della stessa forma. L'header di
 * tests/audit-article-corpus-drift-categorize.test.ts racconta le prime due,
 * entrambe nel categorizzatore di quel file: un verdetto non interpretabile
 * cadeva su `'ok'`, quindi l'audit riportava successo senza aver verificato
 * niente. Qui la causa e' a monte del categorizzatore — il campione e' vuoto —
 * quindi nessuna delle due correzioni precedenti la intercetta.
 *
 * ─── La misura ───────────────────────────────────────────────────────────
 *
 * Run 32620849579 di audit-article-corpus-drift (2026-08-23), l'UNICO verde in
 * sei run consecutive, log verbatim:
 *
 *   [audit-article-corpus-drift] section=frontaliere corpusSize=0 sampled=0
 *   [audit-article-corpus-drift] section=svizzera corpusSize=0 sampled=0
 *   [audit-article-corpus-drift] PASS — no divergence found in this sample
 *
 * `conclusion: success`. La causa era il profilo sparse-checkout che #9146 ha
 * poi rimosso: 7'171 file materializzati contro 38'176 tracciati al commit
 * della run, quindi `enumerateSectionArticleIds` non trovava i path delle
 * sezioni e li ingoiava in silenzio —
 * `} catch (err) { if (isMissingPathError(err)) continue;` in
 * packages/articles/engine/shared/articleSectionDescriptors.ts.
 *
 * Quel verde fabbricato e' PIU' grave dei 40 falsi positivi che #9146 ha
 * chiuso: un rosso lo si va a leggere, questo dichiara sano un corpus che
 * nessuno ha guardato. Ed e' esattamente il caso che il workflow dell'audit
 * dichiara inammissibile nel proprio header: «Anything short of this is not
 * drift — it is the audit failing to observe».
 *
 * ─── Perche' un modulo condiviso e non una guardia per script ────────────
 *
 * Due chiamanti hanno la stessa forma e la stessa sorgente di verita'
 * (`enumerateSectionArticleIds`), quindi una copia per file andrebbe in drift
 * alla prima modifica — AGENTS.md #6. I chiamanti sono:
 *
 *   - scripts/audit-article-corpus-drift.mjs (`sampled` per sezione)
 *   - scripts/rerender-article-corpus.mjs   (`ids.length` per sezione)
 *
 * NON va messa dentro `enumerateSectionArticleIds`: una sezione vuota e'
 * legittima per gli altri suoi chiamanti (build-plugins/staticPagesPlugin.ts
 * emette un sito con una sola sezione popolata). Il vincolo «devo aver
 * osservato qualcosa» appartiene a chi produce un VERDETTO sul corpus, non
 * all'enumeratore.
 *
 * Non e' una soglia e non va trasformata in una: il confronto e' contro zero,
 * un solo articolo osservato passa. Alzare quel numero farebbe di una guardia
 * di osservabilita' un gate sulla dimensione del campione, che e' un'altra
 * cosa e va discussa a parte.
 */

/**
 * @param {string} label            prefisso di log dello script chiamante
 * @param {Record<string, {total: number, observed: number}>} sections
 * @throws {Error} se la somma degli `observed` e' zero
 */
export function assertCorpusObserved(label, sections) {
  const entries = Object.entries(sections || {});
  const totalObserved = entries.reduce((n, [, s]) => n + (Number(s?.observed) || 0), 0);
  if (totalObserved > 0) return;

  const misura = entries.length
    ? entries.map(([name, s]) => `${name}: total=${s?.total ?? 0} observed=${s?.observed ?? 0}`).join(', ')
    : 'nessuna sezione selezionata';

  throw new Error(
    `${label} ABORT: zero articoli osservati — ${misura}.\n` +
      "  Un verdetto sul corpus che non ha osservato niente non puo' essere verde: e' il\n" +
      '  verde fabbricato della run 32620849579, dove 7\'171 file su 38\'176 tracciati erano\n' +
      '  materializzati e le sezioni risultavano vuote.\n' +
      '  Cause tipiche, in ordine di probabilita:\n' +
      "    - un profilo sparse-checkout che ampute l'albero (vedi assertHeroImagesOnDisk);\n" +
      '    - `--only-ids` con id che non esistono nella sezione richiesta;\n' +
      '    - `--section <x>` su una sezione che non ha articoli.\n' +
      '  Nessuna di queste e un corpus sano, quindi nessuna deve uscire 0.',
  );
}
