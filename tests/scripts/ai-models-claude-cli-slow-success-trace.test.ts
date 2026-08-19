import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Stessa ragione del gemello `ai-models-claude-cli-stream-json.test.ts`:
// `_callClaudeCli` spawna `node:child_process` direttamente, e mockarlo e'
// l'unico modo di far scattare il percorso senza un `claude` vero.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { AI_MODELS, callLLM, resetState } from '../../scripts/lib/ai-models.mjs';

const AI_MODELS_SRC = readFileSync(
  new URL('../../scripts/lib/ai-models.mjs', import.meta.url),
  'utf-8',
);

/**
 * La soglia LETTA DAL SORGENTE, non ricopiata: questi test devono restare
 * asserzioni sull'ORDINE («sopra soglia parla, sotto tace») e non su un valore.
 * Il file gemello ha gia' pagato una volta l'errore opposto, restando inchiodato
 * a `120_000` finche' il floor non si e' mosso.
 */
const SOGLIA_MS = Number(
  /const CLAUDE_CLI_SLOW_CALL_LOG_MS = \(\(\) => \{[\s\S]*?return (\d[\d_]*);/.exec(AI_MODELS_SRC)![1].replace(/_/g, ''),
);
/** Il minimo per-chiamata, che e' anche il momento in cui il kill timer spara. */
const FLOOR_MS = Number(
  /const CLAUDE_CLI_MIN_TIMEOUT_MS = ([\d_]+);/.exec(AI_MODELS_SRC)![1].replace(/_/g, ''),
);

/**
 * Una chiamata LENTA MA RIUSCITA vive in una finestra stretta, e sbagliarla
 * cambia il test in silenzio: sotto `SOGLIA_MS` la riga non esce, a `FLOOR_MS`
 * il kill timer di `_runClaudeCliProcess` spara e la chiamata non e' piu' un
 * successo ma un timeout — cioe' l'altro caso, quello che il gemello copre
 * gia'. Il punto di mezzo e' l'unico posto dove la proprieta' sotto test esiste
 * davvero, e la guardia sotto lo rende un errore rumoroso invece che un test
 * che prova un'altra cosa.
 */
const LENTA_MS = Math.floor((SOGLIA_MS + FLOOR_MS) / 2);
if (!(LENTA_MS > SOGLIA_MS && LENTA_MS < FLOOR_MS)) {
  throw new Error(`taratura incoerente: soglia=${SOGLIA_MS} lenta=${LENTA_MS} floor=${FLOOR_MS}`);
}

/**
 * ── UNA DIAGNOSTICA APPESA AL FALLIMENTO E' MUTA DAVANTI ALLA LENTEZZA ──────
 *
 * Il gemello di questo file (`ai-models-claude-cli-stream-json.test.ts`) prova
 * che il TIMEOUT sa dire dove si e' fermato. Quella proprieta' copre il difetto
 * di allora, che era un errore: «claude CLI timed out after 120000ms».
 *
 * Il difetto di oggi non e' un errore. Run 32230961988 del corpus (2026-08-19,
 * job `generate` 08:06:22→08:23:22, 17m00s, `success`, un articolo prodotto):
 * `claude-cli/haiku` chiude 3 chiamate su 3 con SUCCESSO impiegando 197s, 206s
 * e 253s — 656s su 1020, il 64% del job — mentre nessun altro modello del
 * roster supera mai i 60s. Il riepilogo di fine run dice `claude-cli 3 served/0
 * failed` e non una parola su quei 656 secondi, perche' `trace.describe()` era
 * invocato solo dai due rami d'errore.
 *
 * Questo file e' l'osservatore end-to-end della riga che li racconta: che il
 * PROCESSO la emetta davvero, sopra soglia e non sotto. I test unitari di
 * `describeCost()` stanno nel gemello del corpus
 * (`generator/tests/claude-cli-slow-success-trace.test.mjs`).
 *
 * NOTA SULLO SCOPO, identica a quella del gemello: questa suite non prova che
 * haiku sia diventato veloce, perche' la PR non lo rende veloce — lo rende
 * misurabile. Floor, semaforo e soglia del breaker restano quelli che sono,
 * deliberatamente: tre tentativi alla cieca su quelle leve sono gia' stati
 * spesi senza un dato su cui puntare.
 */
describe('claude CLI: una chiamata riuscita ma lenta dice quanto e\' costata', () => {
  const ENV_KEYS = ['ENABLE_HAIKU_ARTICLE_FALLBACK', 'CLAUDE_CODE_OAUTH_TOKEN', 'LOCAL_LLM_ENABLED', 'AI_COMPETING_TIERS'] as const;
  const saved: Record<string, string | undefined> = {};
  let warn: ReturnType<typeof vi.spyOn>;

  /** L'involucro `result` nella forma reale (campi verificati sul CLI 2.1.235). */
  const RESULT = `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'CORPO-ARTICOLO',
    duration_ms: 197_000,
    duration_api_ms: 196_400,
    ttft_ms: 181_000,
    num_turns: 1,
    usage: {
      input_tokens: 11_512,
      output_tokens: 2_140,
      output_tokens_details: { thinking_tokens: 1_180 },
    },
  })}\n`;
  const INIT = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })}\n`;

  /** Un `claude` che emette subito e chiude: la chiamata sana e veloce. */
  function cliVeloce(chunks: string[]) {
    return () => {
      const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      queueMicrotask(() => {
        for (const c of chunks) stdoutListeners.data?.forEach((cb) => cb(Buffer.from(c)));
        listeners.close?.forEach((cb) => cb(0));
      });
      return {
        stdout: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stdoutListeners[ev] ||= []).push(cb); } },
        stderr: { on: () => {} },
        on: (ev: string, cb: (...args: unknown[]) => void) => { (listeners[ev] ||= []).push(cb); },
        kill: vi.fn(),
      };
    };
  }

  /**
   * Un `claude` che impiega `dopoMs` e POI chiude con successo. E' la forma del
   * difetto di oggi, e non esisteva finora nella suite: il gemello ha solo
   * processi appesi che muoiono di SIGKILL.
   */
  function cliLentoMaRiuscito(dopoMs: number, chunks: string[]) {
    return () => {
      const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      setTimeout(() => {
        for (const c of chunks) stdoutListeners.data?.forEach((cb) => cb(Buffer.from(c)));
        listeners.close?.forEach((cb) => cb(0));
      }, dopoMs);
      return {
        stdout: { on: (ev: string, cb: (...args: unknown[]) => void) => { (stdoutListeners[ev] ||= []).push(cb); } },
        stderr: { on: () => {} },
        on: (ev: string, cb: (...args: unknown[]) => void) => { (listeners[ev] ||= []).push(cb); },
        kill: vi.fn(),
      };
    };
  }

  /**
   * UNA chiamata a orologio VERO prima di tutte le altre.
   *
   * Senza, il primo test del file scade: `callLLM` alla prima invocazione
   * inizializza lo score store, e quell'inizializzazione avviene sotto i timer
   * finti — con `Date` falsificato non progredisce e la promise non si risolve
   * mai. E' lo stesso «primo giro a freddo» che rende rosso il confinement test
   * al primo colpo e verde al secondo: il costo lo paga chi arriva per primo.
   *
   * Scaldare qui e' preferibile ad alzare il `testTimeout`, che nasconderebbe
   * lo stallo invece di toglierlo, e a non falsificare `Date`, senza cui una
   * chiamata «da due minuti» resta istantanea per il codice sotto test.
   */
  beforeAll(async () => {
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    spawnMock.mockImplementation(cliVeloce([INIT, RESULT]));
    await callLLM(
      [{ role: 'user', content: 'riscaldamento' }],
      { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU] },
    );
    resetState();
  });

  beforeEach(() => {
    resetState();
    spawnMock.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    delete process.env.LOCAL_LLM_ENABLED;
    delete process.env.AI_COMPETING_TIERS;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `Date` in piu' rispetto al gemello: il tempo trascorso e' misurato con
    // `Date.now()`, quindi senza falsificarlo una chiamata «da 200 secondi»
    // resterebbe istantanea per il codice sotto test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    warn.mockRestore();
    resetState();
    vi.useRealTimers();
  });

  const chiama = () => callLLM(
    [{ role: 'user', content: 'Scrivi un articolo' }],
    { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU] },
  );

  /** La riga 🐢, o `undefined` se non e' stata emessa. */
  const rigaLenta = () => (warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes('🐢')));

  it('sopra soglia: la riga esce, e porta il payload intatto', async () => {
    spawnMock.mockImplementation(cliLentoMaRiuscito(LENTA_MS, [INIT, RESULT]));

    const promise = chiama();
    await vi.advanceTimersByTimeAsync(LENTA_MS);
    const out = await promise;

    // Il contratto della chiamata non cambia: la diagnostica non tocca il
    // valore restituito, che e' l'unica cosa che i chiamanti guardano.
    expect(out).toBe('CORPO-ARTICOLO');
    expect(rigaLenta()).toBeDefined();
  });

  it('la riga separa la CODA dalla GENERAZIONE, che vogliono rimedi opposti', async () => {
    spawnMock.mockImplementation(cliLentoMaRiuscito(LENTA_MS, [INIT, RESULT]));

    const promise = chiama();
    await vi.advanceTimersByTimeAsync(LENTA_MS);
    await promise;

    const riga = rigaLenta()!;
    // `ttft_ms` alto con `duration_api_ms` di poco superiore = attesa, non
    // generazione: il rimedio sarebbe di pianificazione, non sul prompt.
    expect(riga).toMatch(/primo token a 181000ms/);
    expect(riga).toMatch(/api 196400ms/);
    expect(riga).toMatch(/2140 token di output \(1180 di thinking\)/);
    // Il numero per cui il cap dei giri di schema era dichiarato `blocked:`.
    expect(riga).toMatch(/giri-schema/);
    // E la meta' che gia' esisteva ma parlava solo in caso d'errore.
    expect(riga).toMatch(/rate_limit_event/);
  });

  it('sotto soglia: silenzio, cosi\' il volume di log resta quello di oggi', async () => {
    spawnMock.mockImplementation(cliVeloce([INIT, RESULT]));

    const out = await chiama();

    expect(out).toBe('CORPO-ARTICOLO');
    expect(rigaLenta()).toBeUndefined();
  });

  it('il tempo passato in CODA conta come tempo speso', async () => {
    // Il cronometro parte prima di `_withClaudeCliSlot`. Se partisse allo
    // spawn, una chiamata rimasta 200s dietro al semaforo risulterebbe
    // istantanea — ed e' proprio una delle cause che la riga deve mostrare.
    const i = AI_MODELS_SRC.indexOf('async function _callClaudeCli(');
    expect(i).toBeGreaterThan(-1);
    const cron = AI_MODELS_SRC.indexOf('const startedAt = Date.now();', i);
    const coda = AI_MODELS_SRC.indexOf('_withClaudeCliSlot(async () =>', i);
    expect(cron).toBeGreaterThan(-1);
    expect(coda).toBeGreaterThan(-1);
    expect(cron).toBeLessThan(coda);
  });

  it('non tocca nessuna delle tre leve gia\' spese alla cieca', () => {
    // Il valore di questo cambiamento e' esattamente che NON e' la quarta leva.
    // Se un domani ci si appende una modifica al floor, al semaforo o al
    // breaker, smette di essere osservativo e questo test lo dice.
    expect(AI_MODELS_SRC).toMatch(/const CLAUDE_CLI_MIN_TIMEOUT_MS = 180_000;/);
    expect(AI_MODELS_SRC).toMatch(/const CLAUDE_CLI_MAX_CONCURRENCY = 2;/);
    expect(AI_MODELS_SRC).toMatch(/const CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD = 3;/);
  });
});
