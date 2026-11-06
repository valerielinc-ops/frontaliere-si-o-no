# SEO Growth Plan — SEMrush Data (21 Aprile 2026)

Piano di crescita organica eseguibile **in parallelo da agent autonomi**. Ogni workstream è indipendente, con deliverables misurabili e criteri di successo chiari. Nessuna dipendenza cross-workstream eccetto dove esplicitamente dichiarata.

## Dati baseline (SEMrush, 21 Apr 2026)

- **DB Italia**: 358 keyword, 47 traffic/mese, rank 971'373
- **DB Svizzera**: 348 keyword, 41 traffic/mese, rank 367'903
- **Authority Score**: 8/100
- **Backlinks**: 5 totali da 5 referring domains (blocker principale)
- **Top competitor**: ocst.ch (1'498 kw / 3'157 traffic) — 67× il nostro traffico

## Target (90 giorni)

- Keyword top-10: da ~20 → 50+
- Traffico organico stimato: da ~90 → 500+/mese
- Authority Score: da 8 → 20+
- Backlinks: da 5 → 30+

---

# WORKSTREAM A — Fix Cannibalizzazione (Technical SEO)

**Agent**: `typescript-reviewer` + `seo`
**Dipendenze**: nessuna
**Effort**: 1-2 giorni
**Priorità**: 🔴 CRITICA (riduce ranking di TUTTE le keyword impattate)

## Problema

Molteplici URL competono per la stessa keyword, diluendo il link juice e impedendo a una singola pagina di salire in top 10.

## Task A.1 — Consolidare "casale lugano" (7 URL in competizione)

**Keyword**: `casale lugano` (volume 170)

**URL in competizione**:
1. `/cerca-lavoro-ticino/spedizione-casale-sa-lugano-ticino/` — pos 13 (master)
2. `/cerca-lavoro-ticino/hse-spezialist-casale-sa-lugano-ticino-b892fl/` — pos 39
3. `/cerca-lavoro-ticino/instrument-ingegnere-casale-sa-lugano/` — pos 49
4. `/en/find-jobs-ticino/expediter-casale-sa-lugano/` — pos 73
5. `/fr/trouver-emploi-tessin/expediteur-casale-sa-lugano-ticino/` — pos 83
6. `/en/find-jobs-ticino/company-casale-sa/` — pos 88
7. `/de/jobs-im-tessin/proposal-manager-casale-sa-lugano-ticino-slm01t/` — pos 14 (CH DB)

**Azione**:
1. Identificare/creare una **"company hub page"**: `/cerca-lavoro-ticino/azienda-casale-sa-lugano/` (+ equivalenti locales)
2. Aggiungere `<link rel="canonical">` su tutte le job detail page che puntano al hub se la keyword "casale lugano" è il principale driver di ricerca
3. **Alternativa più sicura**: lasciare canonical self-referencing sulle job detail page ma aggiungere internal link prominente dalla detail page → company hub
4. Verificare che esista `/cerca-lavoro-ticino/azienda-casale-sa/` e sia indicizzato

**Success criteria**: massimo 2 URL in competizione per "casale lugano" in SEMrush (la company hub + 1 detail page), miglioramento posizione master URL.

**Verifica**: `npx vitest run` + controllo in `services/router.ts` + query SEMrush `domain_organic` con filtro `+|Ph|Eq|casale lugano` dopo 14 giorni.

## Task A.2 — Consolidare "guess europe sagl" (6 URL)

Stesso pattern di A.1. Master candidate: `/cerca-lavoro-ticino/azienda-guess-europe-sagl/`.

URL da unificare tramite internal linking:
- 6 job detail page con posizioni 37, 55, 68, 73, 75, 83

**Azione**: company hub page + internal links from detail pages.

## Task A.3 — Consolidare calcolatori stipendio (5 URL)

**Keyword**: `calcolo stipendio netto in svizzera` (390 vol) — attualmente pos 33-60

**URL in competizione**:
1. `/` (homepage) — pos 46
2. `/calcola-stipendio/` — pos 33 (master candidate)
3. `/calcola-stipendio/quanto-guadagneresti-in-svizzera/` — pos 57
4. `/calcola-stipendio/stipendio-netto-100000-chf-residenza-entro-20km/` — pos 60
5. `/calcola-stipendio/stipendio-netto-60000-chf-residenza-entro-20km/` — pos 54

**Azione**:
1. Designare `/calcola-stipendio/` come hub principale (master)
2. Title + H1 ottimizzati: "Calcolo Stipendio Netto Svizzera 2026 — Simulatore Frontalieri"
3. Internal link dalle scenario page (100k CHF, 60k CHF) → hub con anchor "calcolatore stipendio netto"
4. Aggiungere schema `SoftwareApplication` o `WebApplication` alla hub page
5. Le scenario page restano (servono per long-tail) ma NON devono targetare la stessa keyword: devono targetare "stipendio netto 100000 chf frontaliere" (long-tail).

**Success criteria**: `/calcola-stipendio/` sale in top 10 per "calcolo stipendio netto in svizzera" entro 30 giorni.

