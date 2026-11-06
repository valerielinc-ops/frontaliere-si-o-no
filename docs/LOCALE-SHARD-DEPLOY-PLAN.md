# Piano: sharding deploy per-locale dietro Cloudflare proxy

> Stato: **PROPOSTA — da validare prima di scrivere codice.**
> Obiettivo: rientrare sotto il limite 10GB di GitHub Pages **senza cambiare un solo URL indicizzato**.

---

## 1. Problema

GitHub Pages misura **disk usage** (blocchi allocati), non i byte logici del contenuto.

| Metrica | Valore (artifact scaricato) |
|---|---|
| Contenuto logico | 9.04 GB |
| **Disco reale (`du`)** | **11 GB** ⚠️ |
| File | 1.279.560 |
| **Directory** | **1.040.803** |
| Inode totali | ~2.32M |

Il gap 9→11GB **non è contenuto**: è struttura del filesystem.
- **Dir-per-pagina** (URL puliti `/slug/` = dir + `index.html`): 1.04M directory × blocco 4KB = **~4GB di soli blocchi-directory**.
- **Block padding** su 1.28M file piccoli: altri ~1–2GB.

`deploy.yml` riporta ~13GB uncompressed in produzione → cap 10GB colpito, mitigato oggi con un hack di polling da 40 min (`deploy.yml:1260-1291`).

### Perché le alternative semplici NON vanno

| Opzione | Verdetto |
|---|---|
| Flat `.html` invece di `slug/index.html` | ❌ Pages serve `slug.html` a `/slug` (no slash); `/slug/` → **404**. Romperebbe ~1M URL canonicalizzati **con** trailing slash (canonical+sitemap usano `/slug/`). |
| Subdomain `en.frontaliereticino.ch` | ❌ Cambia gli URL → rompe tutti gli `/en/ /de/ /fr/` indicizzati (Pages non fa 301 server-side). |

L'unico modo per **togliere i byte dal repo tenendo vivo `/en/...`** è che l'URL resti `frontaliereticino.ch/en/...` mentre i file stanno in un altro origin → serve un **proxy davanti** che tu controlli.

---

## 2. Approccio scelto: sharding per-locale dietro Cloudflare

Un repo GitHub Pages per locale + un Cloudflare Worker che li ricuce sotto un solo dominio. L'utente e Google vedono **sempre** `frontaliereticino.ch/...` invariato.

### Topologia target

| Repo | Origin nascosto (DNS-only) | Contenuto | Disco stimato | Headroom |
|---|---|---|---|---|
| principale (esistente) | apex `frontaliereticino.ch` | tutto **tranne** `en/ de/ fr/` (IT + sitemap + robots + rss + shared) | ~3.5 GB | ~6.5 GB |
| `frontaliere-en` (nuovo) | `origin-en.frontaliereticino.ch` | solo `en/` (+ `en.html`, `rss-en.xml`) | ~2.5 GB | ~7.5 GB |
| `frontaliere-de` (nuovo) | `origin-de.frontaliereticino.ch` | solo `de/` (+ `de.html`, `rss-de.xml`) | ~2.5 GB | ~7.5 GB |
| `frontaliere-fr` (nuovo) | `origin-fr.frontaliereticino.ch` | solo `fr/` (+ `fr.html`, `rss-fr.xml`, `sitemap-fr-salaire-net.xml`) | ~2.5 GB | ~7.5 GB |

