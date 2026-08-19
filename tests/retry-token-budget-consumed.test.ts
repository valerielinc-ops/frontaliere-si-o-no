/**
 * ── IL NUMERO CHE LA LIBRERIA CALCOLAVA E NESSUNO LEGGEVA (sito) ────────────
 *
 * Gemello di nanakokyobashi-rgb/frontaliere-articles#373. `create-article.mjs`
 * e' `mode: adapted` nel manifest: i due fork differiscono per costruzione.
 *
 * AGGIORNATO 2026-08-15 (issue #374 punto 1): fino a oggi questo lato NON aveva
 * il layer del pre-flight del budget — niente `PROMPT_TOKEN_BUDGET`, niente
 * marker `[prompt-budget]`, niente scala di riduzione — e il budget dettato
 * dalla flotta faceva una cosa sola, senza misurare se bastasse: lasciare fuori
 * i fatti di dominio. Il «resto della scala» che quel commento chiamava lavoro
 * concatenato e' arrivato, ed e' cio' che i due describe in fondo pinnano.
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

  it('callGemini lo trasforma nel bersaglio della scala', () => {
    // Un ritaglio solo che copre lettura e ripiego: la dichiarazione e' corta e
    // spezzarla in due ritagli farebbe scattare la guardia di lunghezza minima
    // invece di misurare qualcosa.
    const blocco = cut('  const _promptTokenTarget =', 'EVERGREEN_FACTS_BRIEF');
    assert.ok(
      /sourceContext\?\._promptTokenBudget/.test(blocco),
      'il bersaglio non legge _promptTokenBudget dal contesto',
    );
    assert.ok(
      /:\s*PROMPT_TOKEN_BUDGET/.test(blocco),
      'senza budget dettato non ripiega sul cap dichiarato dalla flotta: '
      + 'l\'attempt 1 sforerebbe senza nemmeno provare a rientrare',
    );
  });

  it('il marker del pre-flight e\' presente e machine-readable', () => {
    // Il difetto era invisibile nei log: ogni riga di skip nomina un modello,
    // nessuna nominava il prompt. Il marker e' parte del rimedio, e i suoi campi
    // sono un contratto verso chi ci costruisce sopra un watchdog.
    //
    // L'ancora e' il SITO DI EMISSIONE — `[prompt-budget] branch=`, forma che
    // esiste solo dentro il template literal — e non la prima menzione del
    // marker. `SRC.indexOf('[prompt-budget]')` seguito da una finestra fissa di
    // 400 char misurava «il primo posto del file dove quelle parole compaiono»,
    // che e' una proprieta' della PROSA, non del codice: alla PR #6028 e'
    // bastato un commento che nominava il marker 689 righe sopra per far
    // atterrare l'indice li' dentro e rendere rosso questo test senza che
    // l'emissione cambiasse di un byte. Sul gemello del corpus lo stesso
    // ancoraggio sarebbe gia' rotto da due commenti che precedono l'emissione.
    // Un'ancora che qualunque prosa puo' spostare non e' un'ancora.
    const EMISSIONE = '[prompt-budget] branch=';
    const inizio = SRC.indexOf(EMISSIONE);
    assert.notEqual(inizio, -1, `il marker non esiste piu' nella forma \`${EMISSIONE}\``);
    assert.equal(
      SRC.indexOf(EMISSIONE, inizio + EMISSIONE.length),
      -1,
      "il sito di emissione del marker non e' piu' unico: due punti che stampano "
      + "`[prompt-budget] branch=` vogliono due asserzioni, non una che ne misura uno a caso",
    );
    // La finestra segue lo STATEMENT (fino alla chiusura della console.error),
    // non un numero di caratteri: se il marker cresce di una riga, il test
    // continua a leggerlo tutto invece di troncarlo a meta'.
    const fine = SRC.indexOf('\n  );', inizio);
    assert.notEqual(fine, -1, "chiusura della console.error del marker non trovata — aggiornare questo test");
    const riga = SRC.slice(inizio, fine);
    assert.ok(
      riga.length > 100 && riga.length < 1000,
      `finestra del marker implausibile (${riga.length} char): l'ancora di chiusura e' scivolata`,
    );
    for (const campo of ['branch=', 'section=', 'attempt=', 'est=', 'budget=', 'over=', 'shrink=']) {
      assert.ok(riga.includes(campo), `il marker non pubblica piu' ${campo}`);
    }
  });
});

/**
 * ── LA SCALA, ESEGUITA (issue #374 punto 1) ─────────────────────────────────
 *
 * Le asserzioni qui sotto non leggono il sorgente: lo RITAGLIANO e lo ESEGUONO,
 * per la stessa ragione del ritaglio del `catch` sopra. Una scala di riduzione
 * e' fatta di aritmetica, e un `grep` che trovi la parola `Math.max` non prova
 * che il pavimento tenga — che e' esattamente il finding Important della PR
 * #373 sul corpus: il gradino al 60% poteva scendere SOTTO il minimo dichiarato
 * ogni volta che la fonte partiva gia' corta, cioe' proprio quando c'era meno
 * da togliere.
 */
