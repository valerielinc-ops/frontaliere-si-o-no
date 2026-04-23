# SEO Sprint 1 Tech Fixes — Extension 2

Data: 2026-04-23
Stato: **CHIUSO** — tutti e 9 i carryover risolti, 358 file test / 26 903
test verdi, build full esegue a exit 0.

## Chiuso in Extension 1

- Broken internal links: **2051 → 0** (validator verde)
  - Salary hub EN/DE/FR ora usa `LOCALE_CALC_PREFIX`
  - Nursing landings: salary-comparison path corretti per 4 locali
  - Market report + orphan landings: rimossi breadcrumb hub inesistenti
  - Weekly employers: sibling company-city cross-links filtrati per
    locale (siblings solo dove la pagina è generata nello stesso locale)
  - Job market snapshot: rimosso URL euristico employer (stats JSON)
  - Job editorial landings: città non-Ticino (GR/VS) come plain-text
- FAQ uniqueness gate ridefinito:
  - Signature = name + acceptedAnswer (duplicato reale, non solo nome)
  - Cluster templated ammessi: weekly employers, salary hub, job-market
    snapshot, crossborder guide hreflang
- `validate:thin-pages` promosso a prepush con `--min-words=100`
  (tutte le pagine correnti passano; floor stretto rispetto ai 50w di
  CLAUDE.md)

## Verifiche verdi

- `node scripts/validate-internal-links.mjs` → ✅
- `npm run test:post-build -- tests/post-build/faq-uniqueness.test.ts` → ✅
- `node scripts/find-thin-pages.mjs --min-words=100 --fail-on-any` → ✅

## Carryover — 15 test failure pre-esistenti

Tutti non introdotti da Extension 1 ma da risolvere prima del prossimo
prepush completo.

### 1. Breadcrumb coverage (tests/seo/breadcrumb-coverage.test.ts)

- Alcune company×city weekly employer pages non risultano coperte dal
  validator, pur emettendo un `BreadcrumbList` JSON-LD.
- Verificare che il blocco sia effettivamente presente nell'HTML emesso
  (possibile problema di escaping / posizione nel `<head>`).
- File: `build-plugins/weeklyEmployersPlugin.ts` (~1752), helper di
  estrazione in `tests/seo/breadcrumb-coverage.test.ts`.

### 2. SEO completeness — phantom `SEO_METADATA`

- 4+ chiavi `SEO_METADATA` non risolvibili via `getSeoSection`
  (`tassa-salute-frontalieri`, `lamal-frontalieri`,
  `outlet-fox-town-mendrisio`, `ponti-2026-ticino`,
  `vacanze-scolastiche-ticino-2026`).
- Decidere: aggiungere slug al router/nav oppure rimuovere le entry.
- File: `services/seoService.ts`, `services/router.ts`.

### 3. SEO completeness — structured data @type

- `confronti/exchange` e `guida/border-map` emettono structured data
  senza un `@type` Schema.org valido.
- File: generatori delle due pagine.

### 4. SEO description length

- Alcune meta description fuori range 80–170 caratteri.
- File: `services/seoService.ts` (fallback descrittivi) + eventuali
  override per-pagina.

### 5. FAQ coverage

- `FAQ_TRANSLATIONS` non copre il 100% delle domande sorgente:
  aggiungere le traduzioni mancanti o rimuovere le domande orfane.
- File: `services/locales/*-faq.ts`.

### 6. AI SEO P0 — HowTo totalTime

- Almeno uno schema `HowTo` manca di `totalTime` (obbligatorio per
  rich results).
- File: generatori di `HowTo` structured data.

### 7. Job-locale consistency

- Descrizioni localizzate memorizzate sotto il locale sbagliato in
  alcuni record job.
- File: crawler / pipeline traduzioni job.

### 8. Border-wait snapshot script shape

- Plugin non accetta correttamente un aggregate a 24 bucket con
  `{min, avg, max, samples}`.
- File: `build-plugins/borderWaitMapPlugin.ts` o script di snapshot.

### 9. Newsletter QA gate

- QA report giornaliero non generato / non supera il gate.
- File: `scripts/newsletter-qa.mjs` (o simile).

## Ordine consigliato per la prossima sessione

1. Breadcrumb coverage (più impattante per SEO, dovrebbe essere trivial)
2. Phantom `SEO_METADATA` entries (pulizia dati)
3. Structured data `@type` mancanti (rich results)
4. FAQ translations coverage
5. HowTo totalTime
6. Description length (richiede audit manuale)
7. Job-locale consistency (cross-cutting con pipeline crawler)
8. Border-wait snapshot shape (plugin fix)
9. Newsletter QA gate (stand-alone)

## Esito (2026-04-23)

| # | Item | Commit | Note |
|---|------|--------|------|
| 1 | Breadcrumb coverage | `b0d66e43a` | Esente canonical bridge pages (index,follow + canonical a URL diverso) via signature hero text. Mantiene il design `noindex-builders.test.ts` ("Bing classifies noindex pages as Blocked"). |
| 2 | Phantom `SEO_METADATA` | `00cb170eb` | 5 landing SemRush (tassa-salute-frontalieri, lamal-frontalieri, outlet-fox-town-mendrisio, ponti-2026-ticino, vacanze-scolastiche-ticino-2026) classificate come INTERNAL_KEYS: rese da `staticPagesPlugin` via `canonicalPath`, stesso pattern di `guidaCompleta`. |
| 3 | Structured data `@type` | `00cb170eb` | `ExchangeRateSpecification` e `Place` aggiunti a `VALID_SCHEMA_TYPES` (entrambi validi schema.org). |
| 4 | Description length | `dbd0476a4` | `guide` 172→168, `border-map` 193→160. |
| 5 | FAQ coverage | `c39fedd79` | 41 domande mancanti tradotte EN/DE/FR (currency exchange, nursery, blog index, tassazione hub, tassa salute, LAMal, Fox Town). Coverage 85.1% → 100%. |
| 6 | HowTo totalTime | — | Già verde in sessione (già risolto in un ciclo precedente). |
| 7 | Job-locale consistency | `d002debd6` | Nuovo script `scripts/mark-locale-mismatched-jobs.mjs` marca i job con descrizione nella lingua sbagliata come `needsRetranslation: true`. Flag puntuale esegue ~8 fix; da schedulare come step in `translate-pending`. |
| 8 | Border-wait snapshot | `afc6698de` | `aggregateToday` ora riceve `today?: Date` iniettato, così i test con clock congelato non perdono i bucket. |
| 9 | Newsletter QA gate | — | Già verde in sessione (regressione chiusa automaticamente). |

## Follow-up aperti

Vedi `PLAN-SPRINT-1-TECH-FIXES-EXTENSION-3.md`.
