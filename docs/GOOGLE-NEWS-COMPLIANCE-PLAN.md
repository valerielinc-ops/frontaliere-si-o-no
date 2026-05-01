# Google News & Discover Compliance — Piano d'azione (v5)

**Data audit**: 2026-04-30
**Versione**: 5.0 (corretta dopo verifica sitemap reali dei competitor — il volume non è il problema)

**Fonti**:
- [Semrush — Google News SEO](https://www.semrush.com/blog/google-news-seo/)
- [SearchAtlas — Google News SEO](https://searchatlas.com/blog/google-news-seo/)
- [Google Publisher Center — Technical requirements](https://support.google.com/news/publisher-center/answer/9607104)
- [Google News content policies](https://support.google.com/news/publisher-center/answer/6204050)
- [Lumar — Google News SEO](https://www.lumar.io/blog/best-practice/google-news-seo/)
- [Search Engine Land — Google News optimization](https://searchengineland.com/google-news-optimization-boost-content-visibility-traffic-395031)
- [How Google News works (Google ufficiale)](https://www.google.com/search/howsearchworks/how-news-works/)
- [SEO for Google News (Barry Adams)](https://www.seoforgooglenews.com/)
- [Google Discover Core Update — Febbraio 2026](https://developers.google.com/search/blog/2026/02/discover-core-update)
- [LinkedIn — Discover signals fin 2025/2026](https://www.linkedin.com/pulse/google-discover-fin-2025-2026-signaux-locaux-related-auteurs-andell-wriff/)
- [Intervista Barry Adams (Roberto Serra, ago 2025)](https://www.roberto-serra.com/news/intervista-barry-adams-agosto-2025/)

**Obiettivo**: Rendere `frontaliereticino.ch` eleggibile per Google News, Top Stories carousel, e Discover su query frontaliere/fiscali ticinesi — e difendere il traffico contro AI Mode/AI Overviews.

---

## 0. Calibrazione su esempi reali in Google News IT (v3)

Per validare le assunzioni del piano sono stati analizzati due articoli realmente presenti su Google News IT con query frontalieri/Ticino:

### 0.1 Articolo 1 — RSI (`rsi.ch`)

URL: `rsi.ch/info/ticino-grigioni-e-insubria/Frontalieri-tassa-sulla-salute-al-via-entro-settembre-3689550.html`

| Caratteristica | Valore osservato |
|---|---|
| Publisher | RSI — Radiotelevisione Svizzera Italiana (broadcaster pubblico) |
| Headline | "Frontalieri, "tassa sulla salute" al via entro settembre" (~58 char, ~9 parole) |
| Author | `meta name=author` = `sdr` (iniziali editor, NO Person, NO bio link) |
| **JSON-LD** | **Nessuno** (zero schema markup!) |
| `article:published_time` | `2026-04-23` (7 giorni prima — fuori finestra 48h) |
| `dateModified` visibile | "23 aprile, 22:47" + "24 aprile, 09:57" (doppia data visibile) |
| Hero image | 1300×731, 16:9 ✓ |
| Article body word count | 683 parole |
| `og:image`, `twitter:summary_large_image` | presenti |
| Topic | frontalieri salute (perfetto match nicchia) |

### 0.2 Articolo 2 — ComoZero (`comozero.it`)

URL: `comozero.it/attualita/ticino-dumping-salariale-annuncio-frontalieri-mozione-sirica/`

| Caratteristica | Valore osservato |
|---|---|
| Publisher | ComoZero — "Il portale di informazione della provincia di Como" (WordPress + Yoast) |
| Headline | "L'offerta di lavoro da 2900 franchi è solo per frontalieri…" (102 char, 17 parole) |
| Author schema | `Person` con `name: "Redazione"`, foto Gravatar, **nessun bio link**, **nessun KG/sameAs** |
| Schema type | **`Article` generico** (NON `NewsArticle`) |
| Publisher schema | **`Organization` generico** (NON `NewsMediaOrganization`) |
| `datePublished` | `2026-04-27` (3 giorni prima — fuori finestra 48h) |
| `dateModified` | uguale a `datePublished` |
| `wordCount` schema | 413 (esattamente al minimo) |
| `articleSection` | `["Attualità"]` (categoria WordPress generica) |
| `keywords` | 6 keyword inline |
| Hero image | 1200×826 (3:2, **NON 16:9**) |
| `dateline` | assente |
| `contentLocation` | assente |
| `ClaimReview` | assente |
| AI disclosure | assente |

### 0.3 Pattern condivisi e rilevanti

Entrambi gli articoli **condividono** solo questi tratti:

1. **Topical fit** specifico per la nicchia (frontalieri Ticino/Como)
2. **Headline** dentro 10-110 char, no clickbait
3. **Single publication date** visibile vicino a H1 (ok, RSI ne ha 2 ma vicine)
4. **Hero image** ≥1200px, formato widescreen-ish
5. **Body** ≥400 parole
6. **Section pages** (categorie/sezioni regionali) sul publisher
7. **Brand/domain authority** stabilita (RSI = broadcaster pubblico storico; ComoZero = testata regionale dal 2014)
8. **Topical specialization** del publisher (entrambi sono testate locali/regionali Como/Ticino)

### 0.4 Cosa **NON** hanno (e che il piano v2 sopravvalutava)

| Feature piano v2 | Realtà nei 2 articoli | Verdetto |
|---|---|---|
| `NewsArticle` (vs `Article`) | ComoZero usa `Article`; RSI niente | **Demote: `Article` basta** |
| `NewsMediaOrganization` (vs `Organization`) | ComoZero usa `Organization` generico | **Demote: best-practice ma non bloccante** |
| Author Person KG-linkable (Wikidata, sameAs) | ComoZero: "Redazione" Gravatar; RSI: solo iniziali "sdr" | **Demote: Person basta, KG link è bonus** |
| Pagine autore con bio | Nessuna delle due ha author bio reale | **Demote: nice-to-have, non critico** |
| Finestra freshness < 48h | RSI 7gg, ComoZero 3gg, entrambi su News | **Aggiornato: la news sitemap accetta < 48h, ma articoli più vecchi possono comunque apparire su News** |
| Image variants 16:9 + 4:3 + 1:1 | ComoZero 3:2 (1200×826) | **Demote: una variante widescreen sufficiente** |
| `dateline` field | Nessuna delle due | **Demote: best practice di nicchia** |
| `contentLocation` schema | Nessuna delle due | **Demote: best practice di nicchia** |
| `ClaimReview` schema | Nessuna delle due | **Demote: solo se fai veri fact-checks** |
| WebSub/PubSubHubbub | Probabilmente sì WordPress (auto), RSI sconosciuto | **Tieni: easy win** |
| AI disclosure | Nessuna delle due | **MA noi ne abbiamo bisogno per via del volume** (vedi 0.5) |

### 0.5 Cosa il confronto **rinforza**

I due esempi **confermano** la priorità di:

1. **Volume sostenibile**: ComoZero pubblica ~5-10 articoli/giorno, RSI ~20-40, **noi ne pubblichiamo 108/giorno con commit "📰 Auto-generated"** → questo è il segnale più anomalo del nostro pattern.

2. **Topical fit**: entrambi i publisher sono iper-specializzati su area geografica + tema. La nostra news sitemap mescola fisco frontaliere con sport e cultura locale → diluisce.

3. **Brand authority**: entrambi hanno una storia di pubblicazione, una redazione riconoscibile, mentions cross-domain. **Noi siamo nuovi** → serve brand-building diretto (newsletter, citazioni cross-publisher, presenza social di redazione).

4. **Author come `Person` (anche minimo)**: anche un "Redazione" + Gravatar è meglio di `Organization`. Il salto da `Organization` a `Person` è il vero step funzionale; KG-link è amplificatore.

5. **Section pages SSR**: entrambi le hanno (`/info/ticino-grigioni-e-insubria/`, `/attualita/`).

6. **Headline rules + body 400+ parole**: pattern comune, semplice da rispettare.

### 0.6 Implicazioni concrete sul piano

**Priorità RIVISTE**:
- 🔼 **PROMUOVI**: riduzione volume + topical filter + AI disclosure + autori Person base (anche solo "Redazione" + foto + pagina semplice)
- 🔽 **DEMOTE / RIMANDA**: KG linking Wikidata, `NewsMediaOrganization`, image variants 4:3 + 1:1, `dateline`, `contentLocation`, `ClaimReview`
- 🆕 **AGGIUNGI**: brand-building diretto (cross-publisher mentions, presenza redazione su LinkedIn, citazioni, partnership con testate regionali)

**Soglie reali osservate** (vs quelle teoriche delle fonti):
- News sitemap window: 48h teorico, ma articoli fino a 7gg restano su News se topical fit è alto
- Image: 1200px largo basta, qualunque rapporto widescreen
- Word count: 400+ è il minimo reale
- Author: Person con name + foto, anche senza bio profonda
- Schema: `Article` minimo o **anche zero JSON-LD** se domain authority alta (RSI)

---

## 0ter. Verifica sitemap reali competitor (correzione critica v5)

**La v4 conteneva un errore di calibrazione.** Avevo assunto frequenze editoriali a partire dalla quota SERP per la query "frontalieri svizzera" (5-6 articoli per publisher in 30 giorni), concludendo erroneamente che i competitor pubblicassero ~5-10/settimana. **Sbagliato di un ordine di grandezza.** I dati veri dalle sitemap pubbliche:

### 0ter.1 Frequenze editoriali reali (verificate)

| Publisher | Source | Articoli/giorno | Note |
|---|---|---|---|
| **Tio.ch** | `tio.ch/news-sitemap.xml` | **~85-90** | News sitemap a finestra 48h: 8 (28apr) + 89 (29apr) + 88 (30apr) = 185 URL |
| **Corriere del Ticino** | `naxos-cdn01.gruppocdt.ch/cdt/sitemaps/2026/sitemap-2026-04.xml` | **~63** (range 27-83) | 1745 URL totali ad aprile 2026 |
| **ComoZero** | `comozero.it/post-sitemap39.xml` (chunk corrente) | **~22** (range 10-30) | 251 URL nelle ultime ~11 giornate |
| TVS tvsvizzera.it | sitemap-2026 (date-sharded, da contare) | non misurato | redazione SRG SSR, presumibile alto |
| **Noi (frontaliereticino.ch)** | `dist/sitemap-news.xml` | **108** | 324 URL in 72h |

### 0ter.2 Cosa significa

Il nostro volume **non è il problema**. Siamo perfettamente in linea con il range competitor (22-90/giorno).

L'errore della v4 era confondere:
- **Volume editoriale totale** del publisher (tutto ciò che pubblica) → 22-90/giorno
- **Quota SERP per query specifica** ("frontalieri svizzera") → 5-6 articoli per publisher in 30 giorni

Su 90 articoli/giorno di Tio.ch, solo 1-3 toccano direttamente "frontalieri" (il resto è cronaca, sport, politica ticinese, economia svizzera, etc.). Lo stesso vale per CdT e ComoZero. Quindi il SERP "frontalieri svizzera" mostra solo la frazione tematicamente pertinente, non l'output complessivo.

### 0ter.3 Implicazioni per il piano

**Ricalibro il target volume**:
- v4 (errato): "5-10 articoli/settimana"
- **v5 (corretto): mantenere 30-100/giorno è OK**, allineato al mercato

**Quello che resta vero (e centrale)**:
- **Topic discipline**: i competitor fanno **giornalismo regionale a 360°** (cronaca, politica, economia, sport ticinese). Non sono publisher mono-tema. La loro forza è essere **publisher locali generalisti** con autorità sul territorio. Noi non possiamo competere sull'ampiezza generalista; **il nostro angle è verticalità su frontaliere-fiscale**.
- **Authorship reale**: i loro articoli hanno bylines (anche se generici come "sdr" o "Redazione"), nostri sono `Organization` + commit "📰 Auto-generated".
- **Originalità reporting**: loro riportano fatti freschi (mozioni, comunicati, dichiarazioni). Noi spesso ri-elaboriamo. Pattern AI evidente.
- **Brand authority storica**: Tio.ch dal 2002, CdT dal **1891**, ComoZero dal 2014. Noi siamo nuovi → outreach + brand-building (§6bis).
- **Section structure SSR**: tutti hanno categorie ben definite (`/info/ticino-grigioni-e-insubria/` su RSI, `/attualita/` su ComoZero). Noi le abbiamo solo come tab SPA.

### 0ter.4 Correzione priorità

Cosa **rimane prioritario** (invariato):
- **C1** topical filter: per noi resta vero perché siamo **un publisher verticale**, non generalista. Sport e cultura locale **non sono** il nostro spazio. (≠ ComoZero che li include perché è generalista regionale.)
- **A3** AI disclosure: i competitor sono human-authored, noi siamo AI-assisted → asimmetria che richiede disclosure.
- **Authorship Person** (A1+A2 minimal): anche solo "Redazione" + foto + pagina semplice → match ComoZero pattern.
- **Section pages SSR** (C3): confermato, tutti i top 4 le hanno.
- **Pulizia commit message** auto-generated: cambiare a `feat(article): <title>` con `Reviewed-by: <author>`.

Cosa **NON è più priorità** (ritirato dalla v4):
- ❌ "Riduci volume a 5-10/settimana" — sbagliato, il volume va bene
- ❌ "Story-tracking competitor → follow-up entro 24h": resta utile come tattica di copertura, ma non urgente; non è il blocker

Cosa **ENTRA come priorità nuova v5**:
- 🆕 **Pipeline editoriale lightweight ma visibile**: AI genera bozza → autore reale rivede minuti (non ore) → firma → commit con metadata. Velocità preservata, authorship reale acquisita.
- 🆕 **Cambio messaging commit**: da `📰 Auto-generated blog article` a `feat(article): <title>\n\nReviewed-by: <author-slug>` per non lasciare segnali AI espliciti su Git pubblico (il repository su GitHub è indicizzabile/citabile).
- 🆕 **Verticalità chiara**: positioning come "publisher specializzato fisco-frontaliere" non come "publisher locale generalista". Competiamo su **profondità tematica**, non su ampiezza geografica.

---

## 0bis. SERP analysis "frontalieri svizzera" (Google News IT, 30 apr 2026)

Estratti 27 articoli unici dal SERP `news.google.com/search?for=frontalieri+svizzera&hl=it`. Pattern emersi:

### 0bis.1 Concentrazione publisher (top 4 = 74% del SERP)

| Pos | Publisher | Articoli | Quota | Profilo |
|---|---|---|---|---|
| 1 | **Ticinonline** (`tio.ch`) | 6 | 22% | Portale Ticino, gruppo Tio |
| 2 | **Corriere del Ticino** (`cdt.ch`) | 5 | 19% | Quotidiano storico Ticino |
| 3 | **ComoZero** (`comozero.it`) | 5 | 19% | Portale provincia Como |
| 4 | **TVS tvsvizzera.it** | 4 | 15% | Edizione italiana SRG SSR |
| 5 | RSI Radiotelevisione svizzera | 2 | 7% | Broadcaster pubblico |
| 6 | la Repubblica | 1 | 4% | Nazionale generalista |
| 7 | VareseNews | 1 | 4% | Provincia Varese |
| 8 | Ticinolive | 1 | 4% | Magazine Ticino |
| 9 | Il Giorno | 1 | 4% | Lombardia generalista |
| 10 | cgil.lombardia.it | 1 | 4% | Sindacato |

**Insight 1**: Il mercato è **dominato da 4 testate iper-specializzate sul confine Como/Varese-Ticino**. Tutti regional/local digital, non grandi quotidiani nazionali. Questo è **esattamente il nostro spazio competitivo target** (Tier 2).

### 0bis.2 Macro-temi del SERP (5 cluster)

| Tema | Articoli | Quota |
|---|---|---|
| Disoccupazione frontalieri / riforma UE / Bruxelles | 8 | 30% |
| Tassa sulla salute Lombardia / sanitari di confine | 6 | 22% |
| Salari / dumping / annunci a basso prezzo | 5 | 18% |
| Mobilità / treni / autisti bus | 3 | 11% |
| Fisco vario (valore locativo, perequazione) | 5 | 18% |

**Insight 2**: 100% del SERP è coperto da 5 macro-temi tutti **strettamente frontalieri-fiscali-lavorativi**. Sport, cultura, eventi locali, infrastruttura non frontaliera **non compaiono mai** per questa query → la nostra news sitemap con sport/cultura è completamente sprecata.

### 0bis.3 Freshness distribution

| Range | Articoli | Quota |
|---|---|---|
| < 24h | 1 | 4% |
| 1-3 giorni | 7 | 26% |
| 4-7 giorni | 10 | 37% |
| 8-21 giorni | 4 | 15% |
| Oltre 21 giorni | 0 | 0% |
| Senza timestamp visibile | 5 | 18% |

**Insight 3**: Solo **30% degli articoli è entro 3 giorni**. Articoli fino a **21 giorni** sono ancora indicizzati per la query. La regola "48h strict" della news sitemap è solo per **eligibility iniziale**; la SERP di Google News per query specifiche pesca da finestra molto più ampia (~30 giorni).

### 0bis.4 Pattern stilistici dei titoli

Dei 27 titoli analizzati:

- **Keyword "frontalier" presente nel 96%** (26/27) — pattern dominante per la query
- **Lunghezza media**: ~80 char, range 47-113
- **Quote/virgolette dirette**: 8/27 (30%) — es. `«La Svizzera non deve versare la disoccupazione»`, `"tassa della salute"`
- **Numeri specifici**: 11/27 (41%) — es. `2900 franchi`, `140 milioni`, `10mila euro`, `19%`, `un miliardo`
- **Geo entities (Ticino, Lombardia, Como, Varese, Bruxelles, Berna)**: 89%
- **Action verbs forti**: `scoppia la bomba`, `scatta la mozione`, `via libera`, `perdono il lavoro`, `spinge sulla riforma`
- **NO clickbait** ("non crederai", "scioccante" — zero match)

### 0bis.5 Multi-coverage clusters (Google premia la convergenza)

Stesse storie coperte da N publisher in finestra ravvicinata:

| Storia | Publisher che coprono | N |
|---|---|---|
| Disoccupazione frontalieri / riforma UE | RSI + CdT + Ticinonline + Ticinolive + ComoZero | 7 articoli |
| Tassa sulla salute Lombardia | RSI + TVS + ComoZero + VareseNews | 5 articoli |
| Annuncio 2900 franchi Massagno | ComoZero + CdT | 2 articoli |

**Insight 4**: Le storie con copertura multi-publisher (≥3 testate in 7 giorni) **dominano il SERP**. Pubblicare su una storia che nessun altro copre dà ranking quasi-zero — Google considera "prominenza" come feature di ranking primaria (cit. Google News docs: "if news sources are heavily covering a particular news story").

### 0bis.6 Strategia operativa derivata (8 azioni)

1. **Monitor RSS dei top 4 competitor** (Ticinonline, CdT, ComoZero, TVS) ogni ora — quando 2+ coprono la stessa storia in 24h, **pubblichiamo follow-up entro 24h con angle finanziario specifico** (calcolo impatto, simulazione, tabella comparativa).

2. **Topic whitelist news sitemap calibrata sul SERP reale**:
   - Disoccupazione frontalieri / UE
   - Imposte sanità / tasse di confine
   - Salari / dumping / minimi salariali
   - Mobilità transfrontaliera (treno/auto/bus)
   - Fisco frontaliere (valore locativo, perequazione, accordo 2026)
   - **NIENTE altro** nella news sitemap.

3. **Headline patterns da imitare** (validati dal SERP):
   - Includere sempre `frontalier*` o `frontalieri`
   - Aggiungere geo entity (`Ticino`, `Lombardia`, `Como`, `Varese`)
   - Includere numero specifico se disponibile
   - Lunghezza 60-90 char (sweet spot)
   - Considerare quote dirette di policymaker (Sirica, Consiglio federale)

4. **Asset proprietari da titolare**: i nostri dataset (`jobs-stats.json`, `health-premiums.json`, `fuel-prices.json`) producono **numeri specifici** che competitor non hanno → es. *"Il salario medio frontaliere 2026 è 5.840 CHF: +3,2% sul 2025"*. Questi sono titoli "data-led" che tendono ad attirare backlink (signal autorità).

5. **Smettere di scrivere su sport/cultura/infrastruttura locale generica** nella news sitemap — restano in `sitemap-blog.xml` ma **escono** dalla news sitemap (riconfermato C1 v2 + v3).

6. **Tier-2 positioning realistico**: target competitor non è RSI o la Repubblica, ma **Ticinolive / VareseNews / cgil.lombardia.it** (1 articolo cadauno nel SERP). Bastano: domain authority modesta + topical fit estremo + 5-10 articoli/settimana di qualità.

7. **Frequenza target ricalibrata**: dai 30 articoli/giorno della v2 a **5-10 articoli/settimana** sui macro-temi. ComoZero e VareseNews compaiono con questa frequenza e dominano il SERP.

8. **Story tracking sheet**: per ogni cluster (storia coperta da 2+ publisher), tracciare nostra copertura, time-to-publish, posizione nel SERP — feedback loop per editing pipeline.

### 0bis.7 Validazioni / invalidazioni v3 → v4

**Confermato** (rimane priorità alta):
- Topical filter news sitemap (C1) — ancora più stretto del v3
- Riduzione volume (C4) — ricalibrata da ~30/giorno a ~5-10/settimana
- Brand authority gap (§6bis) — confermato target Tier 2

**Invalidato/aggiustato**:
- v3 prevedeva ~20-30 articoli/giorno → **ricalibrato a ~5-10/settimana** sui macro-temi
- v3 implicava finestra freshness <48h come critica → **realtà SERP: fino a 21 giorni** ancora competitive
- v2/v3 trattavano headline come item secondario → **realtà**: pattern stilistico molto specifico (numeri, geo, action verbs, quote) → **da implementare nel prompt LLM con esempi few-shot**

**Nuovo (non era nei piani precedenti)**:
- **Story-tracking pipeline**: monitor RSS competitor + cluster detection + auto-flag opportunità di follow-up
- **Headline pattern library** few-shot per LLM: 27 esempi reali del SERP come reference
- **Data-led titling**: sfruttare dataset proprietari per titoli con numeri esclusivi

---

## 1. Stato attuale

### 1.1 Già conforme

| Requisito | Stato | Riferimento |
|---|---|---|
| News sitemap con namespace `xmlns:news` | OK | `dist/sitemap-news.xml` — 324 URL nelle ultime 48h |
| Sitemap index dichiara la news sitemap | OK | `public/sitemap.xml` |
| Schema `NewsArticle` JSON-LD | OK | `scripts/create-article.mjs:4595`, `build-plugins/ogPagesPlugin.ts:699` |
| Campi `NewsArticle` core (headline, image, datePublished, dateModified, author, publisher, mainEntityOfPage) | OK | tutti presenti |
| `isAccessibleForFree: true` (paywall flag) | OK | settato a true |
| Hreflang alternates (it/en/de/fr/x-default) | OK | nella news sitemap e in `<head>` |
| Canonical URL stabile (`https://frontaliereticino.ch`, no `www`) | OK | `services/seoService.ts` |
| Pagina "Chi siamo" con sezione editoriale | OK | `components/pages/ChiSiamo.tsx` (202 righe) |
| Mobile responsive (Tailwind 4) | OK | layout fluido |
| Image dimensions nello schema (1200×675) | OK | sopra il minimo richiesto |
| Pubblicazione in finestra 48h | OK | publication_date 2026-04-28 → 2026-04-30 |
| Speakable schema | OK | `cssSelector: ["article h1", "article h2", "article p"]` |
| `news:publication_date` in formato W3C | OK | ISO 8601 con timezone |

### 1.2 Gap critici (bloccano l'inclusione)

| ID | Gap | Severità | Bloccato da Google |
|---|---|---|---|
| **A** | Author = `Organization`, mai `Person` con KG link | BLOCKER | Sì (E-E-A-T) |
| **B** | Volume + commit pattern AI evidente, no review umana visibile | BLOCKER | Sì (Scaled content abuse, mar 2024) |
| **C** | Articoli off-topic (sport, cultura) nella news sitemap | ALTO | Topical authority |
| **D** | Nessuna disclosure AI in pagina | ALTO | Trasparenza |
| **E** | News sitemap duplicato (`sitemap_news.xml` + `sitemap-news.xml`) | MEDIO | Sì (confusione) |
| **F** | Manca pagina `/correzioni/` pubblica | MEDIO | Sì (transparency) |
| **G** | Manca pagine autori dedicate | MEDIO | Sì (E-E-A-T) |
| **H** | Manca disclosure ownership/funding/sponsorship | MEDIO | Sì (transparency) |
| **I** | Schema usa `Organization` invece di `NewsMediaOrganization` per il publisher | MEDIO | Best practice |
| **J** | Manca section pages SSR (`/fisco/`, `/lavoro/`, `/salari/`…) | MEDIO | Architettura news |
| **K** | Headline non validati (10-110 char, `<title>`=`<h1>`, no clickbait) | MEDIO | Best practice |
| **L** | Solo 1 variante immagine (16:9) — no 4:3, no 1:1 | MINOR | Best practice |
| **M** | Nessun WebSub/PubSubHubbub ping per indexing istantaneo | MINOR | Best practice |
| **N** | Mancano `articleBody`, `articleSection`, `dateline`, `keywords` nel JSON-LD | MINOR | Best practice |
| **O** | Nessun test compliance Google News in CI | MINOR | Regression prevention |
| **P** | Date visibili in pagina possibilmente molteplici/inconsistenti | MINOR | Sì (single clear date) |
| **Q** | Nessun segnale geografico locale (dateline città, schema `Place`) | MEDIO | Discover Feb 2026 |
| **R** | Nessuna defense contro AI Mode (nessun brand-building diretto evidente nelle pagine articolo) | MEDIO | Strategia 2026 |

---

## 2. Soglie tecniche di riferimento (ricavate dalle fonti)

| Parametro | Soglia richiesta / raccomandata | Fonte |
|---|---|---|
| Article freshness top placements | **< 10 ore** | Search Engine Land |
| News sitemap window | **< 48 ore** | Google Publisher Center |
| Articolo eligibility location section | **< 90 giorni** | Search Engine Land |
| News sitemap max URL per file | **1.000** | Google specs |
| Headline length | **10-110 caratteri** o **2-22 parole** | Google + Semrush |
| `<title>` ↔ `<h1>` | devono **coincidere** | Google Publisher Center |
| Image min dimensions | **60×90 px** | Publisher Center |
| Image min area | **≥ 50.000 px²** (W×H) | Search Engine Land |
| Image ideal | **1.200×674 px, 16:9** | Search Engine Land |
| Image varianti raccomandate | **16:9 + 4:3 + 1:1** | Search Engine Land |
| Image format | **JPEG, PNG, WebP** | Google |
| Core Web Vitals — LCP | **< 2,5 s** | Google |
| Core Web Vitals — INP | **< 200 ms** | Google |
| Core Web Vitals — CLS | **< 0,1** | Google |
| Date format | **ISO 8601 con timezone** in schema, **single visible date** in pagina | Google |
| `datePublished` ↔ `dateModified` | `dateModified ≥ datePublished` | Google |
| Articolo body word count | **≥ 400 parole** (raccomandato news) | best practice |

---

## 3. Implicazioni del Discover Core Update Feb 2026

Riassunto da fonte LinkedIn (Andell Wriff) + segnalazioni Google + Barry Adams:

1. **Author Knowledge Graph linking**. Google ora estrae il nome autore da schema/HTML e cerca di mapparlo a entità Knowledge Graph. Tracciamento volumi pubblicati + topic specialization + cross-domain footprint per ranking.

2. **Local geo signals rinforzati**. Boost per contenuti che menzionano luoghi rilevanti per la regione dell'utente. "Top Geo" facet genera related articles basati su entità geografiche del seed.

3. **Like ≠ trigger Related**. Il segnale "like" non genera più (o pochissimo) "related articles" → il segnale di affinity si è spostato altrove.

4. **Clickbait demotion + freshness boost paired**. Google testa combinazioni come "Low Clickbait Demotion + 8h Freshness Boost" — la qualità è premiata sulla freschezza.

5. **LLM-based retrieval in test**. Google sperimenta retrieval con LLM per filtrare contenuti AI-generated low-quality. **Direct hit per il nostro pattern attuale**.

6. **Pipeline reuse esteso (FR test)**. Bundle ID riusati ~6 minuti → meno esplorazione, meno spam injection ma anche meno diversità — i siti devono essere già autorevoli per entrare nel mix.

7. **AI Mode killing referrals**. Da Barry Adams (ago 2025): AI Mode usa fan-out queries per sintetizzare news in tempo reale → il referral diretto agli editori si riduce. Difesa: brand recognition, paywall, app, newsletter, audience diretta.

**Implicazioni operative immediate**:
- Investire **fortemente** in autori KG-linkable (sameAs Wikidata/LinkedIn pubblico/Twitter verificato)
- **Geo-tag ogni articolo** (dateline città, schema `Place`, articleSection regionale)
- **Rimuovere clickbait** dai titoli generati AI; passare il check 10-110 char + active voice
- **Push newsletter aggressivo** (già in piedi su `frontaliereticino.ch`) come hedge contro AI Mode
- **Ridurre volume AI** (pattern auto-generate è esattamente ciò che la LLM-retrieval sta imparando a filtrare)

---

## 4. Piano d'azione prioritizzato

Sei fasi, ~2-3 settimane di lavoro effettivo. Le fasi sono parzialmente sovrapponibili — gli step indipendenti possono essere lavorati in parallelo (max 3-4 worktree per `feedback_parallel_agents`).

### FASE 1 — Sblocchi strutturali (2-3 giorni)

#### A1 — Crea 2-3 autori reali con pagine dedicate, KG-linkable

**File da creare:**
- `data/authors.ts` — registry autori
- `components/pages/AutorePage.tsx` — pagina profilo
- `services/seo/seo-authors.ts` — metadata SEO
- `public/images/authors/{slug}.jpg` — foto 400×400 minimo

**Schema dati:**

```typescript
type Author = {
  slug: string;
  name: string;
  role: string;
  bio: string;                    // 150+ parole
  photoPath: string;              // /images/authors/{slug}.jpg
  email?: string;
  social: {
    linkedin?: string;            // OBBLIGATORIO per KG link
    twitter?: string;
    mastodon?: string;
    wikidataId?: string;          // se esiste, BOOST E-E-A-T
  };
  expertise: string[];            // ['fiscalità frontaliera', 'AVS', 'LPP']
  joinedAt: string;               // ISO date
  publications?: { url: string; date: string }[];  // articoli su altri domini
};
```

**JSON-LD `Person` su pagina autore** (KG-friendly):

```json
{
  "@context": "https://schema.org",
  "@type": "Person",
  "@id": "https://frontaliereticino.ch/autori/mario-rossi/#person",
  "name": "Mario Rossi",
  "image": "https://frontaliereticino.ch/images/authors/mario-rossi.jpg",
  "jobTitle": "Esperto fiscalità frontaliera",
  "description": "...",
  "url": "https://frontaliereticino.ch/autori/mario-rossi/",
  "sameAs": [
    "https://www.linkedin.com/in/...",
    "https://twitter.com/...",
    "https://www.wikidata.org/wiki/Q..."
  ],
  "knowsAbout": [
    "Fiscalità frontaliera",
    "AVS",
    "LPP",
    "LAMal",
    "Accordo fiscale Italia-Svizzera 2026"
  ],
  "worksFor": { "@id": "https://frontaliereticino.ch/#organization" },
  "alumniOf": "...",
  "knowsLanguage": ["it", "en"]
}
```

**Routing** (`services/router.ts`):
- Aggiungi `'autore'` a `ActiveTab`
- Slug table: IT `autori`, EN `authors`, DE `autoren`, FR `auteurs`
- Path: `/autori/{slug}/`

**Sitemap**: aggiungi `sitemap-authors.xml` o estendi `sitemap-pages.xml`.

**Stima**: 1 giornata.

#### A2 — Sostituisci `Organization` con `Person` in NewsArticle

**File**: `scripts/create-article.mjs:4595-4612` + componente blog renderer

```javascript
// Da
"author": {"@id": "${BASE_URL}/#organization"},

// A
"author": {
  "@type": "Person",
  "@id": "${BASE_URL}/autori/${data.author.slug}/#person",
  "name": "${data.author.name}",
  "url": "${BASE_URL}/autori/${data.author.slug}/"
},
```

**Logica di assegnazione**:
- Round-robin sugli autori filtrati per `expertise` matching topic
- Funzione: `pickAuthorForTopic(topic, authors): Author`
- Salva `author.slug` nei dati dell'articolo per consistency

**Byline visibile** (componente `BlogArticle.tsx`), **single clear date**:

```tsx
<div className="article-meta">
  <p className="byline">
    Di <a href={`/autori/${author.slug}/`} rel="author">{author.name}</a>
  </p>
  <p className="article-date">
    Pubblicato il <time dateTime={publishedAtISO}>{formatDate(publishedAt, 'it')}</time>
    {modifiedAt > publishedAt && (
      <> · Aggiornato il <time dateTime={modifiedAtISO}>{formatDate(modifiedAt, 'it')}</time></>
    )}
  </p>
</div>
```

**Posizione**: tra `<h1>` e il body. Una sola data visibile in pagina (no `last-update` separato in altri punti).

**Migrazione**: `scripts/backfill-article-authors.mjs` retroattivo sui 324 articoli (round-robin).

**Stima**: 0.5 giornata.

#### A3 — Disclosure AI + processo editoriale visibile

**File**: `components/blog/BlogArticleRenderer.tsx`

**Box trasparenza** (sotto byline, sopra body):

```tsx
<aside className="ai-disclosure" role="note">
  <p>
    <strong>Trasparenza editoriale:</strong> bozza assistita da AI generativa,
    revisionata e approvata da{' '}
    <a href={`/autori/${author.slug}/`}>{author.name}</a> il{' '}
    <time dateTime={reviewedAt}>{formatDate(reviewedAt)}</time>.
    Le fonti utilizzate sono linkate nel testo e in fondo all'articolo.
  </p>
  <p className="ai-disclosure-links">
    <a href="/metodologia/">Come scriviamo gli articoli</a> ·{' '}
    <a href="/correzioni/">Segnala una correzione</a>
  </p>
</aside>
```

**Pagina `/metodologia/`** (`components/pages/Metodologia.tsx`):
- Pipeline editoriale (fonti → bozza AI → review umana → fact-check → pubblicazione)
- Strumenti AI usati (Claude/GPT/etc) e in quale fase
- Fonti primarie obbligatorie (AFC, comunicati stampa, sentenze, statistiche UST)
- Standard giornalistici (separazione fatti/opinioni, attribuzioni, citazioni)
- Politica aggiornamenti

**Stima**: 0.5 giornata.

#### A4 — Pulizia sitemap news duplicato

**Investigazione**: `grep -rn "sitemap_news\.xml" build-plugins/ scripts/ vite.config.ts`

**Azioni**:
- Rimuovi il plugin/script che emette la versione underscore
- Test in `tests/sitemap.test.ts` che fallisce se `dist/sitemap_news.xml` esiste post-build
- `dist/sitemap-news.xml` (dash) è l'unico canonical

**Stima**: 0.25 giornata.

#### A5 — Validation headline + `<title>` ↔ `<h1>` sync

**Nuovo** rispetto al piano v1.

**File**: `scripts/create-article.mjs` (sezione generation prompt + post-processing)

**Validatori da aggiungere**:

```javascript
function validateHeadline(headline) {
  const errs = [];
  if (headline.length < 10) errs.push('Headline troppo corto (min 10 char)');
  if (headline.length > 110) errs.push('Headline troppo lungo (max 110 char)');
  const wc = headline.trim().split(/\s+/).length;
  if (wc < 2 || wc > 22) errs.push(`Headline ${wc} parole, range 2-22`);
  if (/^\d/.test(headline)) errs.push('Headline non deve iniziare con numero');
  if (CLICKBAIT_PATTERNS.some(p => p.test(headline))) errs.push('Pattern clickbait rilevato');
  return errs;
}

const CLICKBAIT_PATTERNS = [
  /non\s+crederai/i,
  /scioccante/i,
  /incredibile/i,
  /sconvolgente/i,
  /ti\s+lascerà\s+senza\s+parole/i,
  /\?\?\?$/,
  /!{2,}$/,
];
```

**Sync `<title>` con `<h1>`**: in `services/seoService.ts`, per articoli, il `seo.title` deve coincidere con `seo.headline`. Aggiungi assert in `tests/blog-seo-titles.test.ts`.

**Stima**: 0.5 giornata.

---

### FASE 2 — Compliance editoriale (2-3 giorni)

#### B1 — Pagina `/correzioni/` (corrections policy + log)

**File**: `components/pages/Correzioni.tsx`

**Contenuto**:
1. Policy: come segnalare errori (form + email), SLA 48h, tipologie accettate
2. Log pubblico cronologico con `articleId`, data, tipo (factual/typo/clarification), diff sintetico
3. Schema `WebPage` con `lastReviewed`

**Storage**: `data/corrections-log.json`, aggiornato via `scripts/log-correction.mjs <articleId> <type> <description>`.

**Link**: footer site-wide + box trasparenza articolo.

**Stima**: 0.5 giornata.

#### B2 — Estendi `ChiSiamo.tsx`

Aggiungi sezioni:

1. **Finanziamento e indipendenza editoriale**
   - Monetizzazione AdSense (link policy AdSense)
   - Eventuali partner/sponsor (oggi nessuno)
   - Indipendenza: nessun sponsored content senza etichetta visibile

2. **Standard giornalistici**
   - Accuratezza, fact-checking, fonti primarie
   - Separazione fatti/opinioni
   - Uso AI dichiarato (link `/metodologia/`)

3. **Team**
   - Foto + bio breve per ogni autore
   - Link a pagina autore + LinkedIn

4. **Schema `NewsMediaOrganization`** (vedi I1)

**Stima**: 0.5 giornata.

#### B3 — Disclosure pubblicitaria su tutti gli AdSense

**Investigazione**: trova `AdSlot` (probabilmente `components/ads/AdSlot.tsx`).

**Modifica**: ogni slot AdSense con etichetta visibile sopra.

```tsx
<div className="ad-container">
  <small className="ad-label">Pubblicità</small>
  <ins className="adsbygoogle" ... />
</div>
```

CSS: `.ad-label` distinguibile, contrasto 4.5:1, font-size 12px.

**Stima**: 0.25 giornata.

#### B4 — Test E2E pagine editoriali

`tests/google-news-editorial-pages.test.ts`:
- Esistono `/chi-siamo/`, `/correzioni/`, `/metodologia/`, `/autori/{slug}/` per ogni autore
- HTML rendered ha tutti i campi (Person schema, contact, social)
- ChiSiamo ha le 4 sezioni richieste

**Stima**: 0.25 giornata.

---

### FASE 3 — Topical authority + segnali locali (3-5 giorni)

#### C1 — Filtra news sitemap per topic frontaliere

**File**: `scripts/cleanup-news-sitemap.mjs`

**Whitelist topic** (case-insensitive su `articleSection`, slug, tag):
- `fisco` / `tasse` / `730` / `dichiarazione` / `nuovo-accordo-2026` / `imposta-fonte`
- `avs` / `lpp` / `pensione` / `previdenza`
- `lamal` / `assicurazione-malattia` / `cassa-malati`
- `dogana` / `frontiera` / `varco` / `permit-g` / `permit-b`
- `lavoro-frontaliere` / `salari` / `stipendi` / `contratto`
- `cambio-valuta` / `chf-eur` / `bonifico` / `tasso`
- `trasporti-frontaliere` / `treno` / `auto` / `traffico` / `webcam-dogana`

Tutto il resto resta in `sitemap-blog.xml` ma esce dalla news sitemap.

**Risultato atteso**: news sitemap da 324 a ~50-80 URL/72h.

**Stima**: 0.5 giornata.

#### C2 — Geo-tag e dateline su ogni articolo

**Nuovo** rispetto al piano v1 — risposta diretta a Discover Feb 2026.

**File**: `scripts/create-article.mjs` + schema NewsArticle esteso.

**Aggiungi a ogni articolo**:

```javascript
// data/blog-articles-data.ts entry
{
  ...
  dateline: 'Lugano, 30 aprile 2026',
  contentLocation: {
    name: 'Canton Ticino',
    addressRegion: 'Ticino',
    addressCountry: 'CH',
    latitude: 46.0037,
    longitude: 8.9500,
  },
  primaryCity: 'lugano',  // slug, deve essere in lista approvata
}
```

**Lista città approvate** (`data/cities-ticino.ts`):
- Lugano, Bellinzona, Mendrisio, Chiasso, Locarno, Biasca, Ascona, Faido
- Como, Varese, Milano, Lecco (province italiane confinanti)

**Schema esteso**:

```json
{
  "@type": "NewsArticle",
  ...
  "contentLocation": {
    "@type": "Place",
    "name": "Lugano",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "Lugano",
      "addressRegion": "Ticino",
      "addressCountry": "CH"
    },
    "geo": {
      "@type": "GeoCoordinates",
      "latitude": 46.0037,
      "longitude": 8.9500
    }
  },
  "dateline": "Lugano, 30 aprile 2026"
}
```

**Dateline visibile in pagina**: prima frase del lead.

**Stima**: 0.75 giornata.

#### C3 — Section pages SSR aggregate

**Nuovo** rispetto al piano v1.

Google News richiede section pages dedicate, server-rendered, con auto-aggregazione articoli recenti. Le tab della SPA non bastano (sono client-side).

**Sezioni da creare** (build plugin → static HTML in dist/):

| Section | Path IT | Path EN | Path DE | Path FR |
|---|---|---|---|---|
| Fisco | `/fisco/` | `/en/tax/` | `/de/steuern/` | `/fr/fiscalite/` |
| Lavoro frontaliere | `/lavoro-frontaliere/` | `/en/cross-border-work/` | `/de/grenzgaenger-arbeit/` | `/fr/travail-frontalier/` |
| Salari | `/salari/` | `/en/salaries/` | `/de/loehne/` | `/fr/salaires/` |
| Cambio valuta | `/cambio-valuta/` | `/en/currency-exchange/` | `/de/waehrung/` | `/fr/change/` |
| Trasporti | `/trasporti/` | `/en/transport/` | `/de/verkehr/` | `/fr/transports/` |
| Pensioni | `/pensioni/` | `/en/pensions/` | `/de/renten/` | `/fr/retraites/` |
| Dogana | `/dogana/` | `/en/customs/` | `/de/zoll/` | `/fr/douane/` |

**Plugin nuovo**: `build-plugins/sectionPagesPlugin.ts`

Per ogni section:
- HTML statico SSR con auto-aggregazione ultimi N articoli
- Schema `CollectionPage` + `ItemList` con articoli
- Link nel main nav (NON aggiungere come 7° tab — usa footer + link contestuali, rispetta hard cap 6 tab)
- Sitemap entry in `sitemap-pages.xml`

**Stima**: 1.5 giornate.

#### C4 — Riduci frequenza, alza qualità (review pipeline)

Da ~108/giorno a ~20-30/giorno frontaliere-only.

**Pipeline review umana**:

```
1. Cron AI genera bozza  → data/articles-pending/{slug}.json
2. Notifica autore       → email/Slack con link bozza
3. Autore approva        → script `scripts/approve-article.mjs <id> <author-slug>`
4. Commit metadata       → "feat(article): <title>" + Reviewed-by: <author>
5. Build + deploy
```

Modifiche:
- `scripts/create-article.mjs` → output in `data/articles-pending/` invece di committare
- Nuovo `scripts/approve-article.mjs` → muove a `blog-articles-data.ts` + setta `author.slug` + `reviewedAt`
- GitHub Actions: deploy solo dopo approvazione

**Stima**: 1.5 giornate.

#### C5 — Migrazione articoli esistenti off-topic

`scripts/migrate-off-topic-articles.mjs`:
- Identifica articoli non-frontaliere già pubblicati
- Sposta da `sitemap-news.xml` a `sitemap-blog.xml` only
- Per articoli severamente fuori topic (sport, cultura non-fiscale): chiedi approvazione esplicita prima di rimuovere — `feedback_never_noindex_without_approval`

**Stima**: 0.5 giornata.

#### C6 — Pulizia URL stabili (no `?id=`, no `#`)

**Audit**: `grep -rn "\?[a-z]*=" services/router.ts components/`

**Verifica**:
- Slugs articoli sono permanenti (no rename post-publish senza 301)
- No fragment identifier `#` per content (ok per anchor TOC)
- Mobile/desktop redirect consistenti
- Avoidance di `?id=`, `?session=`, `?utm=` nei link interni

**Stima**: 0.25 giornata.

---

### FASE 4 — Schema avanzato + indexing (2 giorni)

#### I1 — `NewsMediaOrganization` site-wide

**Nuovo** rispetto al piano v1.

`Organization` generico è insufficient per News. Sostituisci con `NewsMediaOrganization` nel JSON-LD del sito (in `services/seoService.ts` o nel build plugin global).

```json
{
  "@context": "https://schema.org",
  "@type": "NewsMediaOrganization",
  "@id": "https://frontaliereticino.ch/#organization",
  "name": "Frontaliere Ticino",
  "url": "https://frontaliereticino.ch",
  "logo": {
    "@type": "ImageObject",
    "url": "https://frontaliereticino.ch/logo-1024.png",
    "width": 1024,
    "height": 1024
  },
  "foundingDate": "2025-XX-XX",
  "diversityPolicy": "https://frontaliereticino.ch/chi-siamo/#politica-diversita",
  "ethicsPolicy": "https://frontaliereticino.ch/chi-siamo/#etica",
  "missionCoveragePrioritiesPolicy": "https://frontaliereticino.ch/chi-siamo/#missione",
  "correctionsPolicy": "https://frontaliereticino.ch/correzioni/",
  "verificationFactCheckingPolicy": "https://frontaliereticino.ch/metodologia/#fact-checking",
  "ownershipFundingInfo": "https://frontaliereticino.ch/chi-siamo/#finanziamento",
  "actionableFeedbackPolicy": "https://frontaliereticino.ch/correzioni/",
  "masthead": "https://frontaliereticino.ch/chi-siamo/#team",
  "sameAs": [
    "https://www.linkedin.com/company/...",
    "https://twitter.com/..."
  ]
}
```

**Stima**: 0.5 giornata.

#### I2 — Estendi NewsArticle con campi raccomandati

**File**: `scripts/create-article.mjs`

Aggiungi:
- `articleBody` (full text, ≥400 parole)
- `articleSection` ("Fisco", "Lavoro frontaliere", etc — coerente con section pages)
- `keywords` (array di 3-7 keyword)
- `wordCount`
- `inLanguage` (già presente)
- `dateline` (vedi C2)
- `contentLocation` (vedi C2)
- `thumbnailUrl` (variant 1:1)

**Stima**: 0.5 giornata.

#### I3 — Image variants 16:9 + 4:3 + 1:1

**Nuovo** rispetto al piano v1.

**File**: `scripts/optimize-blog-images.mjs` + `scripts/create-article.mjs`

Per ogni hero image, genera 3 varianti:
- `{slug}-16x9.webp` (1200×675)
- `{slug}-4x3.webp` (1200×900)
- `{slug}-1x1.webp` (1200×1200)

Schema:

```json
"image": [
  { "@type": "ImageObject", "url": "...{slug}-16x9.webp", "width": 1200, "height": 675 },
  { "@type": "ImageObject", "url": "...{slug}-4x3.webp", "width": 1200, "height": 900 },
  { "@type": "ImageObject", "url": "...{slug}-1x1.webp", "width": 1200, "height": 1200 }
]
```

**Stima**: 0.5 giornata.

#### I4 — WebSub ping per indexing istantaneo

**Nuovo** rispetto al piano v1.

WebSub (ex PubSubHubbub) notifica Google immediatamente di nuovi contenuti, accelerando indexing.

**Aggiungi al sitemap**:

```xml
<urlset ...>
  <link rel="hub" href="https://pubsubhubbub.appspot.com/"/>
  <link rel="self" href="https://frontaliereticino.ch/sitemap-news.xml"/>
  ...
</urlset>
```

**Ping al hub** dopo deploy:

```bash
curl -X POST https://pubsubhubbub.appspot.com/publish \
  -d "hub.mode=publish" \
  -d "hub.url=https://frontaliereticino.ch/sitemap-news.xml"
```

Aggiungi step in `.github/workflows/deploy.yml` post-deploy.

**Stima**: 0.25 giornata.

#### I5 — Schema `ClaimReview` per fact-checks (opzionale ma boost)

**Nuovo** rispetto al piano v1.

Per articoli che fanno fact-checking di affermazioni (es. "vero che il nuovo accordo aumenterà le tasse del 30%?"), aggiungi schema `ClaimReview`. Boost grosso in Google News.

```json
{
  "@type": "ClaimReview",
  "author": { "@id": ".../autori/.../#person" },
  "datePublished": "2026-04-30",
  "claimReviewed": "Il nuovo accordo aumenta le tasse del 30%",
  "reviewRating": {
    "@type": "Rating",
    "ratingValue": "1",
    "bestRating": "5",
    "alternateName": "Falso"
  },
  "itemReviewed": {
    "@type": "Claim",
    "appearance": "https://...source-claim..."
  }
}
```

**Stima**: 0.5 giornata (template + un articolo pilota).

---

### FASE 5 — Submission, monitoring, AI Mode defense (1 giorno + monitoraggio continuo)

#### D1 — Google Publisher Center

**Steps manuali**:
1. [publishercenter.google.com](https://publishercenter.google.com)
2. Aggiungi "Frontaliere Ticino" come publication
3. Verifica ownership dominio (DNS o file)
4. Configura:
   - **Logo principale**: 600×60 (sfondo trasparente)
   - **Logo quadrato**: 1024×1024
   - **Logo small**: 192×192
   - **Sezioni**: Fisco, Lavoro frontaliere, Salari, Cambio valuta, Trasporti, Pensioni, Dogana
   - **Contact**: redazione@frontaliereticino.ch
   - **Lingue**: IT (primary), EN, DE, FR
   - **Geographic focus**: Svizzera (Ticino) + Italia (province confinanti)
5. Submit per review (1-2 settimane Google)

**Bonus**: Bing News Publisher (`bing.com/toolbox/submit-site-url`).

**Stima**: 0.5 giornata + tempi review esterni.

#### D2 — AI Mode / AI Overviews defense

**Nuovo** rispetto al piano v1 — da Barry Adams.

AI Mode sintetizza news senza bisogno che l'utente clicchi sul publisher → traffico calo strutturale 2025-2026. Difese:

1. **Push newsletter aggressivo**
   - Già in piedi (`newsletter_subscribers/`). Aumenta CTA in articoli + sticky banner
   - Settimanale digest, non daily (non spammare)
   - Contenuti esclusivi per iscritti (es. simulatore avanzato beta)

2. **Brand recognition**
   - Logo + brand color visibile in OG/Twitter Card
   - "By Frontaliere Ticino" in tutti i meta description
   - Tone-of-voice riconoscibile (italiano colloquiale ticinese, dati specifici)

3. **Contenuti che AI non può sintetizzare**
   - Simulatori interattivi (fiscale, AVS, LPP)
   - Comparatori in tempo reale (fuel, premi LAMal)
   - Mappe interattive (border wait times, webcam dogane)
   - Strumenti che richiedono input utente

4. **PWA / app mobile** (long-term)
   - Aggiungi a `public/manifest.webmanifest` (già presente)
   - Push notifications opt-in per articoli urgenti
   - Direct audience hedge

5. **Diversificazione canali**
   - Newsletter (esiste)
   - LinkedIn page company
   - Forum interno (esiste — `forum` tab)

**Stima**: distribuita lungo 2-4 settimane.

#### D3 — Monitoring

**GSC**:
- Filter "Search appearance: News"
- Performance on Discover
- Sitemap submission status

**Locale** (`scripts/audit-google-news.mjs`):
- News sitemap entries count + age distribution
- Compliance rate (% articoli con autore Person + KG-link valido)
- Topical fit (% articoli in whitelist topic)
- Freshness (% articoli <10h, <48h, <90d)
- Image variants coverage (16:9 + 4:3 + 1:1)
- Headline validation pass rate

**Cron settimanale**: `.github/workflows/audit-google-news.yml` ogni lunedì 06:00 UTC. Alert se compliance < 95%.

**Stima**: 0.5 giornata.

---

### FASE 6 — Hardening e regression prevention (continuo)

#### E1 — Test compliance Google News in CI

**File**: `tests/google-news-compliance.test.ts`

**Per ogni articolo nella news sitemap, verifica**:

| Check | Pass condition |
|---|---|
| Author type | `JSON-LD.author.@type === 'Person'` |
| Author resolves | URL `/autori/{slug}/` esiste in dist |
| Author has KG signals | `sameAs` contiene LinkedIn pubblico |
| datePublished present | ISO 8601 con timezone |
| dateModified present | `≥ datePublished`, ISO 8601 |
| Single visible date | nel rendered HTML (no datestamps duplicati) |
| `<title>` ↔ `<h1>` | testi identici |
| Headline rules | 10-110 char, 2-22 parole, no clickbait pattern |
| Image dimensions | width ≥ 1200, height ≥ 675 |
| Image variants | almeno 1 di 16:9 (richiesto), bonus 4:3 e 1:1 |
| Article body word count | ≥ 400 parole |
| AI disclosure box | presente nel rendered HTML |
| Topic whitelist | `articleSection` o slug match topic frontaliere |
| Byline visible | `<a rel="author">` con nome autore |
| Dateline | presente nel testo o nello schema |
| `articleSection` | presente e in lista approvata |
| `contentLocation` | presente per articoli con luogo |

**Gate CI** (`.github/workflows/deploy.yml`): blocca deploy se compliance < 100%.

**Stima**: 1 giornata.

#### E2 — Audit ricorrente settimanale

`.github/workflows/audit-google-news.yml`:
- Lunedì 06:00 UTC
- Output `data/google-news-audit-{YYYY-MM-DD}.json`
- Alert via newsletter dev se compliance scende
- Diff settimanale di topical fit

**Stima**: 0.5 giornata.

#### E3 — Documentazione interna

In `docs/`:
- `docs/EDITORIAL-WORKFLOW.md` — pipeline AI → review → publish
- `docs/AUTHORS.md` — come aggiungere/aggiornare autore
- `docs/GOOGLE-NEWS-RULES.md` — quick reference per dev/editor
- `docs/AI-MODE-DEFENSE.md` — strategia anti AI Mode

**Stima**: 0.5 giornata.

---

## 5. Riepilogo timeline

| Fase | Durata | Dipendenze | Output |
|---|---|---|---|
| FASE 1 | 2-3 giorni | nessuna | Autori reali (KG-link), Person schema, AI disclosure, sitemap pulita, headline validation |
| FASE 2 | 2-3 giorni | F1 (autori esistono) | Pagine editoriali, AdSense disclosure |
| FASE 3 | 3-5 giorni | F1 + F2 | Topical authority, geo-tag, section pages SSR, review pipeline |
| FASE 4 | 2 giorni | F1 + F3 | NewsMediaOrganization, NewsArticle esteso, image variants, WebSub, ClaimReview |
| FASE 5 | 1 giorno + 1-2 settimane review esterna + AI defense continuo | F1-F4 | Publisher Center submission, monitoring, AI Mode hedge |
| FASE 6 | continuo | tutte | CI gate, audit settimanale, docs |

**Lavoro effettivo**: ~12-15 giornate dev. Tempo calendario: ~3 settimane + 1-2 settimane review Google esterna.

---

## 6. Priorità immediata — corretta v5 (post-sitemap reality check)

> **Cambiamento chiave v5**: la verifica sitemap competitor ha rimosso "ridurre volume" come priorità (siamo in linea, 108/giorno vs 22-90 dei competitor). Le priorità si concentrano su: **topic discipline + authorship reale + AI disclosure + commit message hygiene**.

### Top 5 v5 (priorità riordinate)

1. **C1 estremo** — topic whitelist news sitemap calibrata sui 5 macro-temi del SERP reale (~0.5 gg) — rimuove ~60-80% degli URL non-frontaliere
2. **A1 + A2 versione minimal + commit message cleanup** — Person autori semplici (anche "Redazione" + 2-3 foto) + cambio commit da "📰 Auto-generated" a `feat(article): <title>` (~1.5 gg)
3. **A3** — disclosure AI in pagina (0.5 gg) — l'unica vera asimmetria vs human-authored competitor
4. **A5 + headline pattern library** — validation 10-110 char + few-shot LLM con i 27 esempi SERP (~1 gg)
5. **A4** — pulizia sitemap duplicato (0.25 gg)

Totale v5: ~3.75 gg per arrivare a baseline submittable.

### Top 6-10 (seconda ondata)

6. **B1 + B2** — correzioni + ChiSiamo esteso (1 gg)
7. **C3** — section pages SSR (1.5 gg)
8. **§6bis subset** — outreach Tier 2 (LinkedIn company, sindacati Lombardia/Ticino) (~1 gg)
9. **NEW lightweight review pipeline** — AI bozza → human review veloce → firma (~1 gg, NON deve rallentare il volume)
10. **Story-tracking competitor (downgraded)** — RSS Tio + CdT + ComoZero per opportunità follow-up; tattica utile ma non bloccante (~0.5 gg)

### Demoted (Fase 4 post-submission, opzionali)

- KG-linking autori con Wikidata
- `NewsMediaOrganization` schema
- Image variants 4:3 + 1:1
- `ClaimReview`, `dateline`, `contentLocation`, `articleBody` full-text in JSON-LD
- WebSub
- Riduzione volume (RIMOSSO definitivamente: il volume è OK)

---

## 6.legacy.v4. Priorità v4 (archiviata — conteneva errore di calibrazione volume)

> **Cambiamento chiave v4**: l'analisi del SERP reale "frontalieri svizzera" rivela che il mercato è dominato da 4 testate (Ticinonline, CdT, ComoZero, TVS = 74% del SERP) iper-specializzate su 5 macro-temi. Le priorità si spostano verso **story-tracking competitor + topic discipline estrema + headline pattern matching + frequenza calibrata 5-10/settimana** (non 20-30/giorno come v3).

### Top 5 v4 (priorità riordinate)

1. **C1 estremo** — topic whitelist news sitemap calibrata sui 5 macro-temi del SERP reale (~0.5 gg) — **rimuove ~80% della news sitemap attuale**
2. **NEW — Story-tracking pipeline competitor**: RSS Ticinonline + CdT + ComoZero + TVS + cluster detection (2+ publisher in 24h sulla stessa storia) → flag opportunità di follow-up (~1 gg)
3. **C4 ricalibrato** — frequenza target: **5-10 articoli/settimana**, non più 20-30/giorno; review pipeline AI → human (~1.5 gg)
4. **A3** — disclosure AI in pagina (0.5 gg)
5. **A5 + headline pattern library** — validation 10-110 char + `<title>=<h1>` + few-shot LLM con i 27 esempi SERP per replicare pattern stilistico (numeri, geo, action verbs, quote dirette) (~1 gg)

Totale v4: ~4.5 gg per arrivare alla baseline submittable.

### Top 6-10 (seconda ondata)

6. **A1 + A2 versione minima** — Person autori semplici, no KG iniziale (~1 gg)
7. **A4** — pulizia sitemap duplicato (0.25 gg)
8. **B1 + B2** — correzioni + ChiSiamo esteso (1 gg)
9. **C3** — section pages SSR (1.5 gg) — confermata, tutti i top 4 competitor le hanno
10. **§6bis subset** — brand-building outreach: contatto ai sindacati Lombardia/Ticino + LinkedIn company page (~1 gg)

### Demoted (Fase 4 post-submission, opzionali)

- KG-linking autori con Wikidata (i top 4 competitor non lo hanno)
- `NewsMediaOrganization` schema (ComoZero usa `Organization` generico)
- Image variants 4:3 + 1:1 (1 sola variante widescreen è la norma)
- `ClaimReview`, `dateline`, `contentLocation`, `articleBody` full-text in JSON-LD
- WebSub (nice-to-have, non strettamente necessario)

---

## 6.legacy. Priorità v3 (archiviata)

> **Cambiamento chiave v3**: dopo l'analisi dei 2 articoli reali in Google News, le priorità sono ribilanciate verso **volume + topical fit + AI disclosure + Person autore (minimo)**, e si **demotano** schema avanzati (KG linking, NewsMediaOrganization, ClaimReview, image variants 4:3/1:1) che gli esempi reali non usano.

In ordine di impatto/effort, da fare nei prossimi 3-5 giorni:

1. **C4 + C1** (anticipato dalla Fase 3) — review pipeline AI → human + topical filter news sitemap (~2 gg) — **principale blocker reale**: il pattern volume + auto-generate è ciò che ci distingue negativamente dagli esempi reali
2. **A1 + A2 versione semplificata** — autori `Person` minimi ("Redazione" + 2-3 foto + pagina base, senza KG linking iniziale) (~1 gg) — **gap E-E-A-T base**
3. **A3** — disclosure AI in pagina (0.5 gg) — **uniche al volume che abbiamo**
4. **A4** — pulizia sitemap duplicato (0.25 gg) — **quick win**
5. **A5** — headline validation 10-110 char + `<title>=<h1>` (0.5 gg) — **quality signal**

Totale: ~4 giornate per i quick win critici → baseline submittable a Publisher Center.

Poi seconda ondata (giorni 5-10):

6. **B1 + B2** — correzioni + ChiSiamo esteso (1 gg) — **transparency**
7. **C3** — section pages SSR (1.5 gg) — **architettura news (entrambi gli esempi reali le hanno)**
8. **I4** — WebSub ping (0.25 gg) — **indexing istantaneo**
9. **D2 (subset)** — newsletter CTA aggressivo + brand recognition (~0.5 gg) — **AI Mode hedge**

**Demoted alla Fase 4 (post-submission, opzionali)**:
- A1 estensione KG-linking con Wikidata `sameAs` (i 2 esempi reali non lo hanno)
- I1 `NewsMediaOrganization` (ComoZero usa `Organization` generico)
- I3 image variants 4:3 + 1:1 (ComoZero usa solo 1 variante 3:2)
- I5 `ClaimReview` (nessuno dei due lo usa)
- C2 `dateline` + `contentLocation` (nessuno dei due lo usa)
- I2 `articleBody` full text in JSON-LD (nessuno dei due lo include)

Da fare solo **dopo** essere stati accettati su Publisher Center, come incremental gain marginali.

---

## 6bis. Brand authority gap (nuovo in v3)

L'analisi dei 2 articoli reali ha esposto un gap che il piano v2 sottovalutava: **entrambi i publisher in Google News hanno una storia di brand già stabilita** (RSI è broadcaster pubblico storico, ComoZero è testata regionale dal 2014). Noi siamo nuovi → serve attivamente **brand-building**.

### Azioni brand authority (parallele alle fasi tecniche)

1. **Citazioni cross-publisher**: contattare testate ticinesi (`tio.ch`, `cdt.ch`, `laregione.ch`, `ticinonews.ch`, `tvsvizzera.it`) per essere citati come fonte su simulatori fiscali / dati frontaliere. Ogni mention con backlink è un segnale forte.

2. **LinkedIn company page** + post settimanali con dati esclusivi (es. trend salari frontaliere, premi LAMal medi). Anche redazione su LinkedIn.

3. **Newsletter aggressiva**: già esiste; aumentare CTA in articoli, sticky banner, contenuti esclusivi per iscritti (alert nuovi accordi, calcolatore premium).

4. **Press release** sui dataset proprietari: quando aggiorniamo `data/jobs-stats.json` o `data/health-premiums.json`, rilascio comunicato stampa con tabelle citabili.

5. **Partnership con sindacati / associazioni**: OCST, sindacati frontalieri italiani — link da loro siti = autorità domain.

6. **Wikipedia mention**: creare voce su Wikipedia IT per "Frontaliere Ticino" come fonte secondaria (evitare auto-promo, devono essere fonti terze a citarci).

7. **Schema `mentions` cross-domain**: quando un articolo cita una fonte primaria (AFC, sentenza, TV svizzera), aggiungere `citation` schema → costruisce co-citazione con domini autoritativi.

**Effort**: distribuito 2-4 settimane, principalmente lavoro di outreach e content.
**Effort tecnico**: minimo (manifest LinkedIn, citation schema in `create-article.mjs`).

---

## 7. Cambiamenti vs piano v1

Per chi legge dopo aver visto la v1:

**Aggiunti**:
- A5 (headline validation 10-110 char, `<title>=<h1>`)
- C2 (geo-tag + dateline + schema `Place`) — Discover Feb 2026
- C3 (section pages SSR) — Google News architecture
- C6 (URL stability audit)
- I1 (`NewsMediaOrganization` invece di `Organization`)
- I3 (image variants 16:9 + 4:3 + 1:1)
- I4 (WebSub / PubSubHubbub)
- I5 (`ClaimReview` schema)
- D2 (AI Mode defense — Barry Adams)
- Sezione **Soglie tecniche** (§2)
- Sezione **Implicazioni Discover Feb 2026** (§3)

**Modificati**:
- A1: aggiunto requisito KG-linkability (`sameAs` Wikidata/LinkedIn pubblico) per ogni autore
- A2: aggiunta regola "single visible date" tra `<h1>` e body
- C1: whitelist topic ampliata
- I2: NewsArticle esteso con `articleBody`, `articleSection`, `keywords`, `wordCount`, `dateline`, `contentLocation`
- E1: test compliance esteso con check headline, varianti immagine, sync `<title>=<h1>`

**Confermati invariati**:
- Strategia generale a 6 fasi
- Volume target ~20-30 articoli/giorno
- Pipeline review umana

---

**v5 (verifica sitemap reali competitor — correzione errore calibrazione volume)**:

**Errore corretto**:
- v4 affermava "ridurre volume a 5-10 articoli/settimana", basandosi su quota SERP per query specifica
- **Realtà**: i competitor pubblicano 22-90 articoli/giorno totali; noi siamo a 108/giorno → **in linea, non anomalo**
- L'errore era confondere quota SERP (5-6 articoli per publisher in 30gg) con frequenza editoriale totale

**Aggiunti**:
- §0ter Verifica sitemap reali competitor (Tio.ch ~85-90/gg, CdT ~63/gg, ComoZero ~22/gg)
- §0ter.4 Correzione priorità

**Demoted**:
- Riduzione volume → rimossa definitivamente (il volume va bene)
- Story-tracking competitor → declassata da #2 a #10 (tattica utile, non blocker)

**Promoted nella top 5**:
- A1+A2 con cleanup commit message ("📰 Auto-generated" → `feat(article): <title>`)
- AI disclosure (resta unica vera asimmetria vs competitor human-authored)
- Headline pattern library (sweet spot di efficacia/effort)

**Mantenuto**:
- Topic discipline rigorosa (C1) — verticalità su frontaliere-fiscale, non publisher generalista
- Authorship Person minimale anche solo "Redazione" + foto
- Section pages SSR (C3)

---

**v3 (calibrazione su 2 articoli reali in Google News IT — RSI + ComoZero)**:

**Aggiunti**:
- §0 Calibrazione su esempi reali (audit completo dei 2 articoli)
- §6bis Brand authority gap (nuovo focus su outreach, citazioni cross-publisher, LinkedIn company, partnership)

**Demoted/rimandati a Fase 4 post-submission**:
- KG-linking autori con Wikidata `sameAs` (nessuno dei 2 esempi lo ha)
- `NewsMediaOrganization` schema (ComoZero usa `Organization` generico)
- Image variants 4:3 + 1:1 (ComoZero usa solo 3:2)
- `ClaimReview` schema (nessuno dei 2 lo usa)
- `dateline` + `contentLocation` (nessuno dei 2 li ha)
- `articleBody` full text in JSON-LD (nessuno dei 2 lo include)
- `NewsArticle` strict (`Article` generico è sufficiente — ComoZero docet)

**Promoted a #1**:
- C4 (review pipeline) + C1 (topical filter) — il pattern volume + AI è il nostro vero blocker, non il fine-tuning schema
- A1+A2 versione semplificata (Person basta, anche solo "Redazione" + foto, senza KG iniziale)

**Cambiata priorità immediata**:
- v1+v2: "A1+A2 KG-linkable autori" era #1
- v3: "C4+C1 ridurre volume + filtrare topic" è #1; A1+A2 versione minima è #2

---

## 8. Riferimenti

- [Semrush — Google News SEO](https://www.semrush.com/blog/google-news-seo/)
- [SearchAtlas — Google News SEO](https://searchatlas.com/blog/google-news-seo/)
- [Google Publisher Center — Technical requirements](https://support.google.com/news/publisher-center/answer/9607104)
- [Google News content policies](https://support.google.com/news/publisher-center/answer/6204050)
- [Lumar — Google News SEO](https://www.lumar.io/blog/best-practice/google-news-seo/)
- [Search Engine Land — Google News optimization](https://searchengineland.com/google-news-optimization-boost-content-visibility-traffic-395031)
- [How Google News works (ufficiale)](https://www.google.com/search/howsearchworks/how-news-works/)
- [SEO for Google News (Barry Adams)](https://www.seoforgooglenews.com/)
- [Google Discover Core Update Feb 2026](https://developers.google.com/search/blog/2026/02/discover-core-update)
- [LinkedIn — Discover signals fin 2025/2026 (Andell Wriff)](https://www.linkedin.com/pulse/google-discover-fin-2025-2026-signaux-locaux-related-auteurs-andell-wriff/)
- [Intervista Barry Adams (Roberto Serra, ago 2025)](https://www.roberto-serra.com/news/intervista-barry-adams-agosto-2025/)
- [schema.org/NewsArticle](https://schema.org/NewsArticle)
- [schema.org/NewsMediaOrganization](https://schema.org/NewsMediaOrganization)
- [schema.org/Person](https://schema.org/Person)
- [schema.org/ClaimReview](https://schema.org/ClaimReview)
- [Google News Sitemap Specification](https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap)
- [WebSub W3C Recommendation](https://www.w3.org/TR/websub/)
- CLAUDE.md non-negotiable rules #5 (root cause), #11 (gh CLI)
- Memory: `feedback_never_noindex_without_approval.md`
