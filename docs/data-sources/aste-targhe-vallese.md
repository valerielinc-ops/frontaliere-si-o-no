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
4. **Corretto in #6801** (follow-up di #6775): le altre due tab
   ("Inscription pour les futures enchères" = tabContent2, "Plaques
   souhaitées" = tabContent4) NON richiedono un account autenticato — il
   `Login` visibile nel menu resta una sessione anonima. La pagina è un
   classico tab-widget server-rendered: **un solo fetch** di
   `VS_AUCTION_URL` restituisce già tutti i pannelli tab in un unico
   documento HTML (`tabContent1`/`tabContent2`/`tabContent3`/`tabContent4`),
   con `display:none` su quelli non selezionati — confermato anche
   interrogando `ui/app/changeTab/app?tabNumber=2` con un cookie di sessione:
   nessun redirect a login, solo stato `tabNumber` diverso. Le due tab
   mostrano oggi "Plaques indisponibles" (nessuna voce), non un blocco.

## Connettore

`scripts/plate-auctions/connectors/vs.mjs` esporta `fetchVsPlateAuctions()`
(rete, un solo fetch) e `parseVsAuctionRows(html, opts)` (parsing puro,
testabile offline) che producono snapshot conformi al tipo `PlateAuction`
(`services/plateAuctions/types.ts`, validati con `validatePlateAuction()`).
`fetchVsPlateAuctions()` applica `parseVsAuctionRows` a ciascuna delle tre tab
pubbliche (`VS_TAB_SECTIONS`: tab1 → `auctionStatus: 'active'`, tab2/tab4 →
`'upcoming'`, isolate con `extractTabSection()`) — `dataConfidence: 'partial'`
riflette che il markup delle tab2/tab4 non è ancora stato osservato con righe
reali (sono vuote al momento della verifica), non un dubbio sui campi
estratti dalla tab1. Test di schema: `tests/plate-auction-connector-vs.test.ts`
contro fixture reali salvate (`tests/fixtures/vs-ecari-auction-sample.html`).

Il registry (`data/plate-auction-sources-registry.json`, entry `vallese`) è
aggiornato a `status: "active"`, `accessMethod: "html-scrape"`.

## Prossimo passo, se si vuole estendere

Le tab2/tab4 sono scrapate ma attualmente vuote sul sito live: quando eCari
pubblicherà la prima voce reale in una di esse, verificare che
`parseVsAuctionRows` la estragga correttamente (il markup atteso è lo stesso
`<tr class="L" style=...>` della tab1, ma non ancora osservato con dati
reali) — se il formato differisce, generalizzare il parser di conseguenza.
Il numero interno d'asta (`openDetails(N)`) è stabile per record ma non
garantito cross-sessione dal fornitore; se necessario un id più stabile,
verificare se `openDetails` espone un identificativo persistente lato
dettaglio.
