# Loop health report

`scripts/ci/loop-health-report.mjs` è un report deterministico dei workflow di
automazione. Non è una telemetria del provider: non stima modelli, token, costi
o PR consegnate.

## Contratto delle metriche

- La tabella principale usa il `conclusion` della run GitHub. `success`,
  `failure`, `cancelled`, `neutral` e `skipped` restano outcome distinti.
- Il failure-rate usa solo run terminali eleggibili: `cancelled` e `skipped`
  sono fuori dal denominatore. Le run `queued`/`in_progress` sono mostrate a
  parte e non entrano nel rate.
- Una `conclusion` sconosciuta è non classificabile: resta fuori dal
  denominatore e rende il rate `n/d` per il periodo, con avviso di copertura.
- Per `issue-fix.yml`, il report legge al massimo 40 risposte `jobs` e separa il
  job `fix` saltato, pending o avviato; il risultato del job resta separato.
  La risposta REST usa `started_at` come prova temporale; un job `cancelled`
  senza `started_at` resta non classificabile. Un job avviato è un segnale di
  esecuzione del job, non una prova di consumo modello o di consegna PR.
- Un errore API, una risposta non valida o una fonte troncata produce `n/d` e
  un avviso di copertura; non viene trasformato in zero e non viene mostrata
  la frase rassicurante “Nessuna soglia superata” senza disclaimer.
- `PR con una sola review del bot` descrive soltanto il conteggio delle review
  del bot osservate. Non significa “first-shot LGTM”: il report non ricostruisce
  un verdetto LGTM da un semplice conteggio.
- L'allocazione dei workflow diventa `n/d` se una run è non classificabile.
  Un lookup fallito del tracker è incompleto e non autorizza la creazione di un
  nuovo issue.

## Budget di lettura

Il limite dei job fixer è esplicito (`FIX_JOB_INSPECTION_LIMIT = 40`). Il report
mantiene inoltre cap sui run (`1000`), sulle PR merged (`1000`), sulle issue
zombie (`100`, con al massimo 40 controlli PR) e sulle liste di label (`200`),
segnalando ogni troncamento. Le scritture opzionali del tracker non fanno parte
delle metriche. I commenti del tracker sono richiesti via GraphQL con
`comments(last:14)`, mantenendo l'ordine restituito per il calcolo degli streak.

Il report non modifica scheduling, workflow di automazione o mirror del corpus.
