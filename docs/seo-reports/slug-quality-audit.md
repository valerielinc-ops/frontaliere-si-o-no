# Job Slug Translation Quality Audit

_Generated: 2026-04-21T15:53:22.086Z_

## Summary

- Jobs scanned: **2410**
- Locales audited: **en, de, fr**
- Jobs with at least one flag: **183**

| Flag | Count |
|------|------:|
| Brand-translated slug (brand name altered in localized slug) | 5 |
| Identical slug across locales (untranslated copy) | 275 |
| Literal/mangled translation (heuristic dictionary hit) | 10 |

## 1. Brand-translated slugs

The protected brand appeared in the Italian slug but is missing (or altered) in the localized slug. **`restoreProtectedBrands()` in the AI pipeline should already prevent this** — any hit here is a regression.

| Job ID | Locale | Brand | IT slug | Localized slug | Company |
|--------|--------|-------|---------|----------------|---------|
| `company-rm634f` | de | timberland | `verkauferin-flexibel-teilzeit-o-vollzeit-napapijri-landquart-fashion-outlet-vf-international-the-north-face-timberland-emea-che-landquart-ou-rm634f` | `verkauferin-flexibel-teilzeit-oder-vollzeit-napapijri-landquart-fashion-outlet-vf-international-the-north-face-timberlan` | VF International (The North Face, Timberland) |
| `company-rm634f` | fr | timberland | `verkauferin-flexibel-teilzeit-o-vollzeit-napapijri-landquart-fashion-outlet-vf-international-the-north-face-timberland-emea-che-landquart-ou-rm634f` | `vendeur-flexible-a-temps-partiel-ou-a-temps-plein-napapijri-landquart-fashion-outlet-vf-international-the-north-face-tim` | VF International (The North Face, Timberland) |
| `capri-holdings-ac474361024f` | en | michael-kors | `assistant-manager-full-time-sede-capri-holdings-michael-kors-versace-graubunden` | `assistant-manager-full-time-landquart-capri-holdings` | Capri Holdings (Michael Kors / Versace) |
| `capri-holdings-1eaaf12ee666` | en | michael-kors | `vendite-associate-20-terreno-capri-holdings-michael-kors-versace-graubunden` | `sales-associate-20-landquart-capri-holdings` | Capri Holdings (Michael Kors / Versace) |
| `capri-holdings-c2478bfc8995` | en | michael-kors | `vendite-associate-50-terreno-capri-holdings-michael-kors-versace-graubunden` | `sales-associate-50-landquart-capri-holdings` | Capri Holdings (Michael Kors / Versace) |

## 2. Identical slugs across locales

The localized slug is byte-identical to the Italian slug. Likely cause: translation fell back to source, or slugify produced the same shape for both languages.

