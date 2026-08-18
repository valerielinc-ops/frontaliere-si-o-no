/**
 * ── IL TETTO CHE NESSUNO ABBASSAVA ──────────────────────────────────────────
 *
 * Gemello vitest di `generator/tests/adaptive-call-timeout.test.mjs` nel repo
 * del corpus. Esiste da QUESTO lato perche' `scripts/lib/ai-models.mjs` e'
 * dichiarato `mode: identical` nel manifest del ciclo, e il drift check
 * confronta i file uno per uno: non vede l'assenza di un test da un lato. Un
 * file allineato con la guardia su una meta' sola e' la forma di buco gia'
 * documentata (SiteShellContract, alert-pat-down.mjs) — CI verde, contratto
 * scoperto. Questo e' inoltre il lato SORGENTE per un `identical`, quindi e'
 * qui che una regressione nascerebbe per prima.
 *
 * La misura che ha prodotto la fix (su `generate-article.yml` del corpus, 14
 * run consecutive `success`, 2026-08-18 09:01-11:06 UTC): quattro run hanno
 * perso 60,0 ± 0,003 s ciascuna in UNA chiamata appesa, sempre su
 * `nvidia/meta/llama-3.1-8b-instruct` — 240 s su 14 run, 17,1 s/run, 4,3 %
 * della durata. Non era un giro di retry (entrambi i loop dei provider gia' si
 * rifiutano di ritentare un timeout) ma il `timeout` del chiamante speso per
 * intero su una chiamata che non sarebbe mai tornata.
 *
 * I due meccanismi che sembrano doverlo intercettare non lo intercettano:
 *   - il ledger REGISTRA il timeout (`recordModelFailure` con `exhausted:true`,
 *     cioe' -50) ed e' inerte, perche' quel modello vale +36819 in
 *     `ai_model_scores/_all` (172.042 successi / 3.286 fallimenti, letto il
 *     2026-08-18 alle 11:25 Z): -50 lo sposta dello 0,14 % e resta primo su
 *     340, col secondo a +120;
 *   - bandirlo sarebbe sbagliato: 98,1 % di successo storico, ~26 chiamate
 *     riuscite nella stessa run che poi perde 60 s, e una sonda diretta
 *     sull'endpoint ha risposto 5 volte su 5 in 1,2-5,3 s.
 *
 * ── DUE COSE CHE UN FETCH FINTO ROMPE, E COME SONO CHIUSE ───────────────────
 *
 * 1. Tutti i timer di `_callModel` sono `unref()` di proposito (il cap duro e
 *    l'heartbeat non devono tenere vivo il processo), e anche
 *    `AbortSignal.timeout()` e' unref'd per contratto Node. Con la rete VERA
 *    resta vivo il socket del fetch; con un fetch finto non resta niente e il
 *    runner puo' concludere che il loop e' finito mentre la chiamata e' appesa
 *    — su `node --test` con Node 22 questo ha ucciso l'intero file gemello con
 *    «Promise resolution is still pending but the event loop has already
 *    resolved» (quattro test rossi per un difetto solo). Il `keepAlive` e' un
 *    timer ref'd che rimpiazza l'handle che il fetch finto non ha, spento
 *    appena la chiamata si risolve: non sposta di un millisecondo il momento
 *    in cui l'abort scatta.
 * 2. L'asserzione non confronta il tempo trascorso con una frazione fissa del
 *    numero del chiamante — su un runner lento quel confronto si inverte e il
 *    test diventa flaky. Confronta col tetto REALMENTE applicato, che il
 *    codice espone su `err.adaptiveTimeoutMs`, e la precondizione «il tetto
 *    guadagnato sta sotto il numero del chiamante» fallisce con un messaggio
 *    che dice che la macchina era troppo lenta, invece di dire il falso.
 *
 * ── COSA BLOCCA QUESTO FILE ─────────────────────────────────────────────────
 *
 * Il test comportamentale passa da `callSingleModel`, cioe' dal vero
 * `_callModel`, con la rete sostituita: prima si fanno rispondere in fretta
 * alcune chiamate (l'unica prova che il tetto accetta), poi si fa appendere la
 * successiva e si misura QUANDO muore. Senza la fix muore al numero del
 * chiamante; con la fix muore al tetto adattivo. Provato per mutazione nel
 * gemello del corpus: neutralizzando `_withAdaptiveTimeout` a `return opts` la
 * chiamata appesa torna a durare 8002 ms contro gli 8000 del chiamante.
 */

process.env.AI_ADAPTIVE_TIMEOUT_MIN_SAMPLES = '2';
process.env.AI_ADAPTIVE_TIMEOUT_MULT = '4';
process.env.AI_ADAPTIVE_TIMEOUT_FLOOR_MS = '150';
process.env.GROQ_API_KEY = 'test-key-la-rete-e-sostituita';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const {
  callSingleModel,
  computeAdaptiveTimeoutMs,
  getCallLatencyStats,
  resetState,
} = await import('../../scripts/lib/ai-models.mjs');

const MODEL = 'groq/llama-3.1-8b-instant';
/** Il numero del chiamante: cio' che si pagherebbe senza tetto adattivo. */
const CALLER_TIMEOUT_MS = 8_000;
/** Margine sopra il tetto applicato: copre lo scheduling, non una corsa. */
const SLACK_MS = 2_000;

