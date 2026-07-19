# Runbook: scorporo di una sezione su Pages-shard per-locale (meccanismo generico)

Procedura generica per portare live lo scorporo di una **sezione canton-scoped**
(`{section}` ∈ `ticino`, `svizzera`, `zurigo`, …) su **un repo GitHub Pages per
locale** — `frontaliere-<section>-{it,en,de,fr}` — ognuno servito da
`origin-<section>-<loc>.frontaliereticino.ch` dietro il locale-router Worker.

`ticino` è il **caso di riferimento già live** (vedi
[`TICINO-SHARD-RUNBOOK.md`](./TICINO-SHARD-RUNBOOK.md) per lo storico di quella
prima istanza). Questo documento generalizza quella procedura e la usa per il
rollout corrente di **`svizzera`** (aggregatore nazionale) e **`zurigo`**
(cantone più popoloso) — le due sezioni nuove che questa runbook porta live.

## Perché

Stesso pattern di sempre: GitHub Pages ha un **cap hard 10 GB** (uncompressed)
per deploy, e il `dist/` cresce col numero di job/pagine indicizzate. La prima
volta (Ticino, 2026-06-30) l'abbiamo trattato ad-hoc: script e workflow scritti
specificamente per quella sezione. Il sito è ricresciuto oltre il cap una
**seconda volta**, e stavolta la causa non è più "una sezione anomala" ma il
pattern strutturale — ogni sezione canton-scoped che aggrega abbastanza job
(bridge cross-canton compreso) finisce per superare, da sola, una frazione
significativa del cap.

Per questo il meccanismo è stato **generalizzato** invece di essere
ri-duplicato: un'unica coppia di script parametrizzati (`push-section-shard.sh`,
`strip-section-subtree.sh`), un unico file dati (`scripts/lib/section-shard-slugs.json`)
come single source of truth per gli slug URL, e Worker/workflow che iterano su
`{section}` invece di avere codice Ticino-specifico copiato per ogni nuova
sezione. Aggiungere una sezione futura significa aggiungere una entry al JSON
+ i repo/secret/DNS della sezione, non riscrivere script.

**Perché un repo PER LOCALE e non uno per sezione:** stesso ragionamento del
caso Ticino — il bridge cross-canton gira indipendentemente in ogni locale,
quindi la sezione pesa in modo comparabile in `it`, `en`, `de`, `fr`. Un repo
combinato per-sezione (tutti e 4 i locali in un solo shard) rischierebbe di
superare il cap 10 GB esso stesso. Quindi 4 shard per sezione, uno per locale
— stessa struttura del caso Ticino.

> **Cap Worker:** routare sezioni ad alto traffico dal Worker è OK — account su
> **Workers Paid** (10M req/mese, overage ~$0.30/M). Cap free 100k/day non è un
> vincolo.

## Stato a PR mergiata

Tutto **dormiente** per le sezioni non ancora flippate. Due gate indipendenti
per sezione (populate-then-strip), **per-sezione**, non globali:

| Gate | Tipo | Abilita |
|------|------|---------|
| `SHARD_<SECTION_UPPER>_<LOC_UPPER>_DEPLOY_KEY` (×4 per sezione) | secret | il **push** per-leg (popola lo shard `<section>-<loc>`) |
| `<SECTION_UPPER>_SHARD_LIVE=true` | variabile repo | lo **strip** da dist per quella sezione (apex < 10 GB), solo se il push del run ha lasciato l'ok-marker |

Senza i secret di una sezione, ogni step di quella sezione è un no-op → build
identico a oggi. Le sezioni sono **indipendenti**: `TICINO_SHARD_LIVE=true` non
implica nulla su `SVIZZERA_SHARD_LIVE`/`ZURIGO_SHARD_LIVE`, e viceversa.

---

## Naming conventions

| Elemento | Pattern | Esempio (`svizzera`, `it`) |
|---|---|---|
| Repo GitHub Pages | `frontaliere-<section>-<locale>` | `frontaliere-svizzera-it` |
| Origin host (DNS-only, dietro Worker) | `origin-<section>-<locale>.frontaliereticino.ch` | `origin-svizzera-it.frontaliereticino.ch` |
| Secret deploy-key (per sezione×locale) | `SHARD_<SECTION_UPPER>_<LOCALE_UPPER>_DEPLOY_KEY` | `SHARD_SVIZZERA_IT_DEPLOY_KEY` |
| Variabile repo gate (per sezione) | `<SECTION_UPPER>_SHARD_LIVE` | `SVIZZERA_SHARD_LIVE` |
| Ok-marker (per sezione×locale, per-run) | `shard-ok-<section>-<locale>` | `shard-ok-svizzera-it` |
| Build artifact (per sezione×locale×run) | `<section>-dist-<locale>-<run_id>` | `svizzera-dist-it-28439781734` |

