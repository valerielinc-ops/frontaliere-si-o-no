# Arricchimento delle schede farmacia

Le schede usano il catalogo ufficiale come fonte dell'identità della sede. I
dati facoltativi — telefono, email, orari, servizi e sito — vengono raccolti
solo da fonti esplicitamente registrate in
`data/pharmacy-enrichment-sources.json` e conservati in
`data/pharmacy-enrichment.json` con provenienza per campo e data di controllo.

## Fonti supportate

- Pagine HTML ufficiali allow-listate, come la scheda del Comune di Casciago.
  Il parser pubblica un fatto solo dopo avere verificato città, via, numero
  civico e un token del nome della farmacia.
- PDF ufficiali allow-listati, come l’elenco farmacie di ATS Insubria. Il
  testo viene estratto in memoria, la riga viene verificata con città, strada,
  numero civico e token del nome, e vengono conservati solo i campi dichiarati
  dalla sorgente (per esempio il telefono). Il PDF non viene salvato nel
  repository e l’edizione pubblicata, quando riconoscibile, resta nella
  provenienza come `sourceUpdatedAt`.
- Google Places API (New), tramite `GOOGLE_MAPS_API_KEY`. Ogni farmacia deve
  essere inserita esplicitamente nella lista `pharmacyIds`; il codice non legge
  pagine di risultati Google o Maps e non salva rating, numero di recensioni,
  testo delle recensioni né telefono/orari/sito restituiti da Places. Usa
  provvisoriamente nome e indirizzo della risposta per verificare la sede e
  conserva soltanto il `place_id` stabile, da cui costruisce il link Maps.
  Questo rispetta l'eccezione di caching documentata da Google; per mostrare
  altri contenuti Places servirebbero recupero live e attribuzione Google Maps.
  Anche quando Places non è disponibile, la scheda può offrire un link di
  navigazione Google Maps costruito dall'identità già verificata nel catalogo:
  è solo un collegamento di ricerca e non rappresenta dati, coordinate,
  recensioni o rating restituiti da Google.
- Facebook Graph API, soltanto con un `PHARMACY_FACEBOOK_PAGE_ID` e un
  `PHARMACY_FACEBOOK_PAGE_ACCESS_TOKEN` autorizzati. Anche qui il nome e la
  località devono corrispondere prima di accettare i dati; i post e le
  recensioni non vengono importati. Se i valori Facebook sono già coperti da
  una fonte con priorità maggiore, Facebook resta comunque registrato come
  fonte corroborante: la provenienza osservata non sostituisce il fatto
  selezionato.

I segreti arrivano da Firebase Remote Config tramite
`scripts/load-rc-env.mjs`; non devono essere inseriti nel JSON o nei log. Se
una fonte non è configurata o non supera l'identity match, il refresh conserva
il dato precedente e registra un warning invece di inventare valori.

## Pubblicazione SEO/AI

La build applica lo snapshot alle schede e rende i fatti verificati in HTML semantico:
indirizzo, telefono, email, sito, mappa, orari, servizi, fonte e data del
controllo. Il JSON-LD `Pharmacy` ripete solo i fatti verificati e aggiunge
`sameAs`, `OpeningHoursSpecification`, `amenityFeature` e coordinate quando
disponibili. Il titolo usa il nome leggibile dell'entità, mentre il nome
legale completo resta nell'H1, nel corpo e nello schema.

Per aggiornare i dati:

```bash
npm run pharmacies:import
npm run pharmacies:check
```

Il workflow giornaliero esegue gli stessi passaggi e propone i cambiamenti in
una PR, così la provenienza resta revisionabile.
