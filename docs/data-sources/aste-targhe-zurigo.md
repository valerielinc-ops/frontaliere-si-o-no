# Zurigo — asta targhe (`auktion.stva.zh.ch`)

Verifica della piattaforma pubblica e connettore, 2026-09-13.

## Fonte identificata

Il Canton Zurigo pubblica il catalogo delle aste delle targhe sul portale
ufficiale `https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car`.
La pagina istituzionale di riferimento è
`https://www.zh.ch/de/mobilitaet/fahrzeuge-kontrollschilder/kontrollschilder.html`.

## Esito: catalogo pubblico leggibile

Le schede pubbliche espongono identificativo, numero di targa, prezzo corrente,
numero di offerte, tipo di veicolo e termine dell’asta. Il connettore legge il
catalogo auto pubblico e costruisce il link alla scheda ufficiale di ogni riga.
I nomi degli offerenti e ogni altro dato personale non vengono raccolti né
pubblicati.

Un prezzo corrente resta un’osservazione del catalogo: non viene trattato come
prezzo finale. Le classifiche storiche accettano soltanto un prezzo finale con
timestamp di verifica ufficiale.

## Connettore e limiti

`scripts/plate-auctions/connectors/zh.mjs` usa `parseZhAuctionCards()` nel
parser puro `functions/src/plateAuctionsCore.js`. Le date locali di Zurigo sono
normalizzate in UTC mantenendo la semantica `Europe/Zurich`.

Il registry marca la fonte `active` con `accessMethod: "html-scrape"` e una
frequenza massima di raccolta di quattro fetch al giorno. I filtri ulteriori
(per esempio motocicli o sottocategorie) restano da verificare sulla
piattaforma prima di estendere il connettore oltre il catalogo auto.
