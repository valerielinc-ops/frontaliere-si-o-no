# Vallese — asta targhe (`ecari.vs.ch/ecari-auction/`)

Verifica di rete + connettore (issue #6358, follow-up di #4854 Fase 0), 2026-08-27.

## Fonte identificata

Il Canton Vallese pubblica il link all'asta targhe ("Plaques aux enchères")
dalla pagina del Service de la circulation routière et de la navigation
(`vs.ch/web/scn`), che punta a **`https://ecari.vs.ch/ecari-auction/`**.

È la stessa piattaforma white-label **eCari** usata dal Ticino
(`carieauktion.ti.ch`, vedi `docs/data-sources/aste-targhe-ticino.md`) — un
fornitore commerciale condiviso da più cantoni, non un sistema VS-specifico.

## Esito: scrapabile — dati server-side, nessun blocco robots/ToS

A differenza di TI (nessun form, modulo esterno irraggiungibile), l'istanza
VS espone la tabella "Enchères en cours" (aste in corso) **renderizzata
server-side sulla pagina pubblica**, senza login:

1. `GET https://ecari.vs.ch/ecari-auction/` risponde con una catena di
   redirect (302 → 302 → 302 → 200) fino a
   `/ecari-auction/ui/app/init?locale=fr_ch`; un singolo `fetch(url, {
   redirect: 'follow' })` di Node segue l'intera catena senza bisogno di un
   cookie jar manuale (verificato in #6358).
2. La tabella "Enchères en cours" (tab di default, `categorieID=1`, targhe
   auto) contiene targa, prezzo iniziale, incremento minimo, offerta
   corrente, scadenza e numero di offerte in markup HTML statico — nessuna
   chiamata XHR/JSON separata necessaria.
3. `curl -sI https://ecari.vs.ch/robots.txt` risponde **503** in modo
   consistente (anche a distanza di secondi, 3 tentativi): il dominio non
   serve file statici alla root perché l'app è montata solo sotto
   `/ecari-auction/` — non è un `Disallow`, è l'assenza di un file
   robots.txt. Nessuna pagina di termini d'uso separata è stata trovata nel
   markup (solo `© Canton du Valais` nel footer).
4. Le altre due tab ("Inscription pour les futures enchères", "Plaques
   souhaitées") richiedono un account autenticato (`Login`/`Créer
   utilisateur` nel menu) — fuori scope del connettore.

## Connettore

`scripts/plate-auctions/connectors/vs.mjs` esporta `fetchVsPlateAuctions()`
(rete) e `parseVsAuctionRows(html)` (parsing puro, testabile offline) che
producono snapshot conformi al tipo `PlateAuction`
(`services/plateAuctions/types.ts`, validati con `validatePlateAuction()`).
Copre solo la tab "Enchères en cours" / targhe auto — `dataConfidence:
'partial'` riflette questo scope ridotto, non un dubbio sulla correttezza dei
campi estratti. Test di schema: `tests/plate-auction-connector-vs.test.ts`
contro una fixture reale salvata (`tests/fixtures/vs-ecari-auction-sample.html`).

Il registry (`data/plate-auction-sources-registry.json`, entry `vallese`) è
aggiornato a `status: "active"`, `accessMethod: "html-scrape"`.

## Prossimo passo, se si vuole estendere

Copertura delle altre categorie (moto, "plaques souhaitées") richiede
autenticazione — non tentato qui. Il numero interno d'asta (`openDetails(N)`)
è stabile per record ma non garantito cross-sessione dal fornitore; se
necessario un id più stabile, verificare se `openDetails` espone un
identificativo persistente lato dettaglio.
