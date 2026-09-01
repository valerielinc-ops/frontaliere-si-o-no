/**
 * L'OSSERVATORE del divieto «un test del job bloccante non legge dati vivi».
 *
 * Cosa e' successo il 2026-08-21. La stessa revisione di
 * `tests/pre-flight-headline-check.test.ts` era verde alle 15:47 e rossa alle
 * 18:38, senza che una riga di codice fosse cambiata: nel mezzo la pipeline
 * aveva pubblicato un articolo il cui titolo collideva con una delle headline
 * «unrelated» hardcoded nel test, che leggeva il registro VIVO
 * (`services/locales/blog-meta-it.ts`, 3'457 titoli in crescita quotidiana).
 *
 * Il costo non e' stato quel test. `vitest` e' il gate su cui `pr-review-loop`
 * si innesca, quindi quel rosso ha fermato cinque PR non correlate insieme.
 *
 * Il guard non vieta in blocco — ventina di test leggono dati vivi e per alcuni
 * il corpus E' il soggetto, dove un rosso da dato e' il segnale voluto. Congela
 * l'esistente e impedisce che cresca: un test NUOVO non puo' entrare
 * nell'inventario senza che qualcuno lo scriva a mano e lo giustifichi.
 */
import { describe, expect, it } from 'vitest';
import {
  scanLiveDataTests,
  diffAgainstInventory,
  stripComments,
  segmentSequenceRegex,
  KNOWN_LIVE_DATA_TESTS,
  LIVE_DATA_SCAN_EXEMPTIONS,
  LIVE_DATA_ROOTS,
  listLiveDataTestsForCi,
} from '../scripts/ci/live-data-test-guard.mjs';

describe('nessun test NUOVO puo` leggere dati vivi', () => {
  it('non ci sono test fuori inventario che leggono radici dati vive', () => {
    const { added } = diffAgainstInventory();
    const detail = added.map((a) => `${a.file} → ${a.roots.join(', ')}`).join('\n  ');
    expect(
      added,
      added.length
        ? `\nQuesti test leggono dati che la pipeline riscrive da sola:\n  ${detail}\n\n`
          + 'Un test che legge dati vivi non e\' riproducibile: passa e fallisce sullo\n'
          + 'stesso codice a seconda di cosa e\' stato pubblicato. E `vitest` e\' il gate\n'
          + 'su cui si innesca la review, quindi il suo rosso ferma anche le PR altrui.\n\n'
          + 'Rimedio: pinna il dato in `tests/__fixtures__/` e leggi da li\'.\n'
          + 'Se invece il corpus E\' davvero il soggetto del test, aggiungi la voce a\n'
          + 'KNOWN_LIVE_DATA_TESTS in scripts/ci/live-data-test-guard.mjs spiegando perche\'.'
        : '',
    ).toEqual([]);
  });

  it('l`inventario non nomina test spariti o gia` riparati', () => {
    // Una voce fantasma e' peggio di nessuna voce: sembra debito tracciato e
    // non lo e', e maschera il fatto che il guard non copre piu' niente li'.
    const { removed } = diffAgainstInventory();
    expect(removed, `voci da rimuovere dall'inventario: ${removed.join(', ')}`).toEqual([]);
  });

  it('il test che ha causato il difetto e` fuori dall`inventario', () => {
    // Regressione diretta: `pre-flight-headline-check` e' stato pinnato a una
    // fixture. Se qualcuno lo ripuntasse al corpus vivo, questo torna rosso.
    const files = scanLiveDataTests().map((e) => e.file);
    expect(files).not.toContain('tests/pre-flight-headline-check.test.ts');
    expect(KNOWN_LIVE_DATA_TESTS.map((e) => e.file)).not.toContain('tests/pre-flight-headline-check.test.ts');
  });
});

describe('il rilevatore', () => {
  it('non si autoaccusa per un percorso citato in un commento', () => {
    // Il primo giro segnalava il test appena riparato, perche' il commento che
    // SPIEGA il difetto cita il percorso vivo fra backtick.
    expect(stripComments("const a = 1; // legge 'services/locales/x'")).not.toContain('services/locales/');
    expect(stripComments('/* `packages/articles/content/y` */ const b = 2;')).not.toContain('packages/articles/content/');
    // Il codice vero sopravvive.
    expect(stripComments("read('services/locales/z')")).toContain('services/locales/');
  });

  it('vede un percorso costruito a segmenti, non solo il letterale con slash', () => {
    // Gemello speculare del difetto dei commenti: li' testo che non e' lettura,
    // qui lettura che non e' testo. `resolve(ROOT, 'packages', 'articles')` non
    // contiene mai la stringa `packages/articles/`, e senza questo il guard e'
    // aggirabile per caso — basta scrivere il percorso in due pezzi. Il repo ne
    // aveva gia' uno che girava nel job bloccante (news-ticker-data).
    const rx = segmentSequenceRegex(['packages', 'articles']);
    expect(rx.test("np.resolve(ROOT, 'packages', 'articles')")).toBe(true);
    expect(rx.test('path.join(ROOT, "packages" , "articles")')).toBe(true);
    // Segmenti non adiacenti non sono quel percorso.
    expect(rx.test("resolve(ROOT, 'packages', 'other', 'articles')")).toBe(false);
  });

  it('non confonde un URL con un commento di riga', () => {
    expect(stripComments("const u = 'https://example.ch/x';")).toContain('https://example.ch/x');
  });

  it('copre le radici che la pipeline riscrive, non le baseline pinnate', () => {
    expect(LIVE_DATA_ROOTS).toContain('services/locales/');
    expect(LIVE_DATA_ROOTS).toContain('data/jobs.json');
    expect(LIVE_DATA_ROOTS).toContain('data/prospector/');
    // Una baseline cambia solo quando qualcuno decide di cambiarla: e' dato
    // pinnato, e vietarlo renderebbe il guard rumoroso e quindi ignorato.
    expect(LIVE_DATA_ROOTS.some((r) => r.includes('baseline'))).toBe(false);
  });

  it('mantiene il test meta e rimuove i gate di qualita live dalla PR', () => {
    expect(listLiveDataTestsForCi()).not.toContain('tests/corpus-wide-test-partition.test.ts');
    expect(listLiveDataTestsForCi()).toContain('tests/evergreen-pool-consumption.test.ts');
    expect(listLiveDataTestsForCi()).toContain('tests/article-body-wordcount.test.ts');
    expect(listLiveDataTestsForCi()).toContain('tests/job-locale-consistency.test.ts');
    expect(listLiveDataTestsForCi(), 'la suite Gardenia deterministica deve restare nel gate PR')
      .not.toContain('tests/albergo-gardenia-crawler.test.ts');
    expect(listLiveDataTestsForCi()).toContain('tests/albergo-gardenia-live-regression.test.ts');
    expect(listLiveDataTestsForCi(), 'la fixture causale iPersonal deve restare nel gate PR')
      .not.toContain('tests/ipersonal-route-recovery-7045.test.ts');
    expect(listLiveDataTestsForCi()).toContain('tests/ipersonal-route-recovery-7045-live.test.ts');
    for (const { file } of LIVE_DATA_SCAN_EXEMPTIONS) {
      expect(listLiveDataTestsForCi(), `${file} deve restare nel gate PR`).not.toContain(file);
    }
  });
});
