# Hospital crawlers — Da verificare manualmente

> Lista degli ospedali svizzeri elencati in `docs/HOSPITAL-CRAWLERS-INVENTORY-2026-05-19.md` per cui **non è stato implementato un crawler dedicato** durante lo sprint 16-21.

**Totale entries da verificare:** 50

Tipologie di blocker incontrate:
- nessun URL career identificato dall'inventory originale (TBD)
- agent precedente ha riportato 0 vacancies live / solo Spontanbewerbung al momento della scansione
- dominio NXDOMAIN / parked / Cloudflare challenge non bypassabile headless
- ATS dietro JS che richiedeva Playwright + ulteriore reverse-engineering
- piccola clinica privata senza ATS pubblico

**Procedura:** per ogni voce sotto, apri l'URL nel browser. Se trovi ≥1 vacancy reale, **segnalalo a Claude** indicando l'URL canonico e il nome dell'ospedale. Verrà implementato il parser dedicato (no threshold).

Per voci con `URL = —`, prova Google:
  `site:.ch "{nome clinica}" stellen OR karriere OR jobs OR concorsi OR carrieres OR emploi`

---

## TI

### Clinica Dr. Spinedi
- **URL:** —
- **Note:** Reparto omeopatico dentro Clinica Santa Croce; nessuna sezione carriere propria. Verify se ha url separato.

### Clinica Santa Croce, Orselina
- **URL:** —
- **Note:** Inventory dice nessuna sezione "lavora con noi"; candidature spontanee via info@santacroce.ch. Verify se ha sezione career.

### Clinica Viarnetto, Pregassona
- **URL:** —
- **Note:** Sito vetrina senza sezione carriere; annunci pubblicati su portali esterni. Verify.

## GR

