# Piano: Parametrizzazione Location di Tutti i Crawler

> **Status 2026-04-24** — audit eseguito, la maggior parte della Fase 1 è
> implementata. `scripts/lib/crawler-location-config.mjs` centralizza
> `TARGET_CANTONS` (TI/GR/VS), `SWISS_CANTONS` (26 cantoni), `COMPANY_HQ`
> (+ alias `HQ_REGISTRY`), `isTargetCanton`, `getCantonForLocation`,
> `getCantonDisplayName`, `getCompanyDefaults` e `PROSPECTIVE_REGION_IDS`.
> `scripts/lib/target-swiss-locations.mjs` legge `TARGET_CANTONS`.
>
> La maggioranza dei ~100 crawler `update-*.mjs` **non hardcoda gating logic**:
> le occorrenze di "Ticino"/"Grigioni" sono in larga parte nomi aziendali
> ("Swisscom sede Ticino", "Migros Ticino"), log di stato, commenti e
> funzioni di branding — non condizionali di canton. L'unico file con
> ternari hardcoded (`canton === 'GR' ? 'Grigioni' : 'Ticino'`) era
> `scripts/update-ist-jobs.mjs`, ora migrato a `getCantonDisplayName()`.
>
> **Gap residui**: espandere `TARGET_CANTONS` a tutti i 26 cantoni richiede
> ancora: (a) data-driven PROSPECTIVE/WORKDAY region IDs per cantoni non
> target; (b) audit quality-guard per ciascun crawler dedicato; (c) URL
> slugs `/cerca-lavoro-svizzera/` in `build-plugins/jobsSeoPagesPlugin.ts`.

## Obiettivo
Rendere TUTTI i 137 crawler configurabili tramite un unico punto centrale per la location.
Oggi: hardcoded TI/GR ovunque. Domani: si cambia UN file e tutti i crawler cercano in tutta la Svizzera.

## Approccio architetturale

### Nuovo modulo: `scripts/lib/crawler-location-config.mjs`

Singola fonte di verità per:
1. **Target cantons** — quali cantoni cercare (oggi: `['TI', 'GR']`, domani: tutti)
2. **Municipality database** — tutte le città svizzere con canton code + postal code
3. **API region mappings** — per ogni piattaforma (Prospective, Workday, SuccessFactors), la mappa canton → API-specific IDs
4. **Company HQ registry** — per Cat C, la sede di ogni azienda (slug → { city, canton, postalCode })

```js
// crawler-location-config.mjs (schema concettuale)
export const TARGET_CANTONS = ['TI', 'GR']; // ← IL SINGOLO SWITCH
export const CANTON_MUNICIPALITIES = { TI: [...], GR: [...], ZH: [...], ... };
export const PROSPECTIVE_REGION_IDS = { TI: '1024522', GR: '1024512', ZH: '...', ... };
export const WORKDAY_FACETS = { /* per-company facet mappings */ };
export const COMPANY_HQ = { 'eoc': { city: 'Bellinzona', canton: 'TI', postalCode: '6500' }, ... };
export function isTargetLocation(text) { /* checks against TARGET_CANTONS */ }
export function getCompanyDefaults(slug) { /* returns HQ info from registry */ }
```

---

## Fase 1: Infrastruttura centrale

### 1.1 Creare `crawler-location-config.mjs`
- Estrarre tutti i dati da `target-swiss-locations.mjs` nel nuovo formato
- `TARGET_CANTONS` array come switch principale
- Database municipalities per tutti i 26 cantoni (da BFS API o file CSV)
- API region mappings per Prospective.ch, Workday, SuccessFactors
- Company HQ registry per tutti i 49 Cat C crawlers

### 1.2 Refactorare `target-swiss-locations.mjs`
- `isTargetSwissLocation()` → legge da `TARGET_CANTONS` invece di hardcode TI/GR
- `isTicinoRelevant()` e `isGrigioniRelevant()` → `isCantonRelevant(canton, text)`
- `inferSwissTargetCanton()` → cerca in tutti i `TARGET_CANTONS`
- Mantenere backward compatibility per non rompere tutto in un colpo

### 1.3 Refactorare `dedicated-crawler-common.mjs`
- Linea 4041: `canton === 'TI' || canton === 'GR'` → `TARGET_CANTONS.includes(canton)`
- Linea 4102: safeguard solo città TI → safeguard tutte le città target
- Linea 4112-4113: stessa cosa per `isLocationExplicitlyForeign()`
- Linea 4141-4158: `isExplicitlyOutsideSwissTicino()` → `isExplicitlyOutsideTargetCantons()`
- Linea 4508: label `'not_ticino_relevant'` → `'not_target_relevant'`

### 1.4 Refactorare `jobsSeoPagesPlugin.ts`
- Linea 683: `return 'TI'` default → richiedere canton esplicito o dedurre da DB completo
- Linee 97-101: URL slugs "ticino"/"tessin" → parametrizzare (fase branding separata)
- Linee 718-719: fallback TI → fallback dinamico
- Linee 795-941: testi SEO "Ticino" → template con canton/region name

### 1.5 Refactorare `JobBoard.tsx`
- Linea 339-340: default `'Ticino'`/`'TI'` → rimuovere o rendere generico `'Svizzera'`
- Linea 2708: `cantonRank` sort TI>GR → configurabile o rimuovere preferenza
- Linee 3224-3225: schema defaults → generico

---

## Fase 2: Cat A — Crawlers con filtro post-fetch (52)

### 2.1 Già centralizzati — nessun cambio (24 crawlers)
Questi già delegano a `isTargetSwissLocation()` o `inferSwissTargetCanton()`.
Quando la Fase 1 cambia `target-swiss-locations.mjs`, funzioneranno automaticamente.

