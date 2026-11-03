## Implementato

- **in questa PR** — 10 crawler validati aggiunti ai manifest e alle schedule, con **36 annunci osservati** durante VALIDATE. Ognuno ha superato il gate di `scripts/lib/prospector/promotion-gate.mjs`: qualita' >= 0.9, con **2 validazioni buone su 2 giorni distinti** — la condizione che una singola run, per quanto buona, non puo' soddisfare, semantica provata su almeno il 75% del campione e identita' del datore confermata. Main segna il merge come `awaiting_first_crawl`; `production` richiede una slice `jobs` fresca e non vuota.
- **in questa PR** — `skan-com` · SKAN AG · 8 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · jobs.skan.com
- **in questa PR** — `invias-swiss` · Invias AG · 7 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · invias.swiss
- **in questa PR** — `zindel-united-swiss` · Zindel + Co. AG · 7 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · zindel-united.swiss
- **in questa PR** — `mountains-ch` · Engadin St. Moritz Mountains AG · 4 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · mountains.ch
- **in questa PR** — `lemco-precision-com` · Lemco Précision SA · 3 annunci · qualita' 0.94 su 2 giorni distinti · estrazione `template` · lemco-precision.com
- **in questa PR** — `eqe-ch` · eqe AG · 2 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · eqe.ch
- **in questa PR** — `az-systems-ch` · AZ systems AG · 2 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `template` · az-systems.ch
- **in questa PR** — `internezzo-ag` · Internezzo AG · 1 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `jsonld` · link.ostendis.com
- **in questa PR** — `jobdoor-ch` · Jobdoor AG · 1 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `jsonld` · jobdoor.ch
- **in questa PR** — `lipsuisse-ch` · LIP SUISSE · 1 annunci · qualita' 1.00 su 2 giorni distinti · estrazione `jsonld` · lipsuisse.ch
- **in questa PR** — voci nel manifest e gruppi di workflow rigenerati, quindi i crawler entrano nella schedulazione esistente.
- **in questa PR** — file workflow rigenerati: `.github/corpus-workflows/contract.json`, `.github/corpus-workflows/crawler-group-24.yml`, `.github/workflows/crawler-group-24-logic.yml`, `.github/workflows/crawler-group-24.yml`.
- **in questa PR** — `data/crawler-companies-auto.json` rigenerato nello stesso commit dei runner: la directory aziende del sito resta allineata all'insieme dei crawler realmente in produzione, invece di dipendere da un `npm run companies:generate` lanciato a mano (era fermo a 213 voci su 614 runner, issue #6481).

## Non implementato (ancora)

- **by construction** — nessun parser scritto a mano: cio' che e' specifico del datore vive nella spec dichiarativa sotto `data/prospector/crawlers/`, e l'estrazione in produzione e' la stessa che il gate ha misurato. **Motivo:** il percorso comune elimina divergenze fra scaffolding, test e runtime. **Prossimo passo:** mantenere i nuovi datori nel percorso dichiarativo e nel gate esistente.
- **per scelta** — al massimo 15 crawler per giro. Una pipeline non presidiata che ne aggiunge dieci al giorno e' recuperabile, una che ne aggiunge quattrocento no. **Motivo:** il limite contiene il blast radius di una promozione automatica. **Prossimo passo:** il giro successivo continua dai candidati graduati rimasti.
- **blocked: serve una run successiva** — 37 candidati graduati non hanno superato il gate (5 solo per la stabilita' richiesta da 2 validazioni buone su 2 giorni distinti; 32 per altre condizioni). Le cause dettagliate sono nel log dello stadio PROMOTE: solo il primo gruppo si risolve con una run successiva. **Motivo:** la stabilita' o le altre condizioni del gate non sono ancora soddisfatte. **Prossimo passo:** eseguire una run successiva per ricontrollare la stabilita' e rivalutare le altre condizioni del gate.