describe('la scala di riduzione del prompt', () => {
  // Le due clamp sono a modulo e non esportate: si ritagliano insieme alla
  // scala, cosi' cio' che viene eseguito e' il codice che gira davvero.
  const clamps = cut('function _clampRemediation(', '// ── Step 2: Generate article');
  const ladder = cut('  const PROMPT_SOURCE_FLOOR_CHARS = 3000;', '  let prompt = null;');

  const costruisciScala = new Function(
    'truncatedContent',
    'domainFactsBlock',
    'headlineRefinementInstruction',
    'factCheckRefinementInstruction',
    `${clamps}\n${ladder}\nreturn { _shrinkLadder, PROMPT_SOURCE_FLOOR_CHARS };`,
  );

  const FATTI = '\nFATTI DI DOMINIO VERIFICATI (…):\nxxx\n';
  const RIMEDIO = 'R'.repeat(4000);
  const scalaCon = (lunghezzaFonte: number) =>
    costruisciScala('F'.repeat(lunghezzaFonte), FATTI, RIMEDIO, RIMEDIO);

  it('ha cinque gradini, e il primo non toglie niente', () => {
    const { _shrinkLadder } = scalaCon(6000);
    assert.equal(_shrinkLadder.length, 5, 'la scala non ha piu\' cinque gradini');
    assert.equal(_shrinkLadder[0].domainFacts, FATTI, 'il primo gradino gia\' toglie i fatti');
    assert.equal(_shrinkLadder[0].sourceBody.length, 6000, 'il primo gradino gia\' taglia la fonte');
  });

  it('toglie i fatti di dominio PRIMA di toccare la fonte', () => {
    // L'ordine e' la sostanza della scala: la fonte e' il materiale su cui il
    // gate di fedelta' giudica, i fatti di dominio sono contorno.
    const { _shrinkLadder } = scalaCon(6000);
    assert.equal(_shrinkLadder[1].domainFacts, '', 'il gradino 1 non toglie i fatti');
    assert.equal(_shrinkLadder[1].sourceBody.length, 6000, 'il gradino 1 tocca gia\' la fonte');
    assert.equal(_shrinkLadder[2].remediation.length < RIMEDIO.length * 2, true, 'il gradino 2 non tronca il rimedio');
    assert.equal(_shrinkLadder[2].sourceBody.length, 6000, 'il gradino 2 tocca gia\' la fonte');
  });

  it('il PAVIMENTO tiene anche quando la fonte parte gia\' corta', () => {
    // ── Il finding Important di #373, in forma di test ───────────────────
    // Con una fonte da 3000 char il 60% e' 1800, che e' SOTTO il minimo
    // dichiarato. Senza `Math.max(PROMPT_SOURCE_FLOOR_CHARS, …)` il gradino 3
    // consegnerebbe al writer una fonte piu' corta di quella che il gradino 4 —
    // l'ultima risorsa — considera il minimo accettabile: la scala si
    // scavalcherebbe da sola.
    const { _shrinkLadder, PROMPT_SOURCE_FLOOR_CHARS } = scalaCon(3000);
    const sessanta = _shrinkLadder[3].sourceBody.replace(/\n\[\.\.\.[^\]]*\]$/, '');
    assert.ok(
      sessanta.length >= PROMPT_SOURCE_FLOOR_CHARS,
      `il gradino al 60% e' sceso a ${sessanta.length} char, sotto il pavimento `
      + `di ${PROMPT_SOURCE_FLOOR_CHARS}: manca il Math.max`,
    );
  });

  it('su una fonte lunga il 60% morde davvero', () => {
    // Il contrappeso del test sopra: un pavimento che vincesse SEMPRE renderebbe
    // il gradino 3 identico al gradino 2, cioe' uno gradino sprecato.
    const { _shrinkLadder } = scalaCon(20000);
    const sessanta = _shrinkLadder[3].sourceBody.replace(/\n\[\.\.\.[^\]]*\]$/, '');
    assert.ok(sessanta.length < 20000, 'il gradino al 60% non ha tagliato niente');
    assert.ok(sessanta.length <= 12000, `il gradino al 60% ha lasciato ${sessanta.length} char (atteso ≤12000)`);
  });

  it('non cresce mai scendendo i gradini', () => {
    // La proprieta' che rende la scala una scala. Un gradino che allarga
    // vanificherebbe la riduzione gia' decisa.
    for (const lunghezza of [3000, 6000, 20000]) {
      const { _shrinkLadder } = scalaCon(lunghezza);
      const peso = (s: any) => s.sourceBody.length + s.domainFacts.length + s.remediation.length;
      for (let i = 1; i < _shrinkLadder.length; i++) {
        assert.ok(
          peso(_shrinkLadder[i]) <= peso(_shrinkLadder[i - 1]),
          `fonte ${lunghezza}: il gradino ${i} pesa piu' del ${i - 1}`,
        );
      }
    }
  });

  it('sui retry i gradini 3 e 4 coincidono, ed e\' documentato', () => {
    // Dal secondo tentativo MAX_SOURCE_CHARS scende a 4500: il 60% fa 2700 e il
    // pavimento lo rialza a 3000, cioe' esattamente l'ultimo gradino. Il test
    // esiste perche' la coincidenza sia una scelta registrata e non una
    // scoperta: il ciclo si ferma al primo gradino che rientra, quindi ripeterne
    // uno costa una stima, mentre «differenziarli» costerebbe fonte sotto il
    // minimo dichiarato sostenibile.
    const { _shrinkLadder } = scalaCon(4500);
    expect(_shrinkLadder[3].sourceBody).toBe(_shrinkLadder[4].sourceBody);
    // E sul primo tentativo (6000) restano distinti, che e' dove la scala e' tarata.
    const primo = scalaCon(6000)._shrinkLadder;
    assert.notEqual(primo[3].sourceBody, primo[4].sourceBody, 'a 6000 char i due gradini devono differire');
  });

  it('l\'ultimo gradino e\' al minimo dichiarato', () => {
    const { _shrinkLadder, PROMPT_SOURCE_FLOOR_CHARS } = scalaCon(20000);
    const ultimo = _shrinkLadder[4].sourceBody.replace(/\n\[\.\.\.[^\]]*\]$/, '');
    assert.ok(
      ultimo.length <= PROMPT_SOURCE_FLOOR_CHARS,
      `l'ultimo gradino lascia ${ultimo.length} char, sopra il minimo di ${PROMPT_SOURCE_FLOOR_CHARS}`,
    );
  });

  // ── IL CICLO CHE LA CONSUMA, non solo la scala che la descrive ──────────
  //
  // Una scala costruita bene e mai percorsa e' lo stesso difetto di prima con
  // un array in piu': la prima versione di questo file la pinnava tutta e
  // restava verde anche sostituendo il corpo del `for` con un `break` secco.
  // Qui il ciclo viene ritagliato ed ESEGUITO con una stima finta, cosi' cio'
  // che si misura e' la DISCESA.
  describe('il ciclo di selezione', () => {
    const loop = cut('  let prompt = null;', '  // Marker machine-readable');

    /**
     * Esegue il ciclo vero. `pesoPerGradino` e' la stima finta: l'indice del
     * gradino decide il costo, cosi' il test controlla quando si rientra.
     */
    function percorri(pesoPerGradino: number[], bersaglio: number) {
      const scala = pesoPerGradino.map((_, i) => ({
        label: `g${i}`, sourceBody: `s${i}`, domainFacts: '', remediation: '',
      }));
      const fn = new Function(
        '_shrinkLadder', '_promptTokenTarget', 'buildPrompt', 'buildMessages',
        'estimateRequestTokens', 'articleSchema', 'IT_GENERATION_MAX_TOKENS', 'pesi',
        `${loop}\nreturn { _promptShrinkStep, _promptEstTokens, _promptShrinkLabel, prompt };`,
      );
      return fn(
        scala, bersaglio,
        ({ sourceBody }: any) => sourceBody,
        (p: string) => [{ role: 'user', content: p }],
        (msgs: any) => pesoPerGradino[Number(String(msgs[0].content).slice(1))],
        {}, 8000, pesoPerGradino,
      );
    }

    it('si ferma al PRIMO gradino che rientra, non prima e non dopo', () => {
      const out = percorri([9500, 9000, 8500, 7900, 7000], 8000);
      assert.equal(out._promptShrinkStep, 3, 'non si e\' fermato al primo gradino sotto budget');
      assert.equal(out._promptEstTokens, 7900, 'ha riportato la stima di un altro gradino');
    });

    it('non scende affatto quando il primo gradino gia\' rientra', () => {
      // Il caso normale, ed e' quello che non deve regredire: un prompt che sta
      // nel budget non perde i fatti di dominio per zelo.
      const out = percorri([5000, 4000, 3000, 2000, 1000], 8000);
      assert.equal(out._promptShrinkStep, 0, 'ha ridotto un prompt che stava gia\' dentro');
      assert.equal(out.prompt, 's0', 'non ha usato il gradino intero');
    });

    it('percorre TUTTA la scala quando nessun gradino basta', () => {
      // Sopra budget anche all'ultimo: si tiene l'ultimo e si lascia degradare
      // la catena ai modelli grandi, invece di fermarsi al primo.
      const out = percorri([9500, 9400, 9300, 9200, 9100], 8000);
      assert.equal(out._promptShrinkStep, 4, 'si e\' fermato prima dell\'ultimo gradino');
      assert.equal(out._promptEstTokens, 9100, 'non ha usato l\'ultimo gradino');
    });

    it('un budget dettato piu\' stretto fa scendere piu\' in basso', () => {
      // E' il collegamento con #374 punto 1: lo stesso prompt, due bersagli.
      const pesi = [9500, 9000, 8500, 7900, 7000];
      assert.equal(percorri(pesi, 9000)._promptShrinkStep, 1, 'bersaglio largo: doveva bastare il gradino 1');
      assert.equal(percorri(pesi, 7500)._promptShrinkStep, 4, 'bersaglio stretto: doveva arrivare al gradino 4');
    });
  });

  it('la fonte troncata conserva sempre il marcatore', () => {
    // E' cio' che dice al writer che il testo non finisce li'. Senza, il modello
    // crede di avere la fonte intera e il gate di fedelta' chiede ancore che
    // non puo' vedere.
    const { _shrinkLadder } = scalaCon(20000);
    for (const i of [3, 4]) {
      assert.ok(
        _shrinkLadder[i].sourceBody.endsWith('[...contenuto troncato per brevità]'),
        `il gradino ${i} ha perso il marcatore di troncamento`,
      );
    }
  });
});
