/**
 * ── LA CAUSA CHE VENIVA RINOMINATA (corpus #313 / #361) ─────────────────────
 *
 * Gemello di `generator/tests/exhaustion-cause-naming.test.mjs` nel repo del
 * corpus. `scripts/lib/ai-models.mjs` e' `mode: identical` nel manifest del
 * ciclo, quindi il difetto qui era LATENTE, non assente: nessun articolo viene
 * generato da questo lato oggi, ma `publish-journalist-article` importa il
 * gemello di create-article e gira ogni 15 minuti.
 *
 * `Generate Blog Article` e' uscita `success` 60+ volte di fila senza produrre
 * un articolo. La decisione di differire (exit 0, run verde) sta in
 * `transientExhaustion`, che e' un voto di maggioranza fra cause transitorie e
 * persistenti — e il voto era truccato a monte, non nel conteggio.
 *
 * Un modello esaurito da un 401 (chiave stale), un 402 (credito finito) o un
 * 404 (modello ritirato) veniva marcato `nonretryable` nel punto giusto, con un
 * commento che spiegava perche' NON va etichettato come quota. Poi, al giro
 * successivo, il ramo di skip lo rimetteva nel riepilogo con una stringa fissa:
 *
 *     "skipped — exhausted (daily limit / consecutive 429s / timeout circuit-breaker)"
 *
 * una disgiunzione a tre di cui due rami non sono transitori. `classifyExhaustionCause`
 * la matchava su `daily limit` e contava TRANSITORIO. La causa era gia' registrata
 * in `_exhaustReason`: solo il messaggio la buttava via.
 *
 * Misurato sulla run 31823202761 (104 modelli nel tally): 54 transitori contro 49
 * persistenti, e tutti e 54 i transitori portavano quella stringa. Con la causa
 * vera al suo posto il conto e' 39 contro 65 — la run esce rossa.
 *
 * PERCHE' I TEST GUARDANO LA CLASSIFICAZIONE E NON IL TESTO DEL MESSAGGIO. Un
 * test che asserisse "il messaggio contiene la causa" resterebbe verde anche se
 * la regex smettesse di riconoscerla; e' la coppia messaggio→classe a essere
 * load-bearing, quindi e' quella a essere asserita.
 */

import { describe, expect, it } from 'vitest';

import {
  AI_MODELS,
  DEFAULT_CHAIN,
  classifyExhaustionCause,
  classifyNonRetryableError,
} from '../scripts/lib/ai-models.mjs';

// Ponte verso lo stile del sito: le asserzioni restano identiche al gemello del
// corpus (`generator/tests/exhaustion-cause-naming.test.mjs`), che gira su
// node:test. Tenerle nella stessa forma e' cio' che permette di diffare i due
// file quando il manifest segnala drift su ai-models.mjs.
const assert = {
  equal: (a, b, m) => expect(a, m).toBe(b),
  deepEqual: (a, b, m) => expect(a, m).toEqual(b),
  ok: (a, m) => expect(a, m).toBeTruthy(),
};

// Il corpo esatto che l'API Gemini ha restituito nella run 31823202761.
const GOOGLE_RETIRED_BODY = JSON.stringify({
  error: {
    code: 404,
    message: 'This model models/gemini-2.0-flash is no longer available. Please update your code to use a newer model for the latest features.',
    status: 'NOT_FOUND',
  },
});

