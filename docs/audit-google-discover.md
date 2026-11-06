# Audit — Google Discover

> Audit a codice statico + DNS/robots pubblici, eseguito il 2026-08-10 nell'ambito della issue #5555.
> Google Discover non ha un'attivazione esplicita: Google mostra automaticamente contenuti idonei in base a
> segnali di qualità/interesse. Questo audit verifica **idoneità tecnica ed editoriale**, non "attiva" nulla.
> I dati live del report Discover in Search Console (impressioni/clic/CTR) **richiedono l'API GSC**
> (`GOOGLE_APPLICATION_CREDENTIALS`/`FIREBASE_SERVICE_ACCOUNT_JSON` — Firebase SA raddoppia come credenziale
> GSC in questo progetto, vedi `scripts/lib/evidence/gscFetcher.mjs`), **non disponibile in questo ambiente
> CI issue-fix**. Vedi §6.

## 1. Search Console: ownership e misurazione

- **Ownership verificata**: `dig TXT frontaliereticino.ch` restituisce
  `google-site-verification=LuKVWJ1HHO2Ow2A-i3E162WWrM0uxGDxQd88sNuLBfY` — proprietà del dominio verificata
  lato DNS. ✅
- **Integrazione GSC nel repo**: estesa e matura, non un'integrazione ad-hoc. Script rilevanti:
  `scripts/check-gsc-frontaliere-baseline.mjs`, `scripts/monitor-gsc-job-indexation.mjs`,
  `scripts/refresh-gsc-position-rolling.mjs`, `scripts/sync-gsc-orphans.mjs`,
  `scripts/ingest-gsc-*.mjs` (company-hubs, job-orphans, location-hubs, coverage-404s),
  `scripts/lib/evidence/gscFetcher.mjs`. Workflow schedulati: `gsc-frontaliere-monitor.yml`,
  `monitor-gsc-seo.yml`, `refresh-gsc-marquee-demand.yml`, `sync-gsc-orphans.yml`.
- **Report Discover specifico**: nessuno script trovato che interroghi esplicitamente la dimensione
  `searchType: 'discover'` dell'API Search Console Performance (i monitor esistenti sono tutti orientati a
  Search regolare — query/posizione/copertura). **Gap**: se Discover comincia a generare traffico, non c'è
  oggi un monitor dedicato che lo segnali (a differenza di Search, che è ampiamente strumentato). Vedi §5.
- **GA4 collegato**: sì, eventi via gtag.js/Firebase Analytics (`services/analytics.ts`), ma non verificato in
  questo audit se la property GA4 ha il collegamento nativo Search Console→GA4 attivo (richiede accesso alla
  console GA4, non disponibile in CI).

## 2. Crawl e indicizzazione

- **`robots.txt`** (`public/robots.txt`, ispezionato integralmente): `User-agent: * / Allow: /`, nessun blocco
  indesiderato per Googlebot. I `Disallow` sono mirati (endpoint API, JSON dati grezzi, query string interne
  `?q=`/`?debug=`/`?status=`) — corretti, non impattano pagine editoriali/contenuto. ✅
  `Sitemap:` esplicite per `sitemap.xml` (indice) e `sitemap-news.xml` (Google News, meccanismo di discovery
  separato, richiesto esplicitamente da `tests/sitemap-news-canonical.test.ts`). ✅
- **Sitemap**: indice `public/sitemap.xml` + 70+ sub-sitemap per famiglia di template (pages, blog, glossario,
  jobs, guides, ecc.), generate/validate da `scripts/validate-sitemap*.mjs`,
  `scripts/check-sitemap-shard-size.mjs`, sincronizzate ad ogni deploy (`.github/workflows/sync-articles-sitemaps.yml`,
  visto anche nei commit recenti di `main`). ✅ Copertura ampia, monitorata (non ri-verificata riga per riga:
  dato generato, si veda "CODE vs DATA" — il codice che le genera è quello sopra).
- **Meta robots / canonical / redirect**: gestiti centralmente da `build-plugins/shared/robotsDirective.ts`
  (sito) e `packages/articles/engine/shared/robotsDirective.ts` (corpus articoli) — logica condivisa, non
  duplicata per pagina. Copertura test ampia: `tests/seo/discover-robots-directive.test.ts`,
  `tests/noindex-builders.test.ts`, e le suite noindex per-template (`*-municipality-pages.test.ts`,
  `weekly-employers.test.ts`, `employer-profile-pages.test.ts`, ecc.).

## 3. Immagini e metadata (`max-image-preview:large`)

