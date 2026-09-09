# Policy dati — portale farmacie (#6173)

Fonti, SLA, validazione, disclaimer e policy di pubblicazione per la
verticale farmacie/farmacie-di-turno. Copre lo stato implementato a oggi
(registry fonti #6397 + import anagrafica Ticino #6400) e la pipeline turni
Ticino (#6750) già presente. Fissa anche le regole che il resto della
pipeline (evergreen, editoriale) deve rispettare quando verrà valutato.

## Fonti

Ogni fonte è registrata in `data/pharmacy-sources-registry.json`
(`PharmacySourcesRegistry`, `services/pharmacies/types.ts`), una entry per
cantone con `officialSourceUrl`, `accessMethod`, `fetchFrequency`,
`timezone`, `sourceType`, `owner`, `status` (`unverified` / `active` /
`blocked` / `degraded`) e note di verifica.

Gerarchia di affidabilità (#6173 → "Perimetro prodotto"): fonti `official`
(ordine dei farmacisti, ente cantonale) e `verified_partner` sono le uniche
ammesse a determinare uno stato di **turno**; fonti `association`,
`pharmacy` o `directory` possono essere usate solo come *discovery*, mai
come unica fonte per dichiarare un turno attivo.

Ogni cantone entra nel registry con `status: "unverified"` e passa ad
`active` solo dopo una verifica di rete documentata in
`docs/data-sources/<slug>.md` (metodo, esito, robots.txt/crawl-delay,
eventuali limiti — vedi `docs/data-sources/farmacie-turno-ticino.md` per il
precedente Ticino). Un connettore non entra in produzione su una fonte
ancora `unverified`.

### Ticino (`ticino`, `status: "active"`)

- Fonte: `https://www.ofct.ch/farmacieturno/` (Ordine dei Farmacisti del
  Cantone Ticino), `accessMethod: "html-scrape"`, verificata in #6398.
- Copre 4 delle 5 regioni ticinesi (Mendrisiotto, Luganese, Bellinzonese,
  Biasca e Valli). La quinta, **Locarnese** (`farmacielocarnese.ch`,
  dominio/template separato), è stata verificata di rete in #6740
  (accessibile via HTML statico, nessun JS/API, nessun `robots.txt`) ma
  **resta fuori dal connettore**: struttura dati diversa (nessuna
  anagrafica pubblicata, tabella turni senza indirizzo/CAP) non consente di
  validare una scheda pharmacy completa. Nessun dato di Locarnese è quindi
  pubblicato nel directory o attribuito a una farmacia. Vedi
  `docs/data-sources/farmacie-turno-ticino.md`.
- `robots.txt` dichiara `crawl-delay: 10`: rispettato da
  `scripts/import-pharmacies-ticino.mjs` (10s fra un fetch di regione e il
  successivo), UA dedicata e identificabile
  (`FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)`).

## SLA di aggiornamento

- **Anagrafica farmacie**: settimanale/mensile (fonte a bassa volatilità).
  Oggi l'import (`scripts/import-pharmacies-ticino.mjs`) è one-shot, non
  ancora schedulato — schedulazione ricorrente è scope della pipeline turni
  (non ancora costruita, vedi issue #6400).
- **Turni**: giornaliero tramite `scripts/sync-pharmacy-duties.mjs` e
  `.github/workflows/sync-pharmacy-duties.yml` (`fetchFrequency: "P1D"` nel
  registry). Un fetch fallito o dati in conflitto non
  estendono artificialmente la validità di un turno: il dato resta
  all'ultimo stato valido solo fino alla sua scadenza dichiarata, poi va
  marcato `expired`, mai mostrato come attivo oltre `endsAt`.

## Validazione

Ogni dataset checked-in è validato contro uno schema permissivo su campi
extra ma rigido sui required (`validatePharmacy`/`validatePharmacyList` in
`services/pharmacies/types.ts`, coperti da
`tests/pharmacies-ticino-dataset.test.ts`): id univoco, nome, indirizzo,
CAP, città, cantone, `country: "CH"`, `sourceUrl`, `sourceType`,
`lastVerifiedAt`. Un record che fallisce la validazione non viene
pubblicato.

Per i turni (`PharmacyDuty`), lo stato
(`verified` / `pending_review` / `expired` / `conflicting`) è parte del
modello dati fin dalla progettazione (#6173 → "Modello dati proposto") e
deve riflettere l'esito della validazione, non solo la presenza del dato:
un turno con fonte `association`/`pharmacy`/`directory`, o con date
incoerenti, o in conflitto con un'altra fonte per la stessa area/finestra
oraria, entra in coda come `pending_review`/`conflicting`, mai pubblicato
come `verified`.

## Disclaimer e pubblicazione

- Ogni pagina che mostra un dato di turno o uno stato aperta/chiusa deve
  riportare fonte, timestamp dell'ultimo aggiornamento e un disclaimer che
  invita a verificare telefonicamente in caso di emergenza — i dati
  derivano da scraping di terze parti, non da un'API garantita.
- Nessuna pubblicazione automatica di contenuto editoriale (pagina evergreen
  giornaliera, articolo weekend) o alert: il vertical pubblica solo hub,
  directory e intervalli regionali verificati.
- Le pagine `di-turno` indicano sempre la copertura regionale. Non dichiarano
  "aperta ora", "24h" o un turno comunale quando la fonte non lo espone.
  L'UI rivaluta `endsAt` mentre resta aperta e nasconde intervalli scaduti;
  un fetch fallito conserva il record precedente senza rinnovare
  `_fetchedAt`.

## Osservabilità (dashboard interna)

`scripts/check-pharmacy-data-health.mjs` è l'osservatore di questa policy:
misura **copertura** (cantoni con fonte registrata sui 26 svizzeri, quali
`active` hanno davvero un dataset), **freschezza** (età di `_fetchedAt` contro
lo SLA — mensile per l'anagrafica, `fetchFrequency` × 2 per i turni),
**errori di fetch** (gli `_errors[]` che gli importer lasciano nel dataset) e
**conflitti** (id/slug duplicati, stessa farmacia emessa da due regioni, turni
`conflicting` o ancora `verified` oltre `endsAt`). Emette
`data/pharmacy-data-health-report.json` ed esce non-zero se degradato;
`.github/workflows/pharmacy-data-health-monitor.yml` lo gira settimanalmente e
apre/chiude una issue `content-quality` di conseguenza.

Il dataset turni corrente è `data/pharmacy-duties-ticino.json`; il suo report
operativo separato è `data/pharmacy-duties-ticino-status.json`. Un'assenza del
dataset o un `_fetchedAt` oltre due volte `P1D` è un degrado osservabile, non
uno stato atteso da ignorare.

## Ambito non ancora coperto

Restano fuori scope il parser dedicato per Locarnese, le pagine evergreen,
l'articolo editoriale weekend e gli alert. Il connettore e le pagine della
directory Ticino già emesse non deducono dati mancanti e restano limitati alle
quattro regioni OFCT con anagrafica compatibile.
