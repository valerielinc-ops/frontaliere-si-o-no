/**
 * Il ledger diagnostico non deve toccare quello di routing (issue #6611 /
 * corpus#624).
 *
 * `ai_model_scores/_all` e' la memoria che `sortChainByScore()` usa per
 * ordinare la cascata in produzione, e la scrivono i workflow di entrambi i
 * repo. `smoke-test-ai-models.mjs` pinga ogni modello della catena una volta al
 * giorno con un prompt sintetico ("Reply with 'ok'."): il suo esito descrive la
 * raggiungibilita' del modello, non un uso di produzione, e non deve entrare in
 * quel documento.
 *
 * `recordScore: false` (#6065) copre l'esito della SINGOLA chiamata. Non copre
 * gli altri scrittori che un processo diagnostico attraversa comunque — sopra
 * tutti `discoverFreeModels()`, che marca `stale` gli id spariti dal listing
 * PRIMA della prima callLLM: quei modelli restano sporchi e il persist li
 * riscrive con lo score decaduto letto all'init. Il gate qui sotto sta
 * sull'imbuto (`_persistScoresToFirestore`), che e' l'unico punto dove "0
 * scritture" e' vero per costruzione.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as aiModels from '../../scripts/lib/ai-models.mjs';

const SMOKE_TEST = join(process.cwd(), 'scripts', 'smoke-test-ai-models.mjs');
const MODEL = 'mistral/mistral-small-latest';

function fakeStore() {
  const set = vi.fn().mockResolvedValue(undefined);
  const db = { collection: () => ({ doc: () => ({ set }) }) };
  return { db, set };
}

describe('score store: modalita sola lettura per i run diagnostici', () => {
  beforeEach(() => {
    aiModels.resetState();
    delete process.env.AI_SCORE_STORE_READONLY;
  });

  afterEach(() => {
    delete process.env.AI_SCORE_STORE_READONLY;
    aiModels.resetState();
  });

  it('senza il flag il persist scrive davvero (il seam non passa a vuoto)', async () => {
    const { db, set } = fakeStore();
    aiModels.__installScoreStoreForTests(db);
    aiModels.markModelExhausted(MODEL, 'stale');

    await aiModels.flushScores();

    expect(set).toHaveBeenCalledTimes(1);
  });

  it('in sola lettura una marcatura `stale` da discovery non arriva a Firestore', async () => {
    const { db, set } = fakeStore();
    aiModels.__installScoreStoreForTests(db);
    aiModels.setScoreStoreReadOnly();
    // Esattamente cio' che fa `_discoverProvider` su un id non piu' offerto:
    // sporca il modello senza passare da nessun sito con `recordScore`.
    aiModels.markModelExhausted(MODEL, 'stale');

    await aiModels.flushScores();

    expect(set).not.toHaveBeenCalled();
    // Lo stato in-process resta: il flag toglie la SCRITTURA, non lo skip del
    // modello per il resto del run.
    expect(aiModels.isModelAvailable(MODEL)).toBe(false);
  });

  it('in sola lettura nemmeno un esito registrato arriva a Firestore', async () => {
    const { db, set } = fakeStore();
    aiModels.__installScoreStoreForTests(db);
    aiModels.setScoreStoreReadOnly();
    aiModels.recordModelFailure(MODEL);
    aiModels.recordModelSuccess(MODEL);

    await aiModels.flushScores();

    expect(set).not.toHaveBeenCalled();
  });

  it('il flush finale non allarma per scritture omesse di proposito', async () => {
    const { db, set } = fakeStore();
    aiModels.__installScoreStoreForTests(db);
    aiModels.setScoreStoreReadOnly();
    aiModels.markModelExhausted(MODEL, 'stale');

    // `false` farebbe stampare un `::warning::` "model(s) remain pending" in
    // Checks/Annotations per una scrittura che stiamo saltando apposta.
    await expect(aiModels.flushScoresBeforeExit(1000)).resolves.toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it('AI_SCORE_STORE_READONLY vale come il flag, senza toccare il codice', async () => {
    const { db, set } = fakeStore();
    aiModels.__installScoreStoreForTests(db);
    process.env.AI_SCORE_STORE_READONLY = '1';
    expect(aiModels.isScoreStoreReadOnly()).toBe(true);
    aiModels.markModelExhausted(MODEL, 'stale');

    await aiModels.flushScores();

    expect(set).not.toHaveBeenCalled();
  });

  it('lo smoke test alza il flag PRIMA della discovery', () => {
    const src = readFileSync(SMOKE_TEST, 'utf8');
    const readOnlyAt = src.indexOf('setScoreStoreReadOnly()');
    const discoveryAt = src.indexOf('await discoverFreeModels()');
    expect(readOnlyAt).toBeGreaterThan(-1);
    expect(discoveryAt).toBeGreaterThan(-1);
    // `discoverFreeModels()` e' il primo scrittore del processo: alzare il flag
    // dopo di lei lascerebbe passare proprio le scritture che questo fix chiude.
    expect(readOnlyAt).toBeLessThan(discoveryAt);
    // Il guard per-chiamata resta come seconda linea, non viene sostituito.
    expect(src).toMatch(/recordScore: false/);
  });
});
