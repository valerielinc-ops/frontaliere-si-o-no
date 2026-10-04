# Triage dei 5xx di zona e dei receiver webhook

Guida per diagnosticare la famiglia `cloudflare-5xx` senza rifare gli errori del 2026-08-05.

## La regola numero uno: non è una famiglia sola

Per settimane i 5xx sono stati letti come un difetto solo — «R2 non risponde e Cloudflare
sintetizza il 502». Misurando la zona con `originResponseStatus` e `cacheStatus` sono emerse
**tre superfici del sito con origin diversi**; i due host webhook sono invece ingressi
Cloudflare Tunnel distinti:

| superficie | dove | origin | cache rule |
|---|---|---|---|
| `cdn-r2` | `cdn.frontaliereticino.ch/assets`, `/data` | R2 | `cdn-r2-passthrough-cache` |
| `worker-shard` | `frontaliereticino.ch/{en,de,fr}/…` | Worker → shard Pages per-locale | `locale-shard-failover-cache` |
| `apex-pages` | `frontaliereticino.ch/commit-hash.txt`, `/fonts/`, `/favicon.svg` | GitHub Pages | `it-apex-html-cache` |
| `github-webhook-default` | `gh-default.frontaliereticino.ch/github/webhook` | Cloudflare Tunnel → receiver locale `18787` | nessuna cache rule del sito |
| `github-webhook-nanako` | `gh-nanako.frontaliereticino.ch/github/webhook` | Cloudflare Tunnel → receiver locale `18788` | nessuna cache rule del sito |

**Il costo di confonderle è concreto.** `serve_stale` è stato applicato alla sola rule del CDN
e dato per mitigante anche di #5082 — che è un `503` sull'apex e non poteva toccare. Chiuderla
«perché i 5xx sono scesi» avrebbe archiviato un difetto mai diagnosticato.

La partizione vive in `scripts/lib/cf-error-surface.mjs`. Le tre superfici del sito rispecchiano
le cache rule possedute da `scripts/cf-locale-failover-setup.mjs`; i due ingressi webhook sono
classificati dagli hostname configurati per i tunnel. `classifySurface()` descrive il percorso
atteso: da sola non prova quale hop abbia restituito un 5xx.

## I dati

`cf-5xx-monitor.yml` gira ogni giorno alle 03:50 UTC e appende uno snapshot classificato a
`data/cf-5xx-history.jsonl`. Lo snapshot conserva `topPaths` (campione per il report) e
`errorPaths` (tutte le righe ricevute dalla query, fino al limite Cloudflare di 10.000), con
`errorPathsComplete` falso quando la query raggiunge quel limite. **Esiste perché la retention
del piano free è ~3 giorni**: senza questo file, «è meglio della settimana scorsa?» non è una domanda a cui si possa rispondere,
e la retention dell'API — piano free, ~3 giorni, query cappate a ~1 giorno per chiamata —
non è più il vincolo che era.

**Il criterio di chiusura osservativo è tornato verificabile, e questo paragrafo diceva il
contrario.** Fino al 2026-08-05 «nessun 5xx per due finestre di deploy» non era valutabile,
perché i dati scadevano prima della finestra: vero per l'API, non più per noi dal giorno in
cui il monitor ha cominciato a persistere. Misurata la profondità reale il 2026-09-07 su
`origin/main`: **31 snapshot su uno span di 32 giorni** (2026-08-06 → 2026-09-06), **un solo
giorno mancante** (2026-09-01), 26 giorni consecutivi senza buchi, `total5xx` sceso da 443 a
14. Rimisurala con `git show origin/main:data/cf-5xx-history.jsonl | wc -l` (il checkout è
sparse: si legge da git, non dal disco).

Due conseguenze pratiche. La prima: N si esprime in **snapshot**, non in
«finestre di deploy» — la serie è giornaliera a finestra fissa di 23 ore e il deploy non
compare nel file. La seconda: il criterio si conta su N snapshot **presenti**, non su N
giorni di calendario, perché un giorno mancante è un fatto sul monitor e non sulla zona; la
freschezza della serie è un requisito separato e fail-closed. Il codice che lo applica è
`checkUrlClean()` in `scripts/ci/cf-5xx-snapshot.mjs`, che documenta la scelta e il suo
prezzo:

Per chiudere una issue, tutti gli N snapshot devono contenere una lista URL completa. L'assenza
da `topPaths` non significa zero: è solo assenza dal campione. Le righe storiche senza
`errorPathsComplete` restano non verificabili; servono sette snapshot completi e freschi prima
che il comando possa dare exit 0. Una query satura o una lista mancante resta exit 1.

```bash
# «questo URL ha smesso?» — exit 0 solo dopo 7 snapshot completi e freschi senza il path
node scripts/ci/cf-5xx-snapshot.mjs --check-url 'cdn.frontaliereticino.ch/assets/x.js' --snapshots 7
```

È il comando che `cf-5xx-issue-sync.mjs` allega come `COMANDO` nella scheda di ogni issue
che conia, quindi l'esenzione permanente dal criterio di chiusura non serve più.
Lo stesso passo del monitor è anche il **chiuditore**: a ogni run, in ogni ramo
che ha letto i dati di Cloudflare, `scripts/lib/monitor-issue-reconcile.mjs` rilegge le issue
`cloudflare-5xx` aperte e chiude, con un commento di evidenza, quelle il cui URL (dalla riga
`**URL:**` del corpo) passa questo comando; come guardia in più, non deve comparire nemmeno fra i primi 50 path del
report del giorno (che non è una prova di zero 5xx: lo snapshot di oggi non è ancora nella storia).
Due issue aperte con lo stesso titolo = nessuna scrittura (la chiusura va per titolo). Storia corta,
serie ferma, dettagli troncati o URL mai osservato = nessuna scrittura; un pin o un claim
(`keep-open`, `agent:in-progress`, …) esclude la issue; `maybe-resolved` non è una prova. Prova a secco: `node scripts/cf-5xx-issue-sync.mjs --dry-run`.

```bash
# andamento su tutti gli snapshot + istogramma orario dell'ultimo
node scripts/ci/cf-5xx-snapshot.mjs --report

# fotografia live; --by-hour correla path, edge/origin e cache quando la query è completa
source bin/rc-env.sh
node scripts/cf-status-report.mjs --hours=23 --class=5 --limit=40
```

## Le tre domande, e il campo che risponde

### 1. Chi non ha risposto? → `synthesized5xx`

`originResponseStatus: 0` significa che l'origin **non ha risposto affatto** e l'errore è
sintetizzato da Cloudflare. Un valore vero (misurato: `edge=502 origin=502`) significa che è
stato l'origin a restituire l'errore. **I rimedi sono opposti**: nel primo caso si guarda
disponibilità e carico dell'origin, nel secondo i suoi log applicativi.

Se `total5xx` cala ma la quota di `synthesized5xx` resta uguale, non è migliorato niente:
è solo passato meno traffico.

### 2. `serve_stale` sta funzionando? → `staleRescuable5xx` e `byCacheStatus`

`serve_stale` può servire una copia stantia **solo se esiste**. `staleRescuable5xx` conta i
5xx che erano su una superficie con `serve_stale` **e** avevano una copia in cache.

⚠️ **Un `0` persistente non è la prova che la mitigazione sia inerte.** Su una risposta
sintetizzata dall'edge la richiesta può non aver mai raggiunto una decisione di cache, quindi
`cache=none` può voler dire «la dimensione non è significativa qui» invece di «non c'era copia».
Le due cose non sono distinguibili da questo dataset.

Ciò che **è** conclusivo è la direzione opposta: se `stale` o `updating` iniziano a comparire
in `byCacheStatus`, `serve_stale` sta dimostrabilmente scattando.

### 3. Si addensano nei deploy? → `byHour`

`byHour` dà i 5xx per ora. Sovrapponilo agli orari dei run di `deploy.yml`:

```bash
gh run list --workflow=deploy.yml --limit 20 --json createdAt,conclusion \
  -q '.[]|"\(.createdAt) \(.conclusion)"'
```