### Center da Sanda Val Müstair (CSVM)
- **URL:** [https://www.csvm.ch/de/jobs.html](https://www.csvm.ch/de/jobs.html)
- **Note:** Blog-style con PDF download; sito alternativo ovmgr.ch/de/jobs. Da implementare se PDF parsabili.

### Centro Sanitario Bregaglia (CSB)
- **URL:** [https://www.csbregaglia.ch/it/centro-sanitario/offerte-di-lavoro](https://www.csbregaglia.ch/it/centro-sanitario/offerte-di-lavoro)
- **Note:** Listing interno Joomla CMS; nessun ATS esterno. Da implementare se ≥1 job.

### Ospedale San Sisto, Poschiavo (CSVP)
- **URL:** [https://www.csvp.ch/it/lavora-con-noi/introduzione](https://www.csvp.ch/it/lavora-con-noi/introduzione)
- **Note:** Parte di Centro sanitario Valposchiavo. Da implementare.

## VD

### Biotonus, Clinique Bon-Port SA, Territet
- **URL:** —
- **Note:** Clinica indipendente wellness/medicina. URL career da scoprire.

### Clinique Bois-Bougy, Nyon
- **URL:** —
- **Note:** Parte di Clinea Suisse (gruppo Emeis). URL career da scoprire.

### Clinique la Lignière, Gland
- **URL:** [https://carrieres.la-ligniere.ch/jobs.php](https://carrieres.la-ligniere.ch/jobs.php)
- **Note:** Indipendente avventista, riabilitazione cardiovascolare. **URL confermato dall'utente**, agent precedente classificò come JS SPA non scrapabile — verificare manualmente con browser.

### Clinique la Métairie, Nyon
- **URL:** —
- **Note:** Psichiatria, no evidenza chiara di affiliazione SMN. URL career da scoprire.

### Clinique la Prairie, Clarens
- **URL:** [https://www.cliniquelaprairie.com/fr/carrieres](https://www.cliniquelaprairie.com/fr/carrieres)
- **Note:** Longevity/wellness, indipendente. Agent precedente: 404 careers. Verify URL alternativo.

### Fondation de Nant, Corsier-sur-Vevey
- **URL:** [https://nant.ch/carrieres/](https://nant.ch/carrieres/)
- **Note:** Psichiatria Est Vaudois, ~475 dipendenti. ATS = Beehire ma agent skip per "no public unauthenticated JSON endpoint". Verify se Beehire ha endpoint pubblico.

### Hôpital du Pays d'Enhaut, Château-d'Oex
- **URL:** [https://www.pspe.ch/jcms/lav_5063/fr/offres-d-emploi](https://www.pspe.ch/jcms/lav_5063/fr/offres-d-emploi)
- **Note:** Jalios JCMS. Agent E: 1 job via jobup mirror — implementabile con threshold rimosso.

### Pôle santé Vallée de Joux (PSVJ), Le Sentier
- **URL:** [https://www.psvj.ch/jcms/c_5303/fr/emplois](https://www.psvj.ch/jcms/c_5303/fr/emplois)
- **Note:** Server in hang 80s, retry futuro.

## GE

### Clinique Belmont, Genève
- **URL:** —
- **Note:** Addizioni/disturbi alimentari, candidature via job@cliniquebelmont.ch. URL career da scoprire.

### Clinique de la Plaine, Genève
- **URL:** [https://laplaine.ch/jobs/](https://laplaine.ch/jobs/)
- **Note:** **URL confermato dall'utente**. Agent H: 1 active offer (sotto threshold). Implementabile con threshold rimosso.

### Clinique de Maisonneuve, Châtelaine
- **URL:** —
- **Note:** Ensemble Maisonneuve (riabilitazione), no career page evidente.

### Clinique du Grand-Salève, Veyrier
- **URL:** [https://www.grand-saleve.ch/en/vacancies/](https://www.grand-saleve.ch/en/vacancies/)
- **Note:** Parte di Clinea Suisse (Emeis). Agent H: 2 jobs (vc_tta accordion). Implementabile con threshold rimosso.

### Clinique Les Hauts d'Anières
- **URL:** —
- **Note:** Riabilitazione indipendente, no career page dedicata. URL da scoprire.

### Nouvelle Clinique Vert-Pré, Conches
- **URL:** —
- **Note:** Clinica privata piccola, no pagina carriere dedicata. URL da scoprire.

## BL

### Ergolz-Klinik, Liestal
- **URL:** [https://www.ergolz-klinik.ch/unsere-klinik/offene-stellen/](https://www.ergolz-klinik.ch/unsere-klinik/offene-stellen/)
- **Note:** Redirects to ergolz.cardiance.com; spontaneous applications via email. Verify.

### Klinik ESTA, Reinach BL
- **URL:** [https://www.suchthilfe.ch/behandlung/esta-klinik-fuer-suchtbehandlung/](https://www.suchthilfe.ch/behandlung/esta-klinik-fuer-suchtbehandlung/)
- **Note:** Parte di Suchthilfe Region Basel; jobs su sozjobs.ch / sozialinfo.ch. Verify.

### PALLIATIVKLINIK IM PARK, Arlesheim
- **URL:** [https://palliativklinik.ch/offene-stellen/](https://palliativklinik.ch/offene-stellen/)
- **Note:** Static page con PDF job descriptions. Implementabile con PDF parser.

## AG

### Bad Schinznach AG Privatklinik Im Park, Schinznach Bad
- **URL:** —
- **Note:** Spa/Privatklinik. URL da scoprire.

### entero Klinik (4 sedi: Egliswil, Niederlenz, Neuenhof)
- **URL:** —
- **Note:** Gruppo Suchttherapie. URL da scoprire (forse `entero.ch` o `entero-klinik.ch`). Un singolo parser coprirebbe tutte e 4 le sedi.

### Reha Rheinfelden
- **URL:** —
- **Note:** Rate-limited (HTTP 429) durante scan. Verify manualmente.

### Stiftung Spital Muri, Muri AG
- **URL:** —
- **Note:** Acuto. URL career da scoprire.

## AR

### Augenklinik Dr. med. A. v. Scarpatetti, Teufen AR
- **URL:** —
- **Note:** Acuto. DNS dead da scan agent. Verify URL corrente.

## BE

### Klinik Hohmad, Thun
- **URL:** —
- **Note:** Agent S: hohmad.ch = Wohngenossenschaft (cooperativa abitativa). Verify se esiste vera clinica.

### Klinik Selhofen, Burgdorf
- **URL:** [https://selhofen.ch/](https://selhofen.ch/)
- **Note:** Exists, agent S: zero postings live, solo Initiativbewerbung. Verify se ha attualmente posizioni.

### Reha- und Kurklinik EDEN, Oberried am Brienzersee
- **URL:** [https://www.klinikeden.ch/Angebot/offene-stellen/](https://www.klinikeden.ch/Angebot/offene-stellen/)
- **Note:** Agent: solo Spontanbewerbung. Verify se ha posizioni live.

### Reha-Pflegeklinik Eden, Ringgenberg BE
- **URL:** —
- **Note:** Stesso gruppo Eden. URL da verificare.

### Stiftung Diaconis Palliative Care, Bern
- **URL:** —
- **Note:** Cura palliativa. URL career da scoprire.

## FR

### Hôpital Jules Daler, Fribourg
- **URL:** —
- **Note:** Acuto privato. URL career da scoprire.

### Réseau fribourgeois de santé mentale (RFSM), Villars-sur-Glâne + Marsens
- **URL:** —
- **Note:** Psichiatria cantonale FR (2 sedi). URL career da scoprire (probabile rfsm.ch).

## SG

### Clinic Bad Ragaz
- **URL:** —
- **Note:** Riabilitazione (zona di confine GR/SG). URL career da scoprire.

### Klinik Sonnenhof Kinder & Jugendpsychiatrisches Zentrum, Ganterschwil
- **URL:** —
- **Note:** Psichiatria infantile. URL career da scoprire.

### Psychiatrie St. Gallen, Klinik Wil
- **URL:** —
- **Note:** Possibilmente sub-site del parser PSGN. Verify se sono jobs distinti.

### Psychiatrie-Dienste Süd, Pfäfers
- **URL:** —
- **Note:** PSGS Pfäfers. URL career da scoprire.

### Thurklinik, Goldach
- **URL:** —
- **Note:** Possibile sub-site Berit Klinik (già coperto). Verify.

## SZ

### AMEOS Seeklinikum Brunnen
- **URL:** —
- **Note:** Agent O: karriere.ameos.eu TYPO3+ext_solr, solo 3 jobs Brunnen-tagged. Verify se ha attualmente più posizioni.

## TG

### Herz-Neuro-Zentrum Bodensee, Münsterlingen
- **URL:** —
- **Note:** Agent K: hnz.ch = Sedo Cloudflare parking. Verify URL corrente.

### Perlavita, Berlingen
- **URL:** —
- **Note:** Agent K: perlavita.com = Afternic domain-for-sale parking. Verify URL.

### Venenklinik Bellevue, Kreuzlingen
- **URL:** [https://venenklinik.ch/die-klinik/stellenangebote/](https://venenklinik.ch/die-klinik/stellenangebote/)
- **Note:** Agent K: 0 jobs ("Im Moment haben wir keine freie Stelle"). Verify periodicamente.

## ZG

### Klinik Meissenberg, Zug
- **URL:** —
- **Note:** Agent M: no on-page listing; profilo employer su medicus.ch non scrapabile. Verify URL alternativi.

## ZH

### Klinik Pyramide am See, Zürich
- **URL:** —
- **Note:** Agent F: "Zur Zeit hat es keine vakante Stelle" alla scansione. Verify periodicamente.

### Klinik Tiefenbrunnen, Zollikon
- **URL:** [https://www.kliniktiefenbrunnen.ch/](https://www.kliniktiefenbrunnen.ch/)
- **Note:** Agent S: site exists (clinica chirurgia plastica) ma nessuna pagina carriere pubblica trovata. Verify.

### Kinderstation Brüschhalde (PUK Männedorf)
- **URL:** —
- **Note:** Possibile sub-site del PUK parser. Verify se sono jobs distinti.

### Suchtfachklinik Zürich (Vormals Frankental)
- **URL:** —
- **Note:** Custom HTML small clinic. URL career da scoprire (probabile suchtfachklinik.ch ma DNS dead).

### Vista Diagnostics, Zürich
- **URL:** —
- **Note:** Diagnostics outpatient. URL career da scoprire.

---

## Riassunto cantone

| Cantone | Entries da verificare |
|---|---:|
| TI | 3 |
| GR | 3 |
| VD | 8 |
| GE | 6 |
| BL | 3 |
| AG | 4 |
| AR | 1 |
| BE | 5 |
| FR | 2 |
| SG | 5 |
| SZ | 1 |
| TG | 3 |
| ZG | 1 |
| ZH | 5 |
| **Totale** | **50** |