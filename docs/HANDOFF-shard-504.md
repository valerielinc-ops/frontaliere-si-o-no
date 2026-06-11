# Handoff: Cloudflare Worker shard 504s

> Brief tecnico self-contained per chi riprende il caso dei `504` sulle pagine
> locale-shard (`/en /de /fr`). Aggiornato 2026-06-11.

## 1. Architettura (contesto)

Sito SEO `frontaliereticino.ch` (React SPA + SSG, ~1.3M pagine prerenderizzate).
Troppo grande per un repo GitHub Pages (cap 10 GB) → **locale sharding**:

- **IT** (locale primario, ~95% pubblico umano): repo principale, **passthrough
  puro** Cloudflare (no Worker).
- **`/en` `/de` `/fr`**: repo separati (`frontaliere-en/de/fr`), serviti da
  sotto-domini gray-cloud `origin-{loc}.frontaliereticino.ch` (GitHub Pages),
  fronteggiati da un **Cloudflare Worker** `infra/cloudflare-worker/locale-router.js`
  che riscrive l'`Host` mantenendo l'URL pubblico identico.
- Worker routes (`infra/cloudflare-worker/wrangler.toml`): **solo** `/en* /de* /fr*`.
  Deploy via `.github/workflows/deploy-worker.yml` (auto su push a
  `infra/cloudflare-worker/**`); credenziali `CF_API_TOKEN`+`CF_ACCOUNT_ID` da
  Firebase Remote Config (`scripts/load-rc-env.mjs`).

## 2. Il problema

**~26% delle richieste apex sono `504`** (concentrate sui cache-MISS delle pagine
shard), `cache=miss originResponseStatus=0` = **l'origin GitHub Pages non
risponde** sotto il fan-out aggregato di cache-miss. Baseline storica ~104k
504/giorno.

## 3. Cosa è stato implementato (tutto MERGED, 2026-06-10/11)

| PR | Cosa | Esito |
|---|---|---|
| **#1791** | 1° fix 504: timeout 12s + 1 retry + last-known-good (LKG) stale-while-error | merged — **ha introdotto una regressione** |
| **#1814** | 🚨 hotfix: la `resp.clone()` di #1791 creava un **triple-tee** → deadlock backpressure → **stallo 30s su TUTTE le pagine shard** + edge-cache morta. Fix **buffer-once** (`await resp.arrayBuffer()`, poi 3 Response indipendenti) | merged, stallo risolto (curl 0.3s) |
| **#1830** | LKG key **on-zone** (`https://frontaliereticino.ch/__lkg/<enc>` invece di `lkg.invalid` che la Cache API CF no-oppava) + **timeout 12s→6s** | merged, deployato |
| **#1812** | `[observability]` in `wrangler.toml` → Workers Logs (free) | merged |
| **#1820** | `deploy-worker.yml`: check live **timing+origin** post-deploy con **auto-rollback** (becca regressioni-stallo che lo status-check non vedeva) | merged |
| #1795 (altro agent) | timeout+retry anche sul passthrough IT | merged |
| #1798 | apple-touch-icon ai path root (404→200) | merged, **live 200** |
| #1803 | CF edge analytics come sorgente 404 per il reconciler (`scripts/discover-404s-via-cloudflare.mjs` + lib `scripts/lib/cf-analytics.mjs` + workflow) | merged |
| #1810 | CSS entry stabile `assets/index.css` (no più hash → no 404 su hash ruotato) | merged |

**Stato Worker deployato ora:** buffer-once + LKG on-zone `/__lkg/` + timeout 6s +
observability. Verificabile: `GET /accounts/{acct}/workers/scripts/frontaliere-locale-router`.

## 4. Risultato: i 3 fix Worker NON hanno mosso il 504-rate

Misure CF GraphQL (`httpRequestsAdaptiveGroups`) **post-#1830**: apex 504 ancora
**25.8%** (era 24.5-27.5%). **ZERO `503`** nelle analytics.

**Diagnosi del perché (chiave):**

- Zero 503 = **Cloudflare genera il 504 PRIMA che il codice Worker ritorni** il suo
  fallback graceful. Quando il `fetch()` del Worker verso l'origin gray-cloud
  hanga/fallisce, **CF ritorna una Response 504 sintetica al `fetch()` (non un
  throw)**; il codice, con LKG assente, la rilancia tale e quale. Timeout / retry
  / LKG / 503 non intercettano questi casi.
- **L'LKG via `caches.default` è per-colo ed effimero** → non condivide tra
  data-center → non copre i fallimenti cross-colo → non maschera i 504.

## 5. Analisi human-vs-bot (completata)

- **UA non classificabile sui 504**: artefatto CF — i 504 hanno **100%
  User-Agent vuoto**, mentre 404/301 (stesso traffico reale) hanno **0%** vuoto.
  CF non logga l'UA sulle risposte 504.
