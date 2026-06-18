# Locale-Shard BUILD Plan — render-isolated per-locale build

> Stato: **CHIUSO — non procedere oltre Fase 1a.** Vedi "Conclusione empirica"
> in fondo. Le Fasi 0+1a sono merged (opt-in/dormiente, deploy live intatto);
> Fase 2-5 NON danno speedup netto sul monolite → non implementare.
> Companion: `LOCALE-SHARD-DEPLOY-PLAN.md` (split dell'OUTPUT, già in prod).

> ⚠️ **Obiettivo ~15min NON raggiungibile.** Misurato: i locali sono di taglia
> disuguale (IT primario = la maggior parte delle pagine) → lo **shard IT
> domina il wall** e non scende a ~1/4. Anche con manifest+prep il wall plateaua
> a ~25-27min ≈ monolite ~23min, a 4× compute. Dettaglio sotto.

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

## Conclusione empirica (2026-06-18) — CHIUSO

Implementate e misurate **Fase 0** (clusters render-skip) + **Fase 1a** (jobs-seo:
soft-landing 274s + canonical-fallback 199s). Risultato wall per shard (run
27737258033, Fase 0+1a merged):

| shard | jobs-seo | wall | note |
|---|---|---|---|
| **it** | 646s | **34m47s** | ← collo (wall = shard più lento) |
| en | 545s | 29m12s | best |
| de | 629s | 33m04s | |
| fr | 690s | 33m20s | |

Monolite a regime ~23min. Quindi Fase 0+1a hanno tagliato il best-shard da
~38→29min, **ma il wall (shard IT) resta ~34min > monolite**.

### Perché il target ~15min NON è raggiungibile

1. **Locali di taglia disuguale.** IT è il locale primario e genera la maggior
   parte delle pagine → lo **shard IT fa ~3/4 del lavoro** e fissa il wall. Lo
   sharding per-locale dà shard squilibrati: il più grosso domina. Il modello
   "~1/4 per shard" è falso.
2. **`orphan-query-landings` (~222s) non è skippabile pulito.** La sitemap orphan
   (root, it-owned) include una pagina solo se `indexable = matchingJobs≥3 &&
   wordCount≥50`; il `wordCount` richiede il render (su 500 pagine, 74 noindex,
   mix dei due gate). Usare il solo job-count come proxy includerebbe pagine
   noindex in sitemap (viola il gate). Spostare il render orphan al prep-job è
   controproducente (lavoro serial sul critical-path, non locale-invariante).
3. **Overhead per-shard irriducibile** (vite bundle 60s, post-walk, tar, npm ci)
   pagato ×4; il prep-job (Fase 3) lo fattorizza solo in parte.

Stima ottimistica anche completando manifest+prep (Fase 3-4): wall ~25-27min
(collo shard IT) ≈ monolite ~23min, a **4× compute** + complessità + tassa di
coupling cross-locale ricorrente + rischio SEO-divergence (sitemap/hreflang).

### Raccomandazione

**Non implementare Fase 2-5.** Il guadagno netto sul monolite è nullo/negativo.
Mantenere lo split dell'**output** (architettura attuale) che è più semplice e
comparabile. L'infra Fase 0+1a resta su main **opt-in/dormiente** (zero impatto:
`BUILD_LOCALE` unset = byte-identico) — utile solo se il **cap 10GB** un giorno
imponesse build per-locale per *dimensione* (non per velocità).

Per velocizzare davvero il build servirebbe un'altra strada: ottimizzare i plugin
dominanti in sé (jobs-seo/clusters/orphan — ne beneficia anche il monolite),
oppure bilanciare gli shard NON per-locale ma per *volume di pagine* (es. shard
per range di canton/slug), che però rompe l'allineamento con lo split-output
esistente per-locale.
