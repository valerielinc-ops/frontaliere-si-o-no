# SEO Sprint 1 Tech Fixes — Extension 1

Data: 2026-04-22
Stato: carryover dopo completamento del perimetro tecnico principale di Sprint 1

## Chiuso in Sprint 1

- Normalizzazione condivisa dei JSON-LD applicata sia al runtime SEO sia alla build statica.
- Fix del bug di batch write/content-hash che lasciava mancanti molte pagine già presenti in sitemap.
- Aggiunti validator CLI per `hreflang`, internal links, thin pages e sitemap.
- Aggiunti test post-build per canonical, hreflang, sitemap completeness, internal links e FAQ uniqueness.
- Aggiornato `prepush` con i check tecnici stabili.
- Rigenerate le landing pages PDF guide con `hreflang` valido.
- Corretti i related links condivisi per:
  - guide root EN/DE/FR
  - salary benchmark root
  - city fuel links con `/oggi|today|heute|aujourd-hui/`
  - sibling station links con slug reali e segmenti locale-corretti

## Verifiche verdi

- `npx vitest run tests/seo/software-application-jsonld.test.ts`
- `npx vitest run tests/seo-localization.test.ts`
- `npx vitest run tests/related-links.test.ts tests/fuel-daily-stations.test.ts tests/fuel-daily-italian-cities.test.ts`
- `node scripts/validate-canonical.mjs`
- `node scripts/validate-hreflang.mjs`
- `npm run validate:sitemap-links`

## Carryover obbligatorio

### 1. Internal links ancora rotti

Stato al 2026-04-22:
- `node scripts/validate-internal-links.mjs`
- Risultato: 4430 broken links residui

Cluster residui principali:

1. `guides/*` linka a slug blog non presenti in `dist`
- Esempi:
  - `/guides/guida-completa-frontaliere-2026/ -> /articoli-frontaliere/guida-completa-frontaliere/`
  - `/guides/trovare-lavoro-ticino-frontaliere/ -> /articoli-frontaliere/trovare-lavoro-ticino/`
- Probabile fix:
  - risolvere gli slug article canonici via mappa/router condiviso, non hardcode locale IT nel plugin PDF
- File da verificare:
  - `build-plugins/pdfWhitepapersPlugin.ts`
  - `services/routerBlogData.ts`

2. Job-market / sector / recency pages linkano a path listing non generati
- Esempi:
  - `/mercato-lavoro-ticino/settimana-13-2026/ -> /cerca-lavoro-ticino/locarno/`
  - `/mercato-lavoro-ticino/settore/sanita/ -> /cerca-lavoro-ticino/sanita/`
- Probabile fix:
  - allineare i CTA/listing links solo a listing realmente emessi dal jobs build
- File da verificare:
  - `build-plugins/jobMarketSnapshotPlugin.ts`
  - plugin di recency/sector/jobs SEO che generano i listing hub

3. Molte job detail pages linkano a comparator/health path non esistente
- Esempio:
  - `... -> /compara-servizi/assicurazione-malattia/`
- Probabile fix:
  - centralizzare il path comparator corretto e riusarlo nei template job/detail
- File da verificare:
  - generatori pagine job
  - eventuali helper shared per comparator paths
  - `services/router.ts`

4. Blog contextual links continua a iniettare slug legacy/non canonici
- Segnali dal log build:
  - `/en/diesel-prices/today/`
  - `/fr/prix-diesel/aujourdhui/`
  - `/de/tessin-arbeitsmarkt/`
- Probabile fix:
  - riallineare i target del plugin contextual links alle route SEO correnti
- File da verificare:
  - `build-plugins/blogContextualLinksData.ts`
  - plugin contextual links correlato

### 2. FAQ uniqueness gate ancora fuori soglia

Stato:
- il test/validator post-build per duplicazione FAQ cross-page resta troppo rumoroso sul parco pagine generato

Cluster probabili:
- fuel pages
- salary-hub scenario pages
- weekly employers / market pages

Decisione richiesta nel prossimo step:
- mantenere il gate “strict cross-page uniqueness”
- oppure restringerlo a duplicati realmente dannosi per template cluster/canonical siblings

File/aree da verificare:
- `tests/post-build/faq-uniqueness.test.ts`
- generatori che emettono FAQ template-based

### 3. Thin pages gate non ancora promosso a blocco prepush

Stato:
- lo script esiste, ma non è ancora prudente attivarlo come gate globale senza taratura sui cluster reali

File:
- `scripts/find-thin-pages.mjs`
- `package.json`

## Ordine consigliato per la prossima sessione

1. Chiudere i broken links dei `guides/*` con mapping canonico articolo.
2. Sistemare i link generator dei job-market / sector / recency pages.
3. Correggere i target legacy del blog contextual linking.
4. Ridefinire il gate FAQ uniqueness.
5. Valutare se attivare il thin-pages gate in `prepush`.
