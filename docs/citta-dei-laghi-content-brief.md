# Content brief — "La Città dei Laghi può diventare la metropoli transfrontaliera tra Milano e Zurigo?"

Primo pilota della linea editoriale "Insubria 2035" (issue #6535). Questo è un
**brief per la produzione**, non un articolo: nessun dato/statistica qui sotto
è inventato o fabbricato — dove serve un numero, il brief indica la fonte
primaria da consultare al momento della stesura, mai un valore stimato a
memoria da un modello linguistico.

## Perché un brief e non l'articolo pubblicato in questa PR

La generazione/pubblicazione di contenuto editoriale per questo sito vive nel
repository separato `nanakokyobashi-rgb/frontaliere-articles` da cutover
2026-08-02 (`docs/articles-generator-migration.md`), fuori dal perimetro di
scrittura di questa PR. Anche se così non fosse: un longform con "fact-check
claim-by-claim, URL e data di accesso" su dati di popolazione, pendolarismo,
mobilità e costo della vita richiede una ricerca a fonti primarie che va
condotta e verificata da chi pubblica al momento della stesura — scriverla ora
significherebbe inventare numeri plausibili, esattamente il difetto che
`docs/ARTICLE-LEARNING-LOOP.md` (incidente 2026-07-28, istituzione "UFI"
inventata) documenta come il rischio più grave della pipeline editoriale di
questo sito. Questo brief è il modo di far avanzare il lavoro senza
fabbricare.

## Tesi (di lavoro, da confermare/confutare con i dati, non da assumere)

L'area Ticino–Insubria (Como, Lecco, Varese, Canton Ticino) funziona già oggi
come sistema economico integrato via pendolarismo frontaliero, ma non come
sistema urbano riconosciuto: mancano governance comune, infrastrutture di
collegamento dirette e un'identità territoriale condivisa. La tesi deve
restare falsificabile — se i dati mostrano il contrario (es. pendolarismo in
calo, investimenti infrastrutturali fermi), l'articolo lo riporta.

## Fonti primarie da consultare (nessun dato va preso da qui)

| Ambito | Fonte | Cosa cercare |
|---|---|---|
| Pendolarismo frontalieri | Ufficio federale di statistica (USTAT Ticino), SECO | numero frontalieri G per cantone/provincia, trend annuale |
| Popolazione/demografia | ISTAT, Cantone Ticino (dati.ti.ch) | popolazione Como/Lecco/Varese/Ticino, densità |
| Mobilità ferroviaria | FFS, TILO, FNM (Trenord) | frequenze S10/S50/S90, tempi di percorrenza, progetti in corso |
| Costo abitativo | Wüest Partner / UFAB (Svizzera), Osservatorio del mercato immobiliare-OMI (Italia) | prezzi affitto/mq per comune di confine |
| Confronti europei/metodologia | Eurostat (cross-border regions) | definizioni standard di area funzionale transfrontaliera |
| Università/ricerca | pubblicazioni SUPSI, Politecnico di Milano, Università dell'Insubria su aree metropolitane transfrontaliere | letteratura esistente sul tema, per non "reinventare" un'analisi già fatta |

Ogni claim numerico nell'articolo finale deve portare URL + data di accesso
(requisito esplicito della issue). Nessuna cifra "a memoria".

## Struttura (dalla issue, invariata)

1. La domanda: esiste già una città transfrontaliera di fatto?
2. I numeri: popolazione, lavoro, frontalieri, imprese e flussi.
3. I collegamenti: cosa funziona e cosa manca.
4. Abitare tra due sistemi: costi, servizi e qualità della vita.
5. I progetti in corso e le decisioni necessarie.
6. Tre scenari al 2035: minimo, realistico, ambizioso.
7. Fonti, metodologia e aggiornamenti.

## Disciplina editoriale obbligatoria

- Separare esplicitamente fatti (con fonte), scenari (etichettati come tali),
  opinioni (attribuite a una persona/ente reale) e proposte (dell'autore).
- Nessuna citazione di un'istituzione/ente il cui nome non è verificato contro
  la fonte primaria (stesso principio del gate `checkFabricatedInstitutionAcronyms`
  in `scripts/lib/article-factuality-gates.mjs`/nanako — un acronimo o nome
  ente va confermato dalla fonte fetchata, non dedotto).
- Citare l'articolo di Milano Città Stato come lettura correlata quando
  pertinente, mai riprodurne frasi o struttura di paragrafo (vincolo
  copyright, issue §"Vincolo copyright").
- Disclosure esplicita se una sezione si appoggia a una fonte di terzi oltre
  il benchmark.
- Tabelle comparative SOLO se i dati sono metodologicamente comparabili (unità
  di misura, anno di riferimento, definizione di area geografica coerenti) —
  se non lo sono, dichiararlo nel testo invece di forzare un confronto.

## Mappa e infografiche

Nessuna libreria di mappa geografica per contenuti editoriali esiste oggi in
questo repository (verificato in `docs/editorial-longform-audit.md` §4) — la
mappa dell'area e le infografiche proprietarie sono un prerequisito di
produzione da costruire quando questo brief passa in stesura, non un asset
che questa PR può generare senza un consumatore.

## Piazzamento ads

Segue `docs/ads-placement-longform.md` — 3 ad in-content + 1 di chiusura,
mai a cavallo delle tabelle di §2/§4 o della mappa di §3.

## Stato di avanzamento

Questo brief è pronto. Restano bloccati, verso la pubblicazione effettiva:
ricerca a fonti primarie, stesura, fact-check claim-by-claim, mappa/infografiche
originali, pubblicazione (repository esterno) — vedi `## Non implementato
(ancora)` della PR che introduce questo documento.
