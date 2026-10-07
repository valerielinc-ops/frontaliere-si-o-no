# Arricchimento delle schede farmacia

Le schede usano il catalogo ufficiale come fonte dell'identità della sede. I
dati facoltativi — telefono, email, orari, servizi e sito — vengono raccolti
solo da fonti esplicitamente registrate in
`data/pharmacy-enrichment-sources.json` e conservati in
`data/pharmacy-enrichment.json` con provenienza per campo e data di controllo.
La stessa regola vale per gli identificativi legali pubblici, come la Partita
IVA: un valore entra nella scheda solo quando la fonte è identity-matched.

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
- Il workflow conserva nello snapshot un contatore mensile delle richieste
  Google e lo riserva prima di ogni chiamata. `monthlyRequestLimit` è limitato
  hard-coded a 10.000 per Google Places; una risposta fallita conta comunque,
  così un retry non può superare il tetto nello stesso mese. Il registro si
  azzera sul mese UTC successivo e `maxAgeDays: 30` evita richieste ripetute per
  una sede già verificata.
- Il workflow `sync-pharmacies-border` prenota la quota prevista prima della
  prima chiamata in un branch tecnico serializzato,
  `chore/pharmacy-google-usage-reservation`. Se una prenotazione o una PR di
  refresh precedente è ancora pendente, il run successivo aggiorna gli altri
  dati ma disabilita Google Places: il ledger non può essere speso due volte
  dallo stesso snapshot di `main`. L’importer riceve inoltre solo gli ID
  contenuti nel lease, non l’intera allow-list configurata. Una prenotazione
  interrotta resta quindi conservativa fino al merge o al cambio mese.
- Facebook pubblico, tramite il workflow di discovery, senza usare la pagina
  `frontaliereticino` né credenziali Meta. Il nome e la località devono
  corrispondere prima di accettare un candidato; i post e le recensioni non
  vengono importati. L'adapter Graph con `PHARMACY_FACEBOOK_PAGE_ID` e
  `PHARMACY_FACEBOOK_PAGE_ACCESS_TOKEN` è solo un percorso opzionale di
  corroborazione e non è richiesto per la ricerca pubblica. Se i valori
  Facebook sono già coperti da una fonte con priorità maggiore, Facebook resta
  comunque registrato come fonte corroborante: la provenienza osservata non
  sostituisce il fatto selezionato.
- Il workflow settimanale `discover-pharmacy-facebook.yml` cerca le farmacie
  esplicitamente elencate in `discoveryPharmacyIds` nella ricerca pubblica di
  Facebook, apre solo gli URL candidati pubblicamente accessibili e salva un
  report artifact. Quando la pagina espone nome/località e un indirizzo
  coerente oppure il numero di catalogo esatto, il report contiene solo
  telefono, email, sito e orari pubblici identity-matched. Non contiene post,
  recensioni, rating, follower o testo di ricerca non verificato. Facebook
  spesso risponde con login o checkpoint: il workflow li registra e si ferma,
  senza aggirare il blocco. L’artifact è un report di ingestione; la pubblicazione
  nella snapshot passa sempre dalla stessa revisione allow-listata e
  provenance-aware usata dalle altre fonti. Il refresh giornaliero del catalogo
  legge il report e apre la normale PR dati solo se esistono fatti identity-matched;
  con `public_search_blocked` non cambia nulla.

Le pagine Google/AI non vengono trattate come un’API dati: i risultati possono
cambiare, duplicare directory o sintetizzare informazioni senza una provenienza
stabile. La pipeline usa invece gli URL pubblici che quei risultati rendono
scopribili, con identity match, priorità per campo e link di fonte nella scheda.

I segreti arrivano da Firebase Remote Config tramite
`scripts/load-rc-env.mjs`; non devono essere inseriti nel JSON o nei log. Se
una fonte non è configurata o non supera l'identity match, il refresh conserva
il dato precedente e registra un warning invece di inventare valori.

## Pubblicazione SEO/AI

La build applica lo snapshot alle schede e rende i fatti verificati in HTML semantico:
indirizzo, telefono, email, sito, mappa, orari, giorni chiusi, servizi,
identificativo ministeriale, Partita IVA quando verificata, fonte e data del
controllo. Il JSON-LD `Pharmacy` ripete solo i fatti verificati e aggiunge
`sameAs`, `identifier`, `dateModified`, `OpeningHoursSpecification`,
`amenityFeature` e coordinate quando disponibili. Il titolo usa il nome
leggibile dell’entità, mentre il nome legale completo resta nell’H1, nel corpo
e nello schema; le FAQ e i blocchi di risposta restano testo HTML estraibile.

Per aggiornare i dati:

```bash
npm run pharmacies:import
npm run pharmacies:check
```

Il workflow giornaliero esegue gli stessi passaggi e propone i cambiamenti in
una PR, così la provenienza resta revisionabile.
