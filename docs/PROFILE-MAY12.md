# Pipeline profile — 2026-05-12

**Run analizzato:** `25737586562` — branch `worktree-pipeline-profile-may12`, dispatch `profile_sequential=true`, build wall **1180s (19m40s)**.

**Baseline parallel (run `25733510850`, main):** build wall **1631s (27m11s)**.

**Headline:** la modalità **sequenziale è 451s (~7.5 min) più veloce** della parallela, perché elimina la contention sull'event-loop di Node.

---

## 1. Plugin più costosi (sequenziale — wall vs CPU)

| # | Plugin | wall (s) | cpu (s) | cpu/wall | Note |
|---|---|---:|---:|---:|---|
| 1 | jobs-seo-pages | 357 | 670 | 1.87 | Heavy async fan-out (Promise.all su writes) |
| 2 | related-search-clusters | 219 | 327 | 1.49 | render+emit dominante (167s) |
| 3 | post-walk-coordinator | 82 | 166 | 2.02 | 549k file scan, 4 worker |
| 4 | **job-og-images** | **61** | 231 | 3.80 | 4 worker thread, 96% efficienza |
| 5 | border-wait-pages | 41 | 4.7 | 0.12 | Quasi tutto I/O wait |
| 6 | og-pages | 28 | 45 | 1.61 | |
| 7 | static-pages | 10 | 13 | 1.27 | |
| 8 | legacy-redirects | 5.2 | 4.8 | 0.92 | |
| 9 | orphan-query-landings | 5.1 | 5.6 | 1.09 | |
| 10 | job-sector-pages | 3.7 | 3.8 | 1.03 | |

Totale tutti gli altri 40 plugin: **<5s/plugin**, somma ~30s.

---

## 2. Confronto parallel vs sequential (stesso codice, stesso ref+1)

| Plugin | PARALLEL wall (run 25733510850) | SEQ wall (run 25737586562) | Δ |
|---|---:|---:|---:|
| jobs-seo-pages | 857s | 357s | **–500s** |
| related-search-clusters | 837s | 219s | **–618s** |
| job-og-images | **903s** | **61s** | **–842s** (15× più lento in parallel!) |
| og-pages | 472s | 28s | –444s |
| border-wait-pages | 449s | 41s | –408s |
| static-pages | 434s | 10s | –424s |
| salary-hub-seo | 425s | 1.5s | –424s |
| comparisons-hub | 350s | 1.0s | –349s |
| fuel-daily-pages | 383s | 2.6s | –380s |
| (12+ landings al "cluster 350s") | 350±1s | 0.5–2s | tutto wait |

**Hypothesis confirmed:** il "cluster di 12+ plugin a 350s ±1s" non fa lavoro reale — è event-loop starvation. La maggior parte di quei plugin esegue <2s di lavoro effettivo ma viene messa in coda dietro CPU-bound long-runner (jobs-seo, cluster, og-images) finché l'event loop non si libera.

---

## 3. job-og-images deep dive

```
[og-phase] pass1 (cache scan + queue)  1.26s
                                       — queued=1364 cached=1705 skipped=0
[og-phase] pass2 progress 606/1364 (44%) — elapsed=30.1s avg=50ms/render
[og-phase] pass2 progress 1364/1364 (100%) — elapsed=59.0s avg=43ms/render
[og-phase] pass2 summary 59.0s wall — 1364 renders,
                                       satori=20s resvg=206s (satori share=9%)
                                       p50=156ms p90=191ms p99=385ms max=607ms
                                       worker-eff=96%
```

- **resvg-js domina 91% del costo** (PNG raster), satori solo 9% (SVG layout).
- p99=385ms, max=607ms → distribuzione tight, **nessun outlier** che blocca i worker.
- Worker efficienza **96%** (idealWall = 226 CPU-s / 4 worker = 56.5s vs 59s reali).
- Cache hit rate **1705/3069 = 56%** — c'è margine se possiamo aumentare la stabilità degli slug.

**Implicazione:** in sequenziale, og-images è **già ottimizzato** (61s wall). Il problema è che in parallel **degrada 15×**.

---

## 4. jobs-seo-pages tail

```
[js-tail] resolveFlushed  +0.00s
[js-tail] printProfile    +0.00s
[js-tail] sitemapPatch    +0.00s  (total tail 0.00s after Flushed log)
```

**Il "silent tail" di 336s osservato in run 25717295593 (e ridotto a 130s in 25682002264, 38s in 25733510850) è zero in sequenziale.** Anche quello era un artefatto del parallel-closeBundle.

---

## 5. related-search-clusters phase split

```
[cluster-phase] render+emit done at +166.8s  ← dominante
[cluster-phase] collector.flush 44.7s (163074 files)
[cluster-tail]  barrier=0.0s dropOverwritten=7.5s (81537 locs)
[cluster-phase] writeSitemap total 7.6s
```

- **render+emit (167s)** è il vero collo. 81k cluster page + 4 hub + 163k file totali.
- `dropOverwrittenLocs` ridotto a **7.5s** (era >1000s prima della fix inverted-index del 2026-05-10).
- Barrier wait su `jobsSeoPagesFlushed`: **0s** in sequenziale (perché producer completa prima del consumer).