| Crawler | Tipo | Note |
|---------|------|------|
| abb | central | `inferSwissTargetCanton` |
| alten | central via wrapper | `isAltenTicinoLocation → isTargetSwissLocation` |
| amag | central via wrapper | `inferAmagCanton → inferSwissTargetCanton` |
| boggi | central via wrapper | `isBoggiTicinoRelevant → isTargetSwissLocation` |
| bosch | central | `isBoschTargetListing → isTargetSwissLocation` |
| convit | central via wrapper | `isConvitTicinoRelevant → isTargetSwissLocation` |
| damiani | central | `isDamianiTicinoLocation → isTargetSwissLocation` |
| delvitech | central | `isDelvitechTicinoJob → isTargetSwissLocation` |
| engelvoelkers | central via wrapper | delega a centrale |
| guess | central | `isGuessTicinoWidgetJob → inferSwissTargetCanton` |
| lombardi | central via wrapper | delega a centrale |
| manor | central | usa `TICINO_CITIES`/`GRIGIONI_CITIES` dal modulo centrale |
| mkspamp | central via wrapper | delega a centrale |
| mtic | central via wrapper | delega a centrale |
| pemsa | central via wrapper | delega a centrale |
| relewant | central via wrapper | delega a centrale |
| rittmeyer | central | `isRittmeyerTicinoListing → isTargetSwissLocation` |
| sbb | central | usa `TICINO_CITIES`/`GRIGIONI_CITIES` + `isTargetSwissLocation` |
| swisscom | central | `isTicinoLocation → isTargetSwissLocation` |
| zegna | central | `isTargetSwissLocation` diretto |
| confederazione | central + API-scoped | `inferSwissTargetCanton` per post-filter GR |
| ist | central + API-scoped | `inferSwissTargetCanton` |
| schindler | central + API-scoped | `inferSwissTargetCanton` |
| vtg | central + API-scoped | `normalizeCantonCode` + post-filter centrale |

**Azione opzionale**: rinominare wrapper (`isBoggiTicinoRelevant` → `isBoggiTargetLocation`).

### 2.2 Custom hardcoded — sostituire con filtro centrale (14 crawlers)

| Crawler | File:Linea | Cosa cambiare |
|---------|-----------|---------------|
| **alpiq** | `alpiq-job-parser.mjs:29` | `TICINO_LOCATIONS` regex (18 città) → `isTargetSwissLocation()` |
| **axpo** | `update-axpo-jobs.mjs:50` | `GR_CITIES` Set (18 città) → importare `GRIGIONI_CITIES` da centrale |
| **baronie** | `baronie-job-parser.mjs:249` | regex hardcoded (12 token) → `isTargetSwissLocation()` |
| **capri-holdings** | `capri-holdings-job-parser.mjs:45` | `SWISS_LOCATIONS` (13 token) → `isTargetSwissLocation()` |
| **decathlon** | `decathlon-job-parser.mjs:25` | `TICINO_LOCATIONS` (15 città) → `isTargetSwissLocation()` |
| **denner** | `denner-job-parser.mjs:25` | `TICINO_LOCATIONS` (25 città) → `isTargetSwissLocation()` |
| **dxt** | `dxt-job-parser.mjs:103` | `findLuganoAccordionIds` → parametrizzare keyword |
| **hugo-boss** | `hugo-boss-job-parser.mjs:89` | token hardcoded (7) → `isTargetSwissLocation()` |
| **interroll** | `interroll-job-parser.mjs:64` | regex hardcoded (7 token) → `isTargetSwissLocation()` |
| **julius-baer** | `julius-baer-job-parser.mjs:24` | `TICINO_LOCATION_KEYWORDS` (9 città) → `isTargetSwissLocation()` |
| **mikron** | `mikron-job-parser.mjs:18` | `AGNO_LOCATION_KEYWORDS` (3 token) → `isTargetSwissLocation()` |
| **otis** | `otis-job-parser.mjs:26` | `TICINO_LOCATION_KEYWORDS` (15+ token) → `isTargetSwissLocation()` |
| **swiss-med-network** | `swiss-medical-network-job-parser.mjs:25` | `TICINO_LOCATION_KEYWORDS` (14 token) → `isTargetSwissLocation()` |
| **vir-biotechnology** | `vir-biotechnology-job-parser.mjs:16` | `SWISS_LOCATION_KEYWORDS` (12 token) → `isTargetSwissLocation()` |

### 2.3 API-scoped — parametrizzare URL/params (14 crawlers)

| Crawler | API Type | Hardcoded param | Cambio |
|---------|----------|----------------|--------|
| **coop** | Prospective.ch | `f=30:1024522` (TI), `f=30:1024512` (GR) | Loop su config |
| **fust** | Prospective.ch | identico a coop | Stesso approccio |
| **volg** | Prospective.ch CC | `filter_20=1164274/1164264` | Loop su config |
| **axa** | Prospective.ch CC | `filter_20=68794/68792` | Loop su config |
| **cler** | API scoped | canton hardcoded 'TI' | Parametrizzare |
| **fincons** | URL scoped | URL Lugano-only | Multi-location |
| **galenica** | API field | `state==='TI'` | `TARGET_CANTONS.includes(state)` |
| **ibsa** | SuccessFactors | `locationsearch=TI,CH` | Loop su cantoni |
| **lastminute** | URL scoped | `location=chiasso` | Multi-location |
| **lidl** | Geo bbox | bbox TI/GR | Aggiungere bbox per altri cantoni |
| **livingcircle** | URL scoped | `location=Ascona` | Multi-location |
| **prada** | SuccessFactors | `locationsearch=ticino` | Loop su cantoni |
| **zambon** | API field | `country==='CH'` + `canton:'TI'` | Usare config |
| **colin-cie** | Custom | `CITY_MAP` locale | DB centrale cities→canton |

---

## Fase 3: Cat B — Crawlers con API params hardcoded (33)

### 3.1 Prospective.ch (7 crawlers)
Creare `PROSPECTIVE_CANTON_IDS` nel config:
```js
PROSPECTIVE_CANTON_IDS = {
  'm1000103': { TI: '1024522', GR: '1024512', ZH: '...', ... }, // Coop/Fust
  'm1000624': { TI: '1083341', GR_OST: '1083334', ... },        // Confederazione/VTG
  'cc2193': { TI: '68794', GR: '68792', ... },                   // AXA
  'cc1001859': { TI: '1164274', GR: '1164264', ... },            // Volg
}
```
Crawlers: coop, fust, confederazione, vtg, axa, volg, agroscope(post-filter)

