# Runbook: scorporo della sezione Ticino su Pages-shard per-locale

Procedura per portare live lo scorporo della sezione Ticino su **un repo GitHub
Pages per locale** — `frontaliere-ticino-{it,en,de,fr}` — ognuno servito da
`origin-ticino-<loc>.frontaliereticino.ch` dietro il locale-router Worker.

## Perché

Il deploy IT 2026-06-30 ([run 28439781734](https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/28439781734))
è fallito su `actions/deploy-pages`:

```
Uploaded artifact size of 1373098863 bytes exceeds the allowed size of 1 GB. Deployment might fail.
Artifact could not be deployed. … total size is less than 10GB.
```

Il **cap hard 10 GB** (uncompressed) di GitHub Pages è superato: il dist IT è
~11–13 GB, dominato da `cerca-lavoro-ticino` (~4.2 GB / ~222k pagine — il
cross-canton bridge specchia quasi ogni job CH attivo sotto la sezione TI legacy).

**Perché un repo PER LOCALE e non uno solo:** il bridge gira indipendentemente in
ogni locale, quindi anche `/en/find-jobs-ticino`, `/de/jobs-im-tessin`,
`/fr/trouver-emploi-tessin` sono ~4 GB ciascuno. Un repo combinato sarebbe ~16 GB
→ **supererebbe il cap 10 GB esso stesso**. Quindi 4 shard da ~4 GB, uno per
locale. L'apex IT scende a ~6.8 GB e ogni shard en/de/fr torna sotto il cap.

> **Cap Worker:** routare la sezione Ticino (alto traffico) dal Worker è OK —
> account su **Workers Paid** (10M req/mese, overage ~$0.30/M). Cap free 100k/day
> non più un vincolo.

## Stato a PR mergiata

Tutto **dormiente**. Due gate indipendenti (populate-then-strip):

| Gate | Tipo | Abilita |
|------|------|---------|
| `SHARD_TICINO_<LOC>_DEPLOY_KEY` (×4) | secret | il **push** per-leg (popola lo shard `<loc>`) |
| `TICINO_SHARD_LIVE=true`  | variabile repo | lo **strip** da dist (apex < 10 GB), solo se il push del run ha lasciato l'ok-marker |

Senza i secret ogni step Ticino è un no-op → build identico a oggi.

---

## FASE 1 — provisioning 4 repo + 1 deploy key (gh CLI)

```bash
# 1. Crea i 4 repo shard (public, come gli shard locali).
for loc in it en de fr; do
  gh repo create valerielinc-ops/frontaliere-ticino-$loc --public \
    --description "Ticino-$loc Pages shard for frontaliereticino.ch (origin-ticino-$loc, Worker-only)"
done

# 2. UNA coppia di chiavi PER REPO (GitHub rifiuta la stessa deploy key su >1 repo)
#    + la privata come secret per-locale SHARD_TICINO_<LOC>_DEPLOY_KEY.
for loc in it en de fr; do
  K="$(mktemp -u)"
  ssh-keygen -t ed25519 -N "" -C "frontaliere-ticino-$loc deploy key" -f "$K"
  gh repo deploy-key add "$K.pub" --repo valerielinc-ops/frontaliere-ticino-$loc --title "ci-deploy" --allow-write
  gh secret set "SHARD_TICINO_$(echo $loc|tr a-z A-Z)_DEPLOY_KEY" \
    --repo valerielinc-ops/frontaliere-si-o-no < "$K"
  rm -f "$K" "$K.pub"
done
```

Abilita GitHub Pages su ogni repo (branch `main`) e imposta il custom domain
`origin-ticino-<loc>.frontaliereticino.ch` (anche `push-ticino-shard.sh` scrive il
file `CNAME` a ogni push).

---

## FASE 2 — Cloudflare

```bash
# DNS: 4 subdomain gray-cloud (DNS-only) → GitHub Pages, raggiungibili SOLO dal Worker.
# (CF_API_TOKEN da Remote Config — ha DNS:Edit.)
#   origin-ticino-it  CNAME  valerielinc-ops.github.io   (Proxy: DNS only)
#   origin-ticino-en  CNAME  valerielinc-ops.github.io   (Proxy: DNS only)
#   origin-ticino-de  CNAME  valerielinc-ops.github.io   (Proxy: DNS only)
#   origin-ticino-fr  CNAME  valerielinc-ops.github.io   (Proxy: DNS only)
```

Deploya il Worker (porta live le route IT `/cerca-lavoro-ticino*` aggiunte in
`wrangler.toml`) e asserisci la config:

