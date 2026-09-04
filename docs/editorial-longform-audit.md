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

**Sì.** Non risultano, in questo repository, componenti di mappa geografica o
libreria di infografiche riutilizzabile per contenuti editoriali (il sito ha
grafici per dati interni — es. `InlineBorderWaitRanking`, i grafici del
traffico ai valichi — ma nessuno pensato per una mappa "Ticino+Insubria" o
per tabelle comparative multi-territorio). Il brief pilota (§"Requisiti") lo
segna esplicitamente come lavoro non coperto da infrastruttura esistente.

## 5. I KPI privilegiano quantità/SEO breve rispetto a engagement/backlink/brand authority?

**Sì, per quello che è effettivamente strumentato.** `data/article-performance.json`
e il ranker consumano segnali di ricerca/domanda (GSC, keyword match), non
risultano — verificato per assenza di riferimenti nei file sopra — metriche di
scroll depth, tempo sulla pagina o backlink per singolo articolo usate come
input alla selezione dei topic. Questo è coerente con l'obiettivo dichiarato
del selettore (massimizzare match su domanda di ricerca frontaliera), non con
un obiettivo di brand-authority/longform.

## 6. La monetizzazione ads scoraggia il formato longform per limiti di layout/UX?

**Sì, ed è il finding più concreto e azionabile di questo audit.**
`services/articleAdSlots.ts` implementa oggi una strategia dichiarata
esplicitamente **"max-density mode"**:

```
Strategy (2026-05-19): max-density mode — auth-gate removed, every paragraph
inside the body now gets its own ad via the in-renderer hook in
BlogArticles.tsx. [...] No heading-safety check: the per-paragraph injector
[...] is the dominant placer; inter-segment ads complement it.
```

`computeArticleAdSlots()` piazza un ad **a ogni confine tra segmenti**, senza
alcun controllo che eviti di spezzare tabelle, citazioni o liste operative —
esattamente il tipo di interruzione che il brief benchmark (§"Principi per
frontaliereticino.ch" dell'issue) elenca come da evitare. `MAX_INLINE_ADS` è
`Number.MAX_SAFE_INTEGER`: non esiste un tetto.

Questa è la causa diretta della domanda 6: un longform con tabelle, mappa,
citazioni multiple e una sezione di scenari verrebbe oggi trattato dal
renderer esattamente come un articolo breve — un ad ogni paragrafo — il che
è in tensione diretta con "riservare l'above-the-fold alla promessa
editoriale" e "non spezzare tabelle/mappe/citazioni" richiesti dal benchmark.
Il mapping dettagliato e le raccomandazioni sono in
`docs/ads-placement-longform.md`.

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