- **Proxy via paese (`clientCountryName`, popolato):** traffico shard sia 200 che
  504 = **~80-86% USA**. Per un sito frontalieri-Ticino, l'80% USA = **traffico
  automatico**: Googlebot crawla dagli USA (confermato dal campione 200-miss pieno
  di `Googlebot smartphone Nexus 5X`) + Ahrefs/Yandex/Semrush + datacenter.
  Pubblico umano europeo sullo shard **~3-5%**; gli utenti reali frontalieri usano
  le pagine **IT**.

**Verdetto:**

- **Impatto UX umano: trascurabile** — lo shard /en /de /fr è una superficie SEO,
  non dove stanno gli utenti veri.
- **Impatto SEO: REALE** — **Googlebot crawla lo shard al ~26% di 504** →
  crawl-error sui locale multilingua → spreco crawl-budget + rischio
  de-indicizzazione (che è lo scopo stesso dello shard).

## 6. Fix raccomandato (NON ancora implementato) — Opzione A

**Usare la cache tiered nativa di Cloudflare** sul fetch origin invece del
`caches.default` per-colo:

```js
const resp = await fetch(new Request(upstream, request), {
  signal,                                          // mantieni l'AbortController 6s
  cf: { cacheEverything: true, cacheTtl: 7200 },   // 2h, come l'attuale s-maxage
});
```

**Perché funziona dove gli altri no:** `cf:{cacheEverything}` mette la risposta
origin nella **cache tiered persistente e cross-colo** di CF (non il
`caches.default` per-colo). Un miss in un colo popola la cache condivisa → tutti i
colo successivi fanno HIT → **l'origin riceve pochissimi fetch** → meno overwhelm
→ i 504 crollano → Googlebot crawla pulito.

**Caveat da verificare:**

- Confermare che `cf:{cacheEverything}` rispetti la riscrittura Host gray-cloud
  (`upstream.hostname = origin-{loc}...`) e non cachi in modo errato tra locale
  diversi. La cache key CF deve includere l'**URL pubblico**, non l'host origin
  riscritto → valutare `cf.cacheKey` esplicita sull'URL pubblico.
- Decidere se mantenere il fallback LKG come backup (con buffer-once) o affidarsi
  al serve-stale di CF.
- `deploy-worker.yml` ha già **auto-rollback su stallo** → un deploy che regredisce
  si auto-reverte.

**Verifica post-deploy:** ri-eseguire l'analisi 504-rate (per-pagina + per-paese) e
confermare il crollo, specie sul traffico US/Googlebot.

## 7. Tooling creato

- **`scripts/cf-status-report.mjs`** — report status code CF per-pagina. Es:
  ```bash
  eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json node scripts/load-rc-env.mjs)" \
    && node scripts/cf-status-report.mjs --class=5 --host=frontaliereticino.ch
  ```
- **`scripts/lib/cf-analytics.mjs`** — primitivi CF GraphQL condivisi (`cfGraphQL`,
  `resolveZoneId`, `fetchErrorPaths`, `MAX_HOURS`).
- Zone tag: `435c32ec15993fe826d2bb5eb62d3d43`. Free-plan: max 1 giorno/query,
  retention ~3 giorni.
- Dataset raw `httpRequestsAdaptive`: ha `userAgent`, `verifiedBotCategory`,
  `clientCountryName`, `clientRequestPath` (UA **vuoto sui 504** — artefatto;
  `botScore` enterprise-gated, no accesso).

## 8. Gotchas / lezioni

- **Mai** tee/clone lo stream della Response con più consumer
  `ctx.waitUntil(cache.put)` → deadlock backpressure CF (causa dello stallo 30s).
  Usa **buffer-once** (`arrayBuffer`).
- Worker **non ha test** (`infra/cloudflare-worker/` zero test in `tests/`). Un test
  miniflare/`unstable_dev` (no-stall + 2°-hit-HIT) è **follow-up dichiarato**
  (#1814/#1820) — un unit-test Node non riproduce il deadlock CF-specifico.
- **Autorebase churn**: main si muove veloce → cancella i vitest shard delle PR →
  l'aggregatore segna RED su `'cancelled'` (non un fallimento reale). Per PR
  Worker-only (nessun test le copre) può servire merge manuale
  `gh pr merge --squash --admin --delete-branch`.
- **Token `CF_API_TOKEN`** (Remote Config): Analytics:Read + Workers Scripts:Edit +
  Workers Routes:Edit + Zone Settings:Read. **"Account Analytics" è solo-Read** →
  Web Analytics/RUM si configura **solo da dashboard** (già fatto: RUM "Enable",
  `/cdn-cgi/rum` ritorna 204).
- **Verifica deploy live**: `commit-hash.txt` o ispezione Worker via API.
  `deploy-worker.yml` ridepoloya su ogni push a `infra/cloudflare-worker/**`.

## 9. Decisione aperta

Procedere con **A** (cf-native-cache, giustificato da crawlability SEO/Googlebot)
oppure **B** (accettare i 504 — impatto umano nullo, fermarsi). Raccomandazione
corrente: **A**, perché proteggere la crawlability dei locale è il motivo per cui
lo shard esiste.
