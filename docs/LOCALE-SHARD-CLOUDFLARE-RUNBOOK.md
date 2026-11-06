# Runbook: attivare lo sharding per-locale (Cloudflare + flip)

Procedura operativa per portare live l'architettura descritta in
[`LOCALE-SHARD-DEPLOY-PLAN.md`](./LOCALE-SHARD-DEPLOY-PLAN.md). Eseguire **in
ordine**: lo strip dei locali dal main artifact è l'**ultimo** passo e va fatto
solo dopo aver verificato che il proxy serve i locali dagli shard.

Stato di partenza (già fatto via gh CLI, FASE 1):
- repo `frontaliere-en`, `frontaliere-de`, `frontaliere-fr` creati (public).
- deploy key write-only su ogni shard; private key come secret
  `SHARD_EN/DE/FR_DEPLOY_KEY` nel repo `frontaliere-si-o-no`.
- `deploy.yml` pusha i locali agli shard a ogni deploy (additivo, già attivo a
  PR mergiata). Lo strip dal main è dormiente finché `LOCALE_SHARDS_LIVE` ≠ `true`.

---

## FASE 1 — seed degli shard (automatico, nessuna azione manuale)

A PR mergiata, il primo deploy popola i 3 shard. Per non aspettare lo schedule:

```bash
gh workflow run deploy.yml --ref main
```

Verifica che gli shard abbiano ricevuto contenuto (ogni repo deve avere un commit
`locale shard <loc> …` sul branch `main`):

```bash
for loc in en de fr; do
  echo -n "$loc: "; gh api repos/valerielinc-ops/frontaliere-$loc/commits/main --jq '.commit.message' 2>&1 | head -1
done
```

> A questo punto i locali sono **sia** nel main **sia** sugli shard. Il sito
> live è identico a prima: nessun URL cambiato. Si può procedere con calma.

---

## FASE 2 — Cloudflare (manuale — richiede il tuo account + accesso registrar)

### 2.1 Zona su Cloudflare
1. Crea un account Cloudflare (free) e **Add a site** → `frontaliereticino.ch`.
2. Cloudflare importa i record DNS esistenti. **Verifica** che ci siano:
   - apex `frontaliereticino.ch` → A `185.199.108.153`, `.109`, `.110`, `.111`
     (i 4 IP GitHub Pages) — questi restano.
   - `www` → CNAME `valerielinc-ops.github.io`.
   - `cdn` → (record attuale verso il CDN repo) — **lascialo DNS-only, invariato.**
3. Cloudflare ti dà 2 nameserver. **Sul registrar del `.ch`**, sostituisci i
   nameserver attuali con quelli di Cloudflare. Propagazione 24-48h.
   - Durante la propagazione i locali sono ancora serviti dal main → **zero
     downtime**.

### 2.2 Record origin per i 3 shard (DNS-only)
Su Cloudflare → DNS, aggiungi 3 CNAME **gray-cloud (Proxy status: DNS only)**:

| Type  | Name        | Target                        | Proxy    |
|-------|-------------|-------------------------------|----------|
| CNAME | `origin-en` | `valerielinc-ops.github.io`   | DNS only |
| CNAME | `origin-de` | `valerielinc-ops.github.io`   | DNS only |
| CNAME | `origin-fr` | `valerielinc-ops.github.io`   | DNS only |

### 2.3 Custom domain su ogni shard repo
Per ogni shard, imposta il custom domain (il push ha già scritto il file `CNAME`
con il valore giusto; basta registrarlo lato Pages e attendere il check DNS):

```bash
gh api -X PUT repos/valerielinc-ops/frontaliere-en/pages -f cname='origin-en.frontaliereticino.ch' -F https_enforced=true 2>&1 | tail -2 || \
  gh api -X POST repos/valerielinc-ops/frontaliere-en/pages -f 'source[branch]=main' -f 'source[path]=/' ; \
  gh api -X PUT  repos/valerielinc-ops/frontaliere-en/pages -f cname='origin-en.frontaliereticino.ch'
# ripeti per de, fr
```

