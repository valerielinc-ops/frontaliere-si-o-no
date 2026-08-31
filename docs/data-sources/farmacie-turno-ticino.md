# Ticino — farmacie di turno (`ofct.ch`)

Verifica di rete (issue #6398, sub-issue `from-decompose` di #6173 Fase 1
MVP), 2026-08-31.

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

## Verdetto

**Fonte affidabile per lo scraping HTML** su 4/5 regioni ticinesi
(Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli): niente JSON/API, ma
due tabelle HTML server-rendered con classi/id stabili, raggiungibili con un
fetch statico (no browser headless richiesto in produzione — Playwright è
servito solo per la verifica). Il connettore Ticino può passare da
`unverified` ad **`active`** con `accessMethod: "html-scrape"` su questa
base, coprendo 4 regioni su 5.

**Locarnese resta fuori** da questo verdetto: dominio e template diversi
(`farmacielocarnese.ch`), da verificare separatamente prima di includerlo
nello stesso connettore o come fonte a parte.

Prossimo passo per il connettore vero e proprio (#6173 Fase successiva): un
parser che visita le 4 URL regione `ofct.ch`, estrae le due tabelle per
regione, normalizza secondo `PharmacyDuty`/`Pharmacy`
(`services/pharmacies/types.ts`), rispetta `crawl-delay: 10`.
