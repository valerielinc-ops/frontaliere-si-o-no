# Editorial longform audit — perché non esistono articoli come "Città dei Laghi"

Risposta ad audit richiesto in issue #6535 (benchmark: [Milano Città Stato — "Il
futuro sarà della «città dei laghi»"](https://www.milanocittastato.it/grande-milano/il-futuro-sara-della-citta-dei-laghi-la-los-angeles-della-lombardia/)).
Ogni affermazione qui sotto è verificata leggendo il codice della pipeline
editoriale reale, non ipotizzata — dove il codice non basta a rispondere, è
dichiarato esplicitamente.

## 0. Il fatto che cambia la diagnosi: la generazione non vive più in questo repo

Dal cutover del 2026-08-02 (`docs/articles-generator-migration.md`), la
generazione di articoli è stata migrata interamente in un repository separato,
`nanakokyobashi-rgb/frontaliere-articles` ("nanako"). Questo sito è un
**consumer**: `scripts/pull-articles-api.mjs` scarica JSON/sitemap già
pubblicati e li scrive in `public/`, non genera più contenuto in-tree.
`.github/workflows/generate-article.yml` ha lo `schedule:` commentato
esplicitamente "DISABLED AT CUTOVER" e resta solo per `workflow_dispatch`
manuale.

Conseguenza diretta per questo audit: qualunque intervento sul *come* vengono
scelti/scritti gli articoli (prompt, selezione topic, soglie di
fact-checking) va fatto in nanako, non qui. Questo repo può però rispondere
alle domande sull'ARCHITETTURA della pipeline (che è stata portata in nanako
sostanzialmente invariata — vedi §5.2 del migration doc, "MOVE" dei file sotto
`scripts/lib/**`), e sul posizionamento ads/layout (che resta qui, §"Ads" più
sotto).

## 1. Il piano editoriale è centrato su utility/servizi, non su analisi territoriale?

**Sì, per costruzione del selettore di topic**, non per policy dichiarata.
`scripts/lib/article-topic-selector.mjs` (migrato in nanako, stessa logica)
sceglie il prossimo topic in questo ordine:

```
news (score alto) → top-candidate da data/topic-candidates.json (score ≥ 0.6) → evergreen
```

