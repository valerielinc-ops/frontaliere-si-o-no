# Caso chiuso: i "504" Cloudflare sulle pagine shard erano un artefatto di analytics

> Post-mortem self-contained del caso `504` sulle pagine locale-shard
> (`/en /de /fr`). Diagnosi definitiva 2026-06-11, basata su query CF GraphQL
> verificabili (riportate sotto). Sostituisce il brief precedente (PR #1839),
> la cui diagnosi era errata.

## 1. Architettura (contesto)

Sito SEO `frontaliereticino.ch` (React SPA + SSG, ~1.3M pagine prerenderizzate).
Troppo grande per un repo GitHub Pages (cap 10 GB) → **locale sharding**:

- **IT** (locale primario, ~95% pubblico umano): repo principale, **passthrough
  puro** Cloudflare (no Worker).
- **`/en` `/de` `/fr`**: repo separati (`frontaliere-en/de/fr`), serviti da
  sotto-domini gray-cloud `origin-{loc}.frontaliereticino.ch` (GitHub Pages),
  fronteggiati dal Worker `infra/cloudflare-worker/locale-router.js` che
  riscrive l'`Host` mantenendo l'URL pubblico identico.
- Worker routes (`infra/cloudflare-worker/wrangler.toml`): **solo** `/en* /de* /fr*`.
  Deploy via `.github/workflows/deploy-worker.yml` (auto su push a
  `infra/cloudflare-worker/**`, con check timing post-deploy + auto-rollback);
  credenziali `CF_API_TOKEN`+`CF_ACCOUNT_ID` da Firebase Remote Config
  (`scripts/load-rc-env.mjs`).

## 2. Il sintomo riportato

Le zone analytics mostravano **~124k risposte 504/giorno (~26% delle richieste
apex)**, `cache=miss originResponseStatus=0`, interpretate come "GitHub Pages
non risponde sotto il fan-out dei cache-miss" con impatto SEO (Googlebot in
crawl-error sui locale).

## 3. La diagnosi vera: nessun 504 reale — righe interne della Cache API

Le righe 504 hanno TUTTE `requestSource: edgeWorkerCacheAPI` (verificato su 24h:
125.040/125.040). **Non sono richieste di client**: sono le operazioni interne
`caches.default` del Worker, loggate da Cloudflare nelle zone analytics:

- `cache.match()` MISS → riga sintetica **504** (~124k/giorno: una per ogni
  invocation cache-miss del Worker — il conteggio combacia con le ~126k
  invocations/giorno meno i ~2k HIT)