`<SECTION_UPPER>`/`<LOCALE_UPPER>` = maiuscolo (`tr a-z A-Z`), es. `svizzera` →
`SVIZZERA`, `it` → `IT`.

---

## FASE 1 — provisioning repo + deploy key (gh CLI)

8 repo totali per le due sezioni nuove: `frontaliere-svizzera-{it,en,de,fr}` +
`frontaliere-zurigo-{it,en,de,fr}`. Stesso schema del caso Ticino, loop annidato
su sezione × locale:

```bash
# 1. Crea gli 8 repo shard (public, come gli shard Ticino/locale).
for section in svizzera zurigo; do
  for loc in it en de fr; do
    gh repo create valerielinc-ops/frontaliere-$section-$loc --public \
      --description "$section-$loc Pages shard for frontaliereticino.ch (origin-$section-$loc, Worker-only)"
  done
done

# 2. UNA coppia di chiavi PER REPO (GitHub rifiuta la stessa deploy key su >1 repo)
#    + la privata come secret per-sezione-locale SHARD_<SECTION>_<LOC>_DEPLOY_KEY.
for section in svizzera zurigo; do
  SECTION_UPPER="$(echo $section | tr a-z A-Z)"
  for loc in it en de fr; do
    K="$(mktemp -u)"
    ssh-keygen -t ed25519 -N "" -C "frontaliere-$section-$loc deploy key" -f "$K"
    gh repo deploy-key add "$K.pub" --repo valerielinc-ops/frontaliere-$section-$loc --title "ci-deploy" --allow-write
    gh secret set "SHARD_${SECTION_UPPER}_$(echo $loc|tr a-z A-Z)_DEPLOY_KEY" \
      --repo valerielinc-ops/frontaliere-si-o-no < "$K"
    rm -f "$K" "$K.pub"
  done
done
```

Abilita GitHub Pages su ogni repo (branch `main`) e imposta il custom domain
`origin-<section>-<loc>.frontaliereticino.ch` (anche `push-section-shard.sh`
scrive il file `CNAME` a ogni push, per la sezione passata come argomento).

---

## FASE 2 — Cloudflare

```bash
# DNS: 8 subdomain gray-cloud (DNS-only) → GitHub Pages, raggiungibili SOLO dal Worker.
# (CF_API_TOKEN da Remote Config — ha DNS:Edit.)
```

| Type  | Name                  | Target                       | Proxy    |
|-------|-----------------------|-------------------------------|----------|
| CNAME | `origin-svizzera-it`  | `valerielinc-ops.github.io`   | DNS only |
| CNAME | `origin-svizzera-en`  | `valerielinc-ops.github.io`   | DNS only |
| CNAME | `origin-svizzera-de`  | `valerielinc-ops.github.io`   | DNS only |
| CNAME | `origin-svizzera-fr`  | `valerielinc-ops.github.io`   | DNS only |
| CNAME | `origin-zurigo-it`    | `valerielinc-ops.github.io`   | DNS only |
| CNAME | `origin-zurigo-en`    | `valerielinc-ops.github.io`   | DNS only |
| CNAME | `origin-zurigo-de`    | `valerielinc-ops.github.io`   | DNS only |
| CNAME | `origin-zurigo-fr`    | `valerielinc-ops.github.io`   | DNS only |

Custom domain sui nuovi 8 shard repo (il push ha già scritto il file `CNAME`
col valore giusto; basta registrarlo lato Pages e attendere il check DNS):

```bash
for section in svizzera zurigo; do
  for loc in it en de fr; do
    repo="valerielinc-ops/frontaliere-$section-$loc"
    cname="origin-$section-$loc.frontaliereticino.ch"
    gh api -X PUT "repos/$repo/pages" -f cname="$cname" -F https_enforced=true 2>&1 | tail -2 || \
      gh api -X POST "repos/$repo/pages" -f 'source[branch]=main' -f 'source[path]=/' ; \
      gh api -X PUT  "repos/$repo/pages" -f cname="$cname"
  done
done
```

Deploya il Worker (porta live le route delle due sezioni nuove aggiunte in
`wrangler.toml`) e riasserisci la config:

