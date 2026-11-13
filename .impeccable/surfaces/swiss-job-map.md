---
version: 1
slug: "swiss-job-map"
primary_target: "components/community/SwissBubbleMap.tsx"
related_targets:
  - "components/community/JobBoard.tsx"
  - "data/swiss-municipality-map.json"
---

## Direction contract

**THESIS** — La distribuzione delle offerte diventa leggibile sul territorio: confini cantonali, stemmi e conteggi guidano dal quadro federale ai comuni senza far passare i dati mancanti per zeri.

**OWN-WORLD** — Estensione locale dell’identità Frontaliere Ticino: fondo chiaro, titoli navy, accento viola, Space Grotesk e Inter, bordi sottili e spaziatura già definita in [DESIGN.md](../../DESIGN.md). Le geometrie e gli stemmi sono dati geografici verificabili, non decorazioni.

**STORY** — Si parte dai 26 cantoni; selezionandone uno si leggono gli stemmi dei comuni con offerte, i conteggi e l’accesso ai risultati. Le località ticinesi con una pagina dedicata mantengono il collegamento canonico; le altre applicano il filtro alla bacheca senza creare URL di ricerca interni. Le offerte senza un comune riconosciuto restano esplicitamente nel totale cantonale. Il simbolo comunale ufficiale resta distinto dallo stemma quando l’ente non ne ha uno attuale condiviso.

**FIRST VIEWPORT** — La mappa federale precede l’elenco alfabetico dei cantoni con conteggi e accesso ai risultati. Nella vista cantonale la mappa è seguita da conteggi comunali e dettagli leggibili fuori dall’area geografica; su schermi stretti i simboli non portano badge sovrapposti, perché il conteggio è già accanto al nome nell’elenco.

**FORM** — Mappa cantonale con marker di stemma, collegamento geografico discreto, dettagli selezionabili e lista sincronizzata. Forma definita dalla richiesta precisa dell’utente; [new-work.md](../../../../../../../../.agents/skills/impeccable/reference/new-work.md) §3 riserva il concept seed alle superfici aperte e lo esclude dalle estensioni locali.

**QUALITY BAR**

- I 26 stemmi cantonali e le geometrie cantonali corrispondono ai dati ufficiali; i link del quadro federale sono canonici e localizzati.
- Il simbolo comunale appare solo dopo una corrispondenza univoca tra località e comune corrente; nessuna località non riconosciuta viene inventata o sommata a un altro comune.
- I marker restano distinti su desktop e mobile; nome, conteggio, fonte del simbolo e azione sono accessibili e leggibili.
- I conteggi comunali non sostituiscono il totale cantonale; la quota non localizzata è dichiarata.
- Ogni arma o logo mostra la fonte; il logo ufficiale di Haute-Ajoie dichiara che per il comune corrente non è disponibile uno stemma comune.

**FINISH** — unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