### 3.2 Workday (8 crawlers)
Per-company facet config + search text arrays.
Crawlers: julius-baer, fnz, bracco, hamilton(CH-level OK), trumpf(CH OK), otis(CH OK), capri-holdings, vf(base crawler)

### 3.3 SuccessFactors NES (5 crawlers)
`SF_SEARCH_TERMS` per crawler.
Crawlers: schindler, skyguide, ibsa, zurich(già TI+GR), ist(già TI+GR)

### 3.4 Altri (13 crawlers)
migros, denner (Custom HTML), hugo-boss, abb (Phenom), efg (Oracle), lidl (Geo), hitachi-energy (AEM), mikron (Drupal), lastminute (WP), sbb (AEM+login.org), ksgr(GR-only)

---

## Fase 4: Cat C — Company HQ Registry (49 crawlers, ~220 punti hardcoded)

### 4.1 Creare Company HQ Registry
```js
export const COMPANY_HQ = {
  'eoc': { city: 'Bellinzona', canton: 'TI', postalCode: '6500' },
  'bancastato': { city: 'Bellinzona', canton: 'TI', postalCode: '6500' },
  'citta-di-lugano': { city: 'Lugano', canton: 'TI', postalCode: '6900' },
  'ksgr': { city: 'Chur', canton: 'GR', postalCode: '7000' },
  'ferrovia-retica': { city: 'Chur', canton: 'GR', postalCode: '7000' },
  // ... tutti i 49 crawler
};
```

### 4.2 Per ogni crawler: sostituire hardcoded con `getCompanyDefaults(slug)`
- `DEFAULT_CANTON = 'TI'` → `getCompanyDefaults(slug).canton`
- `canton: 'TI'` inline → `getCompanyDefaults(slug).canton`
- `postalCode: '6900'` → `getCompanyDefaults(slug).postalCode`
- `addressRegion: 'TI'` → `getCompanyDefaults(slug).addressRegion`
- `job.canton = 'TI'` post-process → `job.canton = getCompanyDefaults(slug).canton`
- `_targetScope: { canton: 'TI' }` → `_targetScope: getCompanyDefaults(slug)`

### 4.3 TI crawlers (42): a-plus-plus-group, ail, aldi-suisse, artisa, banca-sempione, bps-suisse, cambiavalute, casale, caseificio-gottardo, centiel, cerbios-pharma, citta-di-bellinzona, citta-di-locarno, citta-di-lugano, corner, csc-costruzioni, dot-life, eoc, fart, goline, has-healthcare, helsinn, lafonte, linnea, lis, livingcircle, lwphr, medacta, mendrisio, oscam, pkb-private-bank, raiffeisen-vc, rapelli, rivopharm, sintetica, supsi, tarchini-group, tich, tinext, tpl-lugano, usi, vir-biotechnology

### 4.4 GR crawlers (7): cedes, davos-klosters-bergbahnen, ems-chemie, ferrovia-retica, grace, kronenhof, ksgr, stadt-chur

---

## Fase 5: Build + UI

### 5.1 `dedicated-crawler-common.mjs` — Company HQ addresses (linee 2890-2917)
Spostare nel `COMPANY_HQ` registry.

### 5.2 `jobsSeoPagesPlugin.ts`
- `deriveCanton()` default 'TI' → lookup da DB completo
- URL slugs → fase branding separata
- Testi SEO → template con variabili

### 5.3 `JobBoard.tsx`
- Default → generico 'Svizzera'/'CH'
- `cantonRank` → rimuovere o configurabile
- Schema.org → generico

---

## Ordine di esecuzione
1. **Fase 1** (infrastruttura) — PRIMA di tutto
2. **Fase 2.1** (24 Cat A centrali) — automatico dopo Fase 1
3. **Fase 2.2** (14 Cat A custom) — parallelizzabile
4. **Fase 2.3 + 3** (Cat A API + Cat B) — parallelizzabile
5. **Fase 4** (Cat C) — parallelizzabile
6. **Fase 5** (build + UI) — dopo che i crawler sono OK

## Test strategy
- Ogni cambio deve produrre lo STESSO output di prima (TI/GR only)
- Test di regressione: contare jobs per canton prima e dopo
- Solo quando tutto è verde, cambiare `TARGET_CANTONS` per espandere

Obiettivo: estendere a **tutta la Svizzera** (~8.000–15.000 offerte), mantenendo retrocompatibilità SEO.

## Approccio

Espansione **a strati**: infrastruttura core → crawler common → crawler individuali → UI/SEO/build.

---

## Fase 1 — Infrastruttura Geography (Core)

### 1.1 Riscrivere `scripts/lib/target-swiss-locations.mjs`

Oggi: whitelist (solo TI/GR passano) → `isTargetSwissLocation()` = "è in TI o GR?"
Domani: tutto CH passa → `isSwissLocation()` = "è in Svizzera?"

- Invertire logica: da whitelist TI/GR a "tutto CH ok, escludi estero"
- Mantenere `isTicinoRelevant()`/`isGrigioniRelevant()` per classificazione (non come filtri)
- Aggiungere `inferCanton(text)` per tutti 26 cantoni con alias multilingue
- Creare `data/swiss-cantons.json` (26 cantoni: codice, capoluogo, PLZ, top città, token IT/DE/FR/EN)
- Espandere `data/swiss-postal-codes.json` da solo TI a top 200 città CH

### 1.2 Rimuovere blacklist città svizzere

**File**: `scripts/lib/dedicated-crawler-common.mjs`