describe('classifyNonRetryableError — la ruggine va marcata esaurita', () => {
  it('riconosce la formula di Google per un modello ritirato', () => {
    const r = classifyNonRetryableError(404, GOOGLE_RETIRED_BODY);
    assert.equal(r.nonRetryable, true);
    // Il punto: senza markExhausted il modello viene RITENTATO a ogni passata di
    // ogni retry invece di essere saltato dopo il primo 404. E' cosi' che tre
    // modelli morti hanno prodotto 48 chiamate inutili in una sola run.
    assert.equal(r.markExhausted, true, 'un modello ritirato da Google deve essere marcato esaurito');
  });

  it('riconosce anche la variante "no longer supported"', () => {
    const r = classifyNonRetryableError(404, '{"error":"model is no longer supported"}');
    assert.equal(r.markExhausted, true);
  });

  it('non marca esaurito un 404 di cui non riconosce la causa', () => {
    // Un 404 generico puo' essere un typo nell'URL o un guasto transitorio del
    // routing del provider: marcarlo esaurito toglierebbe il modello dal roster
    // per tutta la run senza prove. Comportamento invariato, asserito perche'
    // allargare il matcher e' esattamente il modo di romperlo.
    const r = classifyNonRetryableError(404, '{"error":"Not Found"}');
    assert.equal(r.nonRetryable, true);
    assert.equal(r.markExhausted, false);
  });

  it('402 e 401 restano non-ritentabili ed esauriti', () => {
    assert.deepEqual(
      classifyNonRetryableError(402, '{"error":{"code":"PAYMENT_METHOD_REQUIRED"}}'),
      { nonRetryable: true, markExhausted: true },
    );
    assert.deepEqual(
      classifyNonRetryableError(401, 'invalid api key'),
      { nonRetryable: true, markExhausted: true },
    );
  });
});

describe('classifyExhaustionCause — le cause di skip finiscono nel secchio giusto', () => {
  // Le stringhe sono quelle che _exhaustSkipCause produce davvero, una per ogni
  // valore possibile di _exhaustReason.
  const PERSISTENTI = [
    'sn/gpt-oss-120b: skipped — exhausted (non-retryable provider error (HTTP 402))',
    'gemini-2.0-flash: skipped — exhausted (non-retryable provider error (HTTP 404))',
    'hf/Qwen/Qwen2.5-72B-Instruct: skipped — exhausted (stale credentials (HTTP 401))',
    'groq/compound: skipped — exhausted (repeated unusable content)',
  ];
  const TRANSITORIE = [
    'gemini-3.1-flash-lite: skipped — exhausted (daily limit / consecutive 429s)',
    'cerebras/gpt-oss-120b: skipped — exhausted (timeout circuit-breaker)',
  ];

  for (const reason of PERSISTENTI) {
    it(`persistente: ${reason.split('exhausted ')[1]}`, () => {
      const { transient, persistent } = classifyExhaustionCause([reason]);
      assert.equal(persistent, 1, `deve contare persistente: ${reason}`);
      assert.equal(transient, 0);
    });
  }

  for (const reason of TRANSITORIE) {
    it(`transitoria: ${reason.split('exhausted ')[1]}`, () => {
      const { transient, persistent } = classifyExhaustionCause([reason]);
      assert.equal(transient, 1, `deve contare transitoria: ${reason}`);
      assert.equal(persistent, 0);
    });
  }

  it('la vecchia stringa fissa contava transitorio anche un 402 — regressione da non riaprire', () => {
    // Documenta il difetto: se qualcuno reintroduce la disgiunzione a tre, questo
    // test resta verde (e' un'asserzione sul PASSATO) ma i quattro sopra no.
    const vecchia = 'sn/gpt-oss-120b: skipped — exhausted (daily limit / consecutive 429s / timeout circuit-breaker)';
    const { transient } = classifyExhaustionCause([vecchia]);
    assert.equal(transient, 1, 'la vecchia stringa era transitoria: e\' il difetto, non il comportamento voluto');
  });

  it('un timeout del CLI claude non finisce piu\' nel secchio ambiguo', () => {
    // transientRe cercava `timeout`; il provider claude-CLI rifiuta con "timed
    // out". L'unico modello davvero invocato della run restava fuori dal conteggio.
    const { transient, total } = classifyExhaustionCause([
      'claude-cli/haiku: claude CLI timed out after 120000ms',
    ]);
    assert.equal(total, 1);
    assert.equal(transient, 1, '"timed out" deve contare quanto "timeout"');
  });

  it('riproduce il ribaltamento misurato sulla run 31823202761', () => {
    // Non i 104 modelli veri, ma le stesse proporzioni delle classi che contano:
    // i 16 modelli a 402 sono cio' che sposta il voto.
    const capSkips = Array.from({ length: 41 }, (_, i) =>
      `m${i}: skipped — request ~10066 tokens exceeds 8000-token input cap`);
    const noKey = Array.from({ length: 11 }, (_, i) => `cf/m${i}: skipped — no API key for provider cloudflare`);
    const quota = Array.from({ length: 38 }, (_, i) => `q${i}: skipped — exhausted (daily limit / consecutive 429s)`);
    const pagamento = Array.from({ length: 16 }, (_, i) =>
      `sn/m${i}: skipped — exhausted (non-retryable provider error (HTTP 402))`);

    const dopo = classifyExhaustionCause([...capSkips, ...noKey, ...quota, ...pagamento]);
    assert.ok(
      dopo.persistent > dopo.transient,
      `persistente deve vincere: ${dopo.persistent} vs ${dopo.transient}`,
    );
    // E' questa disuguaglianza a decidere `transientExhaustion`, che decide
    // l'exit code, che decide se la run e' verde.
    const transientExhaustion = dopo.transient > 0 && dopo.transient >= dopo.persistent;
    assert.equal(transientExhaustion, false, 'la run non deve piu\' differire su un guasto persistente');

    // Con la vecchia denominazione i 16 a pagamento tornavano transitori e il
    // voto si ribaltava — la prova che e' il NOME della causa a decidere.
    const prima = classifyExhaustionCause([
      ...capSkips,
      ...noKey,
      ...quota,
      ...pagamento.map((r) => r.replace(/\(non-retryable[^)]*\)\)/, '(daily limit / consecutive 429s / timeout circuit-breaker)')),
    ]);
    assert.ok(prima.transient >= prima.persistent, 'baseline: prima della fix il transitorio vinceva');
  });
});