| Job ID | Locale | Slug | Company |
|--------|--------|------|---------|
| `grand-hotel-kronenhof-4b5ac4c16a6d` | en | `assistant-reservations-manager-m-w-d-grand-hotel-kronenhof-pontresina` | Grand Hotel Kronenhof |
| `kulm-hotel-b44f164f0f7d` | en | `chef-de-rang-m-w-d-kulm-hotel-st-moritz` | Kulm Hotel St. Moritz |
| `kulm-hotel-b44f164f0f7d` | de | `chef-de-rang-m-w-d-kulm-hotel-st-moritz` | Kulm Hotel St. Moritz |
| `kulm-hotel-b44f164f0f7d` | fr | `chef-de-rang-m-w-d-kulm-hotel-st-moritz` | Kulm Hotel St. Moritz |
| `grand-hotel-kronenhof-ff98dc92419c` | en | `commis-de-cuisine-m-w-d-grand-hotel-kronenhof-pontresina` | Grand Hotel Kronenhof |
| `grand-hotel-kronenhof-ff98dc92419c` | de | `commis-de-cuisine-m-w-d-grand-hotel-kronenhof-pontresina` | Grand Hotel Kronenhof |
| `grand-hotel-kronenhof-ff98dc92419c` | fr | `commis-de-cuisine-m-w-d-grand-hotel-kronenhof-pontresina` | Grand Hotel Kronenhof |
| `grand-hotel-kronenhof-b1168a375ad7` | en | `commis-de-bar-m-w-d-kulm-hotel-st-moritz-st-moritz` | Kulm Hotel St. Moritz |
| `grand-hotel-kronenhof-b1168a375ad7` | de | `commis-de-bar-m-w-d-kulm-hotel-st-moritz-st-moritz` | Kulm Hotel St. Moritz |
| `grand-hotel-kronenhof-b1168a375ad7` | fr | `commis-de-bar-m-w-d-kulm-hotel-st-moritz-st-moritz` | Kulm Hotel St. Moritz |
| `kulm-hotel-49812bd74206` | de | `demi-chef-de-partie-breakfast-m-w-d-kulm-hotel-st-moritz` | Kulm Hotel St. Moritz |
| `kulm-hotel-49812bd74206` | fr | `demi-chef-de-partie-breakfast-m-w-d-kulm-hotel-st-moritz` | Kulm Hotel St. Moritz |
| `afry-aca102c6d39e` | en | `geologo-junior-f-m-d-80-100-cantiere-n2-secondo-tubo-del-san-gottardo-ad-airolo-afry-airolo` | AFRY |
| `afry-aca102c6d39e` | de | `geologo-junior-f-m-d-80-100-cantiere-n2-secondo-tubo-del-san-gottardo-ad-airolo-afry-airolo` | AFRY |
| `afry-aca102c6d39e` | fr | `geologo-junior-f-m-d-80-100-cantiere-n2-secondo-tubo-del-san-gottardo-ad-airolo-afry-airolo` | AFRY |
| `kanton-gr-4164cfd85092` | fr | `hr-controller-in-kantonale-verwaltung-graubunden-chur` | Kantonale Verwaltung Graubünden |
| `hilcona-4e4a95804e43` | de | `anlagenfuehrer-anlagenfuehrerin-efz-2026-bell-schweiz-ag-zell` | Bell Schweiz AG |
| `hilcona-915cc09e9bac` | de | `application-manager-managerin-hilcona-basel` | Bell Schweiz AG |
| `hilcona-915cc09e9bac` | fr | `application-manager-managerin-hilcona-basel` | Bell Schweiz AG |
| `hilcona-964ba49b08d9` | de | `ausbildungsverantwortlicher-ausbildungsverantwortliche-logistik-bell-schweiz-ag-oensingen` | Bell Schweiz AG |
| `hilcona-84e0b5dc2d40` | fr | `auszubildende-industriekaufleute-m-w-d-mit-zusatzqualifikation-internationales-wirtschaftsmanagement-hugli-nahrungsmitte` | Hügli Nahrungsmittel GmbH |
| `hilcona-88702a86a172` | en | `betriebselektriker-betriebselektrikerin-neubau-oensingen-bell-schweiz-ag-oensingen` | Bell Schweiz AG |
| `hilcona-19a6b73a6fa0` | en | `betriebselektrikerin-betriebselektriker-100-bell-schweiz-ag-zell` | Bell Schweiz AG |
| `hilcona-cb3ca529de5f` | en | `betriebsmechaniker-betriebsmechanikerin-neubau-oensingen-bell-schweiz-ag-oensingen` | Bell Schweiz AG |
| `hilcona-db2426faa210` | de | `betriebsmechanikerin-betriebsmechaniker-fleischgewinnung-100-bell-schweiz-ag-zell` | Bell Schweiz AG |
| `hilcona-1a966e72b7f9` | en | `culinary-advisor-im-foodservice-deutschland-m-w-d-hilcona-leinfelden-echterdingen` | Hilcona Feinkost GmbH |
| `hilcona-1a966e72b7f9` | de | `culinary-advisor-im-foodservice-deutschland-m-w-d-hilcona-leinfelden-echterdingen` | Hilcona Feinkost GmbH |
| `hilcona-1a966e72b7f9` | fr | `culinary-advisor-im-foodservice-deutschland-m-w-d-hilcona-leinfelden-echterdingen` | Hilcona Feinkost GmbH |
| `hilcona-e97bab90a4d1` | de | `customer-marketing-specialist-food-service-100-m-w-d-hilcona-steinach` | Hügli Nährmittel AG |
| `hilcona-e97bab90a4d1` | fr | `customer-marketing-specialist-food-service-100-m-w-d-hilcona-steinach` | Hügli Nährmittel AG |
| `hilcona-5852a3674ac2` | en | `in-100-eisberg-ag-dallikon` | Eisberg AG |
| `hilcona-060564b0e006` | de | `fleischer-maschinenbediener-m-w-d-bell-deutschland-gmbh-co-kg-edewecht` | Bell Deutschland GmbH & Co. KG |
| `hilcona-8af1a4d49917` | de | `fleischfachassistent-fleischfachassistentin-eba-2026-bell-schweiz-ag-oensingen` | Bell Schweiz AG |
| `hilcona-8dd735d84b3a` | de | `fleischfachmann-fleischfachfrau-efz-2026-bell-schweiz-ag-oensingen` | Bell Schweiz AG |
| `hilcona-9e514f456c93` | de | `fleischfachmann-fleischfachfrau-efz-2026-bell-schweiz-ag-basel` | Bell Schweiz AG |
| `hilcona-ea2a52b21e62` | de | `fleischfachmann-fleischfachfrau-portionierung-bell-schweiz-ag-oensingen` | Bell Schweiz AG |
| `hilcona-f78b66fd13e9` | de | `fleischfachmann-fleischfachfrau-schlachtbetrieb-bell-schweiz-ag-oensingen` | Bell Schweiz AG |
| `hilcona-8843a4617751` | de | `fleischfachmann-fleischfachfrau-zerlegerei-bell-schweiz-ag-oensingen` | Bell Schweiz AG |
| `hilcona-370c6b5a9d8a` | en | `ict-supporter-supporterin-hilcona-basel` | Bell Schweiz AG |
| `hilcona-370c6b5a9d8a` | fr | `ict-supporter-supporterin-hilcona-basel` | Bell Schweiz AG |
| `hilcona-11abbd3d0f43` | de | `ict-system-engineer-client-services-hilcona-basel` | Bell Schweiz AG |
| `hilcona-11abbd3d0f43` | fr | `ict-system-engineer-client-services-hilcona-basel` | Bell Schweiz AG |
| `hilcona-8a03a251215c` | de | `industriemechaniker-schlosser-m-w-d-suddeutsche-truthahn-ag-ampfing` | Süddeutsche Truthahn AG |
| `hilcona-d4930d62d3df` | en | `key-account-manager-retail-at-80-100-hilcona-schaan` | Hilcona AG |
| `hilcona-d4930d62d3df` | de | `key-account-manager-retail-at-80-100-hilcona-schaan` | Hilcona AG |
| `hilcona-d4930d62d3df` | fr | `key-account-manager-retail-at-80-100-hilcona-schaan` | Hilcona AG |
| `hilcona-6875ac2fb9be` | de | `produktionsmitarbeiter-m-w-d-hubers-landhendl-gmbh-pfaffstatt` | Hubers Landhendl GmbH |
| `hilcona-2c0717df219c` | en | `spezialist-operational-excellence-topx-lean-management-m-w-d-hilcona-harkebrugge` | Bell Deutschland GmbH & Co. KG |
| `hilcona-2c0717df219c` | de | `spezialist-operational-excellence-topx-lean-management-m-w-d-hilcona-harkebrugge` | Bell Deutschland GmbH & Co. KG |
| `hilcona-96218584d31c` | en | `technischer-allrounder-technische-allrounderin-facility-management-hilcona-schaan` | Hilcona AG |
| `hilcona-96218584d31c` | de | `technischer-allrounder-technische-allrounderin-facility-management-hilcona-schaan` | Hilcona AG |
| `marriott-e1c6e3f70c85` | en | `night-ird-chef-de-rang-room-service-winter-26-27-w-verbier-marriott-verbier` | Marriott International |
| `marriott-e1c6e3f70c85` | de | `night-ird-chef-de-rang-room-service-winter-26-27-w-verbier-marriott-verbier` | Marriott International |
| `marriott-a882cb0654a1` | en | `storekeeper-winter-26-27-w-verbier-marriott-verbier` | Marriott International |
| `marriott-7398350e5835` | en | `waiter-tress-brasserie-u-yama-winter-26-27-w-verbier-marriott-verbier` | Marriott International |
| `marriott-0015a8d795df` | en | `welcome-ambassador-bellboy-winter-26-27-w-verbier-marriott-verbier` | Marriott International |
| `rapelli-8201a0349335` | en | `buyer-ingredienti-trade-100-rapelli-stabio` | Rapelli - ORIOR Food AG |
| `rapelli-bdc3322ac1f6` | en | `manutentore-maintenance-technician-100-rapelli-stabio` | Rapelli - ORIOR Food AG |
| `rapelli-59c1bdb72841` | en | `supply-chain-planner-100-rapelli-stabio` | Rapelli - ORIOR Food AG |
| `rapelli-9f442deed99b` | fr | `tecnologo-alimentare-100-rapelli-stabio` | Rapelli - ORIOR Food AG |
| `ems-chemie-822dded89ead` | de | `prozessingenieur-betriebsentwicklung-m-w-d-100-ems-chemie-domat-ems` | EMS-Chemie AG |
| `ems-chemie-822dded89ead` | fr | `prozessingenieur-betriebsentwicklung-m-w-d-100-ems-chemie-domat-ems` | EMS-Chemie AG |
| `ems-chemie-dc1a28e8e6ec` | en | `sap-basis-administrator-m-w-d-100-ems-chemie-domat-ems` | EMS-Chemie AG |
| `ems-chemie-dc1a28e8e6ec` | fr | `sap-basis-administrator-m-w-d-100-ems-chemie-domat-ems` | EMS-Chemie AG |
| `denner-ded67555315e` | de | `filialleiter-in-denner-basel` | Denner |
| `denner-a2b4c921eb6b` | en | `product-manager-einkauf-nearfood-w-m-d-denner` | Denner |
| `denner-b68b26027566` | en | `stv-branch-manager-in-denner-basel` | Denner |
| `denner-bb75bf17e32f` | en | `verkaufer-in-denner-rubigen` | Denner |
| `denner-bb75bf17e32f` | de | `verkaufer-in-denner-rubigen` | Denner |
| `denner-bb75bf17e32f` | fr | `verkaufer-in-denner-rubigen` | Denner |
| `prada-b8ab80bfb2e1` | en | `prada-store-manager-zurich-prada-group-zurich` | Prada Group |
| `prada-b8ab80bfb2e1` | de | `prada-store-manager-zurich-prada-group-zurich` | Prada Group |
| `ruag-ag-72a7d976575e` | en | `teamlead-equipment-disposal-100-w-m-d-ruag-ag-thun` | RUAG AG |
| `ruag-ag-72a7d976575e` | de | `teamlead-equipment-disposal-100-w-m-d-ruag-ag-thun` | RUAG AG |
| `laderach-c8e2a5c55fa8` | en | `promoter-40-60-chocolaterie-bahnhofstrasse-zh-w-m-d-laderach-zurich` | Läderach (Schweiz) AG |
| `laderach-c8e2a5c55fa8` | de | `promoter-40-60-chocolaterie-bahnhofstrasse-zh-w-m-d-laderach-zurich` | Läderach (Schweiz) AG |
| `laderach-c8e2a5c55fa8` | fr | `promoter-40-60-chocolaterie-bahnhofstrasse-zh-w-m-d-laderach-zurich` | Läderach (Schweiz) AG |
| `laderach-40b5aa8a43b6` | en | `harrods-30hr-sales-associate-laderach-england` | Läderach (Schweiz) AG |
| `laderach-9e95d9b01d40` | en | `full-stack-developer-business-solutions-erp-w-m-d-laderach-bilten` | Läderach (Schweiz) AG |
| `laderach-9e95d9b01d40` | de | `full-stack-developer-business-solutions-erp-w-m-d-laderach-bilten` | Läderach (Schweiz) AG |
| `laderach-9e95d9b01d40` | fr | `full-stack-developer-business-solutions-erp-w-m-d-laderach-bilten` | Läderach (Schweiz) AG |
| `lonza-17769db32156` | en | `manufacturing-manager-operations-usp-lonza-ch` | Lonza |
| `lonza-17769db32156` | fr | `manufacturing-manager-operations-usp-lonza-ch` | Lonza |
| `lonza-b4558804df92` | en | `operator-senior-operator-lonza-ch` | Lonza |
| `lonza-1403fab200e4` | en | `senior-qa-specialist-supplier-management-80-100-m-f-d-lonza-ch` | Lonza |
| `company-x29n3h` | de | `levatrice-ostetrica-eoc-ente-ospedaliero-cantonale-bellinzona` | EOC – Ente Ospedaliero Cantonale |
| `allianz-suisse-673166e2ef7b` | de | `allianz-bewerbermanagement-allianz-suisse-region-graubunden` | Allianz Suisse |
| `tschuggen-f6bf7211a6a1` | en | `night-auditor-m-w-d-wintersaison-2026-2027-tschuggen-ch` | Tschuggen Collection |
| `tschuggen-f6bf7211a6a1` | de | `night-auditor-m-w-d-wintersaison-2026-2027-tschuggen-ch` | Tschuggen Collection |
| `tally-weijl-6dfb4331c1aa` | en | `fitting-models-tally-weijl-basel` | TALLY WEiJL |
| `tally-weijl-d34e79917e48` | en | `operations-intern-tally-weijl-basel` | TALLY WEiJL |
| `tally-weijl-d34e79917e48` | de | `operations-intern-tally-weijl-basel` | TALLY WEiJL |
| `tally-weijl-d34e79917e48` | fr | `operations-intern-tally-weijl-basel` | TALLY WEiJL |
| `tally-weijl-61bd4a2ae156` | en | `senior-denim-designer-tally-weijl-basel` | TALLY WEiJL |
| `tally-weijl-61bd4a2ae156` | de | `senior-denim-designer-tally-weijl-basel` | TALLY WEiJL |
| `tally-weijl-61bd4a2ae156` | fr | `senior-denim-designer-tally-weijl-basel` | TALLY WEiJL |
| `davos-klosters-bergbahnen-04875753134f` | en | `head-of-mountain-plaza-hotel-party-davos-klosters-bergbahnen-ag-davos` | Davos Klosters Bergbahnen AG |
| `davos-klosters-bergbahnen-c34722391740` | en | `chef-de-service-club-hotel-davos-klosters-bergbahnen-davos` | Davos Klosters Bergbahnen AG |
| `davos-klosters-bergbahnen-c34722391740` | de | `chef-de-service-club-hotel-davos-klosters-bergbahnen-davos` | Davos Klosters Bergbahnen AG |
| `davos-klosters-bergbahnen-c34722391740` | fr | `chef-de-service-club-hotel-davos-klosters-bergbahnen-davos` | Davos Klosters Bergbahnen AG |
| _…and 175 more_ | | | |