- **Linea 4071**: `isLocationExplicitlyForeign()` — RIMUOVERE Zurich, Bern, Basel, Geneva, Lausanne dalla lista "foreign"
- **Linea 4099**: `isExplicitlyOutsideSwissTicino()` → rinominare `isExplicitlyOutsideSwitzerland()` — tenere solo città NON-CH (Milano, Monaco, Parigi)
- **Linea 4060**: `isExplicitlyOutsideTarget()` — espandere whitelist a tutte le città CH
- **Linea 3999**: `hasSeedMetaTargetScope()` — da `canton === 'TI' || canton === 'GR'` a `VALID_SWISS_CANTONS.has(canton)`

### 1.3 Aggiornare `normalizeCantonCode()`

Mappare tutti 26 cantoni + alias multilingue (Zurigo/Zürich/Zurich → ZH, Vallese/Wallis/Valais → VS, etc.)

### 1.4 Espandere PLZ enrichment

Linea ~2989 di dedicated-crawler-common.mjs ha già fallback PLZ per cantone. Verificare completezza per tutti 26.

---

## Fase 2 — Crawler Common (`dedicated-crawler-common.mjs`)

### 2.1 Aggiornare filtri location

- **Linea 12**: import nuove funzioni
- **Linea 4002**: `isTargetSwissLocation()` → `isSwissLocation()`
- **Linea 4007**: `isJobPortalRelevant()` → usare `isSwissLocation()`
- **Linee 4406-4416**: `getMergeExclusionReasons()` → nuove funzioni

### 2.2 Aggiornare `deriveCanton()` nel SEO plugin

**File**: `build-plugins/jobsSeoPagesPlugin.ts`
- **Linea 671-683**: fallback da `'TI'` → `''` o inferire da PLZ
- **Linea 644-648**: city→canton mapping → espandere a tutte le città CH principali

### 2.3 Canton default nei componenti

**File**: `components/community/JobBoard.tsx`
- **Linea 340**: `canton || 'TI'` → `canton || ''`
- **Linea 3225**: `job.canton || 'TI'` → `job.canton || 'CH'`

---

## Fase 3 — Crawler Individuali (137 script)

### Classificazione per tipo di intervento

### Riepilogo per categoria

| Tipo | Count | Intervento |
|------|-------|------------|
| **A — Fetch broad + post-filter** | **52** | Già fetchano tutta CH (o global), poi filtrano a TI/GR. Basta espandere/rimuovere il filtro. |
| **B — URL/API hardcoded TI/GR** | **33** | L'API viene chiamata con regionId, keyword, o location param fissi. Serve modificare ogni crawler. |
| **C — Azienda solo locale** | **49** | Esistono SOLO in TI/GR. Nessun intervento. |
| **D — Base crawler central gate** | **3** | Usano `runDedicatedBaseCrawler()` con filtro `isTargetSwissLocation` centralizzato. |

---

### 3.1 Categoria A — Fetch broad + post-filter (52 crawler)

Questi fetchano già tutta la Svizzera (o tutto il mondo), poi filtrano con `isTargetSwissLocation()` o una funzione custom `isXxxTicinoRelevant()`. **Basta espandere il filtro centrale o la funzione custom.**

