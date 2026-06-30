# Runbook: scorporo della sezione Ticino su Pages-shard dedicato

Procedura per portare live lo scorporo di `cerca-lavoro-ticino` (+ equivalenti
`/en/find-jobs-ticino`, `/de/jobs-im-tessin`, `/fr/trouver-emploi-tessin`) su un
repo GitHub Pages dedicato `frontaliere-ticino`, servito da
`origin-ticino.frontaliereticino.ch` dietro il locale-router Worker.

## Perché

Il deploy IT 2026-06-30 ([run 28439781734](https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/28439781734))
è fallito su `actions/deploy-pages` con:

```
Uploaded artifact size of 1373098863 bytes exceeds the allowed size of 1 GB. Deployment might fail.
Artifact could not be deployed. … total size is less than 10GB.
```

Il **cap hard 10 GB** (uncompressed) di GitHub Pages è superato: il dist IT è
~11–13 GB, dominato da `cerca-lavoro-ticino` (~4.2 GB / ~222k pagine — il
cross-canton bridge specchia quasi ogni job CH attivo sotto la sezione TI legacy).
Scorporando la sezione Ticino l'apex IT scende a ~6.8 GB e ogni shard en/de/fr
torna sotto il cap. Stesso meccanismo dello sharding per-locale già in produzione
([`LOCALE-SHARD-CLOUDFLARE-RUNBOOK.md`](./LOCALE-SHARD-CLOUDFLARE-RUNBOOK.md)).

> **Nota Cloudflare / cap Worker:** routare la sezione Ticino (alto traffico)
> attraverso il Worker è OK — l'account è su **Workers Paid** (10M req/mese
> inclusi, overage ~$0.30/M). Il vecchio cap free 100k/day non è più un vincolo.

## Stato a PR mergiata