L'ipotesi corrente — mai confermata — è che i 502 di `cdn-r2` si addensino durante l'rclone
sync (`--transfers=24 --checkers=48`, in `scripts/lib/deploy-it-pages-prep.sh`), che carica lo
stesso bucket da cui l'edge fetcha. Il primo istogramma raccolto è coerente (picco 14:00-16:00Z
in una giornata di deploy fitti), **ma un campione non è una correlazione**: servono più giorni
prima di toccare la concorrenza del sync. Il deploy è il percorso OOM-critico documentato in
`deploy.yml`, e il repo pretende misura allegata per i claim di performance.

## Causa radice trovata (2026-08-05, #5162) — l'ipotesi dell'rclone era sbagliata

L'ipotesi qui sopra (i 502 si addensano durante l'rclone sync) **non ha retto alla
misura**. Il driver è il **purge zone-wide**, non il sync.

I numeri, sulla stessa finestra di 23h:

| host | richieste | hit rate |
|---|---|---|
| `cdn.frontaliereticino.ch` | 1.497.318 | **96,0%** |
| `frontaliereticino.ch` | 570.021 | 19,2% |

`post-deploy-validate-live.yml` lanciava `purge_everything` dopo ogni deploy
riuscito, per rinfrescare l'HTML dell'apex tenuto 24h da `it-apex-html-cache`.
Ma il purge è **di zona**, e la zona contiene anche il CDN: ogni deploy buttava
via una cache da 1,4 milioni di oggetti al 96% di hit per rinfrescarne una al
19%. Il CDN non ne aveva bisogno — `/assets/` si invalida già chiave per chiave
con `scripts/ci/purge-changed-cdn-assets.mjs`.

Il conto torna proprio sui 502: con un edge TTL di 7 giorni su `/assets/`, a
regime le fetch verso l'origin dovrebbero essere quasi zero. Ne sono arrivate
**~60.000 in 23h** — spiegabili solo dai purge ripetuti — e **277 sono fallite**
(0,46% delle fetch verso origin), sintetizzate dall'edge come 502.

