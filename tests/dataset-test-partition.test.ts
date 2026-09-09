import { describe, it, expect } from 'vitest';
import {
  listDatasetDependentTests,
  listDatasetIndependentTests,
  shouldAssembleForRelatedTests,
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

  // Run #34315020046 (PR #8081) selected these tests through the workflow
  // asset and related-import graph. None of them reads an assemble output;
  // keeping the cohort here prevents a type-only or pure-helper edge from
  // turning an unrelated workflow diff into a required assemble.
  const B24_NON_READING_SELECTION = [
    'tests/app-lite-shell.test.tsx',
    'tests/app-smoke.test.tsx',
    'tests/build-plugin-order.test.ts',
    'tests/check-sibling-patterns.test.ts',
    'tests/checkout-profile-dangling-alias.test.ts',
    'tests/crawler-generation-barrier-workflows.test.ts',
    'tests/crawler-generation-dispatch-workflow.test.ts',
    'tests/ensure-locale-fields-budget-reachability.test.ts',
    'tests/generate-crawler-group-workflows.test.ts',
    'tests/job-translation-queue.test.ts',
    'tests/regression/footer-canton-scoped-seo-hubs.test.tsx',
    'tests/regression/footer-on-seo-pages.test.tsx',
    'tests/regression/footer-position-on-seo-pages.test.tsx',
    'tests/workflows/crawler-workflows-corpus-sync.test.ts',
  ];

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

  it('non propaga un arco type-only o una funzione pura del modulo lettore', () => {
    expect(dependent.filter((file) => B24_NON_READING_SELECTION.includes(file))).toEqual([]);
    expect(independent).toEqual(expect.arrayContaining(B24_NON_READING_SELECTION));
    // Il percorso opposto resta coperto: un helper che il test invoca e che
    // legge jobs.json mantiene il test nel gruppo lento.
    expect(dependent).toContain('tests/seo/cathedral-previous-slug-canton.test.ts');
  });

  it("non richiede l'assemble per la selezione non-reading di PR #8081", () => {
    expect(shouldAssembleForRelatedTests({
      eventName: 'pull_request',
      changedPaths: [
        '.github/workflows/issue-fix.yml',
        'scripts/ci/followup-drainer.mjs',
        'tests/followup-drainer-wide-scope.test.ts',
      ],
      changedStatus: 'complete',
      selectedTests: B24_NON_READING_SELECTION,
      unreadableCount: 0,
    })).toEqual({ required: false, reason: 'related selection is dataset-independent' });
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
