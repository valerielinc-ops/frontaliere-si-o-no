## Implementato

- **in questa PR** — 10 crawler promossi dal prospector, per **3486 annunci** di datori che non coprivamo. Ognuno ha superato il gate di `scripts/lib/prospector/promotion-gate.mjs`: qualita' >= 0.9 contro la pagina ufficiale del datore, su almeno 3 pagine di dettaglio, con **2 validazioni buone su 2 giorni distinti** — la condizione che una singola run, per quanto buona, non puo' soddisfare.
- **in questa PR** — `fachkraft` · fachkraft.ch GmbH · 3362 annunci · qualita' 0.99 su 2 giorni distinti · estrazione `template` · fachkraft.ch
- **in questa PR** — `ete` · Emil Egger AG · 28 annunci · qualita' 0.99 su 2 giorni distinti · estrazione `template` · ete.ch
- **in questa PR** — `gkb-jobservice` · GKB JobService · 25 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-2607.umantis.com
- **in questa PR** — `ipersonal` · iPersonal AG · 15 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · med-ipersonal.ch
- **in questa PR** — `bewerbermanagement-stellen` · Bewerbermanagement Stellen · 13 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-2904.umantis.com
- **in questa PR** — `eoc-candidati-posizioni` · EOC candiDati Posizioni · 10 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-2761.umantis.com
- **in questa PR** — `burgenstock-collection` · Bürgenstock Collection · 10 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-2850.umantis.com
- **in questa PR** — `bewerbungsmanagement-spital-davos` · Bewerbungsmanagement Spital Davos · 10 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-2966.umantis.com
- **in questa PR** — `kzu-recruiting` · KZU Recruiting · 8 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-1251.umantis.com
- **in questa PR** — `hotel-international` · Hotel International au Lac · 5 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · hotel-international.ch
- **in questa PR** — voci nel manifest e gruppi di workflow rigenerati, quindi i crawler entrano nella schedulazione esistente.

## Non implementato (ancora)

- **by construction** — nessun parser scritto a mano: cio' che e' specifico del datore vive nella spec dichiarativa sotto `data/prospector/crawlers/`, e l'estrazione in produzione e' la stessa che il gate ha misurato.
- **per scelta** — al massimo 10 crawler per giro. Una pipeline non presidiata che ne aggiunge dieci al giorno e' recuperabile, una che ne aggiunge quattrocento no.
- **blocked: serve una run successiva** — 26 candidati graduati non hanno superato il gate; le cause sono nel log dello stadio PROMOTE e la piu' frequente e' la stabilita' su due giorni, che si risolve da sola al giro dopo.