Tutto **dormiente**. Senza il secret `SHARD_TICINO_DEPLOY_KEY` né la variabile
`TICINO_SHARD_LIVE`, ogni step Ticino è un no-op: il build si comporta
**esattamente come oggi** (Ticino resta nell'apex/shard, deploy ancora >10 GB).

I due gate sono **indipendenti** (popola-poi-strippa, mai il contrario):

| Gate | Tipo | Abilita |
|------|------|---------|
| `SHARD_TICINO_DEPLOY_KEY` | secret | il **tar + push** (popola lo shard, additivo) |
| `TICINO_SHARD_LIVE=true`  | variabile repo | lo **strip** da dist (apex < 10 GB) |

---

## FASE 1 — provisioning repo + deploy key (gh CLI)

```bash
# 1. Crea il repo shard (public, come gli shard locali).
gh repo create valerielinc-ops/frontaliere-ticino --public \
  --description "Ticino-section Pages shard for frontaliereticino.ch (origin-ticino, Worker-only)"

# 2. Deploy key write-only + secret nel repo principale.
ssh-keygen -t ed25519 -N "" -C "frontaliere-ticino deploy key" -f /tmp/ticino_shard_key
gh repo deploy-key add /tmp/ticino_shard_key.pub \
  --repo valerielinc-ops/frontaliere-ticino --title "ci-deploy" --allow-write
gh secret set SHARD_TICINO_DEPLOY_KEY \
  --repo valerielinc-ops/frontaliere-si-o-no < /tmp/ticino_shard_key
rm -f /tmp/ticino_shard_key /tmp/ticino_shard_key.pub
```

Abilita GitHub Pages sul repo shard servendo dal branch `main` (UI o API), e
imposta il custom domain `origin-ticino.frontaliereticino.ch` (anche il file
`CNAME` lo scrive `push-ticino-shard.sh` a ogni push).

---

## FASE 2 — Cloudflare

```bash
# DNS: subdomain gray-cloud (DNS-only) → GitHub Pages, raggiungibile SOLO dal Worker.
# (CF_API_TOKEN da Remote Config — ha DNS:Edit.)
#   origin-ticino  CNAME  valerielinc-ops.github.io   (Proxy status: DNS only)
```

Deploya il Worker (porta live le route Ticino IT aggiunte in `wrangler.toml`) e
asserisci la config cache/route:

```bash
gh workflow run deploy-worker.yml --ref main
# oppure manuale:  cd infra/cloudflare-worker && npx wrangler deploy
#                  node scripts/cf-locale-failover-setup.mjs
```

Le route IT `/cerca-lavoro-ticino*` sono nuove (l'apex IT prima bypassava il
Worker); le route `/en|/de|/fr/*` esistenti coprono già le path Ticino localizzate
(il Worker le ri-targetta a origin-ticino in-code via `matchTicino`).
`cf-locale-failover-setup.mjs` asserisce `request_limit_fail_open` su **tutte** le
route legate allo script (auto-discover) → le route Ticino sono coperte
automaticamente. La cache eligibility del fail-open è già coperta dalle regole
esistenti (`it-apex-html-cache` per la path IT, `locale-shard-failover-cache` per
en/de/fr) → nessuna modifica a `cf-locale-failover-setup.mjs` necessaria.

---

## FASE 3 — seed dello shard (additivo, nessun rischio)

Con il **solo** secret impostato (variabile ANCORA non settata), lancia un deploy:

```bash
gh workflow run deploy.yml --ref main
```

Il job `push-ticino-shard` popola `frontaliere-ticino` con i 4 subtree (il carve
**tarra ma NON strippa** → l'apex resta com'è oggi, nessuna regressione). Verifica:

```bash
# Lo shard ha ricevuto contenuto:
gh api repos/valerielinc-ops/frontaliere-ticino/commits/main --jq '.commit.message'

# Il Worker serve la sezione Ticino dallo shard (200, contenuto reale):
curl -sI https://frontaliereticino.ch/cerca-lavoro-ticino/ | head -1
curl -sI https://frontaliereticino.ch/en/find-jobs-ticino/ | head -1
# spot-check di una pagina job reale sotto /cerca-lavoro-ticino/<slug>/
```

> A questo punto la sezione Ticino è servita **sia** dall'apex **sia** dallo
> shard, contenuto identico. Nessun URL cambiato.

---

## FASE 4 — flip: attiva lo strip (apex < 10 GB)

Solo dopo aver verificato FASE 3:

```bash
gh variable set TICINO_SHARD_LIVE --repo valerielinc-ops/frontaliere-si-o-no --body true
gh workflow run deploy.yml --ref main
```

Da ora il carve **strippa** `cerca-lavoro-ticino` (e gli equivalenti en/de/fr)
dall'apex/shard → l'artifact IT scende sotto i 10 GB → `deploy-pages` passa. La
sezione Ticino è servita dallo shard via Worker. `TICINO_SHARD_LIVE` abilita anche
la rehydration in `post-deploy-validate-dist.yml` (i validator ritrovano le pagine
Ticino e non le flaggano come mancanti).

Ordering anti-404: `push-ticino-shard` gira **dentro** `deploy.yml`, che completa
**prima** che `deploy-publish.yml` (workflow_run) pubblichi l'apex strippato → lo
shard è già aggiornato quando l'apex va live.

---

## Rollback

- **Soft** (ri-include Ticino nell'apex): `gh variable delete TICINO_SHARD_LIVE`.
  Il prossimo build smette di strippare → Ticino torna nell'apex. ⚠️ l'apex torna
  >10 GB → il deploy Pages ri-fallisce: usare solo se lo shard è rotto e si accetta
  il deploy fallito finché non si risolve.
- **Full**: rollback soft + rimuovi le route Ticino IT da `wrangler.toml` +
  ri-deploya il Worker + rimuovi il record DNS `origin-ticino`. Il secret/variabile
  e il repo shard possono restare (inerti).

## File coinvolti

- `infra/cloudflare-worker/locale-router.js` — `matchTicino` + `serveShard` → `origin-ticino`.
- `infra/cloudflare-worker/wrangler.toml` — route IT `/cerca-lavoro-ticino*`.
- `scripts/lib/carve-ticino-subtree.sh` — tar (secret) + strip (variabile) per leg.
- `scripts/lib/push-ticino-shard.sh` — push incrementale dei 4 subtree → `frontaliere-ticino`.
- `.github/workflows/deploy.yml` — carve per-leg + job `push-ticino-shard`.
- `.github/workflows/post-deploy-validate-dist.yml` — rehydration Ticino.
- `tests/locale-router-ticino-shard.test.ts` — routing Ticino (9 casi).
