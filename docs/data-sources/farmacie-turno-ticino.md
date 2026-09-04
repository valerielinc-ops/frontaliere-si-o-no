# Ticino — farmacie di turno (`ofct.ch`, `farmacielocarnese.ch`)

Verifica di rete (issue #6398, sub-issue `from-decompose` di #6173 Fase 1
MVP), 2026-08-31. Aggiornato con la verifica del connettore Locarnese
(issue #6740, follow-up di #6722), stesso giorno.

## Metodo

Playwright headless (`page.on('request')`/`page.on('response')`) sul
caricamento di `https://www.ofct.ch/` e della pagina figlia
`https://www.ofct.ch/farmacieturno/`, seguito da un'interazione minima
(navigazione alle 5 pagine di regione linkate dall'hub: Mendrisiotto,
Luganese, Bellinzonese, Locarnese, Biasca e Valli). Confermato poi via
`curl` semplice (nessuna esecuzione JS) che i dati sono presenti nella
risposta HTML iniziale.

## Esito: nessun endpoint JSON/API, ma tabelle HTML server-rendered stabili — machine-readable via parsing HTML

1. **Homepage e hub `/farmacieturno/` sono solo navigazione**: nessun
   `<form>`, nessuna XHR/fetch verso `admin-ajax.php`/`wp-json` durante il
   caricamento o l'interazione. L'hub linka 5 pagine di regione.
2. **4 delle 5 regioni sono sotto lo stesso dominio `ofct.ch`** e condividono
   lo stesso template WordPress/Elementor:
   - `https://www.ofct.ch/mendrisiotto/`
   - `https://www.ofct.ch/luganese/`
   - `https://www.ofct.ch/bellinzonese/`
   - `https://www.ofct.ch/biasca-e-valli/`

   La quinta, **Locarnese, è ospitata su un dominio separato**
   (`https://www.farmacielocarnese.ch/`) con un template diverso —
   **non verificata da questa indagine**, resta un connettore a parte da
   investigare separatamente.
3. Su ognuna delle 4 pagine `ofct.ch`, i dati **sono già nella risposta HTML
   iniziale** (confermato via `curl -A "Mozilla/5.0"`, nessun JS necessario),
   in due tabelle HTML statiche con classi/id stabili:
   - **`#tabella_mese_corrente_compatta`** — calendario dei turni del mese
     corrente, righe `<tr class="farmacia_mese ...">` con celle
     `.cella_farma_compatta_data` (`DD/MM/YYYY`),
     `.cella_farma_compatta_orario` (`HH:MM`),
     `.cella_farma_compatta_nome` (nome farmacia),
     `.cella_farma_compatta_localita` (`CAP Località`). La riga del turno
     **attivo ora** porta la classe aggiuntiva `di_turno` (es.
     `class="farmacia_mese  di_turno"`, con doppio spazio — quirk del
     template, non un errore di parsing); le righe già scadute portano
     `old_row`.
   - **`#tabella_lista_farmacie`** — anagrafica completa delle farmacie della
     regione: `Farmacia` / `Indirizzo` / `Località` / `Telefono`, senza
     classi per-cella ma ordine colonne fisso.
   - Esempio verificato (Mendrisiotto, 2026-08-31): riga `di_turno` →
     `29/08/2026, 08:00, Bernasconi, 6877 Coldrerio` — coerente col testo
     visibile "La farmacia di turno attiva oggi è: Bernasconi, Via San
     Gottardo 29, 6877 Coldrerio, Tel. +41 91 646 49 22".
4. Un div `#coordinate_mappa_google` con un unico marker
   `data-attr-lat`/`data-attr-lon` esiste (consumato lato client da
   `RED_farmacie_ticino/assets/js/gmap_generation.js` per centrare la mappa
   Google) ma **non porta nome/indirizzo** (attributi vuoti) — la mappa è
   solo un'illustrazione, il dato utile è nelle due tabelle HTML sopra.
5. **`robots.txt`** (`https://www.ofct.ch/robots.txt`) blocca solo
   `/wp-admin/` (con eccezione esplicita per `admin-ajax.php`) e dichiara
   `crawl-delay: 10` — le pagine di regione non sono disallowed. Un
   connettore futuro deve rispettare il crawl-delay dichiarato.
6. **Nessun termine d'uso/ToU raggiungibile**: i link di footer "Privacy
   policy" / "Coockie policy" sono testo semplice, non hyperlink — non
   esiste una pagina di condizioni d'uso da verificare per un divieto di
   scraping.
7. `farmacielocarnese.ch` (dominio Locarnese) risponde 200 sulla home ma
   **non ha `robots.txt`** (404 sul path) — nessun vincolo dichiarato, ma la
   struttura dati non è stata ispezionata in questa verifica.

## Verifica Locarnese (`farmacielocarnese.ch`, #6740, 2026-08-31)

Metodo: `curl -A "Mozilla/5.0"` semplice (nessuna esecuzione JS) sulla home
`https://www.farmacielocarnese.ch/` e su `https://www.farmacielocarnese.ch/robots.txt`.

1. **Homepage risponde 200, `robots.txt` risponde 404** (nessun file
   pubblicato) — nessun vincolo `Disallow`/`crawl-delay` dichiarato. Nessuna
   pagina privacy/cookie/ToU raggiungibile (nessun link in footer, il sito
   non ha footer).
2. **Sito single-page, server-rendered, nessuna XHR/API**: markup Bootstrap
   5 con un `<form id="form1">` di layout (non un postback ASP.NET —
   nessun `__VIEWSTATE`), niente `<iframe>`, niente script che carica dati
   via fetch/XHR verso un endpoint separato. I dati sono già nella risposta
   HTML iniziale, confermato dal fatch statico via `curl` (nessun browser
   richiesto).
3. **Farmacia di turno corrente** (box "Farmacia di turno"): nome e
   telefono in bottoni `<a>` semplici senza id stabile ma testo
   riconoscibile (es. `Farmacia Soldati`, `tel:+41917521555`);
   l'**indirizzo** della farmacia attiva è disponibile solo dentro la
   chiamata inline `initFarmaciaMap(lng, lat, htmlPopup)` a fondo pagina
   (es. `via Vallemaggia 61`), non in un nodo HTML dedicato — parsing più
   fragile del box anagrafica di `ofct.ch`.
4. **Tabella turni** (box "Turni", classe `.gridview-wrapper > table`,
   nessun `id`): righe `<tr>` con 4 celle `Data` (`DD.MM.YYYY`) / `Ora`
   (`HH:MM`) / `Farmacia` / `Località` — quest'ultima solo il nome del
   comune, **senza CAP né indirizzo completo** (a differenza di
   `#tabella_lista_farmacie` su `ofct.ch`). La riga attiva ora porta uno
   style inline `font-weight:bold;border-top:2px solid #000;...`, le righe
   scadute `opacity:0.5;text-decoration:line-through;` — nessuna classe
   CSS dedicata come `di_turno`/`old_row` su `ofct.ch`, lo stato va letto
   dallo style inline o dalla posizione riga vs. data odierna.
5. **Nessuna tabella anagrafica farmacie** (equivalente a
   `#tabella_lista_farmacie`): la home pubblica solo la farmacia
   attualmente di turno (nome+telefono+indirizzo via JS inline) e il
   calendario turni futuri (nome+comune, senza indirizzo). Un'anagrafica
   completa delle farmacie della regione non è pubblicata su questa
   pagina.

### Verdetto Locarnese

**Fonte scrapabile via HTTP statico** (nessun JS/API richiesto, stesso
pattern di `ofct.ch`): `robots.txt` assente = nessun vincolo dichiarato,
nessun ToU raggiungibile. La struttura dati è però **meno uniforme** di
`ofct.ch` — tabella turni senza indirizzo/CAP, indirizzo della farmacia
attiva solo dentro una stringa JS inline, nessuna tabella anagrafica — un
parser dedicato (diverso da `pharmacy-ticino-parser.mjs`, che assume la
struttura `ofct.ch`) è necessario prima di poter includere Locarnese nel
connettore Ticino. Non un blocco di accesso: un blocco di forma-dati,
lasciato alla prossima fase implementativa (#6173).

## Verdetto complessivo

**Fonte affidabile per lo scraping HTML** su 5/5 regioni ticinesi
(Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli via `ofct.ch`,
Locarnese via `farmacielocarnese.ch`): niente JSON/API su nessuno dei due
domini, solo HTML server-rendered raggiungibile con un fetch statico (no
browser headless richiesto in produzione — Playwright/curl sono serviti
solo per la verifica). Il connettore Ticino può passare da `unverified` ad
**`active`** con `accessMethod: "html-scrape"` su questa base.

Prossimo passo per il connettore vero e proprio (#6173 Fase successiva): un
parser che visita le 4 URL regione `ofct.ch` (già scritto,
`scripts/lib/pharmacy-ticino-parser.mjs`) più un parser dedicato per
`farmacielocarnese.ch` (struttura diversa, vedi sopra), normalizza secondo
`PharmacyDuty`/`Pharmacy` (`services/pharmacies/types.ts`), rispetta il
`crawl-delay: 10` dichiarato da `ofct.ch` (Locarnese non ne dichiara uno,
ma un connettore futuro deve comunque restare rispettoso: stesso ritardo
minimo tra fetch).
