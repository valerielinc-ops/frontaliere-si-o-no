# Ads placement per longform editoriale — mappa, principi, wireframe

Companion di `docs/editorial-longform-audit.md` (issue #6535). Analizza il
posizionamento ads *come pattern*, non copia pixel-per-pixel del benchmark
Milano Città Stato, e lo confronta con l'implementazione reale in questo
repository.

## 1. Stato attuale, verificato nel codice

Il piazzamento inline vive **interamente** in
`components/community/BlogArticles.tsx` → `renderFormattedContent()` +
`makeInlineAd` (non esiste un modulo di placement separato: `articleAdSlots.ts`,
che non era importato da nessun modulo di produzione, è stato rimosso — issue
#7338):

- **Densità**: un ad prima di ogni confine H2 e uno a fine segmento, subordinati
  a un gap minimo di `AD_MIN_WORD_GAP = 200` parole di contenuto dall'ad
  precedente.
- **Tetto per articolo**: `ARTICLE_INLINE_AD_CAP = 8` sul formato breve (~4 ad
  su 1500 parole, ~7-8 su 3000). Dal 2026-09-05 (issue #7336) non è più
  uniforme: il tetto e il gap escono da `services/articleAdDensity.ts`
  (`resolveArticleAdDensity`), che seleziona il profilo longform di §3 su un
  corpo con ≥7 sezioni `## `.
- **Eleggibilità**: ≥3 segmenti di corpo, ≥220 parole e ≥1400 caratteri
  (`adEligible`), soglia unica per tutti i formati ads.
- **Confini strutturali**: l'unica protezione è il rinvio dell'ad quando la
  sezione dopo l'H2 apre con una tabella (ri-tentato al confine successivo, mai
  perso). Citazioni e liste operative non hanno protezione dedicata.

Questa strategia è corretta per il formato attuale (articoli brevi, singolo
tema, nessuna tabella/mappa) ed è una decisione di revenue esistente — **non va
toccata per il corpus attuale** (AGENTS.md #7, mai degradare la
monetizzazione): il profilo standard resta identico per ogni articolo che non è
longform. La modalità alternativa per il formato strutturalmente diverso, che
prima non esisteva ed ereditava la stessa densità massima, è il profilo di §3.

## 2. Principi per un longform (dal benchmark, adattati)

- Above-the-fold: promessa editoriale (titolo, lede, indice dei capitoli),
  zero ad.
- Primo ad SOLO dopo il primo blocco di valore editoriale (intro + prima
  sezione), non al primo confine di paragrafo.
- Ad tra sezioni H2, mai dentro/subito-a-cavallo di: tabelle comparative,
  mappe/infografiche, citazioni di esperti, liste operative, conclusioni/scenari.
- Nessuna coppia di unità pubblicitarie adiacenti (min. un blocco editoriale
  pieno tra due ad).
- Dimensioni riservate (`min-height`/`aspect-ratio`) per ogni slot, per CLS zero
  — stesso principio già richiesto per Auto Ads in AGENTS.md #7.
- Densità ads più bassa sui contenuti YMYL (qui: dati fiscali/permessi), non
  applicabile 1:1 a un longform di analisi territoriale che non è YMYL in senso
  stretto, ma la disciplina "non spezzare una fonte primaria citata" resta.

## 3. Wireframe testuale — desktop

```
┌─────────────────────────────────────────────┐
│ Breadcrumb                                   │
│ H1 + lede (≤120 char) + indice capitoli      │  ← zero ad
├─────────────────────────────────────────────┤
│ §1 La domanda (intro, tesi)                  │  ← zero ad
├─────────────────────────────────────────────┤
│ [ AD — dimensione riservata ]                │  ← primo ad, dopo §1
├─────────────────────────────────────────────┤
│ §2 I numeri (tabella comparativa)            │  ← zero ad DENTRO la tabella
├─────────────────────────────────────────────┤
│ §3 I collegamenti (mappa originale)          │  ← zero ad DENTRO/accanto a mappa
├─────────────────────────────────────────────┤
│ [ AD — dimensione riservata ]                │  ← dopo §3, prima di §4
├─────────────────────────────────────────────┤
│ §4 Abitare tra due sistemi                   │
├─────────────────────────────────────────────┤
│ §5 Progetti in corso                         │
├─────────────────────────────────────────────┤
│ [ AD — dimensione riservata ]                │  ← dopo §5, prima degli scenari
├─────────────────────────────────────────────┤
│ §6 Tre scenari al 2035                       │  ← zero ad, conclusione critica
├─────────────────────────────────────────────┤
│ §7 Fonti e metodologia                       │  ← zero ad
├─────────────────────────────────────────────┤
│ CTA: newsletter / articoli correlati         │  ← zero ad adiacente alla CTA
├─────────────────────────────────────────────┤
│ [ AD di chiusura — dimensione riservata ]    │
└─────────────────────────────────────────────┘
```

3 ad in-content + 1 di chiusura su 7 sezioni, mai a cavallo di tabella/mappa/
scenari — contro gli attuali N ad (uno a paragrafo) del formato breve.

## 4. Wireframe testuale — mobile

Stessa sequenza di zone, ma: indice capitoli collassato sotto H1 (accordion),
tabelle comparative come card scrollabili orizzontalmente (mai troncate),
mappa a piena larghezza con altezza riservata prima del caricamento (niente
CLS), stesso conteggio di 3 ad in-content + 1 chiusura (non di più: su mobile
la tentazione di aggiungere densità per via dello scroll più lungo va
resistita, è la causa più comune di "contenuto essenziale sotto la piega"
citata dal principio del benchmark).

## 5. Metriche da misurare al primo longform pubblicato

CLS, LCP, INP, viewability, fill rate, RPM per pagina, scroll depth, bounce
rate, tempo sulla pagina — confrontati contro la media del formato breve
esistente sullo stesso periodo. Nessuna di queste è misurabile prima che
esista un longform pubblicato: per questo resta in `## Non implementato
(ancora)` della PR, non è ignorata.

## 6. Stato di implementazione

Il profilo longform è nel placer reale (`components/community/BlogArticles.tsx`,
vedi §1) e non in un modulo di placement separato: quello che esisteva
(`services/articleAdSlots.ts`) non era importato dalla produzione e modificarlo
non avrebbe cambiato una sola impression. La selezione del profilo (predicato
puro + le due coppie tetto/gap) sta in `services/articleAdDensity.ts`, il
piazzamento resta nel renderer.

Costruito il 2026-09-05 (issue #7336) perché il consumatore esisteva già nel
corpus pubblicato: **402 articoli `it` su 3779** hanno ≥7 sezioni `## ` (mediana
10 sezioni, 1634 parole). Misura sul corpus, ad inline in-content: **1647 →
1105** su quei 402 (media 4,10 → 2,75; 342 su 402 arrivano ai 3 di §3), **9599
invariati** sui 3377 non-longform. Il gap longform è 300 parole, non di più:
il credito parole riparte a ogni segmento di corpo (mediana 3 segmenti), quindi
un gap da 500 scenderebbe a una media di 1,57 ad — sotto i 3 della spec, cioè
un taglio di densità invece del profilo specificato.

Resta non misurabile finché non esiste un longform *nuovo* pubblicato: le
metriche di §5 (CLS/LCP/INP, viewability, RPM, scroll depth) vanno confrontate
contro la media del formato breve sullo stesso periodo.
