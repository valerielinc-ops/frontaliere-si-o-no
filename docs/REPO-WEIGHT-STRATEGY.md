# Repo weight: what it costs agent sessions, and what to do about it

Misurato il 2026-08-17 su `origin/main`, dopo il recupero dei 39GB di
`tmp_pack_*` (`docs/AGENTS-HISTORY.md#hook-fetch-pileup`). Serve a decidere
sui numeri invece che a sensazione: prima di proporre una potatura della
history, guarda **quale** costo stai pagando davvero.

## Stato misurato

| Metrica | Valore |
| --- | --- |
| Commit su `main` | 93'438 |
| Commit negli ultimi 30 giorni | 38'827 (~1'300/giorno) |
| Commit negli ultimi 7 giorni | 9'571 |
| Blob totali in history (su disco, dopo repack) | 12.44GB |
| `.git` dopo `repack --geometric=2` | 14GB |
| File tracciati | 40'745 |

Peso della history per area (somma delle dimensioni-su-disco di tutti i blob
di ogni path, tutte le revisioni):

| Area | Peso | Note |
| --- | --- | --- |
| `data/` | 8.27GB (66%) | tutto generato da bot |
| `public/images/` | 3.36GB (27%) | 13'497 file binari |
| tutto il resto (codice incluso) | 0.81GB (6.5%) | |

Singoli path più pesanti: `data/jobs/` 3.30GB su 218'510 revisioni,
`data/seo-404-compat/` 3.02GB su 3'373 revisioni (16 shard riscritti
interi a ogni refresh), `data/jobs-ai-cache.json` 381MB su 590 revisioni,
`data/jobs-stats-history.json` 257MB su 161 revisioni.

**Il 93.5% del peso è output di macchina, non codice.** E il 42% dei commit
di tutta la storia del repo è stato creato negli ultimi 30 giorni: i
generatori dominanti sono `🗺️ Sync article sitemaps…` (721/mese),
`🧑‍💼 Publisher jobs sync` (514/mese), `chore(thin-promotions)` (368/mese),
`chore(border-wait): live snapshot` (262/mese), più ~61 commit separati per
ciclo dei crawler per-datore.

## Cosa paga davvero una sessione agent

Tre costi distinti, con rimedi diversi. Confonderli porta a proporre una
riscrittura della history per un problema che non è la history.

1. **Fetch — proporzionale all'*arretrato*, non alla dimensione della
   history.** A 1'300 commit/giorno, una settimana di silenzio è un catch-up
   multi-GB (24'309 commit arretrati = fetch da 8.1GB, ~20 minuti). Fetch
   quotidiano = pochi MB. → risolto dalla prefetch oraria di
   `git maintenance`; una history più corta non aiuterebbe.
2. **Checkout — 6.4GB per worktree.** `public/images` + `packages/articles`
   sono 31'144 dei 40'745 file. Quattro agent in parallelo = 25GB di
   checkout duplicato. → risolto dallo sparse checkout in cone mode
   (695MB, 7s: `docs/LOCAL-DEV.md#sparse-worktrees-for-agent--multiagent-sessions`).
   Anche questo indipendente dal peso della history.
3. **Push — sensibile alla salute dei pack, non al numero di commit.** Un
   push che spedisce centinaia di MB per un diff minimo è un repo non
   manutenuto (pack disgiunti, `garbage`, midx assente) o un clone shallow.
   → runbook in `docs/LOCAL-DEV.md`; `git maintenance` registrato lo tiene a
   bada.

Corollario: **per il lavoro agent la dimensione della history non è il
collo di bottiglia.** Le tre leve sopra sono già applicate e costano zero
rischio. Quel che resta è il *tasso di crescita*.

## Leve già attive (2026-08-17)

- Fetch dell'hook single-flight + timeout + sweep dei `tmp_pack_*`
  (`scripts/lib/single-flight-lock.mjs`, `scripts/lib/stale-fetch-pack-sweep.mjs`).
- `git maintenance start` realmente registrato (prefetch oraria, commit-graph,
  incremental-repack geometrico, pack-refs).
- `feature.manyFiles`, `core.untrackedCache`, `core.fsmonitor` → `git status`
  su 40'745 file in ~1.4s.
- `push.negotiate=true` → negoziazione più stretta, pack di push più piccoli.
- Ricetta sparse worktree documentata per le sessioni multiagent.

## Leve sul tasso di crescita (richiedono decisione owner)

Non applicate: cambiano il comportamento di pipeline di produzione, quindi
vanno scelte, non dedotte. Ordinate per rapporto beneficio/rischio.

1. **Batch dei commit bot.** ~61 commit `Auto-update <datore>` per ciclo →
   1 commit per ciclo; `Sync article sitemaps` 721/mese → oraria. Nessun
   dato in meno, molti meno commit: riduce direttamente il catch-up dei
   fetch e il rumore in `git log`. Rischio: un revert diventa più grosso
   (non più per-datore).
2. **Snapshot vivi fuori da git.** `chore(border-wait): live snapshot`
   (262/mese) e `🌦️ Refresh weather snapshot` (179/mese) sono stato
   effimero, non sorgente: appartengono a R2/KV, non alla history. Rischio:
   il build deve leggerli a runtime invece che dal filesystem.
3. **Cache derivate fuori da git.** `data/jobs-ai-cache.json` (381MB di
   history) e `data/translation-cache/` sono cache ricostruibili → cache di
   Actions o object storage. Rischio: cache miss al primo run dopo
   l'invalidazione.
4. **Partizionare i file append-only.** `data/jobs-stats-history.json`
   (257MB su 161 revisioni) e i 16 shard di `data/seo-404-compat/` vengono
   **riscritti interi** a ogni refresh: un file mensile/partizionato
   trasforma la riscrittura in un append. Beneficio strutturale, rischio
   basso, ma tocca i reader.
5. **Immagini su CDN.** `public/images/` è 4.0GB di checkout e 3.36GB di
   history; le OG rigenerate sono il grosso. Rischio più alto: tocca il
   funnel di rendering, e un `cdn-assets` branch è già stato provato e
   ritirato — da riesumare solo con un piano.

## Cosa NON fare

- **Riscrivere la history (`git filter-repo`) per potare i blob generati.**
  Taglierebbe ~7GB, ma riscrive ogni SHA: invalida le PR aperte, i pin dei
  commit (`scripts/lib/articles-sync-pin.mjs`,
  `scripts/build-prev-slug-restore-denylist.mjs` puntano a commit fissi), i
  riferimenti nelle issue e ogni clone esistente. Con le tre leve di sopra
  attive, il beneficio per l'agent è ~zero: **non vale il rischio**.
- **Cloni shallow o blobless per gli agent.** `--depth` rompe il push su
  questo repo (`docs/AGENTS-HISTORY.md#shallow-clone-thin-pack`); un clone
  `--filter=blob:none` ri-scarica i blob pigramente durante `pack-objects` e
  reintroduce lo stesso stallo. Lo sparse checkout dà lo stesso risparmio
  senza toccare la completezza del repo.
- **Lasciare che un hook non presidiato faccia rete senza lock e senza
  timeout.** È la causa dell'incidente da 39GB: non "un'operazione lenta",
  ma un leak di disco silenzioso.
