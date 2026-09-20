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
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listCorpusWideTests } from '../scripts/ci/corpus-wide-tests.mjs';
import {
  scanLiveDataTests,
  diffAgainstInventory,
  stripComments,
  segmentSequenceRegex,
  KNOWN_LIVE_DATA_TESTS,
  LIVE_DATA_SCAN_EXEMPTIONS,
  LIVE_DATA_ROOTS,
  listLiveDataTestsForCi,
  listNonLiveDataTestsForCi,
  listLiveDataMonitorTests,
  LIVE_DATA_PARTIAL_TESTS,
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

describe('il censimento 2026-09-19 regge le proprie premesse', () => {
  // Il buco che questo blocco chiude. Fino al 2026-09-19 lo scanner leggeva
  // `readdirSync('tests')` PIATTO: i test sotto `tests/seo/`, `tests/scripts/`,
  // `tests/build-plugins/` non erano nemmeno guardati, e il guard diceva verde
  // perche' non guardava. `tests/scripts/prompt-placeholder-guard.test.ts`
  // scandiva 70.000 campi del corpus pubblicato dentro il job bloccante.
  it('guarda anche dentro le sottocartelle di tests/', () => {
    const roots = new Set([
      ...KNOWN_LIVE_DATA_TESTS.map((e) => e.file),
      ...LIVE_DATA_PARTIAL_TESTS.map((e) => e.file),
      ...LIVE_DATA_SCAN_EXEMPTIONS.map((e) => e.file),
    ]);
    const nested = [...roots].filter((f) => f.split('/').length > 2);
    expect(nested.length, 'il censimento deve contenere file annidati').toBeGreaterThan(5);
  });

  it('la partizione fra gate PR e gruppo dati-vivi e` esatta', () => {
    // Il gate PR esclude per nome file (`VITEST_SKIP_LIVE_DATA=true`), il
    // monitor esegue l'elenco che `--monitor-files` stampa: le due parti sono
    // l'una il complemento dell'altra. Se si sovrapponessero un test girerebbe
    // due volte, se lasciassero un buco non girerebbe MAI — ed e' esattamente
    // il modo in cui un gate sparisce senza che nessuno lo decida.
    const live = listLiveDataMonitorTests();
    const rest = listNonLiveDataTestsForCi();
    expect(live.filter((f) => rest.includes(f)), 'nessun file in entrambi i gruppi').toEqual([]);
    expect(new Set([...live, ...rest]).size).toBe(live.length + rest.length);
    // 120s, non i 15 di default: il complemento si calcola dalla partizione
    // dataset, che fa il parse AST di ~2.400 file di test (11,9s misurati a
    // macchina scarica). Col default questo caso passa in locale e diventa un
    // rosso da CARICO in CI — cioè un falso rosso sul gate, che è esattamente
    // la classe di guasto che questa PR sta togliendo di mezzo.
  }, 120_000);

  it('il monitor non ripesca i gate corpus-wide su main', () => {
    // `corpus-wide-gates.yml` e` `workflow_dispatch` per decisione del
    // proprietario: il corpus appartiene a frontaliere-articles e non deve
    // consumare CI su main di questo repo. Un cron che li riesegue qui sarebbe
    // quella decisione aggirata da un'altra porta.
    const monitor = new Set(listLiveDataMonitorTests());
    for (const file of listCorpusWideTests()) {
      expect(monitor.has(file), `${file} non va nel monitor dei dati vivi`).toBe(false);
    }
  }, 60_000);

  it('il CLI --monitor-files stampa esattamente il gruppo monitor', () => {
    // Il workflow passa questo elenco a `vitest run`. Serve un CLI e non una
    // env letta da `vitest.config.ts`: `run-related-tests.mjs` tratta quella
    // config come globale, quindi una PR che la tocca perde la selezione per
    // diff e ricade sulla suite intera — che a un worker non sta nei 360
    // minuti del job (run 35481674287, cancellata a 6 ore).
    const out = execFileSync(
      process.execPath,
      [path.resolve(__dirname, '..', 'scripts', 'ci', 'live-data-test-guard.mjs'), '--monitor-files'],
      { encoding: 'utf8' },
    );
    expect(out.trim().split('\n')).toEqual(listLiveDataMonitorTests());
  }, 60_000);

  it('i file MISTI girano interi nel monitor, dove la env non li spegne', () => {
    // Nel gate PR i loro casi vivi sono saltati da `SKIP_LIVE_DATA`. Se il
    // monitor non li eseguisse, quei casi non girerebbero da nessuna parte e
    // il taglio per test sarebbe una cancellazione con un altro nome.
    const monitor = new Set(listLiveDataMonitorTests());
    const corpus = new Set(listCorpusWideTests());
    const missing = LIVE_DATA_PARTIAL_TESTS
      .map((e) => e.file)
      .filter((f) => !corpus.has(f) && !monitor.has(f));
    expect(missing, `file MISTI che non girano da nessuna parte: ${missing.join(', ')}`).toEqual([]);
  });

  it('ogni file MISTO usa davvero l`interruttore per-test', () => {
    // Un file nell'elenco parziale e' un file in cui il taglio e' stato fatto
    // DENTRO, per test. Se qualcuno lo elenca qui senza marcare niente, il
    // guard smette di segnalarlo e i suoi test vivi restano nel gate: la voce
    // diventerebbe una deroga silenziosa invece di un taglio.
    const missing = LIVE_DATA_PARTIAL_TESTS.filter(({ file }) => {
      let src = '';
      try { src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'); } catch { return true; }
      return !src.includes('SKIP_LIVE_DATA');
    }).map((e) => e.file);
    expect(missing, `file senza skipIf(SKIP_LIVE_DATA): ${missing.join(', ')}`).toEqual([]);
  });

  it('ogni voce nuova dichiara la prova su cui sta in piedi', () => {
    const measured = KNOWN_LIVE_DATA_TESTS.filter((e) => e.since === '2026-09-19');
    expect(measured.length, 'il censimento non puo` sparire silenziosamente').toBeGreaterThan(30);
    for (const e of measured) {
      expect(['replay', 'review'], `${e.file}: evidence non riconosciuta`).toContain(e.evidence);
      expect(e.roots.length, `${e.file}: senza radici misurate`).toBeGreaterThan(0);
    }
    // 26 file hanno cambiato esito col solo cambio dei dati (snapshot a 7, 14 e
    // 30 giorni, stessa revisione di codice). Di quei 26, undici erano gia'
    // nell'inventario del 2026-08-21: i restanti quindici sono entrati qui, e
    // sono la parte PROVATA del censimento. Non deve diluirsi in una lista di
    // sole valutazioni a vista.
    expect(measured.filter((e) => e.evidence === 'replay').length).toBeGreaterThanOrEqual(15);
  });

  it('i falsi positivi della scansione portano un motivo', () => {
    for (const e of LIVE_DATA_SCAN_EXEMPTIONS) {
      expect(e.reason, `${e.file} senza motivo`).toBeTruthy();
      expect(e.reason.length).toBeGreaterThan(20);
    }
  });
});
