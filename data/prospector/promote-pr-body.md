## Implementato

- **in questa PR** — 1 crawler promossi dal prospector, per **2 annunci** di datori che non coprivamo. Ognuno ha superato il gate di `scripts/lib/prospector/promotion-gate.mjs`: qualita' >= 0.9 contro la pagina ufficiale del datore, su almeno 3 pagine di dettaglio, con **2 validazioni buone su 2 giorni distinti** — la condizione che una singola run, per quanto buona, non puo' soddisfare — e con almeno il 75% delle pagine di dettaglio che **legge come un annuncio di lavoro** e non come contenuto promozionale o editoriale.
- **in questa PR** — `vereinaklosters` · Vereina · 2 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · hotelcareer.ch
- **in questa PR** — voci nel manifest e gruppi di workflow rigenerati, quindi i crawler entrano nella schedulazione esistente.
- **in questa PR** — `data/crawler-companies-auto.json` rigenerato nello stesso commit dei runner: la directory aziende del sito resta allineata all'insieme dei crawler realmente in produzione, invece di dipendere da un `npm run companies:generate` lanciato a mano (era fermo a 213 voci su 614 runner, issue #6481).

## Non implementato (ancora)

- **by construction** — nessun parser scritto a mano: cio' che e' specifico del datore vive nella spec dichiarativa sotto `data/prospector/crawlers/`, e l'estrazione in produzione e' la stessa che il gate ha misurato.
- **per scelta** — al massimo 10 crawler per giro. Una pipeline non presidiata che ne aggiunge dieci al giorno e' recuperabile, una che ne aggiunge quattrocento no.
- **blocked: serve una run successiva** — 84 candidati graduati non hanno superato il gate (9 solo per la stabilita' richiesta da 2 validazioni buone su 2 giorni distinti; 75 per altre condizioni). Le cause dettagliate sono nel log dello stadio PROMOTE: solo il primo gruppo si risolve con una run successiva.