## 3. Literal / mangled translations

The localized slug contains a token from the heuristic "red flag" dictionary (e.g. `expediter`, `beschleuniger`). These are almost always over-translations of Italian role names that produced nonsensical local equivalents.

| Job ID | Locale | Hit | Localized slug | IT slug |
|--------|--------|-----|----------------|---------|
| `tsmg-a2d608938d5a` | fr | le-suisse | `testeur-de-conversations-vocales-ia-locuteur-natif-italien-variante-regionale-suisse-tsmg-bellinzona` | `tester-conversazioni-vocali-ai-madrelingua-italiana-variante-regionale-svizzera-tsmg-bellinzona` |
| `tsmg-024bd327dfe2` | fr | le-suisse | `testeur-de-conversations-vocales-ia-locuteur-natif-italien-variante-regionale-suisse-tsmg-lugano` | `tester-conversazioni-vocali-ai-madrelingua-italiana-variante-regionale-svizzera-tsmg-lugano` |
| `prada-332f237b0ca4` | en | saint- | `miu-miu-store-manager-saint-moritz-prada-group-mendrisio` | `mui-mui-direttore-del-negozio-saint-moritz-prada-group-mendrisio` |
| `prada-332f237b0ca4` | fr | saint- | `miu-miu-store-manager-saint-moritz-prada-group-mendrisio` | `mui-mui-direttore-del-negozio-saint-moritz-prada-group-mendrisio` |
| `bcvs-ce3dbeb41048` | en | saint- | `banking-consultant-banque-cantonale-du-valais-saint-maurice` | `consulente-bancario-banque-cantonale-du-valais-saint-maurice` |
| `bcvs-ce3dbeb41048` | fr | saint- | `conseiller-conseillere-bancaire-banque-cantonale-du-valais-saint-maurice` | `consulente-bancario-banque-cantonale-du-valais-saint-maurice` |
| `reboot-monkey-86ed436a86f9` | fr | saint- | `technicien-data-center-ch-saint-gall-presentiel-reboot-monkey-st-gallen` | `tecnico-data-center-ch-san-gallo-presenza-in-sede-reboot-monkey-st-gallen` |
| `reboot-monkey-35b39707e776` | fr | saint- | `technicien-data-center-ch-saint-gall-sur-site-reboot-monkey-st-gallen` | `tecnico-data-center-ch-san-gallo-presenziale-reboot-monkey-st-gallen` |
| `company-qj6jpx` | en | expediter | `expediter-casale-sa-lugano` | `spedizione-casale-sa-lugano-ticino` |
| `company-qj6jpx` | de | beschleuniger | `beschleuniger-casale-sa-lugano-ticino` | `spedizione-casale-sa-lugano-ticino` |

## Follow-ups

- **G.2 (deferred):** human-review the top-50 flagged slugs against SEMrush keyword volumes and patch `slugByLocale` in `data/jobs.json` + cache. Tracked as separate workstream once this audit is triaged.
- Any brand-mangling hit in section 1 indicates a regression in `restoreProtectedBrands()` — investigate the specific crawler parser.
- Section 3 heuristic list is intentionally narrow; expand as new patterns surface.