```bash
cd infra/cloudflare-worker
npx wrangler deploy
node ../../scripts/cf-locale-failover-setup.mjs
```

`cf-locale-failover-setup.mjs` va **sempre** eseguito dopo ogni `wrangler
deploy` (stessa convenzione di `TICINO-SHARD-RUNBOOK.md` e
`LOCALE-SHARD-CLOUDFLARE-RUNBOOK.md`): il deploy del Worker può resettare il
flag `request_limit_fail_open` delle route al default fail-closed (errore 1027
sopra il cap free 100k/day). Lo script è idempotente (`CF_API_TOKEN` da
`load-rc-env.mjs`), auto-discover delle route legate al Worker — le nuove
route `svizzera`/`zurigo` sono coperte automaticamente, nessuna modifica allo
script stesso. `deploy-worker.yml` lo esegue da solo; solo i deploy manuali
devono ricordarselo.

Le route `/en|/de|/fr/*` esistenti coprono già le path localizzate delle
sezioni nuove (il Worker le ri-targetta a `origin-<section>-<loc>` in-code via
`matchSection`). Solo le route IT specifiche di `svizzera`/`zurigo` (es.
`/cerca-lavoro-svizzera*`, `/cerca-lavoro-zurigo*`) sono nuove in
`wrangler.toml`.

---

## FASE 3 — verify (prima di attivare lo strip)

Con il **solo** secret impostato (variabile ANCORA non settata), lancia un
deploy — ogni leg pusha il subtree della sezione al rispettivo repo shard, ma
lo strip resta gated su `<SECTION>_SHARD_LIVE` → **non strippa** → l'apex
resta com'è oggi, nessuna regressione:

```bash
gh workflow run deploy.yml --ref main
```

Verifica che ogni shard abbia ricevuto contenuto:

```bash
for section in svizzera zurigo; do
  for loc in it en de fr; do
    echo -n "$section-$loc: "
    gh api repos/valerielinc-ops/frontaliere-$section-$loc/commits/main --jq '.commit.message' 2>&1 | head -1
  done
done
```

Verifica il Worker sulle 8 URL pubbliche nuove (200 + contenuto reale, servito
dai nuovi origin — slug da `scripts/lib/section-shard-slugs.json`: `it` →
`frontaliereticino.ch/<slug>/`, `en/de/fr` → `frontaliereticino.ch/<loc>/<slug>/`):

```bash
# svizzera
curl -sI https://frontaliereticino.ch/cerca-lavoro-svizzera/         | head -1
curl -sI https://frontaliereticino.ch/en/find-jobs-switzerland/      | head -1
curl -sI https://frontaliereticino.ch/de/jobs-in-schweiz/            | head -1
curl -sI https://frontaliereticino.ch/fr/trouver-emploi-suisse/      | head -1

# zurigo
curl -sI https://frontaliereticino.ch/cerca-lavoro-zurigo/           | head -1
curl -sI https://frontaliereticino.ch/en/find-jobs-zurich/           | head -1
curl -sI https://frontaliereticino.ch/de/jobs-in-zurich/             | head -1
curl -sI https://frontaliereticino.ch/fr/trouver-emploi-zurich/      | head -1

# sezioni non toccate = passthrough invariato (es. IT apex generico):
curl -sI https://frontaliereticino.ch/ | head -1
```

Tutti gli 8 devono dare 200 con contenuto reale via gli origin nuovi; la
verifica sull'apex IT generico conferma che il routing per `svizzera`/`zurigo`
non ha alterato il passthrough delle altre sezioni/pagine.

---

## FASE 4 — flip: attiva lo strip (apex < 10 GB)

Solo dopo aver verificato FASE 3. Le due variabili sono **indipendenti**: si
possono flippare in ordine qualsiasi, anche a distanza di deploy — utile per
uno staged rollout a basso rischio (es. `svizzera` prima, verifica in
produzione, poi `zurigo`, invece di un flip unico all-or-nothing):

```bash
gh variable set SVIZZERA_SHARD_LIVE --repo valerielinc-ops/frontaliere-si-o-no --body true
gh workflow run deploy.yml --ref main
```

```bash
gh variable set ZURIGO_SHARD_LIVE --repo valerielinc-ops/frontaliere-si-o-no --body true
gh workflow run deploy.yml --ref main
```

