# Analisi preparativa crawler ospedali svizzeri

> **Generato:** 2026-05-19
> **Fonte ospedali:** `data/swiss-hospitals.json` (463 entries scraped da welches-spital.ch, equivalente tedesco di which-hospital.ch/switzerland)
> **Scope:** identificare ospedali svizzeri NON ancora coperti da parser/crawler esistenti, con relative career page e ATS, pronti per implementazione crawler.

---

## 1. Sintesi

| Metrica | Valore |
|---|---|
| Ospedali totali (welches-spital.ch) | **463** |
| Già coperti da parser esistenti | **137** (gruppi + standorte) |
| Geburtshäuser (case nascita, escluse — piccole, no jobs) | **17** |
| Sub-siti di gruppi (consolidati nel parent) | **47** |
| **Standalone uncovered (candidati crawler)** | **277** |
| └─ Cantoni frontaliere priority (TI, GR, VS, VD, GE, BS, BL) | **91** ricercate in dettaglio in §3 |
| └─ Altri cantoni (ZH, BE, AG, SG, LU, FR, TG, …) | **186** elencati in §4 |

### Parser esistenti (riferimento)

31 parser/crawler ospedalieri già in `scripts/lib/`:

| Parser | ATS | Note |
|---|---|---|
| chuv | custom | Lausanne — CHUV |
| cseb | custom | Spitalzentrum Biel/Bienne |
| eoc | umantis (recruitingapp-2761) | Ente Ospedaliero Cantonale TI — copre anche Cardiocentro Ticino |
| flury-stiftung | custom | Spital Schiers GR |
| hirslanden | SAP SF | 18 cliniche CH (incluso Grangettes GE) |
| hochgebirgsklinik-davos | umantis | GR |
| hopital-du-valais | custom | CHVR Sion + SZO Visp |
| hug | SmartRecruiters | HUG Ginevra (copre anche Joli-Mont, Crans-Montana) |
| inselspital | umantis | Insel Gruppe Bern |
| ksa | umantis | Kantonsspital Aarau |
| ksgr | prospective (medium 1000745) | Kantonsspital Graubünden + Walenstadt |
| kssg | SAP SF | KSSG + Flawil |
| ksw | custom | Kantonsspital Winterthur |
| lindenhofgruppe | prospective | 3 sedi Bern |
| luks | custom | Luzerner Kantonsspital + Sursee/Nidwalden/Wolhusen |
| moncucco | custom | Clinica Moncucco Lugano (post-merger Santa Chiara) |
| pdgr | custom | Psychiatrische Dienste GR |
| rss-surselva | custom | Regionalspital Surselva Ilanz |
| see-spital | umantis | See-Spital Horgen + Kilchberg |
| solothurner-spitaeler | custom | Bürgerspital + Olten + Grenchen + Dornach |
| spital-davos | umantis | GR |
| spital-limmattal | custom | Schlieren ZH |
| spital-maennedorf | umantis | ZH |
| spital-sts | prospective | Thun-Simmental-Saanenland |
| spital-thurgau | custom | Münsterlingen + Frauenfeld |
| spital-thusis | custom | GR |
| spital-uster | prospective | ZH |
| stadtspital-zuerich | custom | Triemli + Waid + Oberwaid SG |
| swiss-medical-network | SmartRecruiters | 17 cliniche CH (Sant'Anna, Ars Medica, Genolier, Montchoisi, Valmont, Schmerzklinik, Générale-Beaulieu, ...) |
| unispital-basel | prospective | USB + Felix Platter |
| usz | prospective + SAP SF | Universitätsspital Zürich |

### Distribuzione ATS attesa (su 80 ospedali priority ricercati)

| ATS | # | Note implementazione |
|---|---|---|
| HTML custom | 29 | Pattern frammentato, ognuno parser dedicato |
| Umantis (CH) | 8 | Riusare template Inselspital/KSA — cambia solo `recruitingapp-{ID}` |
| SmartRecruiters | 7 | Riusare template HUG/SMN — config-driven |
| Prospective (CH) | 6 | Riusare template KSGR/Lindenhof — cambia medium ID |
| Jalios JCMS | 6 | **Nuovo template — 6 ospedali VD condividono questo CMS, alto ROI** |
| Unknown | 18 | Bot-block / no career page evidente — ispezione manuale |
| altri (dualoo, ostendis, solique, softgarden, talentsoft, SAP SF) | 6 | One-off, low priority |

---

## 2. Raccomandazioni di priorità implementazione

### Tier 1 — Quick wins (riuso template Umantis/Prospective/SmartRecruiters)

Sotto-ore di sviluppo per ognuno (cambia solo company ID):

1. **Hôpital de La Tour, Meyrin** (GE) — Prospective `recrutement.latour.ch`
2. **EHC Ensemble hospitalier de la Côte, Morges** (VD) — Prospective `emploi.ehc-vd.ch` — 53 jobs visibili
3. **Hôpital Riviera-Chablais, Vevey** (VD) — Prospective `emploi.hopitalrivierachablais.ch` — 2500 dipendenti
4. **Clinique de La Source, Lausanne** (VD) — Prospective `emploi.lasource.ch`
5. **Hôpital Intercantonal de la Broye, Payerne** (VD) — Prospective `emploi.hopital-broye.ch`
6. **Hôpital Ophtalmique Jules Gonin, Lausanne** (VD) — Prospective `emploi.ophtalmique.ch`
7. **Kantonsspital Baselland (KSBL)** (BL) — Umantis `recruitingapp-2748` — 70 jobs (Bruderholz + Liestal + Laufen)
8. **Bethesda Spital, Basel** (BS) — Umantis `recruitingapp-2998`
9. **Adullam Spital, Basel** (BS) — Umantis `recruitingapp-2562`
10. **Klinik Sonnenhalde, Riehen** (BS) — Umantis `recruitingapp-3030`

### Tier 2 — Nuovo template Jalios JCMS (ROI alto — 6 ospedali VD)

Sviluppare un parser `jalios-jcms-job-parser.mjs` riutilizzabile:

- Fondation Rive-Neuve, Blonay
- GHOL Nyon
- Hôpital de Lavaux, Cully
- Hôpital du Pays d'Enhaut
- Pôle santé Vallée de Joux
- Réseau Santé Balcon du Jura Vaudois (RSBJ)

Pattern URL: `/jcms/{id}/{lang}/{path}` — listing HTML.

### Tier 3 — Acuti TI/GR rimanenti (audience frontaliere)

1. **Klinik Gut St. Moritz** — gruppo con 4 sedi GR
2. **CSVP Poschiavo / Ospedale San Sisto**
3. **Ospedale Malcantonese Castelrotto** (OSCAM)
4. **CSVM Val Müstair**
5. **Centro Sanitario Bregaglia**

### Tier 4 — Privati indipendenti grandi

1. **St. Claraspital Basel** — Solique ATS
2. **UKBB Basel** — `stellen.ukbb.ch` subdomain
3. **Merian Iselin Basel** — 15 jobs
4. **Clinique la Prairie Clarens** — wellness/longevity
5. **Institution de Lavigny VD** — 860 dipendenti
6. **REHAB Basel** — Talentsoft ATS
7. **ZURZACH Care** — SAP SF (riusare template)
8. **Klinik Arlesheim** — Dualoo ATS — 40 jobs

### Tier 5 — Bassa priorità (skip o defer)

- Piccole cliniche <50 dipendenti senza career page (Spinedi, Varini, Vert-Pré, Belmont, Métairie, Maisonneuve)
- Sub-siti di gruppi già coperti (Grangettes → Hirslanden, Joli-Mont → HUG, Schmerzklinik → SMN)

---

## 3. Lista ospedali priority cantons (TI/GR/VS/VD/GE/BS/BL)

Legenda: 🔁 = già coperto via parser gruppo esistente | — = candidato netto


### TI — Ticino

| # | Ospedale | Career URL | ATS | Jobs | Coverto | Note |
|---|---|---|---|---|---|---|
| 1 | **Cardiocentro Ticino (CCT), Lugano** | [eoc.ch/it/lavoro.html](https://www.eoc.ch/it/lavoro.html) | (via parent) | ? | 🔁 | Integrato in EOC dal 2021; cardiocentro.org/it/carriere2 redirige a eoc.ch; ATS recruitingapp-2761.umantis.com |
| 2 | **Clinica Dr. Spinedi c/o Clinica Santa Croce, Orselina** | — | TBD | ? | — | Reparto omeopatico dentro Clinica Santa Croce; nessuna sezione carriere propria |
| 3 | **Clinica fondazione G. Varini, Orselina** | [clinicavarini.ch/notizie/](https://clinicavarini.ch/notizie/) | HTML custom | ? | — | Concorsi pubblicati nella sezione 'Notizie'; submission via posta/email |
| 4 | **Clinica Luganese SA Sede San Rocco** | [moncucco.ch/job/](https://moncucco.ch/job/) | (via parent) | 3 | 🔁 | Gruppo Ospedaliero Moncucco (merger Moncucco + Santa Chiara 2023); pagine job .php5 statiche |
| 5 | **Ospedale Malcantonese Fondazione Giuseppe Rossi, Castelrotto** | [oscam.ch/lavoraconnoi/](https://www.oscam.ch/lavoraconnoi/) | HTML custom | 3 | — | Concorsi come PDF; submission via form online dedicato |
| 6 | **Clinica Hildebrand Centro di riabilitazione Brissago** | [clinica-hildebrand.ch/collaborazione.html](https://www.clinica-hildebrand.ch/collaborazione.html) | HTML custom | 1 | — | Annunci come PDF allegati; submission via candidature@clinica-hildebrand.ch |
| 7 | **Clinica psichiatrica cantonale, Mendrisio** | [ti.ch/concorsi](https://www.ti.ch/concorsi) | HTML custom | ? | — | Parte di OSC (DSS Cantone Ticino); jobs pubblicati sul portale concorsi cantonale ti.ch/concorsi |
| 8 | **Clinica Santa Croce, Orselina** | — | TBD | ? | — | Nessuna sezione 'lavora con noi' diretta sul sito; candidature spontanee via info@santacroce.ch |
| 9 | **Clinica Viarnetto, Pregassona** | — | TBD | ? | — | Sito vetrina senza sezione carriere; annunci pubblicati su portali esterni |

### GR — Grigioni

| # | Ospedale | Career URL | ATS | Jobs | Coverto | Note |
|---|---|---|---|---|---|---|
| 1 | **Center da Sanadad Savognin SA (Kreisspital Surses)** | [en.cds-savognin.ch/DE/stellen.html](https://en.cds-savognin.ch/DE/stellen.html) | HTML custom | 4 | — | Annunci pubblicati come PDF su pagina statica; applicare via /DE/bewerbung.html o email |
| 2 | **Center da sanda Engiadina Bassa, Ospidal, Scuol** | [cseb.ch/das-cseb/offene-stellen/](https://cseb.ch/das-cseb/offene-stellen/) | (via parent) | ? | 🔁 | Career page restituisce 404 al fetch HTTP; valida via browser headless o sozjobs.ch mirror |
| 3 | **Center da Sanda Val Müstair Akutabteilung, Sta. Maria V. M.** | [csvm.ch/de/jobs.html](https://www.csvm.ch/de/jobs.html) | HTML custom | 5 | — | Blog-style con PDF download; sito alternativo ovmgr.ch/de/jobs |
| 4 | **Centro Sanitario Bregaglia, Promontogno** | [csbregaglia.ch/it/centro-sanitario/offerte-di-lavoro](https://www.csbregaglia.ch/it/centro-sanitario/offerte-di-lavoro) | HTML custom | 1 | — | Listing interno su Joomla CMS; nessun ATS esterno |
| 5 | **Klinik Gut AG (Gruppe), St. Moritz** | [klinik-gut.ch/de/offene-stellen](https://www.klinik-gut.ch/de/offene-stellen) | HTML custom | ? | — | Gruppo con sedi St. Moritz/Fläsch/Chur/Ascona; tutto interno al dominio |
| 6 | **Ospedale San Sisto Akutabteilung, Poschiavo** | [csvp.ch/it/lavora-con-noi/introduzione](https://www.csvp.ch/it/lavora-con-noi/introduzione) | HTML custom | ? | — | Parte di Centro sanitario Valposchiavo (CSVP) |
| 7 | **reha andeer, Andeer** | [reha-andeer.ch/offene-stellen/](https://reha-andeer.ch/offene-stellen/) | HTML custom | ? | — | Clinica privata indipendente; candidature dirette via email |
| 8 | **Rehaklinik Seewis, Seewis Dorf** | [rehaklinik-seewis.ch/karriere/offene-stellen](https://www.rehaklinik-seewis.ch/karriere/offene-stellen) | softgarden | 8 | — | VAMED/VITREA group; jobs hosted su vitrea-gesundheit.onlyfy.jobs (onlyfy by softgarden) |
| 9 | **Zürcher RehaZentrum Davos, Davos Clavadel** | [valens.ch/karriere](https://valens.ch/karriere) | TBD | ? | — | Fusionato con Kliniken Valens; karriere.zhreha.ch redirige a valens.ch/karriere |
| 10 | **Clinica Holistica Engiadina, Susch** | [clinica-holistica.ch/de/offene-stellen](https://www.clinica-holistica.ch/de/offene-stellen) | TBD | ? | — | WebFetch 403; mirror su hotelcareer.com e praktischarzt.ch |

### VS — Vallese

| # | Ospedale | Career URL | ATS | Jobs | Coverto | Note |
|---|---|---|---|---|---|---|
| 1 | **Clinique CIC Saxon** | [cliniquecic-saxon.ch/fr/emplois](https://www.cliniquecic-saxon.ch/fr/emplois) | HTML custom | 0 | — | Pagina landing senza listing strutturato; jobs pubblicati su jobup.ch sotto 'Clinique CIC Suisse SA' |
| 2 | **Luzerner Höhenklinik Montana, Crans-Montana** | [lhm.ch/de/allgemein/jobs](https://www.lhm.ch/de/allgemein/jobs) | HTML custom | 10 | — | Parte di LUKS Group ma career page indipendente su lhm.ch |
| 3 | **Berner Klinik Montana, Crans-Montana** | [bernerklinik.ch/fr/emploi-et-carriere/offres-demploi/](https://bernerklinik.ch/fr/emploi-et-carriere/offres-demploi/) | HTML custom | 3 | — | Bilingue de/fr; URL pattern /fr/carriere/offres-d-emploi/[slug]-[id] |
| 4 | **Clinique de Crans-Montana** | [hug.ch/crans-montana/offres-emploi](https://www.hug.ch/crans-montana/offres-emploi) | (via parent) | 2 | 🔁 | Filiale HUG; già coperto via HUG parser |
| 5 | **Clinique romande de réadaptation SuvaCare (CRR), Sion** | [crr-suva.ch/clinique-readaptation/carriere-797.html](https://www.crr-suva.ch/clinique-readaptation/carriere-797.html) | TBD | 4 | — | Subsidiaria Suva ma pagina career indipendente; submission via HR contatto diretto |
| 6 | **Leukerbad Clinic (RZL Rehabilitationszentrum Leukerbad AG)** | [leukerbadclinic.ch/de/page/jobs/](https://leukerbadclinic.ch/de/page/jobs/) | TBD | ? | — | WebFetch 403; possibile bot-block, ispezionare via headless browser |

### VD — Vaud

| # | Ospedale | Career URL | ATS | Jobs | Coverto | Note |
|---|---|---|---|---|---|---|
| 1 | **Biotonus, Clinique Bon-Port SA, Territet** | — | TBD | ? | — | Clinica indipendente wellness/medicina |
| 2 | **Clinique CIC Montreux, Clarens** | [cliniquecic-montreux.ch/fr/emplois](https://www.cliniquecic-montreux.ch/fr/emplois) | HTML custom | ? | — | Gruppo Cliniques CIC Suisse |
| 3 | **Clinique de Genolier** | [swissmedical.net/en/career/job-offers](https://www.swissmedical.net/en/career/job-offers) | (via parent) | ? | 🔁 | Flagship di Swiss Medical Network |
| 4 | **Clinique de La Source, Lausanne** | [emploi.lasource.ch/](https://emploi.lasource.ch/) | Prospective | ? | — | Sottodominio emploi.lasource.ch, pattern Prospective |
| 5 | **Clinique de Montchoisi, Lausanne** | [swissmedical.net/en/career/job-offers](https://www.swissmedical.net/en/career/job-offers) | (via parent) | ? | 🔁 | Parte di Swiss Medical Network dal 2003 |
| 6 | **Clinique la Prairie, Clarens** | [cliniquelaprairie.com/fr/carrieres](https://www.cliniquelaprairie.com/fr/carrieres) | HTML custom | ? | — | Longevity/wellness, indipendente |
| 7 | **EHC Ensemble hospitalier de la Côte, Morges** | [emploi.ehc-vd.ch/fr](https://emploi.ehc-vd.ch/fr) | Prospective | 53 | — | Sottodominio emploi.ehc-vd.ch, pattern Prospective |
| 8 | **Etablissements Hospitaliers du Nord Vaudois - eHnv, Yverdon-les-Bains** | [ehnv.ch/emplois](https://www.ehnv.ch/emplois) | HTML custom | ? | — | 1800 dipendenti su 5 siti |
| 9 | **Fondation Rive-Neuve Soins Palliatifs, Blonay** | [riveneuve.ch/jcms/rivd_7358/fr/emplois](https://www.riveneuve.ch/jcms/rivd_7358/fr/emplois) | Jalios JCMS | ? | — | CMS jcms, applicazione via email rh@riveneuve.ch |
| 10 | **Groupement Hospitalier de l'Ouest Lémanique - GHOL, Nyon** | [ghol.ch/jcms/fr/le-ghol/espace-ghol/carrieres/offres-d-](https://www.ghol.ch/jcms/fr/le-ghol/espace-ghol/carrieres/offres-d-emploi-p_6023.html) | Jalios JCMS | ? | — | CMS jcms (Jalios), ~1000 dipendenti |
| 11 | **Hôpital de Lavaux, Cully** | [hopitaldelavaux.ch/jcms/lav_5237/emplois](https://www.hopitaldelavaux.ch/jcms/lav_5237/emplois) | Jalios JCMS | ? | — | CMS jcms, geriatria/riabilitazione |
| 12 | **Hôpital du Pays d'Enhaut, Château-d'Oex** | [pspe.ch/jcms/lav_5063/fr/offres-d-emploi](https://www.pspe.ch/jcms/lav_5063/fr/offres-d-emploi) | Jalios JCMS | ? | — | Pôle Santé Pays-d'Enhaut, CMS jcms |
| 13 | **Hôpital Intercantonal de la Broye - HIB, Payerne** | [emploi.hopital-broye.ch/](https://emploi.hopital-broye.ch/) | Prospective | ? | — | Sottodominio emploi.hopital-broye.ch, pattern Prospective |
| 14 | **Hôpital Ophtalmique Jules Gonin (Fondation Asile des Aveugles), Lausanne** | [emploi.ophtalmique.ch/](https://emploi.ophtalmique.ch/) | Prospective | ? | — | Sottodominio emploi.ophtalmique.ch, pattern Prospective |
| 15 | **Hôpital Riviera-Chablais - HRC, Vevey** | [emploi.hopitalrivierachablais.ch/fr](https://emploi.hopitalrivierachablais.ch/fr) | Prospective | 7 | — | Sottodominio emploi.X, pattern Prospective; ~2500 dipendenti |
| 16 | **Pôle santé Vallée de Joux, Le Sentier** | [psvj.ch/jcms/c_5303/fr/emplois](https://www.psvj.ch/jcms/c_5303/fr/emplois) | Jalios JCMS | ? | — | CMS jcms, 200 dipendenti |
| 17 | **Réseau Santé Balcon du Jura Vaudois (RSBJ), Ste-Croix** | [rsbj.ch/jcms/rsbj_8733/fr/nos-offres-d-emplois](https://www.rsbj.ch/jcms/rsbj_8733/fr/nos-offres-d-emplois) | Jalios JCMS | ? | — | CMS jcms, applicazione via jobs@rsbj.ch |
| 18 | **Clinique Bois-Bougy, Nyon** | — | TBD | ? | — | Parte di Clinea Suisse (gruppo Emeis) |
| 19 | **Clinique la Lignière, Gland** | [la-ligniere.ch/en/working-at-la-ligniere](https://la-ligniere.ch/en/working-at-la-ligniere) | HTML custom | ? | — | Indipendente avventista, riabilitazione cardiovascolare |
| 20 | **Clinique Valmont, Glion** | [swissmedical.net/en/hospitals/valmont/career](https://www.swissmedical.net/en/hospitals/valmont/career) | (via parent) | ? | 🔁 | Parte di Swiss Medical Network |
| 21 | **Institution de Lavigny** | [ilavigny.ch/emploi/](https://www.ilavigny.ch/emploi/) | HTML custom | ? | — | Neurorehab/epilessia, 860 dipendenti |
| 22 | **Clinique la Métairie, Nyon** | — | TBD | ? | — | Psichiatria, no evidenza chiara di affiliazione SMN |
| 23 | **Fondation de Nant, Corsier-sur-Vevey** | [nant.ch/carrieres/](https://nant.ch/carrieres/) | HTML custom | ? | — | Psichiatria Est Vaudois, ~475 dipendenti |

### GE — Ginevra

| # | Ospedale | Career URL | ATS | Jobs | Coverto | Note |
|---|---|---|---|---|---|---|
| 1 | **Clinique de Carouge, Carouge GE** | [cliniquedecarouge.ch/emploi](https://www.cliniquedecarouge.ch/emploi) | HTML custom | ? | — | Centro interdisciplinare indipendente, pagina emploi statica |
| 2 | **Clinique de la Plaine, Genève** | [laplaine.ch/jobs/](https://laplaine.ch/jobs/) | HTML custom | ? | — | Clinica indipendente, chirurgia ambulatoriale |
| 3 | **Clinique des Grangettes, Chêne-Bougeries** | [hirslanden.ch/fr/clinique-des-grangettes/jobs-carriere.](https://www.hirslanden.ch/fr/clinique-des-grangettes/jobs-carriere.html) | (via parent) | ? | 🔁 | Parte di Hirslanden group — ATS Umantis |
| 4 | **Clinique et Permanence d'Onex** | [gmo.ch/](https://www.gmo.ch/) | HTML custom | ? | — | Groupe Médical d'Onex / Cité générations |
| 5 | **Clinique Générale-Beaulieu, Genève** | [swissmedical.net/en/hospitals/generale-beaulieu/career](https://www.swissmedical.net/en/hospitals/generale-beaulieu/career) | (via parent) | ? | 🔁 | Parte di Swiss Medical Network |
| 6 | **Hôpital de La Tour, Meyrin** | [recrutement.latour.ch/fr](https://recrutement.latour.ch/fr) | Prospective | 15 | — | Sottodominio recrutement.latour.ch, pattern Prospective |
| 7 | **Nouvelle Clinique Vert-Pré, Conches** | — | TBD | ? | — | Clinica privata piccola, no pagina carriere dedicata trovata |
| 8 | **Clinique de Joli-Mont, Genève** | [careers.smartrecruiters.com/HUG](https://careers.smartrecruiters.com/HUG) | (via parent) | ? | 🔁 | Integrata in HUG dal 2016, ATS SmartRecruiters |
| 9 | **Clinique de Maisonneuve, Châtelaine** | — | TBD | ? | — | Ensemble Maisonneuve (riabilitazione), no career page evidente |
| 10 | **Clinique du Grand-Salève, Veyrier** | [grand-saleve.ch/en/vacancies/](https://www.grand-saleve.ch/en/vacancies/) | HTML custom | ? | — | Parte di Clinea Suisse (gruppo Emeis) |
| 11 | **Clinique Les Hauts d'Anières** | — | TBD | ? | — | Riabilitazione indipendente, no career page dedicata |
| 12 | **Clinique Belmont, Genève** | — | TBD | ? | — | Addizioni/disturbi alimentari, candidature via job@cliniquebelmont.ch |

### BS — Basilea Città

| # | Ospedale | Career URL | ATS | Jobs | Coverto | Note |
|---|---|---|---|---|---|---|
| 1 | **Adullam Spital (Gruppe), Basel** | [adullam.ch/stellen-karriere/offene-stellen](https://www.adullam.ch/stellen-karriere/offene-stellen) | Umantis | ? | — | recruitingapp-2562.umantis.com; Basel + Riehen sites |
| 2 | **Merian Iselin Klinik, Basel** | [merianiselin.ch/klinik/jobs/offene-stellen](https://merianiselin.ch/klinik/jobs/offene-stellen) | TBD | 15 | — | Custom-looking online application form; no public ATS branding |
| 3 | **Palliativzentrum Hildegard, Basel** | [pzhi.ch/freie-stellen/](https://www.pzhi.ch/freie-stellen/) | HTML custom | ? | — | Acquired by Bethesda Spital end of 2024; relocated to Bethesda campus in 2025 |
| 4 | **Schmerzklinik Basel** | [swissmedical.net/en/hospitals/schmerzklinik/career](https://www.swissmedical.net/en/hospitals/schmerzklinik/career) | (via parent) | 6 | 🔁 | Part of Swiss Medical Network group |
| 5 | **St. Claraspital, Basel** | [claraspital.ch/de/jobs-und-karriere/jobs-und-bewerbung/](https://www.claraspital.ch/de/jobs-und-karriere/jobs-und-bewerbung/offene-stellen) | Solique | ? | — | Solique ATS (live.solique.ch); spontaneous via stclara.pi-asp.de |
| 6 | **Universitäts-Kinderspital beider Basel (UKBB)** | [stellen.ukbb.ch/](https://stellen.ukbb.ch/) | TBD | 26 | — | Dedicated jobs subdomain; jobs.ukbb.ch is alias landing |
| 7 | **Bethesda Spital, Basel** | [bethesda-spital.ch/de/ueber-uns/karriere/jobs.html](https://www.bethesda-spital.ch/de/ueber-uns/karriere/jobs.html) | Umantis | 13 | — | recruitingapp-2998.umantis.com; includes Brustzentrum + Palliativzentrum Hildegard |
| 8 | **REHAB Basel** | [rehabbasel-career.talent-soft.com/stelle/stellenliste.a](https://rehabbasel-career.talent-soft.com/stelle/stellenliste.aspx) | Talentsoft | 13 | — | Talentsoft (Cegid) ATS |
| 9 | **ZURZACH Care Rehaklinik Basel** | [karriere.zurzachcare.ch/](https://karriere.zurzachcare.ch/) | SAP SF | ? | — | SAP SuccessFactors; filter location=Basel for site-specific jobs |
| 10 | **Klinik Sonnenhalde, Riehen** | [sonnenhalde.ch/de/stellenangebot.html](https://www.sonnenhalde.ch/de/stellenangebot.html) | Umantis | ? | — | recruitingapp-3030.umantis.com; psychiatry + psychotherapy |

### BL — Basilea Campagna

| # | Ospedale | Career URL | ATS | Jobs | Coverto | Note |
|---|---|---|---|---|---|---|
| 1 | **Bruderholzspital (Kantonsspital Baselland)** | [karriere.ksbl.ch/de/offene-stellen/jobs/](https://karriere.ksbl.ch/de/offene-stellen/jobs/) | Umantis | 70 | — | Same KSBL group portal covers Bruderholz, Liestal, Laufen sites |
| 2 | **Ergolz-Klinik, Liestal** | [ergolz-klinik.ch/unsere-klinik/offene-stellen/](https://www.ergolz-klinik.ch/unsere-klinik/offene-stellen/) | HTML custom | 0 | — | Redirects to ergolz.cardiance.com; spontaneous applications via email |
| 3 | **Kantonsspital Baselland (Gruppe), Liestal** | [karriere.ksbl.ch/de/offene-stellen/jobs/](https://karriere.ksbl.ch/de/offene-stellen/jobs/) | Umantis | 70 | — | Group-wide portal (recruitingapp-2748.umantis.com) |
| 4 | **Klinik Arlesheim** | [jobs.dualoo.com/portal/s60emmh3?lang=DE](https://jobs.dualoo.com/portal/s60emmh3?lang=DE) | Dualoo | 40 | — | Dualoo ATS (Swiss); anthroposophic hospital |
| 5 | **PALLIATIVKLINIK IM PARK, Arlesheim** | [palliativklinik.ch/offene-stellen/](https://palliativklinik.ch/offene-stellen/) | HTML custom | 5 | — | Static page with PDF job descriptions |
| 6 | **Praxisklinik Rennbahn, Muttenz** | [rennbahnklinik.ch/offene-stellen](https://www.rennbahnklinik.ch/offene-stellen) | HTML custom | 12 | — | Sports/orthopedic clinic; no detectable third-party ATS |
| 7 | **Spital Laufen (Kantonsspital Baselland)** | [karriere.ksbl.ch/de/offene-stellen/jobs/](https://karriere.ksbl.ch/de/offene-stellen/jobs/) | (via parent) | 70 | 🔁 | Covered by KSBL group portal |
| 8 | **Vista Klinik, Binningen** | [vista.ch/ueber-uns/karriere/](https://vista.ch/ueber-uns/karriere/) | Ostendis | ? | — | Ostendis OJP portal (odm.ostendis.com/ojp/); Binningen jobs mixed with other sites |
| 9 | **Klinik ESTA, Reinach BL** | [suchthilfe.ch/behandlung/esta-klinik-fuer-suchtbehandlu](https://www.suchthilfe.ch/behandlung/esta-klinik-fuer-suchtbehandlung/) | HTML custom | ? | — | Part of Suchthilfe Region Basel; jobs posted on sozjobs.ch / sozialinfo.ch |
| 10 | **Psychiatrie Baselland, Liestal** | [jobs.pbl.ch/](https://jobs.pbl.ch/) | TBD | 30 | — | Pagination 3 pages of ~10 jobs; jobs.ch lists 61 total entries |

---

## 4. Altri cantoni — uncovered (analisi preparativa pendente)

Lista ospedali standalone non ancora coperti in cantoni non-frontaliere prioritari. Career URL/ATS da ricercare in fase 2 (questa lista è il punto di partenza).


### AG — Argovia (29)

- aarReha Klinik Schinznach Rehabilitation, Schinznach Bad _(Riabilitazione)_
- aarReha Schinznach, Klinik Zofingen _(Riabilitazione)_
- Asana Spital Leuggern _(Acuto)_
- Bad Schinznach AG Privat­Klinik Im Park, Schinznach Bad _(Riabilitazione)_
- entero Klinik, Egliswil _(Psichiatria)_
- entero Klinik, Entwöhnung Egliswil _(Psichiatria)_
- entero Klinik, Entwöhnung Niederlenz _(Psichiatria)_
- entero Klinik, Entzug Neuenhof _(Psichiatria)_
- Gesundheitszentrum Fricktal (Gruppe), Rheinfelden _(Acuto)_
- Kantonsspital Baden (Kantonsspital Baden AG) _(Acuto)_
- Kantonsspital Baden AG (Gruppe) _(Acuto)_
- Klinik Barmelweid _(Acuto)_
- Klinik Im Hasel, Gontenschwil _(Psichiatria)_
- Klinik Schützen Rheinfelden _(Psichiatria)_
- Klinik Villa im Park, Rothrist _(Acuto)_
- Kreisspital Muri (Kantonsspital Baden AG) _(Acuto)_
- Psychiatrische Dienste Aargau, Windisch _(Psichiatria)_
- Reha Rheinfelden _(Riabilitazione)_
- Rehaklinik Bellikon _(Riabilitazione)_
- Salina Rehaklinik, Rheinfelden _(Riabilitazione)_
- Spital Laufenburg (Gesundheitszentrum Fricktal) _(Acuto)_
- Spital Rheinfelden (Gesundheitszentrum Fricktal) _(Acuto)_
- Spital Zofingen _(Acuto)_
- Stiftung Spital Muri, Muri AG _(Acuto)_
- ZURZACH Care (Gruppe), Bad Zurzach _(Riabilitazione)_
- ZURZACH Care Klinik für Schlafmedizin Bad Zurzach _(Psichiatria)_
- ZURZACH Care Rehaklinik Bad Zurzach _(Riabilitazione)_
- ZURZACH Care Rehaklinik Baden _(Riabilitazione)_
- ZURZACH Care Rehaklinik Baden-Dättwil _(Riabilitazione)_

### AI — Appenzello I. (1)

- Hofweissbad Klinik im Hof, Weissbad _(Riabilitazione)_

### AR — Appenzello E. (10)

- Augenklinik Dr. med. A. v. Scarpatetti, Teufen AR _(Acuto)_
- Berit Klinik (Gruppe), Speicher _(Acuto)_
- Berit Klinik Rehabilitation & Kur, Niederteufen _(Riabilitazione)_
- Berit Klinik, Speicher _(Acuto)_
- Klinik Gais _(Riabilitazione)_
- Rheinburg-Klinik, Walzenhausen _(Riabilitazione)_
- Spital Herisau (Spitalverbund AR) _(Acuto)_
- Spitalverbund AR Psychiatrisches Zentrum, Herisau _(Psichiatria)_
- Spitalverbund AR, Spitäler Herisau, Heiden (Gruppe) _(Acuto)_
- Spitalverbund AR, Spitäler Herisau, Heiden (Gruppe) _(Psichiatria)_

### BE — Berna (38)

- Berner Reha Zentrum AG Heiligenschwendi _(Riabilitazione)_
- Kinder- und Jugendpsychiatrie, Klink Neuhaus der Universitären Psychiatrischen Dienste Bern (UPD), Ittigen _(Psichiatria)_
- Kinder- und Jugendpsychiatrie, Therapiezentrum Essstörungen der Universitären Psychiatrischen Dienste Bern (UPD), Moosseedorf _(Psichiatria)_
- Klinik Hohmad, Thun _(Acuto)_
- Klinik Schönberg, Gunten _(Riabilitazione)_
- Klinik Selhofen, Burgdorf _(Psichiatria)_
- Klinik SGM Langenthal Psychosomatik, Psychiatrie, Psychotherapie _(Riabilitazione)_
- Klinik Siloah, Gümligen _(Acuto)_
- Klinik Wysshölzli, Herzogenbuchsee _(Psichiatria)_
- Privatklinik Meiringen AG Zentrum für seelische Gesundheit _(Psichiatria)_
- Privatklinik Meiringen, Burnoutstation, Hasliberg Hohfluh _(Psichiatria)_
- Privatklinik Wyss, Münchenbuchsee _(Psichiatria)_
- Psychiatriezentrum Münsingen (PZM) _(Psichiatria)_
- Psychiatriezentrum Münsingen (PZM), Psychiatrie Biel, Kriseninterventionsstation _(Psichiatria)_
- Psychiatriezentrum Münsingen, PZM (Gruppe) _(Psichiatria)_
- Regionalspital Emmental AG (Gruppe), Burgdorf _(Acuto)_
- Regionalspital Emmental AG (Gruppe), Burgdorf _(Psichiatria)_
- Regionalspital Emmental AG, Alterspsychiatrie Burgdorf _(Psichiatria)_
- Regionalspital Emmental AG, Krisenintervention Burgdorf _(Psichiatria)_
- Reha- und Kurklinik EDEN, Oberried am Brienzersee _(Riabilitazione)_
- Reha-Pflegeklinik Eden, Ringgenberg BE _(Riabilitazione)_
- Rehaklinik Hasliberg, Hasliberg Hohfluh _(Riabilitazione)_
- Soteria Bern _(Psichiatria)_
- Spital Burgdorf (Regionalspital Emmental AG) _(Acuto)_
- Spital Frutigen (Spitäler FMI AG) _(Acuto)_
- Spital Interlaken (Spitäler FMI AG), Unterseen _(Acuto)_
- Spital Langenthal (SRO Spital Region Oberaargau AG) _(Acuto)_
- Spital Langnau (Regionalspital Emmental AG), Langnau im Emmental _(Acuto)_
- Spitäler FMI Frutigen Meiringen Interlaken (Gruppe), Unterseen _(Acuto)_
- Spitäler FMI Frutigen Meiringen Interlaken (Gruppe), Unterseen _(Psichiatria)_
- SRO Spital Region Oberaargau AG (Gruppe), Langenthal _(Acuto)_
- SRO Spital Region Oberaargau AG (Gruppe), Langenthal _(Psichiatria)_
- Stiftung Diaconis Palliative Care, Bern _(Acuto)_
- südhang Klinik für Suchttherapien, Kirchlindach _(Psichiatria)_
- Universitäre Psychiatrische Dienste (UPD), Gemeindepsychiatrisches Zentrum Bern West _(Psichiatria)_
- Universitäre Psychiatrische Dienste Bern (UPD), Ostermundigen _(Psichiatria)_
- Universitätsklinik für Psychiatrie und Psychotherapie (UPD), Bern _(Psichiatria)_
- Zentrum für Psychiatrie und Psychotherapie Langenthal (SRO Spital Region Oberaargau AG) _(Psichiatria)_

### FR — Friburgo (8)

- HFR - Hôpital fribourgeois (Gruppe) _(Acuto)_
- HFR - Hôpital fribourgeois (Site Hôpital de Fribourg) _(Acuto)_
- HFR - Hôpital fribourgeois (Site Hôpital de Riaz) _(Acuto)_
- Hôpital Intercantonal de la Broye - HIB (site Estavayer-le-Lac) _(Riabilitazione)_
- Hôpital Jules Daler, Fribourg _(Acuto)_
- Réseau fribourgeois de santé mentale - RFSM Centre de soins hospitaliers, Fribourg, Villars-sur-Glâne _(Psichiatria)_
- Réseau fribourgeois de santé mentale - RFSM Centre de soins hospitaliers, Marsens _(Psichiatria)_
- Spital Tafers (HFR - Hôpital fribourgeois) _(Acuto)_

### GL — Glarona (3)

- Kantonsspital Glarus _(Psichiatria)_
- ZURZACH Care Rehaklinik Braunwald _(Riabilitazione)_
- ZURZACH Care Rehaklinik Glarus _(Riabilitazione)_

### JU — Giura (2)

- Clinique le Noirmont, Le Noirmont _(Riabilitazione)_
- Hôpital du Jura (Gruppe), Porrentruy _(Acuto)_

### LU — Lucerna (9)

- Cereneo AG Neurorehabilitationsklinik, Vitznau _(Riabilitazione)_
- Cereneo Hertenstein, Weggis _(Riabilitazione)_
- Jugendpsychiatrische Therapiestationen (LUPS), Kriens _(Psichiatria)_
- Klinik Luzern (LUPS) _(Psichiatria)_
- Klinik St. Urban (LUPS) _(Psichiatria)_
- Luzerner Psychiatrie, LUPS (Gruppe), St. Urban _(Psichiatria)_
- Schweizer Paraplegiker-Zentrum Nottwil _(Acuto)_
- Therapiezentrum Meggen _(Psichiatria)_
- ZURZACH Care Rehaklinik Sonnmatt Luzern _(Riabilitazione)_

### NE — Neuchâtel (4)

- Clinique Montbrillant, La Chaux-de-Fonds _(Acuto)_
- Clinique Volta, La Chaux-de-Fonds _(Acuto)_
- CNP Centre Neuchâtelois de psychiatrie (Gruppe), Marin-Epagnier _(Psichiatria)_
- Réseau Hospitalier Neuchâtelois RHNe (Gruppe) _(Acuto)_

### NW — Nidvaldo (1)

- Bürgenstock Hotels AG - Waldhotel Health & Medical Excellence Rehabilitationsklinik, Obbürgen _(Acuto)_

### OW — Obvaldo (2)

- Kantonsspital Obwalden, Sarnen _(Acuto)_
- Luzerner Psychiatrie (LUPS), Klinik Sarnen _(Psichiatria)_

### SG — San Gallo (21)

- Berit Klinik Alkoholkurzzeittherapie PSA Wattwil _(Psichiatria)_
- Berit Klinik Goldach _(Acuto)_
- Berit Klinik Wattwil _(Acuto)_
- Clinic Bad Ragaz _(Riabilitazione)_
- Geriatrische Klinik St. Gallen _(Acuto)_
- HOCH Health Ostschweiz (Gruppe), St. Gallen _(Acuto)_
- Klinik Sonnenhof Kinder­ & Jugendpsychiatrisches Zentrum, Ganterschwil _(Psichiatria)_
- Kliniken Valens (Gruppe) _(Riabilitazione)_
- Ostschweizer Kinderspital, St. Gallen _(Acuto)_
- Psychiatrie St. Gallen Nord, Krisenintervention St. Gallen _(Psichiatria)_
- Psychiatrie St. Gallen, Klinik Wil, Wil SG _(Psichiatria)_
- Psychiatrie-Dienste Süd, Pfäfers _(Psichiatria)_
- Rosenklinik, Rapperswil-Jona _(Acuto)_
- Spital Altstätten (HOCH) _(Acuto)_
- Spital Grabs (HOCH) _(Acuto)_
- Spital Linth (HOCH), Uznach _(Acuto)_
- Spital Wil (HOCH), Wil (SG) _(Acuto)_
- Spitalregion Fürstenland Toggenburg (Gruppe), Wil SG _(Acuto)_
- Spitalregion Rheintal Werdenberg Sarganserland (Gruppe), Rebstein _(Acuto)_
- Therapiestation Romerhuus, Ostschweizer Kinderspital, St. Gallen _(Psichiatria)_
- Thurklinik, Goldach _(Acuto)_

### SH — Sciaffusa (5)

- Kantonsspital Schaffhausen (Spitäler Schaffhausen) _(Acuto)_
- Kantonsspital Schaffhausen (Spitäler Schaffhausen) _(Riabilitazione)_
- Psychiatriezentrum Breitenau (Spitäler Schaffhausen) _(Psichiatria)_
- Spitäler Schaffhausen (Gruppe) _(Acuto)_
- Spitäler Schaffhausen (Gruppe) _(Riabilitazione)_

### SO — Soletta (1)

- Pallas Kliniken AG (Gruppe), Olten _(Acuto)_

### SZ — Svitto (4)

- AMEOS Seeklinikum Brunnen _(Psichiatria)_
- Spital Schwyz _(Acuto)_
- Spital Schwyz _(Riabilitazione)_
- Vista Augenklinik Pfäffikon SZ _(Acuto)_

### TG — Turgovia (10)

- Clienia Littenheid _(Psichiatria)_
- Herz-­Neuro­-Zentrum Bodensee, Münsterlingen _(Acuto)_
- Klinik Aadorf AG Klinische Psychotherapie _(Psichiatria)_
- Klinik Schloss Mammern _(Riabilitazione)_
- Klinik Seeschau, Kreuzlingen _(Acuto)_
- Perlavita, Berlingen _(Riabilitazione)_
- Rehaklinik Dussnang _(Riabilitazione)_
- Rehaklinik Zihlschlacht AG Neurologisches Rehabilitationszentrum _(Acuto)_
- Tertianum Neutal Berlingen _(Riabilitazione)_
- Venenklinik Bellevue, Kreuzlingen _(Acuto)_

### ZG — Zugo (4)

- Klinik Adelheid, Unterägeri _(Riabilitazione)_
- Klinik Meissenberg, Zug _(Psichiatria)_
- Triaplus AG (vorm. Psychiatrische Klinik Zugersee), Oberwil b. Zug _(Psichiatria)_
- Zuger Kantonsspital, Baar _(Acuto)_

### ZH — Zurigo (34)

- Adus Medica, Dielsdorf _(Acuto)_
- Clienia Schlössli, Oetwil am See _(Psichiatria)_
- Eulachklinik, Winterthur _(Acuto)_
- Forel Klinik, Ellikon an der Thur _(Psichiatria)_
- GZO Spital Wetzikon _(Acuto)_
- Integrierte Psychiatrie Winterthur - Zürcher Unterland (ipw) _(Psichiatria)_
- Integrierte Psychiatrie Winterthur - Zürcher Unterland (ipw), Kriseninterventionszentrum (KIZ) _(Psichiatria)_
- Kinderstation Brüschhalde der Psychiatrischen Universitätsklinik Zürich (PUK), Männedorf _(Psichiatria)_
- Klinik Lengg, Zürich _(Acuto)_
- Klinik Pyramide am See, Zürich _(Acuto)_
- Klinik Susenberg, Zürich _(Acuto)_
- Klinik Tiefenbrunnen, Zollikon _(Acuto)_
- Limmatklinik, Zürich _(Acuto)_
- Modellstation SOMOSA, Winterthur _(Psichiatria)_
- Privatklinik Hohenegg, Meilen _(Psichiatria)_
- Privatklinik Lindberg, Winterthur _(Acuto)_
- Psychiatrische Universitätsklinik Zürich (PUK) _(Psichiatria)_
- RehaClinic Limmattal, Schlieren _(Riabilitazione)_
- Sanatorium Kilchberg, Kilchberg ZH _(Psichiatria)_
- Schulthess Klinik, Zürich _(Acuto)_
- Spital Affoltern, Affoltern am Albis _(Psichiatria)_
- Spital Bülach _(Acuto)_
- Spital Zollikerberg _(Acuto)_
- Suchtfachklinik Zürich (Vormals Suchtbehandlung Frankental) _(Psichiatria)_
- Sune-­Egge, Zürich _(Acuto)_
- Universitäts-Kinderspital Zürich _(Acuto)_
- Universitätsklinik Balgrist, Zürich _(Acuto)_
- Universitätsklinik Balgrist, Zürich _(Riabilitazione)_
- Uroviva Klinik für Urologie, Bülach _(Acuto)_
- Vista Diagnostics, Zürich _(Acuto)_
- Zentrum für Integrative Psychiatrie der PUK Zürich, Rheinau _(Psichiatria)_
- Zürcher RehaZentrum Wald, Wald ZH _(Riabilitazione)_
- ZURZACH Care Rehaklinik Kilchberg, Kilchberg ZH _(Riabilitazione)_
- ZURZACH Care Rehaklinik Zollikerberg _(Riabilitazione)_

---

## 5. Note tecniche per implementazione crawler

### ATS riconosciuti — pattern condivisi

- **Prospective** — Endpoint API: ohws.prospective.ch/public/v1/medium/{ID}/jobs — riusare pattern KSGR/Lindenhof
- **Umantis** — recruitingapp-{ID}.umantis.com/Vacancies/ — riusare pattern Inselspital/KSA
- **SAP SF** — SAP SF career site — riusare pattern Hirslanden/KSSG
- **SmartRecruiters** — api.smartrecruiters.com/v1/companies/{co}/postings — riusare pattern HUG/SMN
- **softgarden** — onlyfy/softgarden JSON API — nuovo template
- **Dualoo** — Dualoo Swiss ATS — jobs.dualoo.com/portal/X
- **Ostendis** — Ostendis OJP — odm.ostendis.com/ojp/ — multi-tenant
- **Solique** — Solique ATS Swiss — live.solique.ch
- **Talentsoft** — Talentsoft/Cegid — career portal aspx
- **Jalios JCMS** — CMS Jalios JCMS — HTML statico, pattern condiviso VD
- **HTML custom** — HTML scraping dedicato
- **TBD** — Da identificare con browser headless

### Pattern URL Prospective verificato (Suisse romande)

Molti ospedali svizzeri romandi usano Prospective con sottodominio `emploi.{domain}` o `recrutement.{domain}`. Esempi confermati:

- `emploi.lasource.ch` (Clinique La Source)
- `emploi.ehc-vd.ch` (EHC Côte)
- `emploi.hopitalrivierachablais.ch` (HRC)
- `emploi.hopital-broye.ch` (HIB)
- `emploi.ophtalmique.ch` (Jules Gonin)
- `recrutement.latour.ch` (Hôpital de La Tour)

Il parser `ksgr-job-parser.mjs` usa già `ohws.prospective.ch/public/v1/medium/{ID}` — estrarre l'ID dalla pagina HTML del sottodominio (cerca `medium=` o `mandantId=`) e riusare il template.

### Bot-blocked sites (need browser headless)

- `leukerbadclinic.ch/de/page/jobs/` — 403 al WebFetch
- `clinica-holistica.ch/de/offene-stellen` — 403 al WebFetch
- `cseb.ch/das-cseb/offene-stellen/` — 404 al WebFetch ma esiste in browser

Per questi: usare Playwright/headless invece di fetch diretto, o ricavare dati da mirror (sozjobs.ch, hotelcareer.com).

### Caso speciale: Cardiocentro Ticino → EOC

Cardiocentro è integrato in EOC dal 2021. `cardiocentro.org/it/carriere2` redirige a `eoc.ch/it/lavoro.html`. **Verificare che il parser EOC esistente intercetti effettivamente le offerte Cardiocentro** — se le job entries hanno location separata, va aggiunta nella whitelist EOC. File: `scripts/lib/eoc-job-parser.mjs`.

### Caso speciale: Clinique CIC (Saxon + Montreux)

Piccolo gruppo (2 cliniche). Career page custom HTML ma jobs effettivi pubblicati su **jobup.ch sotto "Clinique CIC Suisse SA"** — più affidabile scrapare jobup.ch che il sito proprietario.

### Caso speciale: Vista Klinik + Ostendis

Vista Klinik (Binningen BL) usa Ostendis OJP (`odm.ostendis.com/ojp/`). Ostendis è multi-tenant — un parser potrebbe coprire più ospedali. **Investigare quanti altri usano Ostendis** prima di implementare.

### Caso speciale: ti.ch/concorsi (Clinica psichiatrica cantonale Mendrisio)

L'OSC (DSS Cantone Ticino) pubblica i bandi sul portale concorsi cantonale, NON sul sito OSC. Riferimento: `update-canton-valais-jobs.mjs`. Costruire `update-canton-ticino-jobs.mjs` filtrando per ente="Organizzazione Sociopsichiatrica Cantonale".

### Cluster Clinea Suisse / Emeis

Diverse cliniche francofone (Grand-Salève VE, Bois-Bougy VD, Les Hauts d'Anières GE) sembrano far parte del gruppo francese **Emeis (ex-Orpea)** sotto brand "Clinea Suisse". **Verificare se esiste un career portal centralizzato Clinea/Emeis** prima di implementare parser separati.

### Cluster Kliniken Valens (riabilitazione SG/GR/ZH)

Il Zürcher RehaZentrum Davos è ora parte di Kliniken Valens (`valens.ch/karriere`). Costruire **un parser Valens** che copra le sedi Valens, Walenstadtberg, Walzenhausen, Davos Clavadel.

---

## 6. Prossimi passi

1. **Validazione utente** della lista priority §3 → decidere ordine implementazione (Tier 1 prima)
2. **Ricerca career URL per altri cantoni (§4)** — replicare metodologia batch agent per i 186 ospedali non-priority
3. **Identificare gruppi nascosti** — Clinea Suisse/Emeis, VAMED/Vitrea, Kliniken Valens — un parser per il gruppo copre 3-5 sedi
4. **Verificare integrazione Cardiocentro nel parser EOC** (test fixture su `tests/parsers/eoc/`)
5. **Implementare template Jalios JCMS** — alto ROI (6 ospedali VD in un colpo)
6. **Refactoring Prospective**: estrarre `prospective-job-parser-template.mjs` parametrizzato su `mediumId` + slug company

---

_File generato automaticamente 2026-05-19. Sorgenti:_
- `data/swiss-hospitals.json` (welches-spital.ch scrape 2026-05-10)
- `scripts/lib/*-job-parser.mjs` (parser esistenti inventoriati)
- WebSearch/WebFetch batch su career pages (80 ospedali priority)
