## Implementato

- `scripts/ci/check-typecheck-baseline.mjs` non esce più 2 su un worktree sparse: il probe `isWorktreeIncomplete()` non è più un abort, accende una **misura degradata e dichiarata**. Il gate gira, stampa il conteggio per file e chiude con exit 0/1 confrontabile con `data/typecheck-baseline.json` — la METRICA della scheda (`prima=exit 2, 0 file misurati` → `exit 0/1 con il conteggio errori per-file`).
- Nuovo `scripts/ci/lib/typecheck-sparse.mjs` (funzioni pure, testabili) che classifica gli errori di `tsc` in tre bucket:
  - **environment**: `TS2307` il cui specificatore risolve a un path che git TRACCIA ma che il worktree non ha materializzato → escluso dalla misura, contato e stampato a parte.
  - **downstream**: gli errori sulla **STESSA RIGA** di un `TS2307` d'ambiente (es. il `TS2322` di `services/seo/articleAuthorUrl.ts:72`, dove `await import('@/data/blog-articles-data')` non risolve) → esclusi e stampati a parte.
  - **measured**: tutto il resto, compresi i `TS2307` **strutturali** verso moduli che non esistono in nessun checkout (i 20 già registrati in baseline).
- Risolti anche gli specificatori con **alias** di `tsconfig.json` (`@/*`): senza, metà degli import dei moduli dati restava non riconosciuta. MISURATO simulando lo sparse: 9 falsi rossi in 4 componenti prima, 0 dopo.
- Il declassamento è **per riga, non per file**: la prima versione declassava tutti gli errori dei file con un import rotto e si mangiava una regressione vera (`const x: number = 'stringa'` piantato a `services/router.ts:4056` → exit 0). Con la regola sulla riga, la stessa prova esce **exit 1** nominando file e riga.
- In sparse il ratchet sui **cali** tace: zero errori su un file che `tsc` non ha letto non è un miglioramento. I file di baseline non materializzati sono elencati come «non misurati» (`unmeasurableBaselineFiles`).
- **Il gate di merge non si abbassa**: sotto `GITHUB_ACTIONS` un probe sparse torna a essere **exit 2**. Il job `vitest (unit + integration)` gira su un checkout sparse anche in CI, ma coi target dei symlink materializzati file per file nel profilo di `tests.yml`; se quel profilo perdesse un carve-out, senza questo guard il check che governa l'auto-merge scivolerebbe in silenzio nella misura degradata (non-negotiable #1).
- `--write-baseline` resta **vietato** in sparse (exit 2, #6061 item 2), e il messaggio residuo dichiara **come si verifica che il blocco valga ancora** (`git config core.sparseCheckout`, `ls -l data/blog-articles-data.ts`) — VISION.md: un `blocked:` non scade da solo.
- La baseline si legge in modo **sparse-immune** riusando `readSiteText` di `corpus-ahead-check.mjs` (disco, altrimenti oggetto git): vive sotto `data/`, cioè esattamente ciò che un worktree sparse non materializza — leggerla solo dal disco sarebbe un exit 2 sul file che serve a evitarlo.
- `tests/typecheck-gate-sparse.test.ts` (12 casi): l'OSSERVATORE chiesto dalla scheda — classificazione, alias, regola della riga (col caso della regressione vera che deve restare contata), file non misurabili, symlink che non risolve, e i tre contratti sul sorgente del gate (niente più abort sul probe, `--write-baseline` vietato coi comandi di verifica, abort in CI).

**Verifica end-to-end eseguita a mano** (sparse simulato spostando fuori `packages/articles/content` e `data/typecheck-baseline.json`):

| scenario | prima | dopo |
|---|---|---|
| checkout pieno | exit 0 | exit 0, output invariato |
| sparse, nessuna regressione | **exit 2, 0 file misurati** | **exit 0**, 7 bloccanti misurati, 75 TS2307 d'ambiente + 1 downstream dichiarati |
| sparse, regressione piantata a `services/router.ts:4056` | exit 2 | **exit 1**, `services/router.ts: 0 → 1` con codice e messaggio |
| sparse, `--write-baseline` | exit 2 | exit 2 (voluto), col comando di riverifica |
| sparse sotto `GITHUB_ACTIONS=true` | exit 2 | exit 2 (voluto), prima di `tsc` |

`npx vitest run tests/typecheck-gate-sparse.test.ts tests/typecheck-gate-wired.test.ts` verde. `tests/checkout-sparse-profiles.test.ts` è rosso su questo branch **e su main senza il diff** (2 casi, `border-live-data-watchdog.yml`): rosso ereditato, non di questa PR.

Closes #7677

## Non implementato (ancora)

- Materializzazione mirata (`git sparse-checkout add packages/articles/content data`), strada (a) della scheda — **per scelta**: scaricherebbe il corpus articoli (~31k file, GB) nel worktree di chi lancia un gate, cioè disferebbe la ragione per cui il profilo sparse esiste (CLAUDE.md, `docs/REPO-WEIGHT-STRATEGY.md`); per un comando di verifica non è un prezzo accettabile. La strada scelta misura senza toccare il checkout.
- Stub tipizzati + `tsconfig.sparse.json`, strada (b) della scheda — **per scelta**: un secondo tsconfig è una seconda verità sui tipi da tenere allineata a mano, e gli stub `declare const …: Article[]` mentirebbero proprio sui moduli dati. La classificazione a valle di `tsc` ottiene lo stesso risultato senza duplicare la configurazione.
- Errori a valle di un modulo assente su righe DIVERSE dall'import (es. un `TS2339` su un tipo diventato `any` 200 righe più in là) restano contati e possono dare un rosso d'ambiente residuo in sparse — **per scelta**: provare quel nesso richiede il type-graph, e la regola larga (per file) è stata MISURATA mentre si mangiava una regressione vera. Fra un falso rosso visibile e un fail-open silenzioso, questo script sceglie il rosso (non-negotiable #1, e la sua stessa testata: «se non si misura, si fallisce»).
- Sibling surfacati da `check-sibling-patterns.mjs` (22), ispezionati uno per uno:
  - scripts/ci/corpus-ahead-check.mjs — falso positivo, per scelta: condivide `readSiteText` perché è il file che lo ESPORTA, ed è già l'idioma sparse-immune che questa PR riusa invece di duplicare.
  - scripts/ci/identical-twin-transport-dryrun.mjs — falso positivo, per scelta: consuma già `readSiteText`; nessun probe di worktree e nessun abort da rendere degradabile.
  - scripts/ci/verify-checkout-profiles.mjs — falso positivo, per scelta: nomina `check-typecheck-baseline`/`typecheck-baseline` solo in un docblock e in `TSC_INVOCATION_PATTERNS`; sui file illeggibili fa già `catch { continue; }`, non si auto-blocca.
  - scripts/ci/check-translation-chain-wired.mjs — falso positivo, per scelta: condivide `BASELINE_PATH` e la riga `JSON.parse(fs.readFileSync(BASELINE_PATH))`, ma la sua baseline sta in `scripts/ci/` (mai esclusa da un profilo sparse) e l'assenza è già gestita con un ritorno vuoto, non con un exit.
  - .github/workflows/tests.yml — falso positivo, per scelta: invoca il gate ma non ne condivide il costrutto; letto per esteso perché è la ragione del guard `GITHUB_ACTIONS`, e i carve-out file-scoped sotto `/packages/articles/content/` ci sono già, quindi in CI la misura resta piena.
  - .github/workflows/corpus-ahead-check.yml — falso positivo, per scelta: agganciato al solo nome `corpus-ahead-check`; nessun typecheck, nessun probe sparse.
  - .github/workflows/pharmacy-data-health-monitor.yml — falso positivo, per scelta: agganciato al solo nome `corpus-ahead-check`; nessun typecheck, nessun probe sparse.
  - scripts/audit-bfs-depth.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/audit-cls-live.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/audit-dist-multi.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/audit-orphan-pages-in-sitemaps.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/audit-parser-quality.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/audit-spa-bundle-injection.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/check-active-jobs-regression.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/check-gsc-frontaliere-baseline.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/ci/check-hardcoded-locale-segments.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/evals/cluster-classifier.eval.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - scripts/generate-crawler-group-workflows.mjs — falso positivo, per scelta: condivide il solo identificatore nudo `BASELINE_PATH`, con una baseline propria in un dominio scorrelato; non esegue `tsc` né si ferma su un probe di worktree.
  - build-plugins/legacyRedirectsPlugin.ts — falso positivo, per scelta: condivide il solo nome di parametro `fromFile`, senza alcun rapporto con la risoluzione dei moduli in sparse.
  - scripts/ci/dataset-dependent-tests.mjs — falso positivo, per scelta: condivide il solo nome di parametro `fromFile`, senza alcun rapporto con la risoluzione dei moduli in sparse.
  - scripts/lib/tschuggen-job-parser.mjs — falso positivo, per scelta: `parseTsc` è una collisione lessicale con un parser di annunci di lavoro: semantica diversa, nessun output di `tsc` da classificare.
  - services/seoService.ts — falso positivo, per scelta: agganciato a `articleAuthorUrl`, che qui compare solo come esempio dentro il commento che documenta la regola della riga.