let realFetch: typeof globalThis.fetch;
/** 'fast' → risponde subito; 'hang' → non risponde mai, muore solo sull'abort. */
let netMode: 'fast' | 'hang' = 'fast';

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    if (netMode === 'fast') {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // nessun segnale: resterebbe appesa per sempre, ed e' il punto
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        reject(err);
      });
    });
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  resetState();
});

const call = () =>
  callSingleModel([{ role: 'user', content: 'ping' }], {
    model: MODEL,
    timeout: CALLER_TIMEOUT_MS,
    maxRetriesPerModel: 1,
    maxTokens: 16,
    // niente `cache`: la cache in-process e' opt-in con `=== true`, quindi
    // l'assenza dell'opzione la tiene gia' spenta (e il tipo dichiarato del
    // modulo non la espone).
  });

/**
 * Rimpiazza l'handle di rete che il fetch finto non ha: senza, l'event loop si
 * svuota mentre la chiamata e' appesa (ogni timer in gioco e' unref'd). Non
 * ritarda l'abort — e' un timer vuoto.
 */
async function withLoopAlive<T>(fn: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 25);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

describe('tetto di chiamata adattivo', () => {
  it('uccide la chiamata appesa al tetto guadagnato, non al numero del chiamante', async () => {
    resetState();
    netMode = 'fast';

    // La prova: due risposte vere. Sotto AI_ADAPTIVE_TIMEOUT_MIN_SAMPLES il
    // tetto non ha titolo per dire niente, ed e' quella la prima garanzia.
    await withLoopAlive(call);
    await withLoopAlive(call);

    const observed = getCallLatencyStats()[MODEL];
    expect(observed, 'le chiamate riuscite devono lasciare una misura di latenza').toBeTruthy();
    expect(observed.samples).toBeGreaterThanOrEqual(2);

    // Precondizione esplicita invece di una soglia a occhio: se la macchina e'
    // cosi' lenta che il tetto guadagnato non sta sotto il numero del
    // chiamante, il test lo DICE — non finge un verdetto sul codice.
    const expectedCeiling = computeAdaptiveTimeoutMs(observed, CALLER_TIMEOUT_MS);
    expect(
      expectedCeiling,
      `ambiente troppo lento per questo test: massimo osservato ${observed.maxMs}ms → tetto ${expectedCeiling}ms`,
    ).toBeLessThan(CALLER_TIMEOUT_MS);

    netMode = 'hang';
    const started = Date.now();
    let caught: any;
    try {
      await withLoopAlive(call);
      throw new Error('la chiamata appesa doveva fallire');
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;

    // Questa e' la marcatura che il codice mette SOLO quando ha stretto lui il
    // tetto: senza la fix non esiste, quindi da sola uccide il mutante — e non
    // dipende da nessun orologio. (Serve anche al circuit-breaker, che senza
    // di essa bandirebbe il modello sulla nostra congettura.)
    expect(caught?.adaptiveTimeoutClamped).toBe(true);
    expect(caught.adaptiveTimeoutMs).toBe(expectedCeiling);
    // E il fatto comportamentale: si e' smesso di aspettare al tetto, non al
    // numero del chiamante. Confronto col tetto REALE piu' uno slack di
    // scheduling, non con una frazione fissa degli 8s: cosi' non e' una corsa.
    expect(
      elapsed,
      `la chiamata appesa e' durata ${elapsed}ms contro un tetto di ${expectedCeiling}ms: il tetto adattivo non e' stato applicato (il chiamante chiedeva ${CALLER_TIMEOUT_MS}ms)`,
    ).toBeLessThan(expectedCeiling + SLACK_MS);
  });

  it('con prova sottile lascia intatto il numero del chiamante', () => {
    expect(computeAdaptiveTimeoutMs(undefined, 60_000)).toBe(60_000);
    expect(computeAdaptiveTimeoutMs({ samples: 0, maxMs: 0 }, 60_000)).toBe(60_000);
    // Un campione sotto soglia non basta: e' la differenza fra «ha risposto in
    // fretta una volta» e «lo fa sempre».
    expect(computeAdaptiveTimeoutMs({ samples: 1, maxMs: 1_000 }, 60_000, { minSamples: 2 })).toBe(60_000);
  });

  it('non alza mai il tetto del chiamante', () => {
    // 4 x 30s = 120s guadagnati, ma il chiamante ne concede 30: vince il chiamante.
    expect(
      computeAdaptiveTimeoutMs({ samples: 50, maxMs: 30_000 }, 30_000, { minSamples: 10, mult: 4, floorMs: 20_000 }),
    ).toBe(30_000);
  });

  it('non scende mai sotto il pavimento, per quanto veloce sia stato il modello', () => {
    // 4 x 100ms = 400ms, ma il pavimento e' 20s: un modello velocissimo non si
    // guadagna un tetto che una singola coda di rete farebbe scattare.
    expect(
      computeAdaptiveTimeoutMs({ samples: 50, maxMs: 100 }, 60_000, { minSamples: 10, mult: 4, floorMs: 20_000 }),
    ).toBe(20_000);
    // E il caso che la fix esiste per recuperare: massimo osservato 5s, tetto
    // 20s (il pavimento), contro i 60s del chiamante → 40s recuperati per evento.
    expect(
      computeAdaptiveTimeoutMs({ samples: 30, maxMs: 5_000 }, 60_000, { minSamples: 10, mult: 4, floorMs: 20_000 }),
    ).toBe(20_000);
  });
});
