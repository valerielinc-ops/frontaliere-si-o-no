# Copilot Prompts Per Crawler Jobs

Usa i prompt qui sotto direttamente in Copilot Chat. Ogni prompt include:
- file del crawler da rivedere
- esempio reale da usare come regressione
- problema osservato
- modifica richiesta
- controlli da aggiungere per evitare ricadute

## Priorita Alta

### `volg-fenaco`
```text
@workspace Rivedi il crawler VOLG in `scripts/update-volg-jobs.mjs`. Caso di regressione: slug `verkauferin-verkaufer-volg-binn`, sorgente `https://jobs.fenaco.com/offene-stellen/verkaeuferin-verkaeufer/e390d1b7-f24f-4904-9187-08cf01d7d44a`. Problema osservato: sul sito pubblichiamo un teaser molto corto, mentre la sorgente contiene sezioni complete come compiti, requisiti, benefits e recruiter; l’audit ha marcato `volg-fenaco` 60/61 `review`. Modifica il parser per usare come fonte primaria il body completo del dettaglio ATS Fenaco, estraendo le sezioni strutturate e non la sola intro/meta description; correggi anche i casi di `title_mismatch` dove il titolo pubblicato o la lingua non coincidono col dettaglio. Aggiungi un test Vitest dedicato con fixture HTML reale del job di esempio che verifichi: titolo esatto, presenza di almeno una sezione compiti e una requisiti, descrizione >= 500 caratteri. Aggiungi una guard nel crawler che rifiuti descrizioni sotto il 25% del body sorgente quando il dettaglio contiene sezioni strutturate, e una verifica di overlap >= 0.6 tra titolo sorgente e titolo salvato. Esegui `node scripts/update-volg-jobs.mjs` e conferma che il job di esempio non venga più ridotto a teaser.
```

### `pemsa`
```text
@workspace Rivedi il crawler PEMSA in `scripts/update-pemsa-jobs.mjs`. Casi di regressione: `lattoniere-pemsa-lugano` (`https://www.pemsa.ch/it/job/lattoniere-2665294/`) e `installatore-idraulico-afc-pemsa-lugano` (`https://www.pemsa.ch/it/job/installatore-idraulico-afc-2665222/`). Problema osservato: `pemsa` è 29/29 `review`, con descrizioni pubblicate molto più corte della sorgente. Modifica il parser per estrarre il corpo completo del dettaglio job PEMSA, incluse mansioni, requisiti, condizioni e CTA, evitando riassunti o snippet iniziali. Aggiungi un test Vitest con fixture HTML reale di uno dei job sopra e verifica descrizione >= 400 caratteri e presenza di almeno due blocchi distinti del contenuto originale. Aggiungi una guard che scarti descrizioni sotto il 20% della lunghezza del body sorgente e un controllo che il testo salvato contenga almeno 2 heading o liste dal dettaglio originale. Esegui `node scripts/update-pemsa-jobs.mjs` e mostra il risultato sul job di esempio.
```

### `lombardi-group`
```text
@workspace Rivedi il crawler Lombardi in `scripts/update-lombardi-jobs.mjs` e, se serve, nella logica condivisa di parsing usata da quel file. Casi di regressione: `progettista-tecnico-rvcs-m-f-x-lombardi-giubiasco` (`https://lombardi.group/eng/careers/job?id=108934`) e `apprendista-it-tecnico-sistemistico-lombardi-giubiasco` (`https://lombardi.group/eng/careers/job?id=109274`). Problema osservato: `lombardi-group` è 8/8 `review` per `title_mismatch`, quindi il crawler sta leggendo il titolo sbagliato o troppo generico. Modifica il parser per prendere il titolo dal dettaglio vacancy reale (`h1`, JSON-LD o heading principale del job) e non da breadcrumb, tab title generico o header di listing. Aggiungi test Vitest con fixture HTML di due job Lombardi che verifichino titolo preciso e overlap >= 0.8 con il dettaglio sorgente. Aggiungi una guard che rifiuti il titolo quando il suo overlap con `h1`/`JobPosting.title` è < 0.6 e usi un fallback ordinato sui campi migliori. Esegui `node scripts/update-lombardi-jobs.mjs` e verifica i due slug di esempio.
```

### `medacta-international`
```text
@workspace Rivedi il crawler Medacta in `scripts/update-medacta-jobs.mjs` e negli helper collegati a Medacta. Casi di regressione: `operatore-pre-post-coating-medacta-castel-san-pietro` (`https://joblink.allibo.com/ats3/job-offer.aspx?DM=1818&ID=102667&LN=IT&FT=455&SG=2`) e `thesis-r-d-orthopedics-medacta-rancate` (`https://joblink.allibo.com/ats3/job-offer.aspx?DM=1818&ID=92188&LN=IT&FT=459&SG=2`). Problema osservato: `medacta-international` è 5/5 `review` perché salviamo descrizioni molto più corte della sorgente, spesso quasi template. Modifica il crawler per estrarre il dettaglio completo Allibo e non il contenuto sintetico/template; se c’è una fase di enrichment, falla partire solo dopo che il body originale è stato acquisito integralmente. Aggiungi test con fixture HTML reali che verifichino descrizione >= 500 caratteri, presenza di almeno tre blocchi reali dal dettaglio e assenza di body eccessivamente template-izzati. Aggiungi una guard che impedisca di pubblicare descrizioni sotto il 20% del dettaglio sorgente o composte quasi interamente da testo boilerplate ripetuto. Esegui `node scripts/update-medacta-jobs.mjs` e conferma il fix sui due esempi.
```

### `baronie`
```text
@workspace Rivedi il crawler Baronie in `scripts/update-baronie-jobs.mjs`. Casi di regressione: `international-sales-manager-chocolat-alprose-sa-baronie-switzerland-sa-ticino` (`https://www.baronie.com/en/jobs/international-sales-manager-caslano`) e `administratieve-support-student-of-flexi-tijdelijk-baronie-belgium-nv-ticino` (`https://www.baronie.com/en/jobs/administratieve_support_tijdelijk_flexi_student`). Problema osservato: `baronie` è 5/5 `review`, con un mix di titoli sbagliati e descrizioni troppo sottili. Modifica il parser per distinguere chiaramente titolo vacancy, intro e body descrittivo, usando il contenuto del dettaglio completo anche quando la lingua della pagina è inglese o olandese. Aggiungi test con fixture HTML per un job con `title_mismatch` e uno con `published_description_too_thin`, verificando titolo esatto e descrizione >= 350 caratteri. Aggiungi due guard: 1) overlap titolo >= 0.6 con `h1`/oggetto vacancy, 2) descrizione minima proporzionale al body sorgente quando la pagina espone sezioni strutturate. Esegui `node scripts/update-baronie-jobs.mjs`.
```

### `manor`
```text
@workspace Rivedi il crawler Manor in `scripts/update-manor-jobs.mjs`. Casi di regressione: `manor-collaboratore-trice-servizio-manora-50-locarno` (`https://positions.manor.ch/job/Locarno-Collaboratoretrice-servizio-%28Manora%29-50/1345112255/`) e `manor-apprendista-polydesigner-3d-afc-100-lugano` (`https://positions.manor.ch/job/Lugano-Apprendista-Polydesigner-3D-AFC-100/1327124155/`). Problema osservato: `manor` è 7/7 `review`, quasi tutti per descrizione molto più corta della sorgente. Modifica il crawler per usare l’intera job description dal dettaglio Manor e non il solo abstract. Aggiungi test con fixture HTML reale che verifichi titolo corretto e descrizione >= 400 caratteri con almeno due sezioni effettive del job. Aggiungi una guard che blocchi la pubblicazione se la descrizione è < 20% del contenuto del dettaglio o non contiene alcun elenco/sezione presente nella sorgente. Esegui `node scripts/update-manor-jobs.mjs`.
```

### `citta-di-mendrisio`
```text
@workspace Rivedi il crawler Città di Mendrisio in `scripts/update-mendrisio-jobs.mjs`. Casi di regressione: `1-apprendista-afc-elettricista-per-reti-di-distribuzione-mendrisio` (`https://mendrisio.ch/downloadConcorsiPdf?uuid=406d1993-b1ab-4edb-aa94-ef296eb1e54e`) e `1-apprendista-cfp-giardiniere-a-paesaggista-mendrisio` (`https://mendrisio.ch/downloadConcorsiPdf?uuid=7b18ea7e-9966-4aaf-ae1a-2e90c5ba26ec`). Problema osservato: `citta-di-mendrisio` è 7/8 `review` per `title_mismatch`, quindi il titolo estratto dai PDF o dai blocchi HTML è sbagliato o troppo generico. Modifica il crawler per ricavare il titolo dal heading principale del PDF o dal blocco introduttivo del bando, non dal filename o da un’intestazione generica. Aggiungi test con fixture PDF/testo estratto che verifichino il titolo corretto per almeno due concorsi. Aggiungi una guard che scarti titoli troppo generici (`Concorso`, `Apprendistato`, ecc. senza specifica del ruolo) e richieda overlap >= 0.7 con la prima riga significativa del PDF. Esegui `node scripts/update-mendrisio-jobs.mjs`.
```

### `spindox`
```text
@workspace Rivedi il crawler Spindox in `scripts/update-spindox-jobs.mjs` e nel parser collegato. Casi di regressione: `network-engineer-spindox-lugano-ti` (`https://joblink.allibo.com/ats4/job-offer.aspx?DM=1405&ID=98700&LN=IT&FT=1067&SG=2`) e `quality-engineer-spindox-lugano` (`https://joblink.allibo.com/ats4/job-offer.aspx?DM=1405&ID=96160&LN=IT&FT=1067&SG=2`). Problema osservato: `spindox` è 3/4 `review` perché la descrizione salvata è molto più corta della sorgente Allibo. Modifica il parser per estrarre integralmente il body del dettaglio, comprese responsabilità, requisiti, location e modalità di lavoro. Aggiungi test con fixture HTML reale e verifica descrizione >= 450 caratteri e presenza di almeno due sezioni originali. Aggiungi una guard che rifiuti body sotto il 20% del dettaglio sorgente e che controlli la presenza di heading/liste dell’annuncio originale. Esegui `node scripts/update-spindox-jobs.mjs`.
```

### `lastminute-com`
```text
@workspace Rivedi il crawler lastminute.com in `scripts/update-lastminute-jobs.mjs`. Casi di regressione: `head-of-data-platform-engineering-chiasso` (`https://corporate.lastminute.com/careers/jobs/job?id=744000111059566&jobName=Head+of+Data+Platform+Engineering`) e `software-engineer-etls-microservices-chiasso` (`https://corporate.lastminute.com/careers/jobs/job?id=744000108444345&jobName=Software+Engineer+%E2%80%93+ETLs`). Problema osservato: 3/5 job `review` perché la descrizione pubblicata è molto più corta della sorgente. Modifica il crawler per usare il blocco completo del dettaglio careers e non una preview ridotta. Aggiungi test con fixture HTML per un job tecnico e verifica body >= 500 caratteri con almeno responsabilità e requisiti. Aggiungi guard che blocchi il salvataggio se il testo estratto è sotto il 25% del contenuto principale o se mancano i blocchi chiave del dettaglio. Esegui `node scripts/update-lastminute-jobs.mjs`.
```

### `axpo-group`
```text
@workspace Rivedi il crawler Axpo in `scripts/update-axpo-jobs.mjs`. Casi di regressione: `anlagenfuhrer-in-heizwerkfuhrer-in-holzheizkraftwerk-w-m-d-2101497b-3a42-43b6-8370-7835eb32af54` (`https://careers.axpo.com/jobs/7144543-anlagenfuehrer-in-heizwerkfuehrer-in-holzheizkraftwerk-w-m-d`) e `dispatcher-in-betriebs-und-schichtdienst-5325390e-c462-4d95-91cb-b5c68f49f8f1` (`https://careers.axpo.com/jobs/7290386-dispatcher-in-betriebs-und-schichtdienst`). Problema osservato: 3/3 `review` per descrizione troppo corta rispetto alla pagina sorgente. Modifica il crawler per estrarre il body completo dalla pagina careers Axpo, non il riassunto iniziale. Aggiungi test con fixture HTML reale che controlli body >= 400 caratteri e presenza di almeno due blocchi originali. Aggiungi una guard di lunghezza relativa e una guard che verifichi la presenza di heading/section titles del dettaglio. Esegui `node scripts/update-axpo-jobs.mjs`.
```

### `la-fonte`
```text
@workspace Rivedi il crawler La Fonte in `scripts/update-lafonte-jobs.mjs`. Casi di regressione: `un-a-operatore-trice-socioassistenziale-60-a-fonte-6-fondazione-la-fonte-agno` (`https://www.lafonte.ch/inizia-con-noi?role=un-a-operatore-trice-socioassistenziale-60-a-fonte-6-la-fonte`) e `apprendisti-e-operatori-trici-socioassistenziali-afc-fondazione-la-fonte-lugano-neggio` (`https://www.lafonte.ch/inizia-con-noi?role=apprendisti-e-operatori-trici-socioassistenziali-afc-la-fonte`). Problema osservato: 3/3 `review`, descrizione pubblicata molto più breve della sorgente. Modifica il crawler per acquisire il contenuto completo del dettaglio `role` e non il solo testo introduttivo. Aggiungi test con fixture HTML reale che verifichi un body >= 350 caratteri e il recupero delle sezioni responsabilità/requisiti. Aggiungi una guard che rifiuti descrizioni troppo corte rispetto al main content e una guard che richieda almeno 2 blocchi testuali distinti dal dettaglio. Esegui `node scripts/update-lafonte-jobs.mjs`.
```

### `oscam`
```text
@workspace Rivedi il crawler OSCAM in `scripts/update-oscam-jobs.mjs`. Casi di regressione: `concorso-generale-2026-oscam-ospedale-e-casa-anziani-malcantonese-castelrotto` (`https://www.oscam.ch/wp-content/uploads/2026/02/Concorso-generale-2026.pdf`) e `concorso-vice-responsabile-finanze-al-100-oscam-ospedale-e-casa-anziani-malcantonese-castelrotto` (`https://www.oscam.ch/wp-content/uploads/2026/03/Concorso-vice-responsabile-finanze-al-100-.pdf`). Problema osservato: 3/3 `review`, i PDF vengono sintetizzati troppo. Modifica il crawler per usare tutto il testo estratto dal PDF e non solo le righe introduttive. Aggiungi test con fixture PDF o testo estratto che verifichi descrizione >= 500 caratteri e presenza delle sezioni salienti del bando. Aggiungi una guard che rifiuti descrizioni troppo corte rispetto al testo PDF normalizzato e che controlli la presenza di almeno 3 paragrafi significativi. Esegui `node scripts/update-oscam-jobs.mjs`.
```

### `banca-cler`
```text
@workspace Rivedi il crawler Banca Cler in `scripts/update-cler-jobs.mjs`. Casi di regressione: `geschaftsstellenleiterin-schaffhausen-w-m-banca-cler-bellinzona` (`https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen/geschaeftsstellenleiterin-schaffhausen-w-m-2587`) e `marktgebietsleiterin-zentral-w-m-banca-cler-bellinzona` (`https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen/marktgebietsleiterin-zentral-w-m-2622`). Problema osservato: 3/5 `review` e 1 `unknown`; il crawler salva una descrizione troppo sottile, quasi teaser. Modifica il parser per prendere il corpo completo della vacancy Cler, non solo il blocco riassuntivo. Aggiungi test con fixture HTML reale che verifichi descrizione >= 350 caratteri e presenza di almeno responsabilità o profilo richiesto. Aggiungi una guard che scarti le descrizioni teaser e un fallback robusto per gestire eventuali pagine temporaneamente non raggiungibili senza degradare il contenuto salvato. Esegui `node scripts/update-cler-jobs.mjs`.
```

### `ail-lugano`
```text
@workspace Rivedi il crawler AIL in `scripts/update-ail-jobs.mjs`. Casi di regressione: `project-coordinator-ail-lugano` (`https://www.ail.ch/downloadJobPosition?uuid=5f8be657-e445-41a0-9335-6b5fcb81c02c`) e `responsabile-della-revisione-interna-audit-ail-lugano` (`https://www.ail.ch/downloadJobPosition?uuid=6d168bc9-6f0f-466e-aab6-d430613bb518`). Problema osservato: 2/2 `review` per `title_mismatch`; il titolo viene letto male dal PDF o da un campo secondario. Modifica il crawler per prendere il titolo dalla prima intestazione forte del PDF/bando e non da filename o heading generico. Aggiungi test con fixture PDF/testo estratto che verifichi titolo preciso sui due esempi. Aggiungi una guard che richieda overlap >= 0.7 tra titolo salvato e prima riga significativa del PDF. Esegui `node scripts/update-ail-jobs.mjs`.
```

## Priorita Media

### `relewant`
```text
@workspace Rivedi il crawler Relewant in `scripts/update-relewant-jobs.mjs`. Casi di regressione: `automation-mft-specialist-relewant-lugano` (`https://relewant.zohorecruit.com/jobs/Careers/467189000019329033/Automation-MFT-Specialist`) e `bi-specialist-relewant-bellinzona` (`https://relewant.zohorecruit.com/jobs/Careers/467189000019329001/BI-Specialist`). Problema osservato: 7/19 `review` e 12 `watch`; i problemi sono un mix di `title_mismatch` e body troppo corto rispetto a Zoho Recruit. Modifica il parser per usare come titolo prioritario `h1`/JSON-LD del dettaglio e come descrizione il body completo della vacancy, riducendo i fallback su metadati o snippet. Aggiungi test con fixture HTML per un job `title_mismatch` e uno `published_description_far_shorter_than_source`. Aggiungi due guard: overlap titolo >= 0.6 con l’`h1`, e rifiuto di body sotto il 25% del main content della vacancy. Esegui `node scripts/update-relewant-jobs.mjs`.
```

### `coop-ticino`
```text
@workspace Rivedi il crawler Coop in `scripts/update-coop-jobs.mjs`. Casi di regressione: `detailhandelsfachfrau-mann-assistent-in-coop-city-grigioni` (`https://jobs.coopjobs.ch/offene-stellen/detailhandelsfachfrau-mann-assistent-in/f0241dd6-5b4a-41c3-aaf7-3a0593a2667e`) e `verkaufsberater-in-textil-coop-city-grigioni` (`https://jobs.coopjobs.ch/offene-stellen/verkaufsberater-in-textil/ecbbf341-223f-4cba-b6bd-e60efa3e2ebc`). Problema osservato: 7/83 `review`, con 6 `title_mismatch` e 1 body troppo corto. Modifica il parser per prendere titolo e descrizione dal dettaglio specifico della vacancy CoopJobs, non da listing o metadata generici; assicurati che titolo e lingua del job detail prevalgano sui campi di navigazione. Aggiungi test con fixture HTML per i due esempi, verificando titolo esatto e body >= 350 caratteri quando il dettaglio contiene testo lungo. Aggiungi una guard sul titolo (overlap >= 0.6 con `h1`) e una guard che impedisca di pubblicare solo l’intro se il dettaglio contiene sezioni complete. Esegui `node scripts/update-coop-jobs.mjs`.
```

### `amministrazione-cantonale-ti`
```text
@workspace Rivedi il crawler Amministrazione Cantonale TI in `scripts/update-tich-jobs.mjs`. Casi di regressione: `1-apprendista-operatrice-tore-di-edifici-e-infrastrutture-afc-per-il-periodo-dal-31-agosto-2026-al-30-agosto-2029-presso-il-servizio-economa` (`https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4117`) e `concorso-generale-2026-collaboratori-trici-amministrativi-e-addetti-e-al-servizio-accoglienza-addetti-e-agli-assicurati-iii-consulenti-telef` (`https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=3994`). Problema osservato: 4/13 `review`, con titoli errati e un caso di descrizione molto più corta del dettaglio. Modifica il parser per prendere titolo e body dalla scheda completa del concorso, isolando il titolo vero dalla testata istituzionale e includendo il contenuto completo del bando HTML. Aggiungi test con fixture HTML per un caso di `title_mismatch` e uno di body corto. Aggiungi una guard che scarti titoli con overlap basso rispetto al dettaglio e una guard che impedisca di salvare solo l’introduzione se il concorso contiene sezioni aggiuntive. Esegui `node scripts/update-tich-jobs.mjs`.
```

### `boggi-milano`
```text
@workspace Rivedi il crawler Boggi in `scripts/update-boggi-jobs.mjs`. Casi di regressione: `retail-hr-specialist-boggi-milano-mendrisio-ticino` (`https://boggimilano1.recruitee.com/l/it/o/retail-hr-specialist-2`) e `treasury-coordinator-boggi-milano-mendrisio-ticino` (`https://boggimilano1.recruitee.com/l/it/o/treasury-coordinator-3`). Problema osservato: 3/5 `review`, body pubblicato troppo corto rispetto a Recruitee. Modifica il parser per usare l’intera description del dettaglio Recruitee e non solo i blocchi iniziali. Aggiungi test con fixture HTML reale che verifichi body >= 400 caratteri e presenza di almeno due sezioni originali. Aggiungi una guard che rifiuti descrizioni sotto il 25% del body sorgente. Esegui `node scripts/update-boggi-jobs.mjs`.
```

### `lidl-svizzera`
```text
@workspace Rivedi il crawler Lidl in `scripts/update-lidl-jobs.mjs`. Casi di regressione: `verkaufer-verkauferin-m-w-d-20-40-lidl-svizzera-st-moritz` (`https://team.lidl.ch/de/jobs/verkaeufer-verkaeuferin-m-w-d-20-40-st-moritz-657113`) e `filialleiter-filialleiterin-m-w-d-80-100-lidl-svizzera-st-moritz` (`https://team.lidl.ch/de/jobs/filialleiter-filialleiterin-m-w-d-80-100-st-moritz-656562`). Problema osservato: 3/10 `review`, descrizioni troppo corte rispetto al dettaglio sorgente. Modifica il crawler per estrarre il body completo da `team.lidl.ch` e non solo l’abstract. Aggiungi test con fixture HTML reale per uno store role e verifica descrizione >= 400 caratteri. Aggiungi una guard sulla lunghezza relativa del body e una guard che verifichi la presenza di almeno una lista o sezione del job detail. Esegui `node scripts/update-lidl-jobs.mjs`.
```

### `usi-universita-della-svizzera-italiana`
```text
@workspace Rivedi il crawler USI in `scripts/update-usi-jobs.mjs`. Casi di regressione: `posizione-a-tempo-pieno-di-scienziato-ingegnere-della-strumentazione-usi-locarno` (`https://www.irsol.usi.ch/it/eventi-notizie/posizione-a-tempo-pieno-di-scienziatoingegnere-del-41206`) e `posizione-a-tempo-pieno-di-uno-scienziato-ingegnere-di-strumentazione-usi-locarno` (`https://www.irsol.usi.ch/en/events-news/full-time-position-of-an-instrumentation-scientist-41206`). Problema osservato: solo 2/24 `review`, ma anche 10 `watch`; i casi problematici mostrano titolo non stabile o summary troppo sintetico sulle pagine IRSOL. Modifica il crawler per dare priorità al titolo del dettaglio sorgente e preservare il body completo dei job USI/IRSOL, con una gestione robusta delle varianti bilingue. Aggiungi test con fixture HTML per la coppia IT/EN qui sopra, verificando titolo coerente e body non riassunto. Aggiungi una guard che verifichi overlap titolo cross-lingua e che rifiuti summary troppo brevi quando la pagina ha contenuto lungo. Esegui `node scripts/update-usi-jobs.mjs`.
```

### `convit-holding`
```text
@workspace Rivedi il crawler Convit in `scripts/update-convit-jobs.mjs`. Casi di regressione: `consulente-previdenziale-per-la-vecchiaia-3a-entrata-laterale-tempo-indeterminato-convit-biasca` (`https://www.careers-page.com/convit-holding-gmbh/job/7X4V6XR5`) e `consulente-previdenziale-m-f-d-ingresso-senza-formazione-ote-fino-a-7-500-chf-convit-biasca` (`https://www.careers-page.com/convit-holding-gmbh/job/8X396X33`). Problema osservato: 2/23 `review`, descrizioni troppo corte per alcune vacancy Careers Page. Modifica il crawler per usare il body completo del dettaglio e non la sola parte introduttiva. Aggiungi test con fixture HTML reale e verifica descrizione >= 350 caratteri e presenza di almeno due blocchi originali. Aggiungi una guard di lunghezza relativa del body. Esegui `node scripts/update-convit-jobs.mjs`.
```

### `migros-ticino`
```text
@workspace Rivedi il crawler Migros in `scripts/update-migros-jobs.mjs`. Casi di regressione: `gerente-denner-sa-biasca` (`https://jobs.migros.ch/it/le-nostre-imprese/job/denner-sa/gerente/bacaa68b-e4db-4290-9f1b-a94f01026d4d`) e `project-manager-immobiliare-real-estate-f-m-d-societa-cooperativa-migros-ticino-s-antonino` (`https://jobs.migros.ch/it/le-nostre-imprese/job/societa-cooperativa-migros-ticino/project-manager-immobiliare-real-estate-fmd/4615b8db-46db-4c41-bf5d-a0362358d907`). Problema osservato: 2/6 `review`, body pubblicato troppo corto rispetto alla sorgente Migros Jobs. Modifica il crawler per prendere il blocco completo del dettaglio, incluse responsabilità e profilo richiesto. Aggiungi test con fixture HTML reale per un job Denner e uno Migros Ticino. Aggiungi una guard che eviti di salvare solo la preview iniziale. Esegui `node scripts/update-migros-jobs.mjs`.
```

### `ibsa-institut-biochimique`
```text
@workspace Rivedi il crawler IBSA in `scripts/update-ibsa-jobs.mjs`. Caso di regressione: `accounting-officer-sost-maternita-e-collaborazione-persona-responsabile-ed-affidabile-abituata-a-gestire-scadenze-a-breve-termine-luogo-di-l` (`https://career.ibsagroup.com/job/Collina-d'Oro-Accounting-Officer-%28sost_-maternit%C3%A0%29-TI-6926/1343827855/`). Problema osservato: 1/9 `review`, descrizione pubblicata molto più corta della sorgente. Modifica il crawler per leggere l’intero job detail e non solo il summary. Aggiungi test con fixture HTML reale che verifichi descrizione >= 400 caratteri e presenza di almeno due sezioni originali. Aggiungi una guard di lunghezza relativa del body. Esegui `node scripts/update-ibsa-jobs.mjs`.
```

### `ffs-officine-ferrovie-federali`
```text
@workspace Rivedi il crawler FFS/SBB in `scripts/update-sbb-jobs.mjs`. Caso di regressione: `dirigente-team-controllo-qualita-m-f-d-ffs-officine-ferrovie-federali-bellinzona` (`https://jobs.sbb.ch/v2/offene-stellen/dirigente-team-controllo-qualita-m-f-d/f40a8456-69e6-4d3f-ad9a-8b7803d10227`). Problema osservato: 1/17 `review`, con descrizione pubblicata più corta della sorgente. Modifica il crawler per prendere il body completo di quella vacancy SBB e non solo un sottoinsieme del testo. Aggiungi test con fixture HTML reale per questo job e verifica descrizione >= 400 caratteri. Aggiungi una guard che eviti di troncare la descrizione quando il dettaglio contiene sezioni strutturate. Esegui `node scripts/update-sbb-jobs.mjs`.
```

### `corner-banca`
```text
@workspace Rivedi il crawler Corner Banca in `scripts/update-corner-jobs.mjs`. Caso di regressione: `candidatura-spontanea-apprendistato-corner-banca-switzerland` (`https://jobs.corner.ch/o/unsolicited-application-apprenticeship`). Problema osservato: 1/5 `review`, body pubblicato molto più corto della vacancy originale. Modifica il crawler per acquisire il contenuto completo della vacancy e non solo il teaser. Aggiungi test con fixture HTML reale che verifichi descrizione >= 300 caratteri. Aggiungi una guard di lunghezza relativa del body. Esegui `node scripts/update-corner-jobs.mjs`.
```

### `fart`
```text
@workspace Rivedi il crawler FART in `scripts/update-fart-jobs.mjs`. Caso di regressione: `1-addetto-al-reparto-verifica-e-pulizia-del-garage-autolinee-100-m-f-fart-ferrovie-autolinee-regionali-ticinesi-locarno` (`https://fartiamo.ch/wp-content/uploads/2026/02/Addetto-al-Reparto-Verifica-e-Pulizia-del-Garage-autolinee.pdf`). Problema osservato: 1/3 `review`, il PDF viene sintetizzato troppo. Modifica il crawler per usare tutto il testo estratto dal PDF e non un riassunto breve. Aggiungi test con fixture PDF/testo estratto che verifichi descrizione >= 400 caratteri e almeno 3 paragrafi significativi. Aggiungi una guard che blocchi body troppo corti rispetto al PDF normalizzato. Esegui `node scripts/update-fart-jobs.mjs`.
```

### `allianz-suisse`
```text
@workspace Rivedi il crawler Allianz in `scripts/update-allianz-jobs.mjs`. Caso di regressione: `consulente-previdenziale-per-l-agenzia-generale-chur-100-allianz-bewerbermanagement` (`https://recruitingapp-2872.umantis.com/Vacancies/404/Description/4`). Problema osservato: 1/2 `review` per `title_mismatch`. Modifica il crawler per leggere il titolo dalla scheda vacancy Umantis e non da breadcrumb o elementi laterali. Aggiungi test con fixture HTML reale che verifichi il titolo esatto. Aggiungi una guard di overlap titolo >= 0.7 con l’`h1` o col blocco `JobTitle` della sorgente. Esegui `node scripts/update-allianz-jobs.mjs`.
```

### `lwphr`
```text
@workspace Rivedi il crawler LWPHR in `scripts/update-lwphr-jobs.mjs`. Caso di regressione: `web-developer-lwp-ledermann-wieting-partners-lugano` (`https://www.lwphr.ch/uploads/1/4/6/5/146598773/web_developer.pdf`). Problema osservato: 1/11 `review` per `title_mismatch`; il titolo del PDF non viene estratto correttamente. Modifica il crawler per derivare il titolo dalla prima intestazione significativa del PDF, non dal filename o da una stringa generica. Aggiungi test con fixture PDF/testo estratto e verifica il titolo corretto. Aggiungi una guard che richieda overlap >= 0.7 tra titolo salvato e prima riga significativa del PDF. Esegui `node scripts/update-lwphr-jobs.mjs`.
```

### `international-school-of-ticino`
```text
@workspace Rivedi il crawler IST in `scripts/update-ist-jobs.mjs`. Caso di regressione: `expression-of-interest-international-school-of-ticino-ist` (`https://jobs.inspirededu.com/job/Lugano-Expression-of-Interest-International-School-of-Ticino/1331830557/`). Problema osservato: 1/2 `review` per `title_mismatch`. Modifica il crawler per usare il titolo reale della vacancy Inspired e non il titolo generico della pagina careers. Aggiungi test con fixture HTML reale che verifichi titolo esatto. Aggiungi una guard di overlap titolo >= 0.7 con l’`h1` sorgente. Esegui `node scripts/update-ist-jobs.mjs`.
```

### `banca-raiffeisen-vedeggio-cassarate`
```text
@workspace Rivedi il crawler Raiffeisen VC in `scripts/update-raiffeisen-vc-jobs.mjs`. Caso di regressione: `consulente-clientela-aziendale-banca-raiffeisen-vedeggio-cassarate-gravesano` (`https://jobs.raiffeisen.ch/posti-vacanti/consulente-clientela-aziendale/be9abb00-04dc-4b3c-b852-62917b8e396d`). Problema osservato: 1/1 `review`, descrizione pubblicata molto più corta della sorgente. Modifica il crawler per estrarre il body completo della vacancy Raiffeisen. Aggiungi test con fixture HTML reale che verifichi descrizione >= 350 caratteri. Aggiungi una guard di lunghezza relativa del body. Esegui `node scripts/update-raiffeisen-vc-jobs.mjs`.
```

### `dxt-commodities`
```text
@workspace Rivedi il crawler DXT in `scripts/update-dxt-jobs.mjs`. Caso di regressione: `junior-legal-dxt` (`https://dxt.com/careers/?panel=20897_1`). Problema osservato: 1/1 `review` per `title_mismatch`. Modifica il crawler per prendere il titolo dal pannello careers attivo e non da heading o tab generici della pagina. Aggiungi test con fixture HTML reale che verifichi il titolo esatto. Aggiungi una guard di overlap titolo >= 0.7 con il titolo del pannello attivo. Esegui `node scripts/update-dxt-jobs.mjs`.
```

### `linnea`
```text
@workspace Rivedi il crawler Linnea in `scripts/update-linnea-jobs.mjs`. Caso di regressione: `erp-system-administrator-and-it-project-lead-linnea` (`https://www.linnea.ch/careers/?position=1`). Problema osservato: 1/1 `review`, descrizione pubblicata molto più corta della sorgente. Modifica il crawler per usare il body completo della vacancy Linnea e non il solo riassunto iniziale. Aggiungi test con fixture HTML reale che verifichi descrizione >= 350 caratteri. Aggiungi una guard che blocchi summary troppo brevi rispetto al contenuto del dettaglio. Esegui `node scripts/update-linnea-jobs.mjs`.
```

## Priorita Bassa Ma Da Sistemare

### `corner cases con un solo job review`
Usa gli stessi principi dei prompt sopra anche per:
- `ibsa-institut-biochimique`
- `ffs-officine-ferrovie-federali`
- `corner-banca`
- `fart`
- `international-school-of-ticino`
- `banca-raiffeisen-vedeggio-cassarate`
- `dxt-commodities`
- `linnea`

## Watch-Only: Non Bloccanti Ma Da Migliorare

Questi crawler non sono da considerare “rotti”, ma hanno segnali di estrazione migliorabile:
- `supsi-dti`: 6 `watch`, soprattutto `borderline_match`
- `schindler`: 4 `watch`, soprattutto `borderline_match`
- `colin-cie`: 3 `watch`
- `efg-international`: 3 `watch`
- `vf-international-the-north-face-timberland`: 1 `watch`
- `axa-svizzera`: 1 `watch`
- `damiani-group`: 1 `watch`
- `zurich-insurance-sede-ticino`: 1 `watch`
- `the-living-circle`: 1 `watch`

Prompt generico per questi casi:
```text
@workspace Rivedi il crawler `<crawler>` nel relativo file `scripts/update-...-jobs.mjs`. L’audit non lo segna come rotto ma come `watch`, quindi il body matcha abbastanza bene mentre titolo o struttura restano borderline. Migliora l’estrazione del titolo dal dettaglio sorgente e aggiungi un test di regressione su un job reale che verifichi overlap titolo >= 0.7 e descrizione non degradata rispetto al body sorgente. Non cambiare il comportamento dei job già corretti.
```
