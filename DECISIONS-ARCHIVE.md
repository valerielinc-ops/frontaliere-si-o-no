# Decisioni del proprietario superate

Righe tolte da `DECISIONS.md` (iniettato nel prompt di issue-fix con il tetto `DECISIONS_MAX_BYTES`): restano qui come storia.

| Data | Decisione | Fonte |
|---|---|---|
| 2026-09-23 → superseded 2026-09-24 | Deny tecnico, capability mancante, timeout e root-cause non convergente vanno in `automation-deferred`; `needs-human` non è più un canale di attesa | istruzione diretta, sessione 23-09 |
| 2026-09-03 → superseded 2026-09-16 | Modello unificato Claude Opus a `--effort medium` per i tier del fixer; decisione storica, sostituita dal lane Codex | issue-fix.yml → Tier |
| 2026-08-14 → superseded 2026-09-24 | Congelamento job-alert revocato: vedi riga 2026-09-24 | sessione 14-08 |
| 2026-08-13 | Publisher doppio sulla stessa coda: spento lo schedule del sito | #5794 → PR #5822 — issue chiusa, riga spostata il 2026-10-05 |
| 2026-08-13 | Quattro scelte LPD registrate | #5764 (commenti 13-08) — issue chiusa, riga spostata il 2026-10-05 |
| 2026-08-24 | #6173 (verticale farmacie svizzere): **SÌ, procedi** | istruzione diretta, sessione 24-08 — issue chiusa, riga spostata il 2026-10-05 |
| 2026-08-24 | #6227 (bande salariali stimate): **opzione A** — scrivere `salarySource`, far comparire l'etichetta "(stima)" dove il codice già la prevede, dato sempre incluso in `baseSalary` per Google — **+ fix del mapping settore IT→EN** (bug indipendente dalla decisione: 70,1% degli annunci ripiega su Logistics per mancata traduzione delle categorie) | istruzione diretta, sessione 24-08 — issue chiusa, riga spostata il 2026-10-05 |
| 2026-09-28 | #7972: **opzione B** — il confronto/tuning del costo di traduzione si dichiara pronto solo dopo 5 finestre consecutive con schema corrente, `starved=false` e rapporto `windowMs` max/min ≤1,2; le finestre legacy, incomplete o fuori budget restano evidenza ma spezzano la sequenza | decisione autonoma secondo VISION D1/D2/D5, sweep 28-09 |
| 2026-11-09 | Candidature: non inferire fatti personali; consensi per trattamento, contatto o conservazione richiedono risposta esplicita. Default solo per presa visione obbligatoria e inequivocabile dell’informativa; rifiutare marketing facoltativo. | 09-11 |