| # | Crawler | API/URL scope | Filtro attuale | Modifica |
|---|---------|---------------|----------------|----------|
| 1 | **afry** | API globale `afry.com/en/api/afp-hr-smartrecruiteres-job-list` | `isAfryTicinoRelevant()` filtra per città | Espandere funzione nel parser |
| 2 | **agie-charmilles** | Pagina company su find-your-future.ch | `isAgieCharmillesTicinoRelevant()` | Espandere parser filter |
| 3 | **agroscope** | Prospective API (tutta l'entità) | `isAgroscopeTicinoRelevant()` per regione/città | Espandere parser filter |
| 4 | **alpiq** | RSS `alpiq.com/career/open-jobs` con `swissOnly:true` | Regex hardcoded per città TI nel main script | Espandere regex cantonale |
| 5 | **alten** | Tutte le offerte CH `alten.ch/career/jobs/` | `isAltenTicinoLocation()` → `isTargetSwissLocation()` | Espandere filtro centrale |
| 6 | **amag** | Listing IT (pre-filtrato TI) + listing DE (tutto) | `inferAmagCanton()` post-filter | Espandere `inferAmagCanton()` + aggiungere URL listing |
| 7 | **ariston** | Sitemap globale `careers.aristongroup.com` + `country=CH` | `isAristonTargetLocation()` | Espandere parser filter |
| 8 | **artificialy** | Pagina carriere `artificialy.com/it/career` | `isArtificialyTicinoRelevant()` | Espandere parser filter |
| 9 | **avaloq** | SmartRecruiters API (tutti i job) | `isAvaloqTargetLocation(city)` callback | Espandere parser filter |
| 10 | **baronie** | Tutte le offerte globali `baronie.com/en/careers` | `isSwissJob()` → JSON-LD `addressCountry=CH` | Già tiene tutti CH (solo Caslano TI) |
| 11 | **boggi** | Recruitee API globale `boggimilano1.recruitee.com` | `parseBoggiApiResponse()` filtra Swiss/Ticino | Espandere parser filter |
| 12 | **bosch** | Tutti CH `jobs.bosch.com/en/?country=ch` | `isBoschTargetListing()` per TI/GR | Espandere parser filter |
| 13 | **burkhalter** | Tutti i job dal JSON inline (~80+ società del gruppo) | `TARGET_CANTONS` set (`grisons/ticino/valais`) | Espandere set cantoni |
| 14 | **capri-holdings** | Workday API con keyword cycling (`Switzerland`, `Mendrisio`, `Lugano`...) | `isSwissLocation()` con `SWISS_LOCATION_KEYWORDS` già ampio | Già fetcha tutti CH → `inferCanton()` da espandere |
| 15 | **colin-cie** | HTML `colin-cie.com/de/karriere` — TUTTE le sedi (Lugano, ZH, BS, BE...) | `CITY_MAP` mappa tag→cantone, **tiene tutti i job** | ✅ Già pronto! Nessuna modifica necessaria |
| 16 | **convit** | HTML `careers-page.com/convit-holding-gmbh` | `isConvitTicinoRelevant()` → `isTargetSwissLocation()` | Espandere filtro centrale |
| 17 | **damiani** | Tutti i job globali `careers.damianigroup.com` | `isDamianiTicinoLocation()` → `isTargetSwissLocation()` | Espandere filtro centrale |
| 18 | **delvitech** | HTML `legacy.delvi.tech/career/` (globale incl. Germania) | `isDelvitechTicinoJob()` → `isTargetSwissLocation()` | Espandere filtro centrale |
| 19 | **efg** | Oracle HCM API con `locationId=CH` (TUTTA la Svizzera) | `detectCanton()` + `SWISS_CITY_CANTON` map — **tiene TUTTI i cantoni** | ✅ Già pronto! `ticinoJobs` è solo logging |
| 20 | **engelvoelkers** | HTML `engelvoelkers.com/ch/it/...` — tutti CH | `isEngelvoelkersTicinoRelevant()` → `isTicinoRelevant()` | Espandere parser filter |
| 21 | **galenica** | JSON statico `data.json` (tutti i job Solique) | `j?.contact?.state === 'TI'` filtra solo TI | Espandere filtro `state` |
| 22 | **giorgio-armani** | SuccessFactors globale (tutti i req ID) | `isGiorgioArmaniSwissJob()` + `inferCanton()` | Già tiene tutti CH |
| 23 | **guess** | Workable widget globale | `isGuessTicinoWidgetJob` → `isTargetSwissLocation()` | Espandere filtro centrale |
| 24 | **hamilton** | Workday API `locationCountry: [CH_FACET_ID]` — tutta CH | `detectCanton()` default GR — HQ è in GR | Tutti job Hamilton sono GR — nessuna modifica |
| 25 | **hilcona** | Sitemap Bell Food Group (tutti i job) | Parser fetcha tutto ma main hardcoda `canton:'GR'` | Aggiungere logica canton detection |
| 26 | **hitachi-energy** | AEM API `?location=Switzerland` — tutta CH | `isHitachiEnergyTicinoRelevant()` → `isTargetSwissLocation()` | Espandere filtro centrale |
| 27 | **hoval** | SAP Hybris API `country:Switzerland` — tutta CH | `isHovalTicinoRelevant()` → `isTargetSwissLocation()` | Espandere filtro centrale |
| 28 | **interroll** | HTML `interroll.com/.../jobs/` — tutti | `isSwissLocation()` nel parser, hardcoda TI | HQ è in TI (Sant'Antonino) — probabilmente solo TI |
| 29 | **kempinski** | Pinpoint API `postings.json` — tutti worldwide | `location.name.includes('switzerland')` + `detectCanton()` (St.Moritz→GR, Engelberg→OW) | ✅ Già tiene tutti CH |
| 30 | **knowledge-lab** | Freshteam API `?status=published` — tutti | `countryCode === 'CH'` poi `isKnowledgeLabTicinoRelevant()` | Espandere parser filter |
| 31 | **laderach** | Softgarden `laderach.career.softgarden.de/jobs/` — tutti | Hardcoda `canton:'GR'` — NB: HQ è in Ennenda (GL, non GR!) | Correggere canton + espandere |
| 32 | **livingcircle** | JSON `jobs.thelivingcircle.ch/jobs.feed.json` — tutti | `TICINO_LOCATIONS` array (ascona, losone, locarno...) | Espandere array locations |
| 33 | **lombardi** | HTML `lombardi.group/.../open-positions` — tutti | `isLombardiTicinoRelevant()` (sedeId=1 → Giubiasco) | Espandere parser filter |
| 34 | **manor** | Sitemap `positions.manor.ch/sitemap.xml` — tutta CH | `MANOR_TICINO_CITIES` + `isTargetSwissLocation()` | Espandere filtro centrale |
| 35 | **mkspamp** | RSS `careers.mkspamp.com` — tutti globale | `isMksPampTicinoRelevant(location)` | Espandere parser filter |
| 36 | **mtic** | HTML `mtic-group.org/.../opportunita-di-lavoro` — tutte le filiali | `isMticTicinoRelevant()` — tiene solo SPS InterCert (Lugano) | Espandere parser filter |
| 37 | **otis** | Workday API `searchText: "Switzerland"` — tutta CH | `isSwissLocation()` ma hardcoda `canton:'TI'` per tutti | Aggiungere canton detection (attualmente mislabels) |
| 38 | **pizzarotti** | InRecruiting listing — tutti globale | `isPizzarottiSwissLocation()` | Espandere parser filter |
| 39 | **postch** | HTML `post.ch/en/jobs/jobs` — tutte le categorie CH | `isTargetSwissLocation()` su ogni detail | Espandere filtro centrale |
| 40 | **postfinance** | Sitemap `jobs.postfinance.ch/sitemap.xml` — tutta CH | `TICINO_CITY_KEYWORDS` pre-filtra sitemap, poi `isTargetSwissLocation()` | Espandere `TICINO_CITY_KEYWORDS` + filtro centrale |
| 41 | **pwc** | Prospective API `limit=500` — tutti PwC CH | **Nessun filtro location!** Tiene tutti i job | ✅ Già pronto! |
| 42 | **relewant** | Zoho Recruit API `?status=published` — tutti | `isRelewantTicinoRelevant(j.city)` | Espandere parser filter |
| 43 | **ruag** | HTML `ruag.ch/.../job-portal` + dettagli ricorsivi | `isRuagTargetLocation()` + facet `job_facet_workplace:310` (Lodrino) | Espandere parser + aggiungere facet |
| 44 | **sbb** | AEM JSON API — tutti i job SBB/FFS (nessun region param) | `isTargetSwissLocation()` su region attr + `TICINO_CITIES`/`GRIGIONI_CITIES` | Espandere filtro centrale |
| 45 | **sunrise** | HTML `careers.sunrise.ch/it/it/search-results` paginato | `isSunriseTargetLocation()` | Espandere parser filter |
| 46 | **swisscom** | Workday API `searchText: ''` — TUTTI i job CH | `isTicinoLocation()` → `isTargetSwissLocation()` | Espandere filtro centrale |
| 47 | **trumpf** | Workday API `searchText: 'Switzerland'` — tutta CH | `isGrLocation()` con `GR_CITIES` set (solo GR!) | Espandere oltre GR |
| 48 | **tsmg** | Lever API `api.lever.co/v0/postings/tsmg` — tutti globale | `country === 'CH'` poi `isTsmgTargetLocation()` | Espandere parser filter |
| 49 | **vir-biotechnology** | Greenhouse API globale | Parser filtra `Switzerland`, hardcoda `canton:'TI'` | Espandere parser per altri cantoni |
| 50 | **zambon** | NcorePlat API `zambon.com/.../careers-api` — globale | `country === 'CH'`, hardcoda Cadempino TI | Solo sede TI → effettivamente C |
| 51 | **zegna** | URL con `Location=177940409` (= Switzerland) — tutta CH | `isZegnaTicinoLocation()` → `isTargetSwissLocation()` + canton check | Espandere filtro centrale |
| 52 | **zucchetti** | InRecruiting listing — tutti DACH | `isZucchettiTargetLocation()` | Espandere parser filter |

**Impatto espansione Cat. A**: ~35 crawler hanno filtro custom nel parser (serve modifica individuale), ~12 usano `isTargetSwissLocation()` direttamente (basta espandere il centrale), ~5 sono già pronti.

---

### 3.2 Categoria B — API/URL hardcoded a TI/GR (33 crawler)

Questi chiamano l'API con parametri fissi (regionId, keyword, location param, bounding box, city IDs). **Serve modificare il codice di ogni crawler.**

| # | Crawler | Meccanismo attuale | Modifica necessaria |
|---|---------|-------------------|---------------------|
| 1 | **abb** | `ABB_SEARCH_KEYWORDS = ['ticino','graubünden','grisons','chur','davos','engadin']` | Aggiungere keyword per ogni cantone/città (zürich, bern, basel, geneva, lausanne...) |
| 2 | **allianz** | `REGION_FILTERS = [{id:'38999405', label:'Tessin'}, {id:'38999401', label:'Graubünden'}]` | Scoprire e aggiungere ID per tutti i cantoni dall'API Umantis |
| 3 | **axa** | `REGION_FILTERS = {tessin:'68794', ostschweiz:'68792'}` (nel parser) | Espandere mappa regioni nel parser con tutti i codici Prospective |
| 4 | **axpo** | RSS globale `careers.axpo.com/jobs.rss` + `GR_CITIES` set hardcoded (**solo GR, no TI!**) | Rimuovere filtro `GR_CITIES` o espandere a tutti i cantoni |
| 5 | **board** | `CAREERS_URL` con `locations%5B%5D=56` (= Switzerland) | URL è già CH-wide! Serve solo espandere post-filter `isBoardTargetLocation()` |
| 6 | **bracco** | Workday API con `SWISS_LOCATION_IDS` (Cadempino TI + Plan-les-Ouates GE) | Aggiungere Workday location facet IDs per altre sedi |
| 7 | **cler** | API `cler.ch/.../jobssearch/search` fetcha tutto CH ma **hardcoda `canton:'TI'` per TUTTI** | Aggiungere estrazione location reale da API/detail + classificazione canton |
| 8 | **confederazione** | Prospective API `f=region:1083341` (TI) + `f=region:1083334` (Ostschweiz, filtrato a GR) | Aggiungere tutti i regionId federali (26 cantoni) |
| 9 | **coop** | Prospective API `f=30:{cantonId}` con `CANTON_IDS = {TI:'1024522', GR:'1024512'}` | Aggiungere canton IDs per tutti i cantoni |
| 10 | **decathlon** | URL `joinus.decathlon.ch/it_CH/annonces` (locale IT-CH = TI stores) + `DECATHLON_STORES` solo TI | Cambiare URL locale/region + aggiungere stores di tutti i cantoni |
| 11 | **denner** | `REGION_IDS = {'Svizzera meridionale':'871', Grigioni:'868'}` (stessa API Migros) | Aggiungere tutti i region IDs |
| 12 | **dxt** | HTML con accordion per città — **parsa solo sezione Lugano** (`LUGANO_SECTION_KEYWORDS`) | Parsare tutte le sezioni città svizzere |
| 13 | **fincons** | URL `?city=lugano` hardcoded in `LISTING_URL` | Rimuovere `city=lugano` o aggiungere query per altre città |
| 14 | **fnz** | Workday API con `SWISS_LOCATION_IDS` (Chiasso + Geneva facet IDs) | Aggiungere location facet IDs per altre sedi svizzere |
| 15 | **fust** | Prospective API `f=30:{cantonId}` con `CANTON_IDS = {TI:'1024522', GR:'1024512'}` | Aggiungere canton IDs per tutti i cantoni (stessa API di Coop) |
| 16 | **hugo-boss** | Phenom URL `?location=Coldrerio` hardcoded | Cambiare/aggiungere location params + espandere canton assignment |
| 17 | **ibsa** | URL `?locationsearch=TI%2C+CH` hardcoded | Cambiare param `locationsearch` o iterare su più cantoni |
| 18 | **ist** | TalentBrew `?locationsearch=Lugano` + ricerche GR extra | Aggiungere ricerche per altre città/cantoni |
| 19 | **julius-baer** | Workday API con facet Lugano + keyword `['Lugano','Ticino','Manno','Bellinzona']` | Aggiungere facet IDs e keyword per altre sedi (ZH, GE, etc.) |
| 20 | **lastminute** | URL `?location=chiasso` hardcoded | Cambiare location param o rimuovere filtro |
| 21 | **lidl** | `LIDL_SEARCH_SOURCES` con bounding box coords per TI + GR italiano | Aggiungere bounding box per altri cantoni |
| 22 | **mcdonalds** | `TARGET_CITY_IDS` Set con IDs specifici (Bellinzona=10596, Lugano=9701, Chur=9640...) | Aggiungere city IDs per tutte le sedi CH |
| 23 | **migros** | `REGION_IDS = {'Svizzera meridionale':'871', Grigioni:'868'}` | Aggiungere tutti i region IDs Migros (reperibili da sito careers) |
| 24 | **mikron** | URL `?location=Switzerland%2C+Agno` + `filterAgno: true` nel parser | Rimuovere filtro Agno, fetchare tutti i job CH |
| 25 | **pemsa** | URL `?_canton=125` (= Ticino) + `isPemsaTicinoRelevant()` | Aggiungere/iterare su altri canton IDs |
| 26 | **prada** | URL `?locationsearch=switzerland` + `?locationsearch=ticino`, hardcoda `canton:'TI'` | Aggiungere search per altri cantoni + canton detection |
| 27 | **rittmeyer** | URL `?location=23&country=1` (location=23 = Ticino) + `isRittmeyerTicinoListing` | Aggiungere/iterare su altri location IDs |
| 28 | **schindler** | URL `?locationsearch=Ticino` hardcoded in `SCHINDLER_SEARCH_URL` | Aggiungere search per altri cantoni |
| 29 | **skyguide** | `LISTING_URLS` con `optionsFacetsDD_location=Locarno` e `Lugano+Agno` | Aggiungere URL con altre città (Ginevra, Zurigo) |
| 30 | **swiss-medical-network** | URL con `region=${TICINO_REGION_UUID}` + hardcoda `canton:'TI'` | Aggiungere UUID per altre regioni o fetchare tutto |
| 31 | **volg** | `REGION_FILTERS = [{id:'1164264', name:'GR'}, {id:'1164274', name:'TI'}, {id:'1164278', name:'VS'}]` | Aggiungere IDs per tutti i cantoni Prospective |
| 32 | **vtg** | `REGION_IDS = {TI:'1083341', Ostschweiz1:'1083334', Ostschweiz2:'1083319'}` | Aggiungere region IDs per tutti i cantoni |
| 33 | **zurich** | `SEED_SEARCH_TERMS = ['Ticino','Tessin','Lugano','Graubünden','Grisons','Chur']` | Aggiungere search terms per tutti i cantoni/città |

**Pattern comuni tra i B**:
- 🏷️ **Prospective.ch** (coop, fust, confederazione, vtg, volg, axa): stessa API, servono i regionId/cantonId per ogni cantone
- 🏷️ **Workday** (bracco, fnz, julius-baer): servono location facet IDs per ogni sede
- 🏷️ **SuccessFactors** (schindler, ibsa, zurich): param `locationsearch=` da espandere
- 🏷️ **Keyword search** (abb, ist): aggiungere keyword per altri cantoni
- 🏷️ **URL location param** (fincons, hugo-boss, lastminute, mikron, pemsa, rittmeyer, skyguide): cambiare/iterare su param

---

### 3.3 Categoria C — Aziende solo locali TI/GR (49 crawler)

Nessun intervento necessario. Queste aziende operano esclusivamente in Ticino o Grigioni.

| # | Crawler | Sede | Cantone | Note |
|---|---------|------|---------|------|
| 1 | a-plus-plus-group | Massagno | TI | IT consulting |
| 2 | ail | Lugano | TI | Utility (Aziende Industriali Lugano) |
| 3 | aldi-suisse | Varie TI | TI | Crawler scoped a stores TI (hardcoda canton) |
| 4 | artisa | Lugano | TI | Real estate group |
| 5 | banca-sempione | Lugano | TI | Banca privata |
| 6 | bancastato | Bellinzona | TI | Banca cantonale TI |
| 7 | bps-suisse | Lugano | TI | Banca privata |
| 8 | cambiavalute | Chiasso | TI | Cambio valuta |
| 9 | casale | Lugano | TI | Engineering |
| 10 | caseificio-gottardo | Airolo | TI | Food |
| 11 | cedes | Landquart | GR | Sensor technology |
| 12 | centiel | Cadro/Lugano | TI | UPS/power systems |
| 13 | cerbios-pharma | Barbengo | TI | Pharma |
| 14 | citta-di-bellinzona | Bellinzona | TI | Municipalità |
| 15 | citta-di-locarno | Locarno | TI | Municipalità |
| 16 | citta-di-lugano | Lugano | TI | Municipalità |
| 17 | corner | Lugano | TI | Cornèr Banca |
| 18 | csc-costruzioni | Lugano | TI | Costruzioni |
| 19 | davos-klosters-bergbahnen | Davos | GR | Impianti sciistici |
| 20 | dot-life | Paradiso | TI | Hotel chain (TI only) |
| 21 | ems-chemie | Domat/Ems | GR | Chimica |
| 22 | eoc | Varie TI | TI | Ente Ospedaliero Cantonale |
| 23 | fart | Locarno | TI | Trasporti regionali |
| 24 | ferrovia-retica | Coira | GR | Ferrovia |
| 25 | goline | Stabio | TI | Software |
| 26 | grace | St. Moritz | GR | Hotel (Grace La Margna) |
| 27 | has-healthcare | Biasca | TI | Pharma |
| 28 | helsinn | Lugano | TI | Biopharma |
| 29 | kronenhof | Pontresina | GR | Hotel (Kulm Group) |
| 30 | ksgr | Coira | GR | Kantonsspital Graubünden |
| 31 | lafonte | Lugano | TI | Fondazione sociale |
| 32 | linnea | Riazzino | TI | Chimica |
| 33 | lis | Pregassona | TI | Istituti sociali Lugano |
| 34 | lwphr | TI | TI | HR consulting |
| 35 | medacta | Castel San Pietro | TI | Medical devices |
| 36 | mendrisio | Mendrisio | TI | Municipalità |
| 37 | oscam | Caslano | TI | Sanità/anziani |
| 38 | pkb-private-bank | Lugano | TI | Banca privata |
| 39 | raiffeisen-vc | Lugano | TI | Banca cooperativa locale |
| 40 | rapelli | Stabio | TI | Food (ORIOR group) |
| 41 | rivopharm | Manno | TI | Pharma |
| 42 | sintetica | Mendrisio | TI | Pharma |
| 43 | stadt-chur | Coira | GR | Amministrazione comunale |
| 44 | supsi | Lugano/Mendrisio | TI | Università |
| 45 | tarchini-group | Manno | TI | Real estate/retail |
| 46 | tich | Bellinzona | TI | Amministrazione cantonale TI |
| 47 | tinext | Lugano | TI | Digital company |
| 48 | tpl-lugano | Lugano | TI | Trasporti pubblici Lugano |
| 49 | usi | Lugano | TI | Università della Svizzera italiana |

---

### 3.4 Categoria D — Base crawler con filtro centrale (3 crawler)

Usano `runDedicatedBaseCrawler()` da `dedicated-crawler-common.mjs` che applica `isTargetSwissLocation()` centralizzato. **Basta espandere il filtro centrale.**

| # | Crawler | Note |
|---|---------|------|
| 1 | **jysk** | `jobs.de.jysk.ch/offene-stellen` — tutti CH, base crawler filtra |
| 2 | **swatchgroup** | Base crawler con adapter config |
| 3 | **vf** | Base crawler con adapter config |

---

### 3.5 Priorità crawler Tipo D-NEW (nuovi da creare)

Grandi employer in cantoni non ancora coperti:

| Priorità | Cantone | Aziende target | Volume stimato |
|----------|---------|----------------|----------------|
| 🔴 Alta | **ZH** | Stadt Zürich, ETH, UZH, Universitätsspital, Swiss Re, Swiss Life, Julius Baer (già B), Lindt | ~2.000–3.000 |
| 🔴 Alta | **BE** | Kanton Bern, Insel Gruppe, Uni Bern, Swisscom HQ (già A), Post HQ (già A) | ~1.000–2.000 |
| 🟡 Media | **VD** | EPFL, CHUV, Nestlé (Vevey), Philip Morris, Logitech | ~1.000–1.500 |
| 🟡 Media | **GE** | CERN, HUG, Pictet, Lombard Odier, Procter & Gamble | ~800–1.200 |
| 🟡 Media | **BS** | Roche, Novartis, Universitätsspital Basel, Baloise, Endress+Hauser | ~1.500–2.500 |
| 🟢 Bassa | **LU** | CSS, Emmi, Schindler (già B), Pilatus, Luzerner Kantonsspital | ~500–800 |
| 🟢 Bassa | **AG** | ABB HQ Baden (già B), Axpo HQ (già B) | ~300–500 |
| 🟢 Bassa | **SG** | Kanton SG, Kantonsspital, Bühler, Leica Geosystems | ~400–600 |

---

## Fase 4 — URL e SEO (Retrocompatibilità critica)

### 4.1 URL Migration con 301 redirect

Nuovi URL: `/cerca-lavoro-svizzera/`, `/find-jobs-switzerland/`, `/jobs-in-der-schweiz/`, `/trouver-emploi-suisse/`
Vecchi URL: redirect 301 → nuovi (mantenere 6 mesi, poi solo redirect)

**Files**: router.ts (slugs), jobsSeoPagesPlugin.ts (URL patterns), searchConsoleCompat.ts, seo-pages.ts

### 4.2 Meta tags: "Ticino" → "Svizzera"

Aggiornare title/description/keywords per job pages. Mantenere landing specifiche per Ticino come sotto-sezione.

### 4.3 Nuove landing page per cantone

`/cerca-lavoro-svizzera/zurigo/`, `/cerca-lavoro-svizzera/berna/`, etc. con structured data e sitemap.

---

## Fase 5 — UI e Filtri

### 5.1 Canton filter nel JobBoard

- Dropdown/pills filtro per cantone (26 + "Tutti")
- Filtro per regione linguistica (DE-CH, FR-CH, IT-CH)
- Rimuovere sorting hardcoded TI > GR (linea 2705-2719)

### 5.2 Mappa e statistiche

Mappa CH con heatmap per cantone, breakdown per regione.

---

## Fase 6 — Build Pipeline & Scaling

### 6.1 Pagine statiche: ~30K → ~150-300K

- `NODE_OPTIONS=--max-old-space-size=8192` in CI
- Streaming write (non bufferizzare in memoria)
- Generazione incrementale (solo pagine cambiate)

### 6.2 Translation pipeline: 200 → 1.000 jobs/run

- Aumentare `RELOCALIZE_MAX_JOBS` a 500-1000
- Parallelizzare per provider AI
- Distribuire load sui 74 modelli gratuiti

### 6.3 Orchestrator: dispatch wave regionali

Dividere 200-300 crawler in wave (TI/GR mattina, ZH/BE pomeriggio, altri sera)

### 6.4 Repo size: jobs.json 23MB → 100-200MB

- Git LFS per file JSON grandi
- O non committare dataset assemblato (generarlo solo in CI)

---

## Fase 7 — Branding

**Raccomandazione**: mantenere "Frontaliere Ticino" come brand (ha autorità SEO), job board con identity separata sotto `/cerca-lavoro-svizzera`.

---

## Stima Impatto

| Metrica | Oggi | Dopo |
|---------|------|------|
| Offerte | ~1.500 | ~8K–15K |
| Crawler | 137 | ~200–300 |
| Pagine statiche | ~30K | ~150K–300K |
| Cantoni | 2 | 26 |
| Aziende | ~113 | ~300–500 |
| Build time CI | ~10 min | ~30–60 min |
| `data/jobs.json` | 23 MB | ~100–200 MB |

## Rischi

1. **SEO regression** — 301 redirect impeccabili per migliaia di URL indicizzati
2. **Build OOM** — già problematico con 30K pagine
3. **Translation bottleneck** — limiti giornalieri dei 74 modelli gratuiti
4. **Crawler maintenance** — 300 crawler = 300 punti di rottura
5. **Brand confusion** — "Frontaliere Ticino" con lavori a Zurigo