```bash
gh workflow run deploy-worker.yml --ref main
# oppure:  cd infra/cloudflare-worker && npx wrangler deploy
#          node scripts/cf-locale-failover-setup.mjs
```

Le route `/en|/de|/fr/*` esistenti coprono già le path Ticino localizzate (il
Worker le ri-targetta a `origin-ticino-<loc>` in-code via `matchTicino`). Solo le
route IT `/cerca-lavoro-ticino*` sono nuove. `cf-locale-failover-setup.mjs`
asserisce `request_limit_fail_open` su tutte le route legate allo script
(auto-discover) → le route Ticino sono coperte automaticamente; la cache
eligibility del fail-open è già coperta dalle regole esistenti (`it-apex-html-cache`
per la path IT, `locale-shard-failover-cache` per en/de/fr). **Nessuna modifica a
`cf-locale-failover-setup.mjs`.**

---

## FASE 3 — seed degli shard (additivo, nessun rischio)

Con il **solo** secret impostato (variabile ANCORA non settata), lancia un deploy:

```bash
gh workflow run deploy.yml --ref main
```

Ogni leg pusha il suo subtree Ticino al rispettivo `frontaliere-ticino-<loc>`
(il push gira, ma lo strip è gated su `TICINO_SHARD_LIVE` → **non strippa** → l'apex
resta com'è oggi, nessuna regressione). Verifica:

```bash
for loc in it en de fr; do
  echo -n "ticino-$loc: "
  gh api repos/valerielinc-ops/frontaliere-ticino-$loc/commits/main --jq '.commit.message' 2>&1 | head -1
done

# Il Worker serve la sezione Ticino dagli shard (200, contenuto reale):
curl -sI https://frontaliereticino.ch/cerca-lavoro-ticino/  | head -1
curl -sI https://frontaliereticino.ch/en/find-jobs-ticino/  | head -1
curl -sI https://frontaliereticino.ch/de/jobs-im-tessin/    | head -1
curl -sI https://frontaliereticino.ch/fr/trouver-emploi-tessin/ | head -1
# spot-check di una pagina job reale sotto /cerca-lavoro-ticino/<slug>/ (data via CDN)
```

---

## FASE 4 — flip: attiva lo strip (apex < 10 GB)

Solo dopo aver verificato FASE 3:

```bash
gh variable set TICINO_SHARD_LIVE --repo valerielinc-ops/frontaliere-si-o-no --body true
gh workflow run deploy.yml --ref main
```

Da ora, in ogni leg, lo strip rimuove il subtree Ticino da dist **solo se** il push
di quel run ha lasciato l'ok-marker (`shard-ok-ticino-<loc>`) → l'artifact scende
sotto i 10 GB → `deploy-pages` passa, con la sezione servita dagli shard. La
variabile abilita anche la rehydration in `post-deploy-validate-dist.yml` (clone dei
4 repo) così i validator non flaggano le pagine Ticino come mancanti.

Ordering anti-404: il push gira **dentro** ogni leg, **prima** dello strip e prima
del publish dell'apex (`deploy-publish.yml` parte solo a `deploy.yml` completo) →
lo shard è già aggiornato quando l'apex strippato va live. Se un push fallisce, il
suo leg non strippa (no ok-marker) → quel subtree resta nell'apex (deploy può
fallire il cap, ma la sezione non è mai **non servita**).

---

## Rollback

- **Soft** (ri-include Ticino nell'apex): `gh variable delete TICINO_SHARD_LIVE`.
  Il prossimo build smette di strippare. ⚠️ l'apex torna >10 GB → il deploy Pages
  ri-fallisce: usare solo se uno shard è rotto e si accetta il deploy fallito.
- **Full**: rollback soft + rimuovi le route Ticino IT da `wrangler.toml` +
  ri-deploya il Worker + rimuovi i 4 record DNS `origin-ticino-*`. Secret/variabile
  e i repo shard possono restare inerti.

## File coinvolti

- `infra/cloudflare-worker/locale-router.js` — `matchTicino` + `serveShard` → `TICINO_ORIGIN[loc]`.
- `infra/cloudflare-worker/wrangler.toml` — route IT `/cerca-lavoro-ticino*`.
- `scripts/lib/push-ticino-shard.sh` — stage+offload+push per-locale → `frontaliere-ticino-<loc>`.
- `scripts/lib/strip-ticino-subtree.sh` — strip (variabile + ok-marker) per-leg.
- `.github/workflows/deploy.yml` — push + strip Ticino in ogni leg.
- `.github/workflows/post-deploy-validate-dist.yml` — rehydration (clone dei 4 repo).
- `tests/locale-router-ticino-shard.test.ts` — routing Ticino (9 casi).