describe('roster — nessun modello ritirato, nessun buco', () => {
  it('un modello ritirato esce dal giro da solo, senza curare il roster a mano', () => {
    // I tre modelli che Google ha ritirato il 2026-08-14 restano in AI_MODELS DI
    // PROPOSITO. Toglierli a mano e' cio' che e' gia' stato fatto una volta
    // (GEMINI_31_FLASH_LITE, 2026-05-27) e che ha lasciato tornare il difetto tre
    // mesi dopo con altri tre: la lista rimarcisce, il matcher no. Con il matcher
    // riparato ognuno costa UN 404 per run invece di sedici.
    //
    // E c'e' una ragione piu' dura per non toglierli in questa PR: farlo rende
    // rosso `tests/local-llm-fallback.test.ts`, che passava soltanto perche' quei
    // tre erano gli unici modelli Gemini non esauriti nello ScoreStore — cioe'
    // grazie al difetto stesso. Un test che dipende dalla ruggine va reso ermetico
    // prima, non aggirato.
    for (const dead of ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-3-pro-preview']) {
      const r = classifyNonRetryableError(404, `{"error":{"code":404,"message":"This model models/${dead} is no longer available."}}`);
      assert.equal(r.markExhausted, true, `${dead} deve essere marcato esaurito al primo 404`);
    }
  });

  it('la catena di default non contiene buchi', () => {
    // Togliere una chiave da AI_MODELS lascia `AI_MODELS.X` a `undefined` in ogni
    // catena che la nominava, e un buco in una catena non somiglia a un errore:
    // somiglia a un modello in meno. E' successo davvero in questo giro con
    // FAQ_MODELS di batch-add-faq-to-articles.mjs.
    const buchi = DEFAULT_CHAIN.map((m, i) => [i, m]).filter(([, m]) => !m || typeof m !== 'string');
    assert.deepEqual(buchi, [], `DEFAULT_CHAIN ha voci non valide: ${JSON.stringify(buchi)}`);
  });

  it('la catena di default non ha duplicati', () => {
    const seen = new Set();
    const dup = DEFAULT_CHAIN.filter((m) => (seen.has(m) ? true : (seen.add(m), false)));
    assert.deepEqual(dup, [], `DEFAULT_CHAIN ha duplicati: ${JSON.stringify(dup)}`);
  });
});
