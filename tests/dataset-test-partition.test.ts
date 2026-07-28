import { describe, it, expect } from 'vitest';
import {
  listDatasetDependentTests,
  listDatasetIndependentTests,
} from '../scripts/ci/dataset-dependent-tests.mjs';

// tests.yml esegue la suite in DUE run vitest: la prima mentre
// assemble-jobs-dataset.mjs gira in `background:`, la seconda dopo il
// `wait-all`. La partizione arriva da dataset-dependent-tests.mjs via
// VITEST_DATASET_GROUP → vitest.config.ts (che agisce solo su `exclude`).
//
// L'invariante che protegge il gate è che le due run coprano esattamente la
// suite di prima: se la partizione perdesse un file, quel test smetterebbe di
// girare SENZA che niente diventi rosso — copertura persa in silenzio, che è
// il modo peggiore di rompere un gate. Se ne duplicasse uno, girerebbe due
// volte (spreco, ma non un buco).
describe('partizione test dataset-dipendenti', () => {
  const dependent = listDatasetDependentTests();
  const independent = listDatasetIndependentTests();

  it('è disgiunta: nessun file in entrambi i gruppi', () => {
    const dep = new Set(dependent);
    expect(independent.filter((f) => dep.has(f))).toEqual([]);
  });

  it('è completa: unione == tutti i file di test', () => {
    const union = new Set([...dependent, ...independent]);
    expect(union.size).toBe(dependent.length + independent.length);
    // Ogni gruppo non vuoto: una classificazione degenere (tutto di qua o
    // tutto di là) toglierebbe ogni valore allo split senza dare errore.
    expect(dependent.length).toBeGreaterThan(0);
    expect(independent.length).toBeGreaterThan(0);
  });

  it('classifica come dipendente chi legge davvero data/jobs.json da disco', () => {
    // job-locale-completeness legge l'output dell'assemble con readFileSync.
    expect(dependent).toContain('tests/job-locale-completeness.test.ts');
  });

  it('non degenera: il gruppo indipendente resta la maggioranza della suite', () => {
    // Il guadagno dello split esiste solo se il gruppo che gira in parallelo
    // all'assemble dura più dell'assemble stesso (~140s). Il criterio è
    // volutamente conservativo — chi cita jobs.json solo come URL da `fetch`
    // (services/jobSlugShards.ts, raggiunto da router.ts e quindi da quasi
    // ogni componente) non conta, ma chi lo LEGGE da disco sì, anche
    // transitivamente. Se una modifica futura facesse dilagare il taint, lo
    // split smetterebbe di servire a qualcosa in silenzio: questa soglia lo
    // rende visibile.
    expect(independent.length).toBeGreaterThan(dependent.length);
  });

  it('è idempotente: chiamate ripetute danno la stessa partizione', () => {
    // Regressione: la prima versione memoizzava solo i risultati positivi di
    // una DFS che usava un set `seen` condiviso fra rami — la seconda chiamata
    // restituiva 596 dipendenti invece di 594, cioè una partizione diversa a
    // seconda di quante volte la si interrogava. vitest.config.ts la calcola
    // una volta per run, ma due run devono coprire esattamente la suite.
    expect(listDatasetDependentTests()).toEqual(dependent);
    expect(listDatasetIndependentTests()).toEqual(independent);
  });
});
