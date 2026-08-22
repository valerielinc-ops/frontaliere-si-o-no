## Implementato

- **in questa PR** — 10 crawler promossi dal prospector, per **117 annunci** di datori che non coprivamo. Ognuno ha superato il gate di `scripts/lib/prospector/promotion-gate.mjs`: qualita' >= 0.9 contro la pagina ufficiale del datore, su almeno 3 pagine di dettaglio, con **2 validazioni buone su 2 giorni distinti** — la condizione che una singola run, per quanto buona, non puo' soddisfare.
- **in questa PR** — `recruitingapp-2677` · E-Recruiting LLB-Gruppe Stellen · 21 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-2677.umantis.com
- **in questa PR** — `michaelpage` · Michael Page · 20 annunci · qualita' 0.99 su 2 giorni distinti · estrazione `template` · pageexecutive.com
- **in questa PR** — `med-ipersonal` · MediPersonal · 15 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · ipersonal.ch
- **in questa PR** — `okjob` · OK Job SA, succursale di Mendrisio · 14 annunci · qualita' 0.95 su 2 giorni distinti · estrazione `template` · okjob.ch
- **in questa PR** — `jsafrasarasin` · J. Safra Sarasin · 14 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · jsafrasarasin.umantis.com
- **in questa PR** — `recruitingapp-1123` · BIG & ARE Stellen · 10 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-1123.umantis.com
- **in questa PR** — `gmo` · gmo · 10 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `microdata` · arsante.ch
- **in questa PR** — `recruitingapp-1154` · SGKB Bewerbermanagement Stellen · 7 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-1154.umantis.com
- **in questa PR** — `recruitingapp-2649` · Alexander von Humboldt-Stiftung Stellen · 4 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-2649.umantis.com
- **in questa PR** — `recruitingapp-2563` · Switch Bewerbermanagement Stellen · 2 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · recruitingapp-2563.umantis.com
- **in questa PR** — voci nel manifest e gruppi di workflow rigenerati, quindi i crawler entrano nella schedulazione esistente.

## Non implementato (ancora)

- **by construction** — nessun parser scritto a mano: cio' che e' specifico del datore vive nella spec dichiarativa sotto `data/prospector/crawlers/`, e l'estrazione in produzione e' la stessa che il gate ha misurato.
- **per scelta** — al massimo 10 crawler per giro. Una pipeline non presidiata che ne aggiunge dieci al giorno e' recuperabile, una che ne aggiunge quattrocento no.
- **blocked: serve una run successiva** — 38 candidati graduati non hanno superato il gate; le cause sono nel log dello stadio PROMOTE e la piu' frequente e' la stabilita' su due giorni, che si risolve da sola al giro dopo.
