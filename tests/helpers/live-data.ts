/**
 * Lo spegnimento PER TEST dei casi che leggono dati vivi.
 *
 * Perche' non basta l'esclusione per FILE. `vitest.config.ts` toglie dal job
 * bloccante delle PR i file dell'inventario (`listLiveDataTestsForCi`), ma in
 * una quarantina di file i test su dati vivi convivono con test deterministici
 * — in `tests/generate-crawler-group-workflows.test.ts` sono una manciata su
 * 87. Buttare il file intero per spegnerli costerebbe la copertura buona
 * insieme a quella fragile.
 *
 * Uso:
 *   import { SKIP_LIVE_DATA } from './helpers/live-data';
 *   it.skipIf(SKIP_LIVE_DATA)('legge il corpus pubblicato', () => { ... });
 *
 * La env la mette solo `tests.yml` sul job bloccante: ogni run locale, e ogni
 * altro workflow, esegue tutto. L'elenco dei file che usano questo interruttore
 * sta in `LIVE_DATA_PARTIAL_TESTS` (scripts/ci/live-data-test-guard.mjs), cosi'
 * il guard sa che li' il debito e' gia' tagliato e non li segnala di nuovo.
 */
export const SKIP_LIVE_DATA = process.env.VITEST_SKIP_LIVE_DATA === 'true';

/** Il complemento, per un test che DEVE girare solo dove il dato vivo c'e'. */
export const ONLY_LIVE_DATA = !SKIP_LIVE_DATA;
