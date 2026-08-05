# Triage dei 5xx di zona

Guida per diagnosticare la famiglia `cloudflare-5xx` senza rifare gli errori del 2026-08-05.

## La regola numero uno: non è una famiglia sola

Per settimane i 5xx sono stati letti come un difetto solo — «R2 non risponde e Cloudflare
sintetizza il 502». Misurando la zona con `originResponseStatus` e `cacheStatus` sono emerse
**tre superfici con origin diversi**, che una sola etichetta nascondeva:

| superficie | dove | origin | cache rule |
|---|---|---|---|
| `cdn-r2` | `cdn.frontaliereticino.ch/assets`, `/data` | R2 | `cdn-r2-passthrough-cache` |
| `worker-shard` | `frontaliereticino.ch/{en,de,fr}/…` | Worker → shard Pages per-locale | `locale-shard-failover-cache` |
| `apex-pages` | `frontaliereticino.ch/commit-hash.txt`, `/fonts/`, `/favicon.svg` | GitHub Pages | `it-apex-html-cache` |

**Il costo di confonderle è concreto.** `serve_stale` è stato applicato alla sola rule del CDN
e dato per mitigante anche di #5082 — che è un `503` sull'apex e non poteva toccare. Chiuderla
«perché i 5xx sono scesi» avrebbe archiviato un difetto mai diagnosticato.

La partizione vive in `scripts/lib/cf-error-surface.mjs` e rispecchia una a una le cache rule
possedute da `scripts/cf-locale-failover-setup.mjs`. Se cambiano quelle, va cambiata lì —
in un posto solo.

## I dati

`cf-5xx-monitor.yml` gira ogni giorno alle 03:50 UTC e appende uno snapshot classificato a
`data/cf-5xx-history.jsonl`. **Esiste perché la retention del piano free è ~3 giorni**: senza
questo file, «è meglio della settimana scorsa?» non è una domanda a cui si possa rispondere,
e un criterio di chiusura osservativo («nessun 5xx per due finestre di deploy») non è
verificabile perché i dati scadono prima della finestra.

```bash
# andamento su tutti gli snapshot + istogramma orario dell'ultimo
node scripts/ci/cf-5xx-snapshot.mjs --report

# fotografia live, adesso (non scrive niente)
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

## Trappole note

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

## Da guardare, non ancora indagato

`cdn.frontaliereticino.ch/` (la root) serviva **31.496 `404` in 23h** — di gran lunga il primo
non-2xx della zona, e senza issue aperta.
