/**
 * ── IL NUMERO CHE LA LIBRERIA CALCOLAVA E NESSUNO LEGGEVA (sito) ────────────
 *
 * Gemello di nanakokyobashi-rgb/frontaliere-articles#373. `create-article.mjs`
 * e' `mode: adapted` nel manifest: i due fork differiscono per costruzione, e
 * questo lato NON ha il layer del pre-flight del budget (niente
 * `PROMPT_TOKEN_BUDGET`, niente marker `[prompt-budget]`, niente scala di
 * riduzione a quattro gradini). Qui il budget dettato dalla flotta fa una cosa
 * sola, la piu' grande che non tocchi la fonte: lascia fuori i fatti di
 * dominio. Il resto della scala e' lavoro concatenato.
 *
 * Quando ogni modello della flotta rifiuta il prompt per DIMENSIONE, `callLLM`
 * non si limita a fallire: allega all'errore il cap piu' permissivo fra quelli
 * che hanno detto no (`err.retryRequestTokenBudget`), il rapporto completo
 * (`err.inputCapReport`) e, nel messaggio, la frase
 *
 *     «A retry must rebuild the prompt under N tokens
 *      — resending the same messages cannot succeed»
 *
 * Era vero alla lettera. Fino al 2026-08-15 il `catch` del ciclo di generazione
 * faceva `continue` e basta: i tentativi 2→6 rispedivano messaggi identici che
 * la libreria aveva gia' dimostrato non poter riuscire. Misurato sulla run
 * 31833016113: **28,8 minuti** e due sezioni per arrivare a una conclusione
 * nota al primo tentativo, con 41 modelli su ~104 saltati dal pre-flight.
 *
 * ── PERCHE' IL BLOCCO VIENE ESTRATTO ED ESEGUITO ────────────────────────────
 *
 * `generateAndValidateArticle` non e' esportata e importarla tirerebbe dentro
 * l'intero albero del generatore (jsdom, sharp, …) che questo repo non ha in
 * node_modules. Un test che facesse `grep` sul sorgente proverebbe che il
 * codice *contiene* certe parole, non che il numero *arriva* dove serve — ed e'
 * esattamente la distinzione che questo difetto ha vissuto per mesi: la frase
 * giusta era scritta, nessuno la leggeva.
 *
 * Quindi qui il ramo `catch` viene ritagliato dal file che gira e ESEGUITO, con
 * un errore finto della forma che `callLLM` produce davvero. Stessa tecnica di
 * `news-prompt-token-budget.test.mjs`. Se le ancore scivolano, il ritaglio
 * fallisce rumorosamente invece di misurare una stringa vuota.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

// Ponte verso lo stile del sito: le asserzioni restano leggibili accanto al
// gemello del corpus (`generator/tests/retry-token-budget-consumed.test.mjs`).
const assert = {
  equal: (a, b, m) => expect(a, m).toBe(b),
  notEqual: (a, b, m) => expect(a, m).not.toBe(b),
  ok: (a, m) => expect(a, m).toBeTruthy(),
};

/** Ritaglia fra due ancore, fallendo forte se una non c'e' piu'. */
function cut(startAnchor, endAnchor) {
  const a = SRC.indexOf(startAnchor);
  assert.notEqual(a, -1, `ancora iniziale non trovata — aggiornare questo test: ${startAnchor}`);
  const b = SRC.indexOf(endAnchor, a + startAnchor.length);
  assert.notEqual(b, -1, `ancora finale non trovata — aggiornare questo test: ${endAnchor}`);
  const blocco = SRC.slice(a, b);
  assert.ok(blocco.length > 200, `ritaglio troppo corto (${blocco.length}): ancore sbagliate`);
  return blocco;
}

/**
 * Il ramo `catch` del ciclo di generazione, verbatim, reso invocabile.
 * Riceve l'errore e il budget accumulato, restituisce il budget aggiornato.
 */
const CATCH_START = '      const budgetDettato = Number(e?.retryRequestTokenBudget) > 0';
const CATCH_END = '      if (attempt < maxAttempts) continue;';
const catchBlock = cut(CATCH_START, CATCH_END);

const applicaCatch = new Function(
  'e',
  'lastPromptTokenBudget',
  'console',
  `${catchBlock}\nreturn lastPromptTokenBudget;`,
);

const silenzioso = { error() {}, warn() {}, log() {} };