Da ora, in ogni leg, lo strip rimuove il subtree della sezione flippata da
dist **solo se** il push di quel run ha lasciato l'ok-marker
(`shard-ok-<section>-<loc>`) → l'artifact scende sotto i 10 GB →
`deploy-pages` passa, con la sezione servita dagli shard. La variabile abilita
anche la rehydration in `post-deploy-validate-dist.yml` (clone dei repo della
sezione) così i validator non flaggano le pagine di quella sezione come
mancanti.

Verifica post-flip:

```bash
# la prossima entry di dist-size-history.jsonl deve mostrare un drop
tail -n 5 data/dist-size-history.jsonl
# il publish Pages non deve fallire con "exceeds 10GB"
gh run list --workflow=deploy.yml --limit 1 --json databaseId,conclusion
```

Ordering anti-404: il push gira **dentro** ogni leg, **prima** dello strip e
prima del publish dell'apex (`deploy-publish.yml` parte solo a `deploy.yml`
completo) → lo shard è già aggiornato quando l'apex strippato va live. Se un
push fallisce, il suo leg non strippa (no ok-marker) → quel subtree resta
nell'apex (il deploy può fallire il cap, ma la sezione non è mai **non
servita**).

---

## Rollback

- **Soft** (ri-include la sezione nell'apex): `gh variable set
  <SECTION>_SHARD_LIVE -b false` (o `gh variable delete`). Il prossimo build
  smette di strippare quella sezione. ⚠️ Funziona solo se `main` non è già
  stato ri-deployato **senza** quella sezione dopo il flip — stesso caveat del
  runbook Ticino: se l'apex non è mai stato ribuildato con la sezione dentro
  da quando lo strip era attivo, il rollback riporta il contenuto al prossimo
  deploy, non istantaneamente. L'apex torna >10 GB per quella sezione → il
  deploy Pages può ri-fallire il cap; usare solo se uno shard è rotto e si
  accetta il rischio.
- **Full**: rollback soft + rimuovi le route Worker della sezione da
  `wrangler.toml` + ri-deploya il Worker + rimuovi gli 8 (o 4, se una sola
  sezione) record DNS `origin-<section>-*`. Secret/variabile e i repo shard
  possono restare inerti.

---

## File coinvolti

- `infra/cloudflare-worker/locale-router.js` — `SECTION_ORIGIN` / `SECTION_ROUTES` / `matchSection` (generalizzato da `TICINO_ORIGIN`/`TICINO_ROUTES`/`matchTicino`).
- `infra/cloudflare-worker/wrangler.toml` — route per sezione (IT specifiche, es. `/cerca-lavoro-svizzera*`, `/cerca-lavoro-zurigo*`).
- `scripts/lib/push-section-shard.sh` — stage+offload+push per sezione×locale → `frontaliere-<section>-<loc>` (sostituisce `push-ticino-shard.sh`, ora **rimosso**).
- `scripts/lib/strip-section-subtree.sh` — strip (variabile + ok-marker) per-leg, parametrizzato su sezione (sostituisce `strip-ticino-subtree.sh`, ora **rimosso**).
- `scripts/lib/section-shard-slugs.json` — single source of truth per gli slug URL delle 3 sezioni × 4 locali.
- `.github/workflows/deploy.yml` — push + strip per ogni sezione in ogni leg.
- `.github/workflows/post-deploy-validate-dist.yml` — rehydration (clone dei repo per sezione live).
- `tests/locale-router-section-shard.test.ts` — routing generico multi-sezione (rinominato da `tests/locale-router-ticino-shard.test.ts`).

---

## Checklist rapida

- [ ] 8 repo `frontaliere-svizzera-{it,en,de,fr}` + `frontaliere-zurigo-{it,en,de,fr}` creati (FASE 1)
- [ ] 8 deploy key generate, secret `SHARD_SVIZZERA_*`/`SHARD_ZURIGO_*` impostati
- [ ] Pages abilitato + custom domain su ognuno degli 8 repo
- [ ] 8 CNAME `origin-svizzera-{it,en,de,fr}` / `origin-zurigo-{it,en,de,fr}` DNS-only su Cloudflare
- [ ] Worker deployato con le nuove route; `cf-locale-failover-setup.mjs` eseguito subito dopo
- [ ] FASE 3: deploy con soli secret → shard popolati, 8 URL pubbliche verificate 200, passthrough altre sezioni invariato
- [ ] `SVIZZERA_SHARD_LIVE=true` flippato indipendentemente, deploy verificato (dist-size-history in calo, nessun errore 10GB)
- [ ] `ZURIGO_SHARD_LIVE=true` flippato indipendentemente, deploy verificato (dist-size-history in calo, nessun errore 10GB)
