# Farmacie di turno — Ginevra

## Fonte e contratto

La fonte allowlisted è [Pharmageneve — Pharmacies de garde 2026](https://pharmageneve.swiss/pharmacie-de-garde/). Il connettore GE la legge come HTML, richiede `Europe/Zurich`, il perimetro `CH/GE` e una corrispondenza univoca fra ogni etichetta della fonte e il catalogo verificato in `data/pharmacy-duties-geneva-catalogue.json`.

Il parser conserva le osservazioni datate, converte gli estremi locali in timestamp verificabili e fallisce chiuso su URL, titolo, località, intervalli, freschezza, identità o calendario incompleto. La carta `pharma24` dichiara esplicitamente apertura 24/7/365: viene trasformata in intervalli giornalieri `24h`, senza dedurre un orario da una semplice anagrafica. Le finestre datate di altre farmacie possono sovrapporsi a questo servizio concorrente; una sovrapposizione della stessa identità resta un errore.

## Stato verificato al 24 settembre 2026

La pagina espone un servizio permanente e due finestre datate:

- `pharma24`, apertura 24h/24 e 7j/7, Boulevard de la Cluse 38, 1205 Genève;
- `Pharmacie du Museum`, 31 ottobre–6 novembre 2026, 08:00–23:00;
- `Pharmacie Plaza`, 15–21 agosto 2026, 08:00–23:00.

La copertura osservata è 365/365 giorni grazie alla dichiarazione esplicita del servizio permanente; le due finestre datate aggiungono 14 intervalli verificati. Lo snapshot è una release accoppiata fresca, con gli intervalli già conclusi marcati `expired` e quelli futuri `verified`. Non esistono ancora route, UI settimanale o SEO GE: l’integrazione resta source-only e non attiva gli altri 25 cantoni.

Il workflow `sync-pharmacies-border.yml` esegue ogni giorno l’importer GE e committa i due snapshot insieme agli altri dati farmacie. Per aggiornare lo snapshot in modo atomico in locale, usando una fixture verificata:

```bash
node scripts/import-pharmacy-duties-geneva.mjs --fixtures=tests/fixtures/pharmacy-duties --at=2026-09-24T12:00:00.000Z
```

Il comando restituisce exit code non-zero quando la release non è pubblicabile; questo è intenzionale e impedisce di scambiare un’osservazione parziale per una release operativa. Il workflow conserva comunque lo snapshot diagnostico quando un fetch o la validazione falliscono, così il monitor può distinguere errore corrente, stalezza e conflitto.