/** Un errore della forma che callLLM produce davvero su ALL_MODELS_EXHAUSTED. */
function erroreFlotta(budget, { count = 41, est = 9740 } = {}) {
  const e = new Error(
    `All AI models failed. Chain: [...]. | Prompt budget: ${count} model(s) refused a ~${est}-token `
    + `request; the most permissive cap among them is ${budget} tokens. A retry must rebuild the `
    + `prompt under ${budget} tokens — resending the same messages cannot succeed.`,
  );
  e.code = 'ALL_MODELS_EXHAUSTED';
  e.retryRequestTokenBudget = budget;
  e.maxSkippedReqLimit = budget;
  e.estimatedRequestTokens = est;
  e.inputCapReport = { count, maxSkippedReqLimit: budget, minSkippedReqLimit: 3000, estimatedRequestTokens: est };
  return e;
}

describe('il budget dettato dalla flotta viene consumato, non ignorato', () => {
  it('un errore con retryRequestTokenBudget lo imposta', () => {
    const out = applicaCatch(erroreFlotta(8000), 0, silenzioso);
    assert.equal(out, 8000, 'il budget non e\' stato letto dall\'errore');
  });

  it('si STRINGE fra un tentativo e l\'altro, non si allenta', () => {
    // La flotta disponibile cambia mentre i modelli si esauriscono: se il
    // secondo rifiuto dichiara un cap piu' basso, e' quello che vale. Allentare
    // vanificherebbe la riduzione gia' decisa e rimetterebbe il prompt fuori.
    const dopoPrimo = applicaCatch(erroreFlotta(8000), 0, silenzioso);
    const dopoSecondo = applicaCatch(erroreFlotta(4000), dopoPrimo, silenzioso);
    assert.equal(dopoSecondo, 4000, 'un cap piu\' stretto deve vincere');
    const dopoTerzo = applicaCatch(erroreFlotta(8000), dopoSecondo, silenzioso);
    assert.equal(dopoTerzo, 4000, 'un cap piu\' largo NON deve allentare quello gia\' stretto');
  });

  it('un errore che non porta il budget lascia le cose come stanno', () => {
    // La stragrande maggioranza dei fallimenti non e' di dimensione (timeout,
    // JSON malformato, quota). Nessuno di quelli deve accorciare il prompt.
    const e = new Error('claude CLI timed out after 120000ms');
    assert.equal(applicaCatch(e, 0, silenzioso), 0, 'un timeout non deve dettare un budget');
    assert.equal(applicaCatch(e, 7000, silenzioso), 7000, 'un timeout non deve toccare il budget gia\' dettato');
  });

  it('valori non validi vengono ignorati invece di azzerare il prompt', () => {
    for (const valore of [0, -1, NaN, 'ottomila', null, undefined]) {
      const e = new Error('x');
      e.retryRequestTokenBudget = valore;
      assert.equal(
        applicaCatch(e, 5000, silenzioso), 5000,
        `retryRequestTokenBudget=${String(valore)} non deve cambiare il budget`,
      );
    }
  });

  it('dice a voce che sta ricostruendo, non ripetendo', () => {
    // Il difetto era invisibile nei log: sei tentativi identici e nessuna riga
    // che dicesse perche'. La riga e' parte del rimedio.
    const righe = [];
    applicaCatch(erroreFlotta(8000), 0, { error: (m) => righe.push(String(m)), warn() {}, log() {} });
    const riga = righe.find((r) => r.includes('8000'));
    assert.ok(riga, `nessuna riga nomina il budget: ${JSON.stringify(righe)}`);
    assert.ok(/41 modelli/.test(riga), 'la riga non dice quanti modelli hanno rifiutato');
  });
});

describe('il budget arriva fino al prompt', () => {
  it('genContext lo passa a callGemini', () => {
    // Il ritaglio sopra prova che il numero viene LETTO; questo prova che viene
    // PASSATO. Sono due difetti diversi e il primo senza il secondo non serve.
    const genContext = cut('    const genContext = {', '\n    };');
    assert.ok(
      /_promptTokenBudget:\s*lastPromptTokenBudget/.test(genContext),
      'genContext non inoltra il budget: callGemini continuerebbe a usare il default',
    );
  });

  it('callGemini lo usa per lasciare fuori i fatti di dominio', () => {
    // Questo fork non ha la scala a gradini del corpus: la sua unica risposta
    // al budget e' togliere il blocco piu' grande che non sia la fonte.
    // Un ritaglio solo che copre flag e uso: la dichiarazione di
    // domainFactsBlock e' una riga sola, e spezzarla in due ritagli farebbe
    // scattare la guardia di lunghezza minima invece di misurare qualcosa.
    const blocco = cut('  const _promptBudgetDettato =', 'EVERGREEN_FACTS_BRIEF');
    assert.ok(
      /sourceContext\?\._promptTokenBudget/.test(blocco),
      'il flag non legge _promptTokenBudget dal contesto',
    );
    assert.ok(
      /const domainFactsBlock = \(isSyntheticSource \|\| _promptBudgetDettato\)/.test(blocco),
      'domainFactsBlock ignora il budget: il retry rispedirebbe lo stesso peso',
    );
  });
});