- `cache.put()` OK → riga **204** (~78k/giorno, l'altro "mistero" del grafico)
- UA vuoto, protocol `UNK`, `originResponseDurationMs: 0`, country ~USA (metal
  CF, non client) — tutte firme di righe non-eyeball.

**Traffico reale (filtro `requestSource: "eyeball"`), stesse 24h:**

| path | 200 | 404 | 301 | 503 | **504** |
|---|---|---|---|---|---|
| `/en%` | 32.507 | 15.347 | 502 | 7 | **0** |
| `/de%` | 21.957 | 14.747 | 542 | 10 | **0** |
| `/fr%` | 25.568 | 16.605 | 297 | 5 | **0** |

**Zero 504 eyeball. 5xx reali su tutto l'apex: 51×503 + 1×500/giorno (~0,02%).**
Googlebot riceve 200 puliti (5,2k/24h in `userAgentBrowser: GoogleBot`). I fetch
Worker→origin (host `origin-*`, `requestSource: edgeWorkerFetch`) sono sani:
200/404/301 regolari, ~34×503/giorno totali, **~zero retry** (subrequests/giorno
≈ invocations cache-miss ⇒ il primo tentativo riesce quasi sempre). Probe live
(cache-busted, anche con UA Googlebot, da colo ZRH): 45/45 → 200 in ~0,1s.
GitHub Pages risponde 200 in ~0,1s anche in diretta su tutti e 4 gli IP anycast.

**Falsificazioni della vecchia teoria** ("origin overwhelmed dal fan-out"):
il fan-out aggregato è ~1,4 req/s di media — nulla per Fastly/GitHub Pages;
il "504-rate" era piatto 21-32% su tutte le 24h (un overload sarebbe correlato
al volume); e l'unica fonte 504 era `edgeWorkerCacheAPI`, che un fetch origin
non genera.

## 4. Storia degli interventi (che cosa è successo davvero)

| PR | Cosa | Senno di poi |
|---|---|---|
| #1791 | timeout 12s + retry + last-known-good (LKG) stale-while-error | inseguiva il fantasma; introdusse il triple-tee |
| #1814 | 🚨 hotfix: buffer-once al posto del tee → risolto lo stallo 30s | **regressione reale, fix reale** — l'unico danno utente di tutta la vicenda è stato auto-inflitto |
| #1830 | LKG key on-zone + timeout 12s→6s | no-op sul "504-rate" (ovvio col senno di poi: il rate non misurava errori) |
| #1812 | observability Workers Logs | utile |
| #1820 | check timing+origin post-deploy con auto-rollback | utile (safety net per il punto 5) |
| #1803 | CF edge analytics come fonte 404 per il reconciler | utile (i 404 sono eyeball al 99,97%, non inquinati) |

## 5. Risoluzione (2026-06-11)

1. **Worker**: rimossa TUTTA la macchineria `caches.default`/LKG; il fetch
   origin usa la cache nativa CF (`cf: { cacheEverything: true, cacheTtl: 7200 }`,
   tiered/cross-colo). Restano timeout 6s + 1 retry + 503 graceful con
   `Retry-After`. → Le righe fantasma 504/204 cessano alla radice; il grafico
   zone analytics torna a riflettere il traffico reale.
2. **Monitoring**: `scripts/lib/cf-analytics.mjs` (`fetchErrorPaths`) e
   `scripts/cf-status-report.mjs` filtrano di default `requestSource: "eyeball"`
   (`--all-sources` per la vista raw). Nessun agente futuro deve ri-diagnosticare
   questo artefatto.
3. I problemi reali residui sui shard sono i **404 eyeball** (~46k/giorno sui
   tre locale: URL morti crawlerati) — workstream separato già attivo
   (reconciler #1803 + `discover-404s`), NON un problema di disponibilità.

## 6. Tooling

- **`scripts/cf-status-report.mjs`** — report status code per-pagina (eyeball-only
  di default). Es:
  ```bash
  eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs)" \
    && node scripts/cf-status-report.mjs --class=5 --host=frontaliereticino.ch
  ```
- **`scripts/lib/cf-analytics.mjs`** — primitivi CF GraphQL condivisi.
- Zone tag: `435c32ec15993fe826d2bb5eb62d3d43`. Free-plan: max 1 giorno/query,
  retention ~3 giorni; molte dimensioni sono gated (`coloCode`, `clientAsn`,
  `originIP`, `botManagementDecision` → "does not have access to the field"),
  ma `requestSource`, `userAgentBrowser`, `clientRequestHTTPProtocol` e i
  filtri relativi funzionano — e bastavano a chiudere il caso.

## 7. Lezioni

- **Prima di diagnosticare un 5xx da zone analytics, SEMPRE segmentare per
  `requestSource`.** Le operazioni Cache API dei Worker appaiono come righe
  504/204/499 sintetiche (`edgeWorkerCacheAPI`) mischiate al traffico reale.
- Un "error rate" piatto h24, con UA vuoto al 100% e durata origin 0ms, è la
  firma di righe sintetiche, non di un outage.
- **Mai** tee/clone lo stream della Response con più consumer
  `ctx.waitUntil(cache.put)` → deadlock backpressure CF (lo stallo 30s di #1791,
  fixato in #1814 col buffer-once; ora strutturalmente impossibile: un solo
  consumer).
- Worker senza test: un test miniflare/`unstable_dev` resta follow-up dichiarato
  (#1814/#1820); il check timing+auto-rollback di `deploy-worker.yml` è la rete
  di sicurezza operativa.
- Verifica deploy live: `commit-hash.txt` o ispezione Worker via API
  (`GET /accounts/{acct}/workers/scripts/frontaliere-locale-router`).