Il ranking (`cascadedScore`) pesa **demand-vocabulary match** (`MIN_DEMAND_SCORE`,
commento del file: "real frontaliere headlines typically score 0.5-2.0 on demand
match") più diversità/novità di cluster. Non esiste una componente che
premi una *tesi originale* o una *struttura a capitoli* — il sistema ottimizza
per "headline con alto match su un vocabolario di domanda frontaliera",
strutturalmente vicino a una notizia breve o a un articolo long-tail SEO
single-question, mai a un longform con più assi tematici (mobilità + economia
+ abitare + scenari, come nel benchmark).

Questo non è un bug: `RANKER_MIN_SCORE`/`MIN_DEMAND_SCORE` esistono proprio per
evitare argomenti fuori target (commento nel file cita il caso reale
"Nottambuli Ticino orari società", un topic generato fuori tema). Ma
l'effetto collaterale, mai bilanciato da un contrappeso, è che il sistema non
ha *nessun* incentivo verso longform di analisi.

## 2. Manca un content brief / pipeline per longform originali?

**Sì.** Non esiste, in nessuno dei due repository (per quanto ispezionabile da
qui), una categoria di generazione distinta da "articolo breve news" o
"evergreen SEO". `scripts/create-article.mjs` (migrato) produce un unico
formato: corpo diviso in `body1..bodyN` con targhet di parole per campo
(vedi commento su "600 words/field" in `generate-article.yml`), pensato per
un articolo di lunghezza standard, non per un longform a 7 capitoli con
tabelle comparative e infografiche come richiesto dal brief del pilota.

Questo PR introduce il primo content brief dedicato:
`docs/citta-dei-laghi-content-brief.md`.

## 3. Il sistema di approvazione favorisce news brevi/derivate rispetto a inchieste da fonti primarie?

**Parzialmente sì, per il design dei gate di factuality.** `docs/ARTICLE-LEARNING-LOOP.md`
documenta un sistema di gate deterministici (`article-factuality-gates.mjs`)
tarato su **una fonte fetchata per run** (`support: present|absent|unknown`).
Il design è esplicitamente conservativo: senza una fonte primaria affidabile,
un claim non può essere confermato (`unknown`, mai bloccante da solo). Questo
è corretto per prevenire fabbricazione (l'incidente del 2026-07-28 — un
verificatore LLM che si autoconvinceva di un'istituzione inventata, UFI — è
la ragione per cui l'intero §5 del learning-loop esiste), ma il corollario è
che un'inchiesta con **più fonti primarie eterogenee** (Cantone Ticino, FFS,
ISTAT, USTAT, Eurostat, come richiesto dal pilota) non ha un percorso di
verifica pensato per quel caso: il gate ragiona per singola fonte fetchata
per singolo claim, non per sintesi cross-fonte.

Conclusione: il vincolo non è "il sistema preferisce le notizie per pigrizia
editoriale", è che l'infrastruttura di fact-check esistente non è stata
progettata per longform multi-fonte — è un gap di capacità, non di scelta
editoriale.

## 4. Mancano dati strutturati, visualizzazioni, mappe per questo tipo di contenuto?

**In parte, e non per assenza della libreria.** La mappa geografica c'è ed è
in produzione: `leaflet` e `react-leaflet` sono dipendenze installate
(`package.json`) e sono usate da **sei** componenti — `LivabilityMap`,
`SupermarketMap`, `TicinoCompanies` (`components/vita/`),
`BorderMunicipalitiesMap`, `FrontierGuide`, `TrafficAlerts`
(`components/guide/`). Quello che manca non è la capacità di disegnare una
mappa, è il **guscio condiviso**: i sei duplicano import di `leaflet.css`,
`MapContainer`/`TileLayer` e altezza riservata, senza un componente comune che
un contenuto editoriale possa istanziare (issue #7339, aperta).

Sulle infografiche il finding regge: i grafici esistenti servono dati interni
(es. `InlineBorderWaitRanking`, i grafici del traffico ai valichi) e nessuno è
pensato per tabelle comparative multi-territorio. Il brief pilota
(§"Requisiti") resta corretto sul secondo punto, non sul primo.

## 5. I KPI privilegiano quantità/SEO breve rispetto a engagement/backlink/brand authority?

**Sì, per quello che è effettivamente strumentato.** `data/article-performance.json`
e il ranker consumano segnali di ricerca/domanda (GSC, keyword match), non
risultano — verificato per assenza di riferimenti nei file sopra — metriche di
scroll depth, tempo sulla pagina o backlink per singolo articolo usate come
input alla selezione dei topic. Questo è coerente con l'obiettivo dichiarato
del selettore (massimizzare match su domanda di ricerca frontaliera), non con
un obiettivo di brand-authority/longform.

## 6. La monetizzazione ads scoraggia il formato longform per limiti di layout/UX?

**Era il finding più concreto di questo audit, ed è stato chiuso.** Alla
stesura, `components/community/BlogArticles.tsx` — il solo placer inline in
produzione, dopo la rimozione del modulo `services/articleAdSlots.ts` che non
aveva consumatori (issue #7338) — applicava **un unico profilo di densità a
tutti gli articoli**: tetto `ARTICLE_INLINE_AD_CAP = 8` e gap minimo di 200
parole, senza alcun predicato di formato. Un longform ereditava il profilo di
un articolo breve.

Dal 2026-09-05 (issue #7336) il predicato esiste: il tetto e il gap escono da
`resolveArticleAdDensity` (`services/articleAdDensity.ts`), che su un corpo con
≥7 sezioni `## ` seleziona il profilo longform di `docs/ads-placement-longform.md`
§3 (3 ad in-content, gap 300 parole) invece dello standard 8/200, invariato per
ogni altro articolo. Misura sul corpus alla stessa data: 402 articoli `it` su
3779 sono longform, i loro ad inline passano da 1647 a 1105; i 9599 sugli altri
3377 restano identici.

Sui confini strutturali va detto cosa il renderer protegge e cosa no. L'ad non
viene mai emesso "a ogni paragrafo": i punti di emissione sono due — prima di un
confine `## ` e a fine segmento di corpo (`tryEmitAd`) — e l'ad che cadrebbe a
cavallo di una tabella viene rinviato al confine successivo, mai perso (issue
#7337). Citazioni e liste operative non hanno invece una protezione dedicata e
possono ancora essere spezzate: è il residuo aperto rispetto al brief benchmark
(§"Principi per frontaliereticino.ch" dell'issue).

Il mapping dettagliato, il wireframe e lo stato di implementazione sono in
`docs/ads-placement-longform.md` §1 e §6.

## Decisione: licenza/syndication vs contenuto originale

**Decisione: contenuto originale** (opzione consigliata dalla issue stessa),
non syndication. Citare l'articolo di Milano Città Stato come lettura
correlata, mai riprodurne testo. Nessuna negoziazione di licenza con terzi è
un'azione che questo ciclo autonomo possa eseguire (richiede contatto/accordo
commerciale con un editore esterno), quindi non è "una variabile vuota" da
sbloccare — è semplicemente la strada non scelta. Decisione presa citando il
driver **D3** di VISION.md (decisioni editoriali autonome) e la
raccomandazione esplicita della issue.

## Cosa resta fuori da questo audit (per onestà, non per scarico)

- Non è stato possibile ispezionare il repository `nanakokyobashi-rgb/frontaliere-articles`
  da questa sessione (nessun accesso configurato in questo run) — le
  affermazioni su "nanako" sopra si basano sul contenuto già portato lì al
  momento del cutover (`docs/articles-generator-migration.md`), non su una
  lettura diretta del suo stato attuale.
- I KPI di engagement/backlink/RPM per il primo longform pubblicato non
  esistono finché non c'è un longform pubblicato da misurare — vedi
  `## Non implementato (ancora)` della PR che introduce questo documento.
