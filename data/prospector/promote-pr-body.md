## Implementato

- **in questa PR** — 5 crawler validati aggiunti ai manifest e alle schedule, con **12 annunci osservati** durante VALIDATE. Ognuno ha superato il gate di `scripts/lib/prospector/promotion-gate.mjs`: qualita' >= 0.9, con **2 validazioni buone su 2 giorni distinti** — la condizione che una singola run, per quanto buona, non puo' soddisfare, semantica provata su almeno il 75% del campione e identita' del datore confermata. Main segna il merge come `awaiting_first_crawl`; `production` richiede una slice `jobs` fresca e non vuota.
- **in questa PR** — `policelavaux-ch` · policelavaux · 4 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · policelavaux.ch
- **in questa PR** — `elektriker-elektromonteur-jobs-ch` · elektriker-elektromonteur-jobs · 3 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · pks-personal.ch
- **in questa PR** — `pks-bewerbung-ch` · pks-bewerbung · 3 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · pks-personal.ch
- **in questa PR** — `nishcom` · nishcom · 1 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `jsonld` · nishcom.jobs.personio.de
- **in questa PR** — `opacc-software-ag` · Opacc Software AG · 1 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `jsonld` · my.jobalino.ch
- **in questa PR** — voci nel manifest.
- **blocked: manca il permesso `workflows` sul token** — i gruppi non sono stati rigenerati, quindi questi crawler esistono ma non sono ancora schedulati. **Motivo:** l'identita' di push non ha potuto completare la rigenerazione in questo giro. **Prossimo passo:** eseguire `node scripts/generate-crawler-group-workflows.mjs` da un'identita' che possa scrivere in `.github/workflows/`.
- **in questa PR** — `data/crawler-companies-auto.json` rigenerato nello stesso commit dei runner: la directory aziende del sito resta allineata all'insieme dei crawler realmente in produzione, invece di dipendere da un `npm run companies:generate` lanciato a mano (era fermo a 213 voci su 614 runner, issue #6481).

## Non implementato (ancora)

- **by construction** — nessun parser scritto a mano: cio' che e' specifico del datore vive nella spec dichiarativa sotto `data/prospector/crawlers/`, e l'estrazione in produzione e' la stessa che il gate ha misurato. **Motivo:** il percorso comune elimina divergenze fra scaffolding, test e runtime. **Prossimo passo:** mantenere i nuovi datori nel percorso dichiarativo e nel gate esistente.
- **per scelta** — al massimo 15 crawler per giro. Una pipeline non presidiata che ne aggiunge dieci al giorno e' recuperabile, una che ne aggiunge quattrocento no. **Motivo:** il limite contiene il blast radius di una promozione automatica. **Prossimo passo:** il giro successivo continua dai candidati graduati rimasti.
- **blocked: serve una run successiva** — 27 candidati graduati non hanno superato il gate (2 solo per la stabilita' richiesta da 2 validazioni buone su 2 giorni distinti; 25 per altre condizioni). Le cause dettagliate sono nel log dello stadio PROMOTE: solo il primo gruppo si risolve con una run successiva. **Motivo:** la stabilita' o le altre condizioni del gate non sono ancora soddisfatte. **Prossimo passo:** eseguire una run successiva per ricontrollare la stabilita' e rivalutare le altre condizioni del gate.