---

## 6. Raccomandazione principale

**Switchare la deploy di produzione da parallel a SEQUENTIAL_PROFILE=1.**

### Change

```yaml
# .github/workflows/deploy.yml, build step env, line ~387
- SEQUENTIAL_PROFILE: ${{ github.event.inputs.profile_sequential == 'true' && github.event.inputs.parallel_plugins != 'true' && '1' || '' }}
+ # Sequential closeBundle è 7.5 min più veloce della parallel: la
+ # contention sull'event-loop di Node degrada job-og-images 15× e
+ # crea un cluster di ~12 plugin che attendono inutilmente a 350s.
+ # Misurato 2026-05-12: parallel 1631s, sequential 1180s.
+ SEQUENTIAL_PROFILE: ${{ github.event.inputs.parallel_plugins == 'true' && '' || '1' }}
```

### Benefici attesi

- **–7.5 min per deploy** (1631s → 1180s, –28% wall).
- **–~15-20 deploy/giorno × 7.5 min = ~2h/giorno di wall time risparmiati.**
- Migliore stabilità memoria (un plugin CPU-intensive alla volta, no fan-out parallelo).
- Profile timings (`[profile] wall_s`) diventano misure veritiere senza bisogno di flag separati.

### Rischi

- **Basso**. Il codice già supporta sequenziale (è esattamente la modalità `SEQUENTIAL_PROFILE=1` esistente).
- I 4 signal in `buildSignals.ts` (`jobsSeoPagesFlushed`, `staticPagesFlushed`, ...) restano corretti — anzi più ovvi in sequenziale (producer completa sempre prima del consumer).
- Mantieni `parallel_plugins=true` come dispatch input per A/B testing futuro.

### Test

1. Una run live su main con la flag attiva (deploy ordinario, no profile-only).
2. Verifica wall time, deploy success, `validate-dist` e `validate-live` puliti.
3. Se ok, deploy come da workflow.

---

## 7. Win secondari (dopo aver lockato il sequential switch)

Ordine d'attacco basato su wall in sequenziale:

| Target | wall | Lever |
|---|---:|---|
| jobs-seo-pages | 357s | Sub-instrumentare per categoria (`jobs_seo_profile=true` dispatch input esiste già) per capire quale fase domina i 670 cpu-s |
| related-search-clusters render | 167s | Bottleneck è candidates+match+render dei 81k cluster — profilare singole fasi |
| post-walk-coordinator | 82s | Già a 4 worker; raddoppiare a 8 può aiutare se runner ha >4 core (verifica `availableParallelism`) |
| job-og-images resvg | 206s cpu | resvg-js è 91% del costo. Provare `@resvg/resvg-wasm` con SIMD o sostituire con sharp+satori-html |
| og-images cache hit | 56% | Investigare perché 44% miss (probabilmente slug churn dei job nuovi). Hash cache su title+company invece di slug può portare hit a 90%+ |

---

## 8. Cleanup

Tutta l'instrumentazione di questo branch è additiva (logs only) ed è da rimuovere dopo aver decifrato la rotta. Il commit `5780ffe48b` (og-phase + [profile-detail] always-on) ha valore residuo: la versione always-on di `[profile-detail]` è utile in produzione anche dopo. Considerare di tenere quella parte e revertire solo le `[og-phase]`, `[js-tail]`, `[cluster-phase]`, `[cluster-tail]`, e i `time`/`--totals` del tar step.

---

## 9. Validazione in produzione (2026-05-12, post-merge PR #134)

Il flip a `SEQUENTIAL_PROFILE=1` come default è stato mergiato su main col commit `d26e4c809b`. Prima run di produzione su main col nuovo default: `25739076601`.

| Metrica | Parallel baseline (25733510850) | Sequential profile-only (25737586562) | **Sequential prod (25739076601)** |
|---|---:|---:|---:|
| Build job wall | 1631s (27m11s) | 1180s (19m40s) | **1394s (23m14s)** |
| closeBundle phase total | ~1100s | 794s | **794s** |
| jobs-seo-pages | 857s | 357s | 340s |
| related-search-clusters | 837s | 219s | 237s |
| job-og-images | 903s | 61s | 60s |
| og-pages | 472s | 28s | 27s |
| static-pages | 434s | 9.9s | 9.3s |

**Δ produzione vs baseline parallel:** **-237s = -14.5%** sul build job complessivo, **-306s = -28%** sulla fase closeBundle isolata.

La distanza tra profile-only (1180s) e prod (1394s) è attribuibile a:
- **+195s** `assemble-jobs` cache MISS (questa run, sfortunata — le prossime con cache HIT recupereranno ~180s)
- **+105s** tar pack (saltato in `profile_sequential=true`)
- **+~30s** altri post-build steps (capture-sitemaps, upload-pages-artifact prep)

A regime, con cache HIT su assemble-jobs, stima **~20-21 min wall** = **-6/7 min vs baseline parallel 27m11s**.

Il `[profile-detail]` always-on (commit `5780ffe48b` sul branch profile) NON è ancora su main — può essere portato come follow-up se si vuole monitoraggio continuo della distribuzione cpu/wall.
