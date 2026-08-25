## Implementato

- **in questa PR** — 2 crawler promossi dal prospector, per **20 annunci** di datori che non coprivamo. Ognuno ha superato il gate di `scripts/lib/prospector/promotion-gate.mjs`: qualita' >= 0.9 contro la pagina ufficiale del datore, su almeno 3 pagine di dettaglio, con **2 validazioni buone su 2 giorni distinti** — la condizione che una singola run, per quanto buona, non puo' soddisfare — e con almeno il 75% delle pagine di dettaglio che **legge come un annuncio di lavoro** e non come contenuto promozionale o editoriale.
- **in questa PR** — `accor` · Ibis Budget · 10 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · careers.accor.com
- **in questa PR** — `apleona-schweiz-ag` · Apleona Schweiz AG · 10 annunci · qualita' 0.98 su 4 giorni distinti · estrazione `template` · recruitingapp-2765.umantis.com
- **in questa PR** — voci nel manifest e gruppi di workflow rigenerati, quindi i crawler entrano nella schedulazione esistente.

## Non implementato (ancora)

- **by construction** — nessun parser scritto a mano: cio' che e' specifico del datore vive nella spec dichiarativa sotto `data/prospector/crawlers/`, e l'estrazione in produzione e' la stessa che il gate ha misurato.
- **per scelta** — al massimo 10 crawler per giro. Una pipeline non presidiata che ne aggiunge dieci al giorno e' recuperabile, una che ne aggiunge quattrocento no.
- **blocked: serve una run successiva** — 29 candidati graduati non hanno superato il gate; le cause sono nel log dello stadio PROMOTE e la piu' frequente e' la stabilita' su due giorni, che si risolve da sola al giro dopo.
