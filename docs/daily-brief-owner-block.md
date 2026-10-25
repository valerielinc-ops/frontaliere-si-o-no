# Daily-brief: bloccata dal proprietario

Il bollettino email è bloccato dal proprietario dal 25/10/2026. Il motivo è
registrato in `data/daily-brief-owner-block.json`: dal 21/10 le edizioni hanno
solo 2-3 blocchi (Benzina assente perché la fonte MIMIT non risponde ai runner
dal 17/10, Lavoro vuoto con `yesterdayAdded` nullo) e circa 12.400 iscritti
sono in arretrato; riaprire ora causerebbe un invio massivo con contenuto
povero.

Restano attivi la generazione e pubblicazione dei dati, i preview e i dry-run.
Nessun percorso reale deve inviare la daily-brief durante il blocco; gli altri
canali email non sono modificati da questa decisione.

## Sblocco

Solo il proprietario può sbloccare la daily-brief, dopo un’istruzione esplicita
nella conversazione. La procedura è:

1. impostare `blocked:false` in `data/daily-brief-owner-block.json`;
2. impostare `ENABLE_DAILY_BRIEF:'true'` in
   `.github/workflows/send-daily-brief.yml`;
3. usare `gh workflow enable send-daily-brief.yml`.

Agenti, self-heal, loop e review automatiche non possono eseguire né anticipare
questi passaggi. Finché l’istruzione non arriva, il blocco resta attivo anche se
un ambiente tenta di impostare `ENABLE_DAILY_BRIEF=true`.