## Task A.4 — Fix "naspi frontalieri" doppio rank

**Keyword**: `naspi frontalieri 2025` (110 vol)

**URL in competizione**:
- `/articoli-frontaliere/naspi-ex-frontalieri-2026` — pos 59 ✅ (master, più recente)
- `/articoli-frontaliere/naspi-disoccupazione-frontalieri/` — pos 81

**Azione**: 301 redirect da `naspi-disoccupazione-frontalieri` → `naspi-ex-frontalieri-2026` (o canonical se il contenuto è diverso e utile).

Location: `build-plugins/legacyRedirectsPlugin.ts`.

## Task A.5 — Audit sistematico cannibalizzazione

**Azione**:
1. Creare script `scripts/seo/detect-cannibalization.mjs` che interroga SEMrush `domain_organic` e raggruppa per keyword con ≥2 URL
2. Output: `reports/cannibalization-YYYY-MM-DD.json`
3. Integrare nel workflow settimanale `snapshot-jobs-weekly.yml`

**Deliverable**: script riutilizzabile + primo report.

---

# WORKSTREAM B — Quick Wins Content (Striking Distance)

**Agent**: `content-writer` (AI con accesso a fonti ufficiali)
**Dipendenze**: nessuna
**Effort**: 3-5 giorni
**Priorità**: 🟠 ALTA (potenziale gain 200-400 traffic/mese entro 30gg)

## Criterio di selezione

Keyword in **posizione 11-30** con **volume ≥ 200**, dove un refresh del contenuto + schema può pushare in top 10.

## Task B.1 — "festivi in ticino" / "festività ticino 2026"