**Perché `serve_stale` (#5158) non poteva funzionare.** Un purge *cancella* la
copia; `serve_stale` sa servire solo una copia che **esiste** ed è soltanto
scaduta. Erano mutuamente esclusivi per costruzione: ecco perché
`staleRescuable` misurava 0 e i 502 non sono calati dopo `7f147c82`. La fix non
poteva essere un altro fallback sopra il purge — doveva togliere il purge.

La freschezza dell'apex ora è `APEX_EDGE_TTL_SECONDS` (300s) in
`scripts/cf-locale-failover-setup.mjs`, senza purge. Invariante in
`tests/cf-zone-purge-blast-radius.test.ts`.

## Aggiornamento 2026-08-06 (#5231 / #5232) — il difetto era nel monitor

Due issue nuove su asset del CDN, aperte alle 06:18Z, **dopo** la fix di #5165. Non erano
un rientro del purge di zona: su `main` la guardia `CF_PURGE_ZONE_WIDE` c'è e lo step di
purge non è più in `post-deploy-validate-live.yml`. Rimisurando a `datetimeMinute`:

| URL | 5xx | quando | richieste sue, 23h | ore con 5xx |
|---|---|---|---|---|
| `/assets/vendor-fdb-auth.js` | 24 | **tutti nel minuto** `2026-08-05T16:03Z` | 22.387 (0,107%) | 1 su 23 |
| `/assets/borderWaitFormat.js` | 21 | **tutti nel minuto** `2026-08-05T15:41Z` | 22.577 (0,093%) | 1 su 23 |

Entrambi zero in **ognuna** delle ~14 ore successive, entrambi `200`/`HIT` alla verifica.
`cf-status-report.mjs` non ha dimensione temporale: un outage di 23h e un blip di 60 secondi
finito ieri pomeriggio sono lo **stesso intero**. `cf-5xx-issue-sync.mjs` selezionava su
quell'intero e dichiarava in docblock di filare su «sustained 5xx volume» — cosa che nessun
test poteva osservare.

La soglia sceglieva anche la **cosa sbagliata**: `i18n.js` è fallito con lo stesso meccanismo
nella stessa finestra, ma nel suo minuto sfortunato sono atterrate 2 richieste invece di 24,
quindi è rimasto muto. A superare `MIN_COUNT` non era la gravità: era la popolarità
dell'asset nel minuto in cui è caduto.

Ora `--by-hour` porta le righe orarie fino al feeder, che scarta le voci il cui ultimo 5xx è
più vecchio di `CF_5XX_MAX_AGE_HOURS` (2h) e scrive la forma del burst nel corpo della issue.
È la stessa chiamata che `isSelfHealedPage404` fa già per i 404 stantii, e non può mascherare
un outage vero: un outage in corso ha età 0. **Fallisce aperto e rumoroso** se le righe orarie
mancano. Invariante in `tests/cf-5xx-recency.test.ts`.

### Il volume di fetch verso origin NON era guidato dal purge

Va corretta la sezione qui sopra. #5165 dava le ~60.000 fetch verso origin in 23h come
«spiegabili solo dai purge ripetuti». Misurato **dopo** la rimozione del purge, stessa
finestra, stesso host, solo `eyeball`:

| | |
|---|---|
| richieste | 2.638.021 |
| hit | 2.567.006 (**97,31%**) |
| fetch verso origin | **71.012** |
| 502 | 239 (0,34% delle fetch verso origin) |

Le fetch verso origin non sono scese: sono **71.012**, e sono **piatte a 2.666-3.272 ogni
ora**, comprese le ore senza deploy né purge. Il driver non era il purge ed è strutturale:
gli asset escono da R2 con `cache-control: public, max-age=600, must-revalidate`, quindi ogni
oggetto ricontrolla l'origin ogni ~10 minuti. Si legge in `byCacheStatus`: `miss` 41.124,
**`revalidated` 23.146**, `expired` 1.498. Non c'è nessun edge TTL di 7 giorni su `/assets/`.

I 502 però **non** sono distribuiti su quelle fetch: 00:00-03:00Z hanno avuto 11.450 fetch
verso origin e **0** 502; 14:00-18:00Z ne hanno avute 17.453 e **139**. Un tasso di guasto
uniforme è escluso. Il meccanismo per-oggetto (scadenza a 600s → refill da R2 che fallisce →
ogni richiesta per quell'oggetto sintetizza 502 finché un refill riesce) spiega la forma
mono-path/mono-minuto, ma **cosa raggruppi i minuti cattivi in certe ore resta non misurato**:
serve più di una finestra prima di toccare qualcosa.

Nota utile: `byCacheStatus` ora riporta `stale: 3`. Per il criterio della §2 qui sopra è il
segno **conclusivo** che `serve_stale` scatta davvero — la prima volta da quando esiste.

## Trappole note

- **I due host webhook non sono CDN, shard locale o apex Pages.** `gh-default` termina sul
  receiver del coordinator default (`localhost:18787`); `gh-nanako` sul receiver nanako
  (`localhost:18788`). Il codice edge e il totale da soli non distinguono tunnel, receiver e
  origine del payload. `--by-hour` correla `originResponseStatus` e `cacheStatus` alle righe
  del singolo URL quando la query è completa; per attribuire il tratto tunnel vs receiver
  servono comunque i log di quei componenti. Non dedurre un rimedio CDN o Pages da questi host.
  **Il 530 su questi due host è atteso a Mac in stop e non conia issue del sito** (decisione del
  proprietario del 2026-10-04, site#8839/site#8840): è il tunnel senza connettore, e nessuna
  modifica a questo repo può farlo cessare. `scripts/cf-5xx-issue-sync.mjs` (`isTunnelOffline530`)
  lo separa e stampa un `::notice title=cf-5xx webhook tunnel offline::` nel log del run; resta
  in `bySurface` dello snapshot (`data/cf-5xx-history.jsonl`). L'osservatore è nel workspace:
  `bin/github-coordinator-health.mjs` con gli allarmi `tunnel_not_ready`,
  `webhook_receiver_down` e `host_slept`, più i log timestampati del receiver
  (`bin/github-webhook-receiver.mjs`, fase e causa di ogni 5xx/400). Gli altri status sugli
  stessi host (502/503/524: tunnel su, receiver rotto) continuano a coniare, con `**REPO**:
  workspace` nella scheda.
- **Un burst senza righe orarie non è un guasto attuale verificato.** Il feeder mantiene la
  issue per prudenza se le righe mancano o la query tocca il limite, ma il body deve dire che
  recency e origine sono sconosciute. L'assenza di righe non è un verde né una diagnosi.
- **Il close-check non usa `topPaths` come prova di completezza.** Se il path è assente dal
  campione ma il set completo degli URL non è disponibile, il risultato è sconosciuto e l'exit
  resta non-zero.

- **`curl -I` non misura la cache: manda `HEAD`, e Cloudflare non serve mai una
  `HEAD` dalla cache.** Ogni path risponde `cf-cache-status: DYNAMIC` e sembra che
  nessuna cache rule stia funzionando. Con `GET` lo stesso identico path risponde
  `HIT`. Costato una diagnosi sbagliata il 2026-08-05 ("le cache rule sono inerti
  sul CDN"), smentita dai dati GraphQL: 96% di hit rate. Usa
  `curl -s -o /dev/null -D - <url>`.
- **`/assets/early-boot.js` è cacheato malgrado la sua rule di bypass.** In
  `http_request_cache_settings` vince l'ultima rule che matcha, e
  `cdn-r2-passthrough-cache` (`cache: true`, indice 4) sta dopo
  `early-boot-js-bypass-cache` (`cache: false`, indice 2). Verificato via `GET`:
  `HIT`, non `BYPASS`. La finestra di skew che quella rule doveva chiudere è
  ancora aperta — difetto separato da #5162, vedi `infra/cloudflare/rules.md`.
- **`/assets/early-boot.js` non può essere servito stantio.** Ha una rule dedicata
  `early-boot-js-bypass-cache` con `cache: false`, perché deve restare fresco per
  l'auto-riparazione dello skew di versione. Un oggetto non cacheato non ha copia stantia:
  per quel file `serve_stale` è strutturalmente inefficace, e va trattato a parte.
- **`serve_stale` vive in due posti che devono restare allineati**: il campo in
  `CDN_CACHE_ACTION_PARAMETERS` **e** il confronto dentro `ruleInShape()`
  (`scripts/cf-locale-failover-setup.mjs`). Senza il secondo, il primo run che vede drift su
  quella regola la riscrive in blocco e toglie il campo in silenzio.
- **Righe `requestSource` non-eyeball vanno escluse.** L'uso passato della Cache API da parte
  del Worker registrava ogni `cache.match()` MISS come un 504 sintetico (~124k/giorno): è stato
  scambiato per un outage reale in tre PR di fila (#1791/#1814/#1830). Gli strumenti qui
  filtrano già su `eyeball` di default.
- **Non chiudere una issue 5xx al merge di una mitigazione.** Il criterio è osservativo: nessun
  nuovo evento sulla *sua* superficie per almeno due finestre di deploy complete.
- **Un totale su 23h non dice se il guasto è ancora in corso.** La finestra del monitor è
  *trailing*: un incidente finito alle 16:03Z resta dentro la finestra fino alle 15:03Z del
  giorno dopo, e ne esce solo scorrendo. Prima di diagnosticare una issue `cloudflare-5xx`,
  guarda la **forma**, non il totale — `node scripts/cf-status-report.mjs --json --class=5
  --by-hour` (o `datetimeMinute` a mano per i burst stretti). Costato #5231 e #5232.
- **`detail` è troncato, `detailByHour` no.** La query DETAIL è limitata da `--limit` (50 dal
  feeder): misurato il 2026-08-06, `detail` sommava 328 dei 462 5xx della finestra. Le righe
  orarie sono limitate solo dal tetto del dataset e sommavano 462, esatto come
  `summaryByClass`. Per un totale di zona fidati del sommario, non di `detail`.

## Da guardare, non ancora indagato

`cdn.frontaliereticino.ch/` (la root) serviva **31.496 `404` in 23h** — di gran lunga il primo
non-2xx della zona, e senza issue aperta.
