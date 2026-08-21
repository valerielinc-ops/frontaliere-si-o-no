# Prospector — il loop autonomo di copertura

Trova datori di lavoro svizzeri che **non** crawliamo, capisce dove pubblicano
davvero le loro offerte, si genera il crawler da solo e ne misura la qualità
contro la pagina ufficiale del datore. Gira **in remoto** su GitHub Actions
(`.github/workflows/prospector-loop.yml`), non in locale.

## Perché esiste

La scoperta di nuovi datori era **una lista curata a mano di 118 grandi nomi**
(`data/marquee-companies-list.json`, campo `_source: "hand-curated"`). Le grandi
aziende stanno però già su tutti i portali: non aggiungono inventario esclusivo.

Misurato sul feed ufficiale SECO, Ticino, finestra 30 giorni: **185 datori
distinti, di cui 163 (87%) assenti dall'intero dataset** — nomi come *Polverini
Spazzacamino Sagl*, *Bio Recycling Sagl*, *V. Luraschi SA*. Quello è
l'inventario che nessun altro ha.

## L'intuizione che regge tutto

Risolvere `nome azienda → pagina carriere` è difficile e fallisce spesso.
Risolvere `piattaforma → tenant → azienda` è **enumerabile**, perché una
micro-impresa non costruisce una pagina carriere: **ne affitta una**. Il loop
spende quindi il suo sforzo a imparare le *piattaforme*, e le aziende cadono
giù come conseguenza.

L'economia: un estrattore di famiglia per un vendor costa come un crawler per
una sola azienda, e rende ogni tenant che quel vendor ha.

## I cinque stadi

| stadio | script | cosa fa |
|---|---|---|
| DISCOVER | `prospect-discover.mjs` | quattro sorgenti riempiono la coda dei candidati |
| TRACE | `prospect-trace.mjs` | segue la traccia carriere e impara le piattaforme |
| EXPAND | `prospect-expand.mjs` | enumera i tenant di una piattaforma — qui la copertura moltiplica |
| SYNTHESIZE | `prospect-synthesize.mjs` | genera la spec del crawler dalla pagina viva |
| VALIDATE | `prospect-validate.mjs` | confronta l'estratto con la pagina ufficiale, campo per campo |

`prospect-report.mjs` stampa lo stato e **dove il loop non arriva**.

## Le quattro sorgenti di scoperta

| sorgente | costo | cosa vede | resa misurata |
|---|---|---|---|
| `own` | zero rete | le piattaforme dei datori che già crawliamo | 34 piattaforme da 22.516 annunci |
| `seco` | API pubblica | chi assume **ora**, per obbligo di legge (Stellenmeldepflicht) | 5.923 datori nuovi su 26 cantoni |
| `osm` | Overpass | imprese con sito, per cantone | 1.411 in Ticino |
| `web` | indice Common Crawl | pagine carriere di **tutto il web svizzero** | ~11 datori per pagina d'indice, su 1.223 pagine |

Nessuna richiede chiave o quota.

## Aggregatori: esclusi per costruzione

L'obiettivo sono le aziende che assumono **direttamente**. Un aggregatore
(bacheca di settore, portale di apprendistato) porta inventario che hanno già
tutti. La distinzione è **strutturale**, non una denylist di nomi: la pagina di
un datore diretto nomina **una** hiring organisation, un aggregatore ne nomina
molte, e i suoi link di dettaglio puntano a host diversi. Vedi
`looksLikeAggregator()` in `scripts/lib/prospector/tenant-enum.mjs`.

## Qualità: contro la pagina ufficiale, non contro il numero di righe

Il monitor di salute esistente conta le righe tornate. Un parser che restituisce
dodici righe di menu gira benissimo e pubblica dodici offerte finte.
`prospect-validate.mjs` scarica la pagina di **dettaglio** che il datore serve e
misura quattro cose indipendenti:

- `reachable` — l'URL che pubblicheremmo risolve;
- `titleMatch` — il titolo è davvero quello della pagina;
- `contentful` — la pagina ha prosa vera, non uno scheletro renderizzato lato client;
- `distinct` — i titoli del listing differiscono fra loro.

Su un lotto di 44 crawler generati: **34 promossi, 7 deboli, 1 respinto**. I due
difetti trovati — titoli non corrispondenti, e titoli tutti uguali — sono
esattamente quelli che un controllo per conteggio non vede.

## Cortesia

Questi datori non hanno chiesto di essere crawlati. Ogni richiesta esce con UA
identificante, **una richiesta per host al secondo**, e `robots.txt` rispettato
per la nostra UA. Il workflow alza ulteriormente il ritardo.

## Stato, e perché è versionato

I runner di Actions sono effimeri: la memoria del loop vive in `data/prospector/`
e viene committata a ogni giro. `candidates.json` è la coda, `platforms.json` il
registro dei vendor, `crawlers/` le spec generate, `validation.json` il report di
qualità. I candidati in stato terminale oltre i 90 giorni vengono potati, così la
coda non cresce senza limite.

## Trappole misurate

- **DNS wildcard**: su molte piattaforme `qualsiasi-cosa.vendor.com` risolve.
  L'esistenza DNS non prova il tenant — serve una sonda HTTP che *punteggi* la pagina.
- **Certificate Transparency è cieca sui wildcard**: un vendor con un solo
  certificato `*.vendor.com` non espone alcun cliente.
- **La radice di un tenant può essere un login**: sondare solo `/` ha dato
  **0 tenant vivi su 135**. Il path di listing si impara dagli adapter che già abbiamo.
- **Il path di dettaglio ≠ il path di listing**: `/Vacancies/123/Description` non
  porta a `/Jobs/All`.
- **Ordine delle sonde**: uno slug è un'ipotesi e ce ne sono decine di migliaia
  (20.215 in una run misurata); un host visto nell'indice web esiste. Senza
  ordinamento per evidenza il budget di sonde va tutto in ipotesi.
- **Overpass rifiuta le UA contenenti "Bot"** con un 406, e la negoziazione di
  contenuto di Apache rende la diagnosi fuorviante.
- **Un canale giù non è "zero risultati"**: l'indice Common Crawl cade spesso;
  senza retry il loop legge l'assenza come una misura.
