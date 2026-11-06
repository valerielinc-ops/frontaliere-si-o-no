# Grigioni — asta targhe (`eauktion.gr.ch`)

Verifica della fonte pubblica e connettore, 2026-09-13.

## Fonte identificata

Il Canton Grigioni espone il catalogo pubblico delle targhe numeriche su
`https://eauktion.gr.ch/`, piattaforma eCari/eAuction dello
Strassenverkehrsamt.

## Esito: catalogo pubblico server-side

La pagina restituisce in HTML le righe delle sezioni pubbliche. Il connettore
legge le aste in corso, le registrazioni future, le vendite dirette e le targhe
desiderate quando presenti; una sezione vuota produce zero righe, non dati
stimati. Sono conservati soltanto identificativo pubblico, targa, categoria,
prezzi numerici, numero di offerte e scadenza.

I nomi degli offerenti vengono deliberatamente scartati. Un prezzo corrente non
è un prezzo finale: il collector non assegna risultati venduti né finali
verificati senza una conferma esplicita della fonte.

## Connettore e resilienza

`scripts/plate-auctions/connectors/gr.mjs` usa il parser eCari condiviso in
`functions/src/plateAuctionsCore.js`. L’identificativo `openDetails(N)` viene
combinato con il prefisso `gr` per ottenere un id stabile nel catalogo corrente;
la pagina ufficiale resta il link di riferimento per l’utente.

Il registry marca la fonte `active` con `accessMethod: "html-scrape"` e una
frequenza massima di raccolta di quattro fetch al giorno. Un fetch fallito o
vuoto non cancella l’ultima osservazione valida; la fonte viene marcata
`degraded` fino al recupero.