**URL**: `/tasse-e-pensione/festivita-ticino/`
**Pos attuale**: 19 (IT) / 12 (CH) — vol cumulativo 2'720
**Keyword gap**: "festività ticino 2025" (1'600), "feste ticino 2025" (1'600), "festività svizzere 2025" (1'300) — ocst.ch ranka in top 25 su tutte

**Azione**:
1. Aggiornare H1/title per includere anno corrente: "Festività Ticino 2026 — Calendario Completo Giorni Festivi"
2. Struttura page:
   - Calendario 2026 con date + giorni della settimana
   - Tabella differenze Ticino vs. resto della Svizzera
   - FAQ: "Il 1° agosto è festivo? Cosa succede se un festivo cade di sabato?"
   - Schema `Event` per ciascun festivo (JSON-LD)
   - Schema `FAQPage` con domande comuni
3. Creare variante dedicata `/tasse-e-pensione/festivita-ticino-2026/` + canonical
4. Internal link dalla homepage + `/tasse-e-pensione/` hub
5. **Produrre in 4 locales** (IT/EN/DE/FR) — CH-DB mostra "feiertage tessin" (DE) a pos 15

**Success criteria**: top 10 su ≥2 varianti "festività ticino/feste ticino/festivi in ticino" entro 30 giorni.

## Task B.2 — "mappa confine italia svizzera"

**URL**: `/guida-frontaliere/mappa-confine/`
**Pos**: 14, vol 260

**Azione**:
1. Integrare **mappa interattiva Leaflet** (già usata nel progetto) con tutti i valichi
2. Aggiungere schema `Place` con `geo` coordinates per ciascun valico
3. Aggiungere tabella comparativa: apertura, code tipiche, auto/pedoni, telecamera live
4. Ottimizzare immagini con `alt` descrittivo + dimensioni
5. Internal linking da ogni pagina `/guida-frontaliere/tempi-attesa-dogana/*`

**Success criteria**: top 10 entro 30 giorni, CTR ≥6%.

## Task B.3 — Pagine dogana Brogeda / Chiasso

**URLs**:
- `/guida-frontaliere/tempi-attesa-dogana/chiasso-brogeda/` (pos 22 per "valico brogeda", vol 480)
- `/guida-frontaliere/tempi-attesa-dogana/chiasso-centro/` (pos 10 per "traffico dogana chiasso")
- `/de/grenzgaenger-ratgeber/wartezeiten-grenze/chiasso-strada` (pos 2-3 DE!)

**Keyword opportunity**: "chiasso zoll" (pos 44, vol 1'000), "chiasso dogana" (pos 65, vol 880), "dogana chiasso strada" (pos 37, vol 1'000)

**Azione**:
1. Espandere ogni border wait page con:
   - Tempi medi per fascia oraria (da dati storici reali)
   - Webcam embed (se consentito legalmente)
   - Percorsi alternativi con mappa
   - FAQ specifica per valico
2. Applicare lo stesso template a tutti i valichi (già esiste `borderWaitPagesPlugin.ts`)
3. Schema `Place` + `TouristAttraction` per ciascuno

**Success criteria**: 3+ pagine dogana in top 10 entro 60 giorni.

## Task B.4 — Company hub "medacta international sa rancate"

**Keyword**: `medacta international sa rancate` (vol 1'300!)
**URL attuali**: 3 job detail page, best pos 24

**Azione**:
1. Creare company hub `/cerca-lavoro-ticino/azienda-medacta-international-sa/`
2. Contenuto: descrizione azienda, sede, dimensioni, settore, ruoli tipici, link a tutte le loro offerte
3. Schema `Organization` + lista `JobPosting` aggregate
4. Internal link dalle job detail page

**Pattern replicabile**: applicare a tutte le aziende con ≥3 job detail e volume keyword ≥500.

**Success criteria**: posizione ≤15 per "medacta international sa rancate" entro 45 giorni.

## Task B.5 — Espandere `/compara-servizi/costo-della-vita/`

**Pos**: 7 per "costo vita svizzera vs italia" (vol 70) — GIÀ in top 10, ma piccolo volume
**Opportunità**: "supermercati in svizzera" (260 vol, pos 65), "quanto costa la vita in svizzera" (320 vol, pos 59)

**Azione**:
1. Aggiungere tabelle aggiornate (basket Lugano vs Como, Bellinzona vs Milano)
2. Sezione "Supermercati in Svizzera: prezzi 2026" (intercetta "supermercati in svizzera")
3. FAQ schema
4. Grafici Recharts con serie storica

---

# WORKSTREAM C — New Landing Pages (Keyword Gap vs Competitor)

**Agent**: `content-writer` + `seo` + `architect`
**Dipendenze**: nessuna (ma evitare conflitti con Workstream B sulle stesse URL)
**Effort**: 5-7 giorni
**Priorità**: 🟠 ALTA (aggredisce 8'500+ volume totale)

## Criterio

Keyword con **volume ≥500**, ocst.ch/beecare.ch/asiticino.ch ranka in top 30, noi non rankiamo.

## Task C.1 — "tassa salute frontalieri"

**Vol**: 1'600 — ocst.ch pos 8
**URL da creare**: `/guida-frontaliere/tassa-salute-frontalieri/` (+ 4 locales)

**Contenuto**:
1. Cos'è la tassa salute per frontalieri (introdotta con Nuovo Accordo 2026)
2. Chi è soggetto, chi è esente
3. Importo 2026 con fonte ufficiale + calcolatore inline
4. Come viene trattenuta
5. Confronto con LAMal
6. FAQ + schema `FAQPage`

**Schema obbligatori**: `Article`, `FAQPage`, `BreadcrumbList`, `HowTo` (se applicabile)

**Success criteria**: top 20 entro 60 giorni, top 10 entro 90.

## Task C.2 — "LAMal frontalieri"

**Keyword cluster**: "lamal" (590 vol, pos 41), "assicurazione malattia frontalieri", "busta paga svizzera per frontalieri" (pos 62)
**URL**: esiste `/glossario-frontaliere/lamal/` → espandere + creare articolo pillar

**Azione**:
1. Creare **pillar page** `/guida-frontaliere/lamal-frontalieri/`
2. Spiegazione completa LAMal, diritto di opzione per frontalieri
3. Calcolatore premi (già esiste `healthPremiumsLanding` plugin — leverage)
4. Confronto con sanità italiana
5. Link da glossario → pillar

## Task C.3 — "outlet svizzera fox town"

**Vol**: 1'300 — ocst.ch pos 66
**URL da creare**: `/vita-in-ticino/outlet-svizzera-fox-town-mendrisio/`

**Nota**: potenzialmente **affiliate-friendly** (Fox Town Mendrisio può avere programma partner).

**Contenuto**:
1. Guida Fox Town: orari, brand, parking, trasporti
2. Sconti medi, periodi migliori
3. Come arrivare da Italia (frontalieri-centric)
4. Alternativa: altri outlet in Svizzera italiana
5. Schema `ShoppingCenter` / `Place`

## Task C.4 — "frontaliere" / "frontalieri" (keyword head)

**Vol combinato**: 6'700 — ocst.ch rankato in coda (pos 65, 89)
**Difficulty**: media ma fattibile con pagina pillar + link interni

**URL**: `/` (homepage) deve targetare "frontalieri svizzera" come keyword principale, `/guida-frontaliere/` deve targetare "frontaliere" come definizione

**Azione**:
1. Homepage: H1 e meta description con "frontalieri Svizzera"
2. `/guida-frontaliere/` → pillar esaustivo: definizione, status giuridico 2026, permessi, tasse, sanità, pensione
3. Table of contents con anchor navigation
4. Schema `Article` + `BreadcrumbList` + `HowTo`
5. Link interni da TUTTE le pagine `/guida-frontaliere/*` al pillar

## Task C.5 — Calendario eventi / festività espansi

Dato il forte segnale su keyword "festività YYYY", creare **template annuale**:
- `/tasse-e-pensione/festivita-ticino-2026/`
- `/tasse-e-pensione/festivita-svizzera-2026/`
- `/vita-in-ticino/ponti-2026-ticino/` (nuovo — intercetta "ponti festivi 2026")
- `/vita-in-ticino/vacanze-scolastiche-ticino-2026/` (intercetta "vacanze scolastiche ticino")

Plugin suggerito: `build-plugins/holidayCalendarPlugin.ts` per generarle automaticamente ogni anno.

## Task C.6 — Cambio valuta CHF/EUR (alto volume, bassa pos)

**Keyword cluster**: "cambia valute ch" (3'600 vol, pos 48), "cambio valute ch" (2'900 vol, pos 86), "cambio valuta ch" (2'400 vol, pos 74)
**URL esistente**: `/compara-servizi/cambio-franco-euro/`

**Azione**:
1. Widget cambio **live** (API: exchangerate-api.com o simili) — già presente?
2. Tabella confronto spread banche/broker/servizi online (Revolut, Wise, UBS, Raiffeisen)
3. Grafico storico 12 mesi (Recharts)
4. Calcolatore commissioni
5. Aggiornamento giornaliero automatico via GitHub Action
6. Schema `ExchangeRateSpecification`

---

# WORKSTREAM D — Internal Linking & Technical

**Agent**: `typescript-reviewer`
**Dipendenze**: beneficia dei risultati di Workstream A (consolidamento master URL)
**Effort**: 2-3 giorni

## Task D.1 — Audit internal link graph

**Azione**: script `scripts/seo/internal-link-audit.mjs` che:
1. Crawla tutto `dist/` dopo build
2. Costruisce grafo (node=URL, edge=link)
3. Calcola per ogni URL:
   - inbound count
   - outbound count
   - PageRank score iterativo
4. Identifica **orphan pages** (0 inbound) + **over-linked footer links**
5. Output report con top-20 URL sottolinkate rispetto al loro ranking SEMrush

**Uso**: prioritizzare internal links sulle pagine con buon ranking SEMrush ma poche inbound.

## Task D.2 — Boilerplate breadcrumb su tutte le pagine

Verificare `components/Breadcrumb.tsx` esiste e sia applicato con schema `BreadcrumbList`. Target: 100% delle pagine generate.

**Test**: aggiungere test in `tests/seo/breadcrumb-coverage.test.ts` che asserisce presenza schema su tutte le URL in `dist/`.

## Task D.3 — Schema audit completo

**Azione**:
1. Script `scripts/seo/schema-audit.mjs` che estrae tutti gli schema JSON-LD da `dist/`
2. Valida contro schema.org
3. Tabella: URL vs. schema presenti
4. Identifica tipi mancanti per tipo di pagina:
   - Article pages → `Article`, `BreadcrumbList`, `FAQPage` (se FAQ presente)
   - Job pages → `JobPosting` + `BreadcrumbList`
   - Calculator pages → `SoftwareApplication` + `BreadcrumbList`
   - Border pages → `Place` + `BreadcrumbList`
   - Comparison pages → `ItemList` + `BreadcrumbList`

## Task D.4 — Title tag audit & fix

**Problema**: molte pagine top job detail hanno title con nome azienda ripetuto, non ottimizzati per keyword search volume.

**Azione**:
1. Script che estrae `<title>` da ogni pagina in `dist/`
2. Crossa con ranking SEMrush → identifica title che non contengono le keyword su cui la pagina ranka
3. Genera patch suggerite (review manuale)

## Task D.5 — Meta description audit

Stesso pattern di D.4 per `<meta name="description">`. Ogni pagina indicizzata deve avere meta description unica, 140-160 char, contenente keyword target.

---

# WORKSTREAM E — Link Building & Authority (Prep)

**Agent**: `marketing` / `pr-outreach` (richiede interazione umana per invio)
**Dipendenze**: nessuna
**Effort**: ongoing (outreach richiede settimane/mesi)
**Priorità**: 🔴 CRITICA nel lungo periodo (senza backlinks non si scala)

## Task E.1 — Asset di linkbait (autonomo)

Creare **3 asset ad alta linkabilità** entro 30 giorni:

### E.1a — Report originale "Mercato del lavoro frontalieri Ticino 2026"
- Dati aggregati dai crawler job board esistenti
- Grafici: salari medi per settore, città con più offerte, aziende top
- Visualizzazioni interattive (Recharts)
- Download PDF
- URL: `/reports/mercato-lavoro-frontalieri-ticino-2026/`
- Aggiornamento mensile

### E.1b — Calcolatore comparativo definitivo
- "Quanto guadagni davvero come frontaliere vs. residente in Svizzera"
- Già presente calculator engine → estendere con risultati condivisibili
- URL condivisibili social (`/simulazione-risultato/[hash]`)
- Schema `SoftwareApplication`

### E.1c — Mappa interattiva valichi con live data
- Tempi di attesa attuali per tutti i valichi
- Storia 7 giorni
- Best practices (orario ottimale)
- Embed code per altri siti (link wanted back)
- URL: `/guida-frontaliere/mappa-live-valichi/`

## Task E.2 — Prospect list outreach

**Agent autonomo**: può generare la lista, l'invio resta manuale.

Output file: `docs/outreach/prospect-list-YYYY-MM-DD.csv`

**Categorie**:
1. **Media ticinesi**: tio.ch, cdt.ch, laregione.ch, ticinolibero.ch, corriere.ch
2. **Media italiani di frontiera**: laprovinciadicomo.it, ilgiorno.it (Como/Varese), eco di bergamo
3. **Forum frontalieri**: forumfrontalieri.it, facebook groups
4. **Associazioni**: OCST (competitor ma partnership possibile), VPOD, ACLI Ticino
5. **Blog/influencer finanza personale**: moneyfarm.it, rivaluta.it, spaziofinanza
6. **Siti B2B Svizzera**: jobcloud.ch, stepstone.ch (per partnership job feed)

Per ogni prospect:
- URL contatto
- Authority Score (da SEMrush API)
- Topic editoriale
- Angolo pitch specifico
- Asset di nostro interesse da offrire

## Task E.3 — Guest post pitches

10 pitch pronti con angolo specifico per ciascun target media. Ogni pitch include:
- Titolo proposto
- Outline 300 parole
- Bio autore
- Link target

## Task E.4 — Digital PR: studio annuale

Pianificare comunicato stampa per **dato originale** (Maggio 2026):
- Dataset: salari aggregati da crawler job board
- Angolo: "Stipendi frontalieri Ticino: +X% YoY, top 10 aziende che assumono"
- Invio: lista media ticinesi + italiani (prima settimana mese)

---

# WORKSTREAM F — Monitoring & Tracking

**Agent**: `devops` / `analytics`
**Dipendenze**: nessuna
**Effort**: 1-2 giorni

## Task F.1 — Dashboard SEMrush in-repo

**Azione**:
1. Script `scripts/seo/semrush-snapshot.mjs` che salva:
   - `domain_rank` (IT + CH, weekly)
   - Top 50 keyword (weekly)
   - Competitor overview (monthly)
2. Storage: `data/seo-snapshots/YYYY-MM-DD.json`
3. Workflow `.github/workflows/semrush-weekly-snapshot.yml` (cron: lunedì 06:00 UTC)

## Task F.2 — Alerting su drop ranking

Se una keyword in top 10 perde >5 posizioni → open GitHub issue automatico con label `seo-alert`.

## Task F.3 — Report cumulativo settimanale

Generare `docs/seo-reports/week-YYYY-WW.md` con:
- Delta keyword in top 3/10/20/50
- Nuove keyword entrate in top 100
- Keyword uscite da top 100
- Delta traffic stimato
- Authority Score evolution
- Nuovi backlinks

---

# WORKSTREAM H — Site Audit Fixes (SEMrush Technical)

**Agent**: `typescript-reviewer` + `build-error-resolver`
**Dipendenze**: nessuna (fixes indipendenti l'uno dall'altro)
**Effort**: 2-3 giorni
**Priorità**: 🔴 CRITICA (Quality Score 88 → target 95+)

## Fonte dati
SEMrush Site Audit snapshot `69e74b825753bf1b853c8d6f` — 100/100 pagine crawlate, 43'160 checks.

**Score baseline**:
- Quality Score: 88/100
- AI Search Score: 93/100
- Markups: 90 (driver: SOFTWARE_APP errors)

## Task H.1 — Fix Structured Data `SOFTWARE_APP` (29 errori) 🔴

**Issue ID**: 45 (top issue del sito)

**Root cause**: Schema `SOFTWARE_APP` richiede `aggregateRating` + `review` obbligatori; alcune pagine hanno anche `offers` mancante; `speakable` non riconosciuto.

**Pagine colpite** (29 + 1 pagina con errori multipli):
- `/calcola-stipendio/` (root hub) — 5 errori (offers + aggregateRating + review)
- `/calcola-stipendio/stipendio-netto-{60000,80000,100000,120000}-chf/`
- `/calcola-stipendio/simula-busta-paga/` (speakable)
- `/calcola-stipendio/cosa-cambia-se/`
- `/calcola-stipendio/stima-bonus-frontaliere/`
- `/calcola-stipendio/simula-cambio-residenza/`
- `/calcola-stipendio/verifica-congedo-parentale/`
- `/calcola-stipendio/confronta-retribuzione-ral/`
- `/compara-servizi/costo-della-vita/`
- `/compara-servizi/confronta-prezzi-spesa/`
- `/compara-servizi/confronta-operatori-mobili/` (speakable)
- `/compara-servizi/confronta-offerte-lavoro/`
- `/compara-servizi/confronta-casse-malati/`
- `/compara-servizi/confronta-banche/`
- `/compara-servizi/cambio-franco-euro/` (speakable)
- `/compara-servizi/calcola-bonus-ristrutturazione/`
- `/tasse-e-pensione/simula-terzo-pilastro/`
- `/tasse-e-pensione/calcola-previdenza/`
- `/guida-frontaliere/mappa-confine/`
- `/guida-frontaliere/costo-auto-pendolare/`
- `/guida-frontaliere/confronta-permesso-g-vs-b/`
- `/vivere-in-ticino/trasporti-frontalieri/`
- `/vivere-in-ticino/confronta-asili-nido/`

**Decisione di strategia (scegliere UNA delle tre opzioni)**:

**Opzione A — Cambiare schema a `WebApplication`** (consigliata)
`WebApplication` è valido senza review/rating per strumenti interattivi. Fix più pulito senza dati sintetici.

**Opzione B — Aggiungere rating/review reali**
Implementare sistema di recensioni on-page (Firestore-backed). Più lavoro ma porta rich results.

**Opzione C — Rimuovere lo schema**
Rinuncia a rich results ma pulisce gli errori.

**Azione consigliata**:
1. Grep `services/` + `build-plugins/` per `SOFTWARE_APP` / `SoftwareApplication`
2. Sostituire con `WebApplication` (stesso schema tree, meno campi required) oppure `HowTo` per i calcolatori step-by-step
3. Rimuovere `speakable` (non più supportato da Google per questi schema)
4. Aggiungere test `tests/seo/structured-data-validation.test.ts` che valida ogni schema generato contro jsonld-schema.org

**Success criteria**: 0 errori ID 45 in prossimo snapshot SEMrush.

## Task H.2 — Fix Hreflang Conflicts (30 errori) 🔴

**Issue ID**: 24

**Root cause**: Le hub pages IT hanno `hreflang="it"` + `hreflang="x-default"` con conflitti (errorType 5 = conflict, errorType 7 = empty).

**Pagine colpite** (tutte hub top-level):
- `/tasse-e-pensione`, `/privacy`, `/mappa-del-sito`, `/guida-frontaliere`
- `/glossario-frontaliere`, `/domande-frequenti-frontalieri`, `/contattaci`
- `/compara-servizi`, `/chi-siamo`, `/articoli-frontaliere`

**Azione**:
1. Audit di `services/seoService.ts` — cercare generazione hreflang
2. Verificare che le pagine IT abbiano ESATTAMENTE:
   - `<link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/[path]">`
   - `<link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/[path]">`
   - `<link rel="alternate" hreflang="de" href="https://frontaliereticino.ch/de/[path]">`
   - `<link rel="alternate" hreflang="fr" href="https://frontaliereticino.ch/fr/[path]">`
   - `<link rel="alternate" hreflang="x-default" href="https://frontaliereticino.ch/[path]">`
3. Rimuovere eventuali duplicati (possibile doppia iniezione SSR + client-side)
4. Nessun hreflang deve avere `href=""` (errorType 7)
5. Test `tests/seo/hreflang-consistency.test.ts`:
   - Ogni pagina IT deve avere 5 tag hreflang
   - Nessun href vuoto
   - x-default deve esistere
   - URL consistenti

**Success criteria**: 0 errori ID 24, `badPages` in hreflang stats da 10 → 0.

## Task H.3 — Fix Broken Internal Links (404) 🔴

**Issue ID**: 2 + 8

**URL 404 linkate dalla homepage**:
- `/stato-api/`
- `/servizi-partner/`
- `/consulenza/`

**Azione**:
1. Grep `App.tsx` + componenti homepage per questi URL
2. **Scelta per ogni URL**:
   - `/stato-api/` → probabilmente dev/debug page, rimuovere link dalla nav pubblica
   - `/servizi-partner/` → creare pagina se roadmap prevede partnerships, altrimenti rimuovere
   - `/consulenza/` → idem
3. Se rimossi, aggiungere 301 redirect in `build-plugins/legacyRedirectsPlugin.ts` verso homepage/contact
4. Aggiungere test `tests/seo/no-broken-internal-links.test.ts` che crawla `dist/` e verifica tutti i link interni

**Success criteria**: 0 URL in 4xx, 0 broken internal links.

## Task H.4 — Normalizzare Trailing Slash 🟠

**Issue**: Semrush tratta come URL distinte le versioni con/senza trailing slash:
- `https://frontaliereticino.ch` vs `https://frontaliereticino.ch/`
- `/articoli-frontaliere` vs `/articoli-frontaliere/`
- Pattern visibile in multiple issue (105, 112, 117, 223)

**Impatto**: raddoppia la maggior parte degli errori (hreflang, duplicate H1, low word count appaiono 2×).

**Azione**:
1. Definire regola canonical: **sempre trailing slash** (già usata nelle route dinamiche)
2. Aggiornare `public/_redirects` (o 404.html GitHub Pages redirect) per forzare trailing slash
3. Rigenerare sitemap con trailing slash consistente
4. Aggiornare `services/router.ts` → `buildPath()` per normalizzare
5. Test `tests/seo/trailing-slash-consistency.test.ts`

**Success criteria**: ogni path appare 1× in dist, tutti i `<link rel="canonical">` e sitemap usano stessa forma.

## Task H.5 — Espandere Low Word Count Pages 🟠

**Issue ID**: 117 (20 pagine <200 parole)

**Top 10 più urgenti** (altre sono policy/admin, meno prioritarie):

| URL | Words | Azione |
|---|---|---|
| `/glossario-frontaliere` | 118 | Aggiungere intro 300w + 3 FAQ prima della lista termini |
| `/tasse-e-pensione/quiz-fiscale/` | 120 | Intro esplicativa + spiegazione di ogni domanda |
| `/vivere-in-ticino/aziende-svizzera-italiana/` | 126 | Espandere con dati da crawler (settori, dimensioni, salari medi) |
| `/vivere-in-ticino/attrazioni-svizzera-italiana/` | 127 | Contenuto editoriale 500w + mappa + foto |
| `/vivere-in-ticino/trasporti-frontalieri/` | 128 | Guida treni/auto/car-sharing dettagliata |
| `/vivere-in-ticino/confronta-asili-nido/` | 130 | Introduzione comparativa + metodologia |
| `/statistiche/migliori-comuni-frontiera/` | 130 | Metodologia classifica + caso-studio |
| `/guida-frontaliere/mappa-confine/` | 132 | Guida valichi pratica (vedi anche B.2 duplicato) |
| `/guida-frontaliere/costo-auto-pendolare/` | 133 | Casi studio numerici + tabelle |
| `/compara-servizi/confronta-offerte-lavoro/` | 147 | Spiegazione metodologia + esempi |

Target: 500+ parole per ogni pagina.

**Success criteria**: 0 pagine <300 parole (rilassato da 500), 18 → 0 issues ID 117.

## Task H.6 — Fix Duplicate H1/Title (18 pagine) 🟠

**Issue ID**: 105

**Root cause**: H1 è identico al `<title>`. SEO best practice: H1 deve essere variante del title (più lungo, più descrittivo).

**Azione per ciascuna pagina in H.5**:
- Title: keyword-dense, <60 char (es. "Quiz Fiscale Frontalieri | Testa le Tue Conoscenze")
- H1: più descrittivo, <100 char, include keyword principale + secondaria (es. "Quiz fiscale frontalieri 2026 — 20 domande sulle tasse CH-IT con risposte spiegate")

Output: mappa in `services/pageMetadata.ts` o simili.

**Success criteria**: 0 pagine con H1 = title (issue ID 105 = 0).

## Task H.7 — Fix Low Text/HTML Ratio 🟡

**Issue ID**: 112 (3 pagine)

- `/articoli-frontaliere/` (ratio 0.09) → HTML molto pesante rispetto al testo
- `/vivere-in-ticino/confronta-asili-nido/` (0.09)

**Azione**:
1. Minificare HTML output (Vite plugin `html-minifier-terser`)
2. Lazy load component React pesanti fuori viewport
3. Aggiungere contenuto testuale strutturato (intro, FAQ, conclusioni)

## Task H.8 — Compression check 🟡

**Issue ID**: 131 (80 pagine, cioè TUTTE)

**Verifica rapida**:
```bash
curl -sI -H "Accept-Encoding: br,gzip" https://frontaliereticino.ch/ | grep -i content-encoding
```

**Se risultato è vuoto** (non compresso): problema reale, configurare compression nel build pipeline o considerare CDN (Cloudflare davanti a GitHub Pages).

**Se gzip/br presente**: falso positivo del crawler SEMrush, documentare e ignorare.

## Task H.9 — Rimuovere pagine "Pagina archiviata" 🟡

**Issue ID**: 4 (4 pagine)

URL interessate (già `robots: noindex`, OK):
- `/vivere-in-ticino/vivere-in-svizzera/`
- `/statistiche/traffico-dogane/`
- `/guida-frontaliere/comuni-di-frontiera/`
- `/calcola-stipendio/confronta-permesso-g-vs-b/`

**Azione**: valutare se queste pagine siano ancora necessarie. Se no:
1. Rimuovere dal build
2. 301 redirect verso pagine corrispondenti attive
3. Rimuovere dal sitemap
4. Aggiornare `robots.txt` disallow se necessario

## Task H.10 — Monitoring Site Audit automatico

Aggiungere a Workstream F.1:

```js
// scripts/seo/semrush-site-audit.mjs
// 1. GET latest snapshot
// 2. Save to data/seo-snapshots/site-audit-YYYY-MM-DD.json
// 3. Diff vs previous → report nuovi issues in report settimanale
// 4. Fail workflow se: errors > baseline, oppure quality score < 85
```

GitHub Action settimanale. Alert automatico se Quality Score scende.

---

# Priority Ranking per Workstream H

| Task | Issue count | Difficoltà | Impact | Ordine esecuzione |
|---|---|---|---|---|
| H.1 Fix SOFTWARE_APP | 29 | Media | Alto (rich results) | 1 |
| H.2 Fix Hreflang | 30 | Media | Alto (international SEO) | 2 |
| H.3 Fix 404 broken links | 6 | Bassa | Medio | 3 |
| H.4 Trailing slash | ~40 collateral | Media | Alto (consolida metric) | 4 |
| H.5 Espandere low word count | 20 | Alta (content) | Alto | 5 (parallelo a B/C) |
| H.6 Fix H1/title | 18 | Bassa | Medio | 6 |
| H.7 Text/HTML ratio | 3 | Bassa | Basso | 7 |
| H.8 Verifica compression | 80 | Bassa (verifica) | Basso se falso positivo | 8 |
| H.9 Archived pages | 4 | Bassa | Basso | 9 |
| H.10 Monitoring | — | Bassa | Alto (prevenzione) | 10 (preemptive) |

Target Site Audit score post-Workstream H: **95+/100** (da 88 attuale).

---

# WORKSTREAM G — Translation Quality Audit

**Agent**: `translation-quality`
**Dipendenze**: nessuna
**Effort**: 2-3 giorni

## Contesto

Le job page locales (EN/DE/FR) rankano molto peggio delle versioni IT, con casi di traduzioni letterali che hanno perso senso ("expediter-casale-sa-lugano", "beschleuniger-casale-sa-lugano" per "spedizione casale sa lugano").

## Task G.1 — Audit job slug translations

**Azione**:
1. Script che analizza tutti gli slug in `data/jobs.json` + locales
2. Flagga: traduzioni letterali + nomi aziende tradotti (vedi memory: never translate brands)
3. Report: `docs/seo-reports/slug-quality-audit.md`

## Task G.2 — Fix top 50 job slug EN/DE/FR

Per le 50 job page con maggior volume keyword potenziale (da SEMrush), correggere slug traducendo correttamente o mantenendo originale IT.

## Task G.3 — Audit meta translations

Applicare stesso audit a `title` e `description` tradotti. Spesso sono copie letterali che non ottimizzano per intent locale.

---

# Execution — Parallelismo Massimo

## Dipendenze reali

```
A (cannibalizzazione) ──┐
                        ├─→ D (internal linking)
B (quick wins)      ────┤
                        │
C (new pages)       ────┘

E (link building)  — completamente indipendente
F (monitoring)     — deve partire PRIMA di tutti per avere baseline
G (translations)   — completamente indipendente
```

## Launch sequence consigliata

**Giorno 0**: Spawn F.1 + F.2 (baseline tracking).

**Giorno 1**: Spawn in parallelo (fino a 4 agent simultanei come da memory feedback):
- Agent 1 → Workstream A (cannibalization)
- Agent 2 → Workstream B (quick wins)
- Agent 3 → Workstream E.1 (linkbait asset)
- Agent 4 → Workstream G (translations)

**Giorno 5**: Al completamento di A/B, spawn:
- Agent 1 → Workstream C (new pages)
- Agent 2 → Workstream D (internal linking)
- Agent 3 → Workstream E.2/E.3 (prospect + pitch)

**Settimanale**: Workstream F genera reports automatici.

## Success metrics (90 giorni)

| Metrica | Baseline (21 Apr) | Target (20 Lug) |
|---|---|---|
| Keyword in top 10 | ~5 | ≥25 |
| Keyword in top 20 | ~15 | ≥60 |
| Traffico stimato SEMrush (IT+CH) | 88 | ≥500 |
| Backlinks | 5 | ≥30 |
| Authority Score | 8 | ≥20 |
| Pagine indicizzate con schema FAQ | ? | 50+ |

## Rule di esecuzione per gli agent

1. **Sempre**: test + build + push dopo ogni task (da CLAUDE.md auto-push rule)
2. **Sempre**: 4 locales per ogni nuovo contenuto (IT/EN/DE/FR)
3. **Sempre**: schema JSON-LD + breadcrumb + static HTML
4. **Mai**: abbassare threshold di test/validation (NON-NEGOTIABLE RULES)
5. **Mai**: creare contenuto thin (<500 parole body)
6. **Mai**: tradurre nomi brand/aziende (vedi memory `feedback_never_translate_brands`)
7. **Sempre**: usare `model: "opus"` per subagent
8. **Sempre**: dopo change su pagine già rankate, monitorare drop in top 50 per 14 giorni (Workstream F)

## Artifact obbligatori per ogni workstream

Ogni agent al completamento deve produrre:
1. Git branch `seo/[workstream]-[task-id]` con commits atomici
2. PR con descrizione dettagliata, before/after metrics stimate, test plan
3. Update a questo file: checkbox su task completato
4. Entry in `docs/seo-reports/completed-tasks.md` con data, impatto atteso, URL review SEMrush a 30/60/90gg

## File correlati (pre-esistenti)

- `docs/SEO-RULES.md` — regole canonical + structured data
- `docs/seo-action-plan-apr2026.md` — piano precedente (GSC-based)
- `docs/seo-canonical-bing-migration.md` — migration canonical history
- `build-plugins/healthPremiumsLandingPlugin.ts` — leverage per C.2
- `build-plugins/orphanQueryLandingPlugin.ts` — pattern per C.*
- `services/router.ts` — slug tables da aggiornare per ogni nuova URL

## Stop conditions (fallback umano)

Un agent deve escalare a review umana se:
- Authority Score rimane <12 dopo 45 giorni (link building non funziona)
- Qualsiasi keyword in top 3 esce da top 10 dopo un suo change (rollback immediato)
- Test fallisce dopo 3 retry automatici (possibile problema architetturale)
- Build time aumenta >30% (possibile page bloat)

---

## Generato
- Data: 2026-04-21
- Fonte dati: SEMrush API (DB `it` + `ch`, snapshot 21 Aprile 2026)
- Authority Score baseline: 8/100 (5 backlinks da 5 referring domains)
- Prossima revisione: 2026-05-21 (30 giorni)
