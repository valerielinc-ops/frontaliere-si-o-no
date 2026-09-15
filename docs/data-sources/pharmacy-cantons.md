# Fonti farmacie per cantone

Mappa delle fonti di ingresso per tutti i 26 cantoni svizzeri, aggiornata il
15 settembre 2026. La data è quella della ricognizione degli URL aggiunti; per
Ticino resta documentata la verifica tecnica del 31 agosto 2026.

Questa pagina descrive una mappa di fonti, non un dataset nazionale di turni.
Un URL registrato permette di raggiungere la fonte di riferimento, ma non
significa che il sito abbia un connettore attivo, che abbia scaricato un dato
recente o che una farmacia sia di turno in questo momento.

## Registro al 15 settembre 2026

`active` è riservato alla fonte Ticino, già verificata come leggibile dal
connettore esistente. Le altre 25 entry sono `unverified`: l'URL è stato
registrato nella ricognizione, ma non esiste ancora un connettore o un dataset
di turni collegato a questa applicazione. La colonna `accessMethod` descrive il
percorso di accesso da valutare; non è una prova di fetch riuscito.

| Codice | Chiave registry | Cantone | Tipo | Accesso | Stato | Verificata | Fonte |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AG | `aargau` | Argovia | association | html-scrape | unverified | 2026-09-15 | [Apotheken Aargau](https://apotheken-aargau.ch/notfall/) |
| AI | `appenzell-innerrhoden` | Appenzello Interno | official | manual | unverified | 2026-09-15 | [Appenzello Interno — emergenze](https://ai.ch/themen/gesundheit-alter-und-soziales/gesundheitsversorgung/rettungswesen-und-notfallversorgung) |
| AR | `appenzell-ausserrhoden` | Appenzello Esterno | official | manual | unverified | 2026-09-15 | [Appenzello Esterno — triage](https://ar.ch/verwaltung/departement-gesundheit-und-soziales/amt-fuer-gesundheit/abteilung-medizinische-dienste/kantonsaerztlicher-dienst/triagestelle/) |
| BE | `bern` | Berna | association | html-scrape | unverified | 2026-09-15 | [apoBern — Notfalldienst](https://apobern.ch/dienstleistungen/notfalldienst/) |
| BL | `basel-landschaft` | Basilea Campagna | official | manual | unverified | 2026-09-15 | [Basilea Campagna — domande mediche](https://www.baselland.ch/politik-und-behorden/direktionen/volkswirtschafts-und-gesundheitsdirektion/amt-fur-gesundheit/medizinische-dienste/kantonsaerztlicher-dienst/kontakte/medizinische-fragen) |
| BS | `basel-stadt` | Basilea Città | official | manual | unverified | 2026-09-15 | [Basilea Città — elenco farmacie](https://www.bs.ch/gd/md/hoheitliche-funktionen/kantonsapothekerin/liste-der-apotheken-basel-stadt) |
| FR | `fribourg` | Friburgo | association | html-scrape | unverified | 2026-09-15 | [Pharmacies Fribourg — pharmacie de garde](https://www.pharmaciesfribourg.ch/fr/prestations-et-conseils/pharmacie-de-garde) |
| GE | `geneva` | Ginevra | association | html-scrape | unverified | 2026-09-15 | [Pharma Genève — pharmacie de garde](https://pharmageneve.swiss/pharmacie-de-garde/) |
| GL | `glarus` | Glarona | official | manual | unverified | 2026-09-15 | [Glarona — numeri di emergenza](https://www.gl.ch/verwaltung/finanzen-und-gesundheit/gesundheit/gesundheitsversorgung/notfallnummern.html/1691) |
| GR | `graubunden` | Grigioni | association | html-scrape | unverified | 2026-09-15 | [Apotheke Chur — emergenza](https://notfall.apotheke-chur.ch/) |
| JU | `jura` | Giura | association | html-scrape | unverified | 2026-09-15 | [Giura — numeri di emergenza](https://www.jura.ch/fr/Autorites/Administration/CHA/SIC/Urgences/Numeros-d-urgence-Urgence.html) |
| LU | `lucerne` | Lucerna | association | html-scrape | unverified | 2026-09-15 | [Apo Luzern — Notfalldienst](https://www.apoluzern.ch/apotheken/notfalldienst) |
| NE | `neuchatel` | Neuchâtel | association | html-scrape | unverified | 2026-09-15 | [Pharmacies de garde Neuchâtel](https://www.pharmacies-gardes-ne.ch/) |
| NW | `nidwalden` | Nidvaldo | official | manual | unverified | 2026-09-15 | [Spital Nidwalden — Notfallpraxis](https://www.spital-nidwalden.ch/standorte/spital-nidwalden/hausarzt-notfallpraxis/) |
| OW | `obwalden` | Obvaldo | official | manual | unverified | 2026-09-15 | [Kantonsspital Obwalden — emergenza](https://www.ksow.ch/notfall) |
| SG | `st-gallen` | San Gallo | official | manual | unverified | 2026-09-15 | [San Gallo — aiuto medico](https://www.hallo.sg.ch/de/gesundheit/medizinische-hilfe.html) |
| SH | `schaffhausen` | Sciaffusa | official | pdf | unverified | 2026-09-15 | [Sciaffusa — documento emergenze](https://sh.ch/CMS/get/file/69283655-61ba-4d85-88f9-7bcbf774fc3f) |
| SO | `solothurn` | Soletta | association | html-scrape | unverified | 2026-09-15 | [AVSO — Notfalldienst Apotheken](https://avso.ch/notfalldienst-apotheken/) |
| SZ | `schwyz` | Svitto | official | manual | unverified | 2026-09-15 | [Svitto — servizi di emergenza](https://www.sz.ch/departement-des-innern/amt-fuer-gesundheit-und-soziales/gesundheit/medizinische-dienste/notfalldienste.html/8756-8758-8802-9317-9316-12587-12685-12632) |
| TG | `thurgau` | Turgovia | association | html-scrape | unverified | 2026-09-15 | [Apotheken Thurgau — Pikettdienst](https://www.apotheken-thurgau.ch/pikettdienst/) |
| TI | `ticino` | Ticino | official | html-scrape | active | 2026-08-31 | [OFCT — farmacie di turno](https://www.ofct.ch/farmacieturno/) |
| UR | `uri` | Uri | official | manual | unverified | 2026-09-15 | [Uri — servizio di emergenza](https://www.ur.ch/dienstleistungen/3677) |
| VD | `vaud` | Vaud | association | html-scrape | unverified | 2026-09-15 | [SVPH — pharmacies de garde](https://garde.svph.ch/) |
| VS | `valais` | Vallese | association | html-scrape | unverified | 2026-09-15 | [PharmaValais — pharmacie de garde](https://www.pharmavalais.ch/pharmacie-valais/pharmacie-garde-51.html) |
| ZG | `zug` | Zugo | official | manual | unverified | 2026-09-15 | [Zugo — comportamento in emergenza](https://zg.ch/de/gesundheit/notfall-und-rettungsdienst/verhalten-im-notfall) |
| ZH | `zurich` | Zurigo | association | html-scrape | unverified | 2026-09-15 | [Notfall-Apotheken Zürich](https://www.notfall-apotheken-zh.ch/) |

Le fonti associative sono AG, BE, FR, GE, GR, JU, LU, NE, SO, TG, VD, VS e
ZH. Le pagine istituzionali per AI, AR, BL, BS, GL, NW, OW, SG, SH, SZ, UR e ZG
sono state conservate come fonti `official` di orientamento, elenco, triage o
contatto; una pagina di emergenza o una hotline non è stata trasformata in un
calendario di farmacie.

## Gap di copertura

- La mappa geografica è completa: ogni codice e ogni chiave di
  `SWISS_CANTONS` ha una entry e un URL HTTPS di ingresso.
- La copertura dei turni non è completa: solo Ticino ha una fonte `active` e un
  connettore/dataset già verificato. Le altre entry restano `unverified`.
- L'assenza di `sourceFetchedAt` per i 25 cantoni non è uno zero turni: indica
  che questa applicazione non ha ancora registrato un fetch riuscito da un
  connettore per quelle fonti.
- Nessuna fonte è stata marcata `degraded` o `blocked`: la ricognizione ha
  fornito URL di ingresso utilizzabili, ma non ha dato evidenza sufficiente di
  instabilità o accesso negato. L'assenza di un connettore si esprime con
  `unverified`, non con uno stato operativo inventato.

## Link di fonte e turno live non sono la stessa cosa

`officialSourceUrl` è un collegamento di provenienza e orientamento. Il suo
solo valore non autorizza a pubblicare:

- il nome di una farmacia di turno;
- un giorno, una fascia oraria o una copertura territoriale;
- uno stato `aperta ora`, `notte`, `weekend` o `24h`;
- un calendario dedotto da una lista di farmacie, da una hotline o dal nome
  della pagina.

Un `PharmacyDuty` potrà essere pubblicato soltanto dopo che un connettore
collegato alla fonte avrà estratto una finestra temporale esplicita e il dato
avrà superato i validator e i controlli di freschezza del dominio. La hub
`/farmacie/` può quindi mostrare il link, il tipo e lo stato della fonte, ma
non presenta l'entry come turno live. Per un bisogno urgente va verificata la
fonte originale e va chiamata la farmacia prima di spostarsi.

Il dettaglio operativo e le regole di pubblicazione sono in
[`docs/pharmacy-data-policy.md`](../pharmacy-data-policy.md); il registry
macchina è [`data/pharmacy-sources-registry.json`](../../data/pharmacy-sources-registry.json).