Ogni shard <10GB con ~4× margine. Scali aggiungendo shard quando un locale cresce (o splittando l'IT se mai supera). **Il tetto 10GB non torna più.**

Gli origin `origin-*.frontaliereticino.ch` sono subdomain **DNS-only** (gray-cloud): raggiungibili solo dal Worker, mai esposti agli utenti.

---

## 3. La seam: split post-build del `dist/` (NESSUN refactor SSG)

Decisione chiave: **non** toccare i plugin di emit. I locali sono già sottoalberi top-level (`build-plugins/jobsSeoPagesPlugin.ts:1084-1089`, `localePrefix = { it:'', en:'/en', de:'/de', fr:'/fr' }`). Quindi dopo il build, in `deploy.yml`, **si sposta la dir**:

```bash
# dopo il build, prima del deploy
for loc in en de fr; do
  mkdir -p "dist-$loc"
  mv "dist/$loc"        "dist-$loc/$loc"          # sottoalbero pagine
  mv "dist/$loc.html"   "dist-$loc/$loc.html"     2>/dev/null || true
  mv "dist/rss-$loc.xml" "dist-$loc/rss-$loc.xml" 2>/dev/null || true
  echo "origin-$loc.frontaliereticino.ch" > "dist-$loc/CNAME"   # custom domain dello shard
done
mv dist/sitemap-fr-salaire-net.xml dist-fr/ 2>/dev/null || true
# dist/ ora contiene SOLO IT + shared → ~3.5GB
```

Vantaggi:
- Zero modifiche ai plugin → zero rischio sull'emit SEO (structured data, hreflang, ecc.).
- Riusa il pattern push-to-separate-repo già in piedi per `frontaliere-cdn` (`CDN_DEPLOY_KEY`).
- Reversibile: togli lo split → tutto torna nel main.

---

## 4. Worker di routing (Cloudflare)

Sull'apex `frontaliereticino.ch`. ~25 righe:

```js
const SHARD = {
  en: "origin-en.frontaliereticino.ch",
  de: "origin-de.frontaliereticino.ch",
  fr: "origin-fr.frontaliereticino.ch",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // primo segmento del path
    const m = url.pathname.match(/^\/(en|de|fr)(\/|$|\.html|\.xml)/);
    if (m) {
      const origin = SHARD[m[1]];
      const target = new URL(request.url);
      target.hostname = origin;              // riscrive solo l'Host verso lo shard
      // l'utente continua a vedere frontaliereticino.ch/<path>
      return fetch(new Request(target, request));
    }
    // tutto il resto (IT, /data, /assets già su cdn., sitemap, robots, /...) → passthrough origin Pages
    return fetch(request);
  },
};
```

Note:
- `/assets/*` e `/data/*` e `/og/*` sono già su `cdn.frontaliereticino.ch` (URL assoluti nell'HTML) → **il Worker non li intercetta**, vanno diretti. Zero conflitto con l'offload esistente.
- hreflang e link cross-locale sono path assoluti sotto lo stesso dominio → il proxy li unifica automaticamente (è esattamente ciò che la subdomain-option rompeva).

---

## 5. DNS / Cloudflare

1. **Sposta i nameserver** del dominio su Cloudflare (free plan). Oggi il dominio punta **diretto** a GitHub Pages (apex A `185.199.108–111.153`, `www → valerielinc-ops.github.io`, header `server: GitHub.com` / Fastly interno di GitHub — nessun proxy tuo davanti).
2. **Apex `frontaliereticino.ch`**: orange-cloud (proxied) → il Worker gira qui.
3. **3 subdomain origin** `origin-en/de/fr.frontaliereticino.ch`: CNAME → `valerielinc-ops.github.io` (o il GH Pages user dello shard), **gray-cloud (DNS-only)**. Sono i custom-domain dei 3 repo shard.
4. **`cdn.frontaliereticino.ch`**: **già orange-cloud (proxied)** oggi (verificato 2026-07-05, non DNS-only come assunto qui in origine — vedi `scripts/ensure-cdn-fonts-redirect.mjs`); il Worker comunque non lo tocca (match solo su path `/en|de|fr`, §4), quindi il piano resta valido invariato.
5. **`www`**: invariato (redirect a apex come oggi).

> Vincolo GitHub: un custom-domain vive su **1 solo repo**. Per questo l'apex resta sul repo principale e ogni shard prende il suo `origin-*` subdomain. Il Worker riscrive l'`Host` verso gli origin nascosti.

---

## 6. Modifiche a `deploy.yml`

1. Dopo il build: blocco di **split** (sezione 3).
2. **4 deploy**:
   - main (`dist/`, ~3.5GB) → invariato via `upload-pages-artifact`/`deploy-pages` (ora ampiamente sotto cap → si potrà togliere l'hack polling 40min in un secondo momento).
   - `dist-en/`, `dist-de/`, `dist-fr/` → push ai 3 repo shard via deploy key dedicata (pattern `frontaliere-cdn`/`CDN_DEPLOY_KEY`). Ogni shard ha la sua `*_DEPLOY_KEY`.
3. **Ordine vincolato** (vedi §7).

---

## 7. Ordine di esecuzione — anti-rottura

Lo strip dei 7.5GB dal main funziona **solo** se il proxy è già live, altrimenti `/en /de /fr` → 404.

```
FASE 1  Crea 3 repo shard + Pages + deploy key. Deploya i locali sui rispettivi origin-*.
        (main NON ancora toccato → /en /de /fr ancora serviti dal main come oggi)
FASE 2  Cloudflare: NS move + apex proxied + Worker live + subdomain origin-*.
        Verifica: curl frontaliereticino.ch/en/<pagina> → 200 servito dallo shard.
FASE 3  SOLO ORA: il build principale fa lo split (rimuove en/de/fr dal dist main).
        main scende a ~3.5GB.
```

Rollback per fase:
- F3 regredisce → riattiva l'emit completo nel main (i locali tornano serviti dal main, Worker bypassato innocuo).
- F2 regredisce → NS back a GitHub diretto (i locali sono ancora nel main → sito intero funziona).
- F1 è puramente additiva.

---

## 8. Cosa NON cambia (e perché)

| Componente | Stato | Perché |
|---|---|---|
| `services/router.ts` `detectLocaleFromPath` | invariato | URL identici → SPA vede `/en /de /fr` come oggi |
| Canonical / hreflang / sitemap | invariati | tutti path assoluti sotto `frontaliereticino.ch`, unificati dal proxy |
| CDN `assets`/`data`/`og` su `cdn.` | invariato | Worker non li intercetta |
| robots.txt, CNAME apex, rss IT | invariati | restano sul main |
| Structured data / SEO emit | invariato | nessun refactor plugin (split è post-build) |

**Nessun URL indicizzato cambia. Nessun redirect. Nessun churn GSC.** Tutto $0 (Cloudflare free, Worker 100k req/giorno >> ~4k/giorno di traffico).

---

## 9. Decisioni aperte (servono da te)

1. **Registrar del dominio `.ch`**: chi è? Il move dei nameserver su Cloudflare va fatto lì. (.ch supporta il cambio NS; serve accesso al pannello registrar.)
2. **Account dei repo shard**: sotto `valerielinc-ops` (stesso del Pages user attuale)? 3 nuovi repo privati/pubblici?
3. **Deploy degli shard**: branch-push via deploy key (come `frontaliere-cdn`) — confermi questo pattern o preferisci un workflow per-repo?
4. **Granularità futura**: partiamo a 1 repo/locale (4 totali). Ok come baseline, o vuoi già predisporre split ulteriore dell'IT (job-detail in repo separato) se cresce?

---

## 10. Rischi

| Rischio | Mitigazione |
|---|---|
| NS cutover propagazione 24–48h | Fase 2 isolata; durante la propagazione i locali sono ancora nel main → nessun downtime |
| Worker latency extra hop sugli shard | 1 fetch interno Cloudflare→Pages, ~cache edge; trascurabile, locali a basso traffico |
| Shard repo cresce oltre 10GB | ~7.5GB headroom each; aggiungi shard (orizzontale) |
| Deploy key sprawl (4 chiavi) | least-privilege write-only come `CDN_DEPLOY_KEY` già in uso |
| `deploy.yml` è funnel-critical | split è additivo + reversibile; testare su `main` post-merge con `gh workflow run` |
```

