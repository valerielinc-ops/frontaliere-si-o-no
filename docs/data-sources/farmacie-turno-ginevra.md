# Farmacie di turno — Ginevra

## Fonte e contratto

La fonte allowlisted è [Pharmageneve — Pharmacies de garde 2026](https://pharmageneve.swiss/pharmacie-de-garde/). Il connettore GE la legge come HTML, richiede `Europe/Zurich`, il perimetro `CH/GE` e una corrispondenza univoca fra ogni etichetta della fonte e un catalogo farmacia GE.

Il parser conserva le osservazioni datate, converte gli estremi locali in timestamp verificabili e fallisce chiuso su URL, titolo, località, intervalli, sovrapposizioni, freschezza, identità o calendario incompleto. La carta `pharma24` con apertura 24/7 è un’osservazione permanente: non viene trasformata in un turno datato.

## Stato verificato al 15 settembre 2026

La pagina espone due sole finestre datate:

- `Pharmacie du Museum`, 31 ottobre–6 novembre 2026, 08:00–23:00;
- `Pharmacie Plaza`, 15–21 agosto 2026, 08:00–23:00.

La copertura osservata è quindi di 14/365 giorni, con 351 giorni scoperti. Lo snapshot checked-in è `not_published`, contiene `duties: []` e ha `indexable: false` nel gate runtime. Non esistono route, UI settimanale o SEO GE: l’integrazione resta source-only finché la fonte non pubblica un calendario annuale contiguo e non è disponibile il catalogo identità GE. Questo blocco vale per GE; gli altri 25 cantoni restano source-only e non vengono modificati dal connettore.

Per aggiornare lo snapshot in modo atomico:

```bash
node scripts/import-pharmacy-duties-geneva.mjs
```

Il comando restituisce exit code non-zero quando la release non è pubblicabile; questo è intenzionale e impedisce di scambiare un’osservazione parziale per una release operativa.
