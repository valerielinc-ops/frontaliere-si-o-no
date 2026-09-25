# Locale-Shard BUILD Plan — render-isolated per-locale build

> Stato: **completamento strutturale per direttiva utente.** Fase 0+1a+1b+2+3
> implementate (opt-in/dormiente, `deploy.yml` live intatto). Fase 4 (validator
> esteso) + Fase 5 (wiring) sotto.
> Companion: `LOCALE-SHARD-DEPLOY-PLAN.md` (split dell'OUTPUT, già in prod).

> ⚠️ **CAVEAT WALL-TIME (misurato, robusto):** la matrix NON scende a ~15min e
> resta ≈ o sopra il monolite (~23min). È **overhead-bound**: ogni shard paga
> il costo fisso del build (vite bundle, post-walk, tar, npm ci — non divisibili
> per locale, non spostabili nel prep) + il render del proprio locale; lo shard
> **IT** (primario, ~3/4 delle pagine) fissa il wall a ~30-34min. Il render-skip
> (Fase 0-2) ha tagliato il best-shard 38→~26-29min ma NON il collo IT. Il
> sistema è **completo e corretto**, ma il suo valore è la *correttezza
> per-locale / il cap-10GB*, **non** la velocità. Wiring prod (Fase 5)
> **flag-gated default OFF** → non rallenta mai il deploy live.

## Obiettivo

Portare il build/deploy da **~23 min monolite → ~15 min** isolando il *render*
per-locale su runner free paralleli, **senza perdere nulla**: build default
byte-identico (`BUILD_LOCALE` unset), hreflang/sitemap completi, tutti i gate
SEO verdi, **costo $0** (no runner a pagamento — usa la concorrenza free).

### Perché (dato empirico, run 27684916473)

La matrix per-locale (PR #2394/#2428/#2443, opt-in dormiente su main) è CORRETTA
ma NON velocizza: ~39-46 min/shard vs ~23 min monolite, perché il *render*
gira pieno (tutti e 4 i locali) su OGNI shard — il gate salta solo le scritture
del collector + 1 loop. Timing per fase (shard en):

| fase | tempo | natura |
|---|---|---|
| jobs-seo-pages | 856s | per-locale ×4 (render NON skippato) |
| orphan-query-landings | 324s | per-locale ×4 |
| related-search-clusters | 264s | per-locale ×4 (203k pagine) |
| og-pages | 25s | locale-invariante (shared) |
| vite bundle | 60s | locale-invariante (shared) |
| data assembly | 15–195s | locale-invariante (shared) |

→ **~1444s (24min) sono render per-locale fatto ×4 redondante.** Isolandolo a
1/4 per shard: ~13-16min/shard, wall (4 paralleli) ~15min.

## Metriche di successo (gate finale)

- Deploy build-phase ≤ **16 min** (da ~23).
- Dist **ricomposta** dai 4 shard passa **tutti i gate SEO** identici al monolite
  (audit-hreflang, sitemap-integrity, broken-link, structured-data).
- Ogni pagina: 4 locali + x-default.
- Build default (`BUILD_LOCALE` unset) **byte-identico** (CI diff-check).
- Zero runner a pagamento.

## Architettura target

```
prep (1 runner)                    build-locale (matrix ×4 paralleli)
─ data assembly        ──artifact──▶ restore artifact
─ OG images (loc-inv)               ─ vite bundle (~60s)
─ canton classification             ─ render+emit SOLO il proprio locale (render-skip)
─ slug-map cross-locale             ─ prune → push shard repo
                                     it: + root/shared/sitemaps → Pages + CDN
```

## Fasi (1 PR ciascuna, gate misurabile)

- **Fase 0 — Prototipo di misura** *(PR #2473)*. Render-skip in
  `related-search-clusters` (1 loop, 264s, isolato). Preserva il bookkeeping
  cross-locale cheap (`sitemapLocs` + `crossSectionMirrorLocs` via
  `buildClusterPath`, senza render). Gate: clusters ~264→~70s su uno shard,
  validate verde, sitemap del main-shard completa.
  - **Hardening consumer sitemap (follow-up #2477).** Il ramo skip alimenta
    `sitemapLocs` con un set cross-locale completo, ma il consumer a valle
    `writeSitemap → dropOverwrittenLocs` **rilegge l'HTML in `dist/`** di ogni
    loc per droppare URL noindex/non-self-canonical. Su uno shard
    `BUILD_LOCALE=it` l'HTML cluster EN/DE/FR non è mai scritto (gated da
    `WriteCollector.add`→`shouldEmitPath`), quindi senza guard ogni loc
    cross-shard verrebbe flaggato `DROP_MISSING` → `sitemap-search-clusters.xml`
    troncato a IT-only. Fix: in `dropOverwrittenLocs` un loc il cui locale
    *owner* non è emesso da questo shard viene **tenuto incondizionatamente**
    (vive su un altro shard; assenza del file attesa, non URL rotto), come fa
    `hreflangGuard` con `!shouldEmitLocale → keep`. Default build
    (`EMIT_ALL_LOCALES`) byte-identico. Il consumer `crossSectionMirrorLocs` →
    `dropMirrorLocsFromSitemapJobs` (patch #911) è invece già safe: è un drop
    per-membership su `sitemap-jobs.xml` (file di un altro plugin), senza
    rilettura dell'HTML cluster. Guard pinnato da `tests/sitemap-clusters-shard-keep.test.ts`.
- **Fase 1 — `jobs-seo-pages` (856s, 34 loop)**. Render-skip per loop, ognuno
  dopo lo stato cross-locale (pattern `emittedActiveJobPaths`→sitemap r.8642;
  slug-map pre-loop hreflang). La parte grossa.
- **Fase 2 — restanti emitter per-locale** (`orphan-query-landings` 324s,
  `weekly-employers` ×4, `job-market-snapshot` ×4, hub vari). Sitemap completa.
- **Fase 3 — prep-job condiviso + artifact** (data+OG+bundle → artifact;
  snapshot atomico; riusa la composite `seo-build-data-prep`).
- **Fase 4 — hardening correttezza**: validator esteso (canonical/x-default/
  robots/build-id/sitemap-alternates) + step **recompose+audit** (ricompone i 4
  shard e gira i gate SEO esistenti) + guard-test anti-regressione (flagga nuovi
  consumer che leggono esistenza-file cross-locale non shard-aware).
- **Fase 5 — wiring prod (`deploy.yml`)**: sostituisce il build monolitico con
  prep + matrix; ogni locale pusha il suo shard (elimina tree-split+strip).
  Mantiene `LOCALE_SHARDS_LIVE`/fallback. Verifica live via build-id + curl.
- **Fase 6 — decommissioning + monitoraggio** 1-2 settimane (wall-time, CWV,
  hreflang GSC, 404 coverage). Revert-trigger documentato.

## Rischi & mitigazioni

| Rischio | Mitigazione |
|---|---|
| Regressione coupling cross-locale | audit per-loop + recompose+audit (gate bloccante, Fase 4) |
| OOM jobs-seo | per-locale = 1/4 pagine → meno memoria, probabile beneficio |
| Divergenza snapshot tra shard | prep-job + artifact atomico (Fase 3) |
| Tassa manutenzione (codice nuovo ri-accoppia) | guard-test anti-regressione (Fase 4) |
| Bookkeeping cheap che driftaa dal render | estrarre loc/mirror in helper condiviso (Fase 1/2) |

**Rollback**: tutto opt-in (`BUILD_LOCALE`); wiring prod dietro flag → revert al
build monolitico in 1 commit.

## Stima

F0 ½gg · F1 2-3gg (34 loop) · F2 1-2gg · F3 1gg · F4 1-2gg · F5 1gg+live · F6 ½gg.
**~1,5-2 settimane**, collo = cicli CI lenti, ~6 PR sequenziali.

---

## Fase 5 — Wiring `deploy.yml` (CABLATO, flag-gated)

> **STATO (aggiornato):** il percorso matrix è ora **cablato in `deploy.yml`**,
> flag-gated dietro `vars.LOCALE_MATRIX_BUILD` (+ input `force_matrix` per i test).
> Default OFF al primo merge → il monolite resta il default, zero rischio live;
> il passaggio a default ON è una decisione utente esplicita (già richiesta).
> Caveat overhead-bound invariato: la matrix è ≈/più lenta del monolite (~30-40min
> per shard vs ~23min), quindi l'attivazione vale per *morfologia* (split per-locale,
> cap-10GB Pages), non per velocità. Rollback = flip del flag.

**Reference implementation validata:** `deploy-matrix-experiment.yml` (prep +
matrix `build-locale` + prune + validate, tutto verde). È il template del
percorso matrix.

**Wiring proposto (quando/se attivato):**
1. Repo var `LOCALE_MATRIX_BUILD` (default unset/OFF).
2. In `deploy.yml`, dietro `if: vars.LOCALE_MATRIX_BUILD == 'true'`:
   - job `prep` (assemble/cleanup/mine/migrate/thumbnails → artifact snapshot);
   - job `build-locale` matrix `[it,en,de,fr]` `needs:[prep]`, `BUILD_LOCALE=<loc>`,
     consuma snapshot, `build:ci`, `prune-locale-shard`, `validate-locale-shard`;
   - ogni shard pusha il suo subtree allo shard repo (riusa `push_shard()` esistente);
   - lo shard `it` produce root+shared+sitemaps → Pages + CDN.
3. Il percorso monolitico resta il default (`else`): zero rischio finché OFF.
4. **Gate pre-attivazione:** (a) il job `compare` di `deploy-matrix-experiment.yml`
   prova l'equivalenza byte/sha256 recomposed-matrix == monolite; (b) un deploy
   matrix dispatchato end-to-end (`force_matrix=true`) verde su tutti i job. NB: il
   recompose+audit SEO per-deploy è ridondante — `post-deploy-validate-dist.yml`
   **già** riaggrega en/de/fr dai repo shard (`LOCALE_SHARDS_LIVE=true`, clona
   `frontaliere-<loc>`) e gira gli audit SEO sul tree completo, sia per il monolite
   che per il matrix. Senza i gate (a)+(b) verdi, NON portare il flag a default ON.

**Implementazione cablata (questo wiring):**
- `matrix-setup` (locale list + `DEPLOY_BUILD_ID` condiviso digits-only),
  `prep` (assemble/cleanup/mine/migrate/thumbnails/news-sitemap + active-jobs
  regression + SEO moratorium → `prepared-snapshot`), `build-locale` matrix.
- Lo shard IT richiama `scripts/lib/deploy-it-pages-prep.sh` (CDN push, offload,
  prune-cdn, drop-assets, tar, sitemaps bundle, dist-bytes/file-delta/url-first-seen)
  e carica gli artifact identici al monolite (`github-pages`, `sitemaps-*`,
  `jobs-master-*`, `pre-deploy-snapshot-*`, `winners-*`) + commit dist-history.
- en/de/fr richiamano offload (`CDN_BASE` esplicito) + `scripts/lib/push-locale-shard.sh`.
- `DEPLOY_BUILD_ID` condiviso → ogni shard emette lo stesso `dist/build-id.txt`
  (`build-plugins/constants.ts` lo onora; monolite invariato quando l'env è unset).
- Downstream `deploy`/`validate-dist`/`validate-live`/`publish` invariati (consumano
  gli stessi artifact via `needs:[build, build-locale]` + success-of-either).

**Rollback:** `LOCALE_MATRIX_BUILD=false` → ritorno immediato al monolite.

**Raccomandazione:** lasciare OFF. Attivare solo se un giorno il cap 10GB di
Pages impone build per-locale per *dimensione* (non per velocità).