Verifica diretta degli origin (devono dare 200, servono dai repo shard):

```bash
for loc in en de fr; do
  echo -n "origin-$loc: "; curl -s -o /dev/null -w '%{http_code}\n' "https://origin-$loc.frontaliereticino.ch/$loc/"
done
```

### 2.4 Deploy del Worker
Apex già su Cloudflare (orange-cloud, default dopo l'NS move). Poi:

```bash
cd infra/cloudflare-worker
npx wrangler deploy        # oppure: incolla locale-router.js nella dashboard Workers
node ../../scripts/cf-locale-failover-setup.mjs   # SEMPRE dopo il deploy (vedi sotto)
```

(le route sono SCOPED ai soli path locale in `wrangler.toml` — mai regredire a
`frontaliereticino.ch/*`, conterebbe anche l'IT nel cap 100k/day.)

Il deploy può resettare il flag `request_limit_fail_open` delle route al
default fail-closed (errore 1027 su tutto sopra il cap free 100k/day).
`scripts/cf-locale-failover-setup.mjs` (idempotente, CF_API_TOKEN da
`load-rc-env.mjs`) ri-asserisce fail-open + le zone rule gestite: la cache rule
che permette alla CDN di servire le pagine apex-keyed scritte dal Worker
(`cache.put`) quando il Worker è bypassato, la WAF rule bot-throttle e la
dynamic redirect rule `trailing-slash-301` (no-slash → slash, #3472).
`deploy-worker.yml` lo esegue da solo; solo i deploy manuali devono
ricordarselo.

### 2.5 Verifica end-to-end (URL pubblico = identico, servito dallo shard)
```bash
# deve dare 200 e il contenuto del locale, via l'URL pubblico invariato:
for loc in en de fr; do
  echo -n "/$loc/ -> "; curl -s -o /dev/null -w '%{http_code}\n' "https://frontaliereticino.ch/$loc/"
done
# una pagina profonda reale (prendine una dalla sitemap):
curl -sI "https://frontaliereticino.ch/en/find-jobs-ticino/" | head -1
# l'IT NON deve essere intercettato (passthrough):
curl -sI "https://frontaliereticino.ch/cerca-lavoro-ticino/" | head -1
```

Tutti 200 + trailing slash funzionante → il proxy serve i locali dagli shard
mantenendo gli URL identici.

---

## FASE 3 — strip dei locali dal main (riduce il main sotto 10 GB)

Solo **dopo** che la FASE 2.5 è verde:

```bash
gh variable set LOCALE_SHARDS_LIVE -b true -R valerielinc-ops/frontaliere-si-o-no
gh workflow run deploy.yml --ref main
```

Il prossimo deploy rimuove `en/ de/ fr/` dal main artifact → main scende a
~3.5 GB, ampiamente sotto il cap. Verifica nel log dello step
*"Strip locale shards from main artifact"* la riga `… -> 3.xG`.

### Rollback
```bash
gh variable set LOCALE_SHARDS_LIVE -b false -R valerielinc-ops/frontaliere-si-o-no
gh workflow run deploy.yml --ref main
```
→ il deploy successivo rimette i locali nel main artifact. (Tornano serviti dal
main; il Worker che li reinstrada agli shard resta innocuo.)

---

## Checklist rapida

- [ ] PR mergiata, primo deploy → shard popolati (FASE 1)
- [ ] Sito Cloudflare creato, DNS importato, `cdn` lasciato DNS-only
- [ ] Nameserver cambiati sul registrar, propagati
- [ ] 3 CNAME `origin-en/de/fr` DNS-only
- [ ] Custom domain impostato su ogni shard repo, origin curl = 200
- [ ] Worker deployato, route `frontaliereticino.ch/*`
- [ ] Verifica end-to-end: `/en/ /de/ /fr/` = 200 via URL pubblico, IT passthrough
- [ ] `LOCALE_SHARDS_LIVE=true` + deploy → main < 10 GB
