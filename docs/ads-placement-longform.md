# Ads placement per longform editoriale — mappa, principi, wireframe

Companion di `docs/editorial-longform-audit.md` (issue #6535). Analizza il
posizionamento ads *come pattern*, non copia pixel-per-pixel del benchmark
Milano Città Stato, e lo confronta con l'implementazione reale in questo
repository.

## 1. Stato attuale, verificato nel codice

`services/articleAdSlots.ts` → `computeArticleAdSlots()`:

- **Densità**: un ad ad ogni confine tra segmenti del corpo (`STEP_SEGMENTS = 1`,
  `STEP_MIN_WORDS = 0` → trigger incondizionato), più un ad per ogni paragrafo
  via l'hook di rendering in `BlogArticles.tsx` ("max-density mode",
  commento del 2026-05-19).
- **Nessun tetto**: `MAX_INLINE_ADS = Number.MAX_SAFE_INTEGER`.
- **Nessun controllo di sicurezza sui confini strutturali**: il commento del
  modulo lo dichiara esplicitamente ("No heading-safety check"). Non distingue
  un confine "tra due paragrafi di prosa" da un confine "subito prima/dopo una
  tabella, una citazione, una lista operativa".

Questa strategia è corretta per il formato attuale (articoli brevi, singolo
tema, nessuna tabella/mappa) ed è una decisione di revenue esistente — **non va
toccata per il corpus attuale** (AGENTS.md #7, mai degradare la
monetizzazione). Il problema è che non esiste una modalità alternativa per un
formato strutturalmente diverso (longform multi-sezione con tabelle/mappe),
che oggi erediterebbe la stessa densità massima.

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

## 6. Cosa NON fa questo documento

Non introduce un nuovo componente/variante a densità ridotta in
`services/articleAdSlots.ts`. Costruire quella variante ora, senza un
consumatore reale (nessun template "longform" esiste ancora nel renderer,
`BlogArticles.tsx` applica oggi un'unica densità a tutti gli articoli),
sarebbe un'astrazione speculativa (AGENTS.md #6). Il mapping sopra è la spec
pronta da implementare quando il primo longform reale esiste da renderizzare.