Esiste già uno **script di audit dedicato e specifico a questo esatto checklist item**:
`scripts/audit-discover-eligibility.mjs` (`npm run audit:discover-eligibility`), creato per la issue #5001.
Non è uno spot-check: fetcha con Googlebot UA una URL per ognuna delle sitemap e misura 4 condizioni
richieste da Discover (incluso `max-image-preview:large` e hero image crawlabile ≥1200px). Gira in CI ad ogni
deploy (referenziato da `.github/workflows/post-deploy-validate-dist.yml`), **report-only per design** (non
gate — il commento nello script spiega perché: una delle 4 condizioni, l'hero image, non è soddisfacibile
oggi da molte famiglie di pagine "data landing" senza foto editoriale, e bloccare `publish` su questo
fermerebbe anche IndexNow/Indexing API/GSC sync per l'intero sito).

- **`max-image-preview:large`**: la direttiva stessa è enforced **alla fonte** (non solo auditata post-hoc)
  da `build-plugins/shared/robotsDirective.ts` + `tests/seo/discover-robots-directive.test.ts` — quindi
  **strutturalmente garantita per pagine nuove**. Il commento nello script di audit registra però un dato
  storico rilevante: il 2026-08-05, un audit ha trovato **50 famiglie di pagine su 83** (delle 87 sitemap)
  senza `max-image-preview:large` nell'output effettivo di `dist/`. Questo è il **gap quantificato più
  concreto** trovato in questo intero audit Discover — un drift misurato tra "la regola esiste nel codice
  sorgente" e "l'output effettivo la rispetta ovunque".
  **Azione consigliata** (non eseguita in questa PR — root cause richiede investigare *quali* famiglie
  divergono e perché, lavoro non banale, va oltre lo scope "audit" di questa issue): lanciare
  `npm run audit:discover-eligibility -- --strict` su un build fresco e usare l'output per aprire issue
  `crawler`/parser mirate sulle famiglie che falliscono, famiglia per famiglia.
- **Alt text / dimensioni immagine**: enforcement esistente lato `AGENTS.md` (`Image → width, height, alt`),
  non ri-verificato pagina per pagina in questo audit (scope: centinaia di migliaia di pagine generate,
  richiede il campione fornito dallo script sopra, non una lettura manuale).

## 4. Qualità editoriale (E-E-A-T)

- **Pagina "Chi Siamo"**: presente, `/chi-siamo/`, componente `components/pages/ChiSiamo.tsx`. ✅
- **Pagina Autore**: presente, `components/pages/AutorePage.tsx` — bylining per contenuti editoriali. ✅
- **Pagina Correzioni**: presente, `components/pages/Correzioni.tsx` — segnale editoriale di trasparenza
  (correction policy), rilevante per E-E-A-T. ✅
- **Data pubblicazione/aggiornamento**: presente nello schema Article/NewsArticle (non ri-verificato
  campo-per-campo in questo audit — la struttura dati JSON-LD è generata centralmente, coerente col pattern
  "CODE vs DATA" di questo repo).
- **Contenuti candidati a Discover** (normativa, scadenze, lavoro, permessi, fiscalità): il sito produce
  attivamente questo tipo di contenuto — bollettino daily-brief (vedi `docs/audit-bollettino-email.md`) e
  articoli editoriali dal corpus esterno `frontaliere-articles`. Non è stata fatta una selezione manuale di
  "10 pagine prioritizzate" (richiesto dal piano operativo Fase 2 della issue) perché richiede giudizio
  editoriale umano su quali argomenti sono più newsworthy/time-sensitive in questo momento — fuori dallo
  scope di un audit a codice.

## 5. Priorità

| # | Rilievo | Stato | Priorità | Azione | Evidenza |
|---|---|---|---|---|---|
| 1 | 50/83 famiglie di pagine senza `max-image-preview:large` nell'output `dist/` (misurato 2026-08-05) | Gap quantificato | **Alta** | Rilanciare `npm run audit:discover-eligibility -- --strict` su build corrente, aprire issue mirate per famiglia | §3, `scripts/audit-discover-eligibility.mjs` |
| 2 | Nessun monitor GSC dedicato al report Discover (`searchType: 'discover'`) | Gap | Media | Estendere `scripts/lib/evidence/gscFetcher.mjs` o un nuovo script schedulato quando/se Discover genera traffico misurabile | §1 |
| 3 | Nessuna selezione editoriale esplicita di pagine prioritarie per Discover | Gap operativo (non tecnico) | Bassa | Decisione umana/editoriale, non un fix di codice | §4 |

## 6. Già OK — nessuna azione richiesta

- Ownership Search Console verificata (DNS).
- `robots.txt` pulito, nessun blocco indesiderato.
- Sitemap ampia, validata, sincronizzata ad ogni deploy.
- Meta robots/canonical centralizzati e testati, non duplicati per template.
- `max-image-preview:large` enforced alla fonte (gap è di **drift misurato**, non di regola mancante — §3).
- E-E-A-T: Chi Siamo, pagina Autore, pagina Correzioni tutte presenti.
- Esiste già un audit tecnico Discover dedicato e specifico (`audit-discover-eligibility.mjs`), gira ad ogni
  deploy — l'infrastruttura di misurazione richiesta dalla issue **esiste già**, non andava creata da zero.

## 7. Non verificabile in questo audit (richiede credenziali/accesso non disponibili in CI issue-fix)

- Report Discover live in Search Console (impressioni/clic/CTR/pagine) — richiede l'API GSC con Firebase SA,
  non disponibile in questo ambiente. `scripts/lib/evidence/gscFetcher.mjs` documenta il meccanismo di auth;
  un run con SA disponibile (es. `/fix-issue` locale o un workflow schedulato con `GOOGLE_APPLICATION_CREDENTIALS`)
  può eseguire questa verifica.
- Copertura indice effettiva in GSC (URL Inspection su singole pagine) — stessa limitazione di credenziali.
- Core Web Vitals/rendering mobile con dati field reali — coperto separatamente da `docs/CWV-FIELD-CRITERION.md`
  (non ri-derivato qui).
