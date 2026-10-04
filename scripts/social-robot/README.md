# Robot social (Instagram e TikTok)

Pubblica i caroselli giornalieri (articoli e lavori più visti di ieri, dogane
più veloci della settimana) su Instagram e TikTok **dal browser reale** del
Mac host agenti, con Playwright e un profilo Chrome persistente. Nessun
servizio terzo, nessuna app API.

**Decisione del proprietario, 2026-10-04 (issue 9798 e 7648).** Il
proprietario accetta il rischio che Instagram e TikTok, secondo i loro termini
d'uso, limitino o sospendano un account che pubblica tramite automazione. Per
questo il robot ha una cadenza bassa e dichiarata, ritardi casuali, e non
insiste mai dopo un errore.

## Come funziona

1. I poster giornalieri (`scripts/post-to-instagram.mjs`,
   `scripts/post-to-tiktok.mjs`, workflow `*-daily-broadcast.yml`) scelgono il
   carosello, generano le slide, le caricano sulla CDN e, quando il robot è il
   trasporto, mettono il post pronto in `data/<canale>-queue.json` su `main`
   (`scripts/lib/social-publish-queue.mjs`). È la stessa scelta, la stessa
   deduplica e lo stesso ledger della pipeline API: il robot non decide cosa
   pubblicare.
2. Il robot (`run.mjs`) legge la coda da `origin/main`, scarica le slide dalla
   CDN e le pubblica dalla pagina web della piattaforma.
3. Solo dopo aver **visto la conferma** della piattaforma nella pagina,
   lancia `social-robot-confirm.yml`, che sposta il post dalla coda al ledger
   `data/<canale>-posted.json`. Un clic senza conferma visibile resta
   `unconfirmed`: il robot non lo ripubblica e apre una issue.

## Interruttore (Firebase Remote Config)

Parametro `SOCIAL_ROBOT_MODE`, letto dai poster in Actions e dal robot sul Mac:

| Valore | Poster | Robot |
|---|---|---|
| `off` | solo API, come prima | non fa nulla |
| `dry` (default: assente, vuoto o sconosciuto) | API se ha le credenziali, altrimenti coda | arriva al bottone di pubblicazione, screenshot, non preme |
| `live` | mai API, sempre coda | preme il bottone (se lanciato con `--publish`) |

I valori sono tutti più corti di sei caratteri: il loader di Remote Config non
li maschera nei log di CI.

## Comandi (sul Mac host agenti, dal checkout del sito)

```bash
# Una volta: il proprietario fa il login nel profilo, poi chiude la finestra.
node scripts/social-robot/run.mjs --login

# Prova a secco (default): fino al bottone di pubblicazione, con screenshot.
node scripts/social-robot/run.mjs --dry-run --platform=instagram

# Pubblicazione: preme solo se Remote Config dice `live`.
node scripts/social-robot/run.mjs --publish

# Launch agent: due finestre al giorno (default 11:30 e 18:30 ora locale,
# SR_WINDOWS="HH:MM HH:MM" per cambiarle), più fino a 20 minuti casuali.
bash scripts/social-robot/launchd.sh install
bash scripts/social-robot/launchd.sh status
bash scripts/social-robot/launchd.sh uninstall
```

Il launch agent non esegue il working tree del checkout (che può essere su un
altro ramo): a ogni finestra estrae i file del robot da `origin/main` in uno
snapshot nella cartella di stato e usa i `node_modules` del checkout. Serve una
sessione grafica aperta sul Mac: il browser non è headless.

## Cadenza (`lib/cadence.mjs`)

- al massimo 2 post al giorno per piattaforma, 1 per finestra;
- 1,2-4,5 s fra un'azione e l'altra, digitazione carattere per carattere;
- 1,5-6 minuti fra Instagram e TikTok nella stessa finestra;
- dopo un muro di login o una verifica: piattaforma in pausa 12 ore.

## Dove guardare

| Cosa | Dove |
|---|---|
| Log | `~/Library/Logs/frontaliere/social-robot.log` |
| Profilo, journal, diagnosi | `~/Library/Application Support/frontaliere/social-robot/` |
| Screenshot e HTML di un errore o di una prova a secco | `.../social-robot/diagnostics/<ora>-<canale>-<id>/` |
| Errori | issue «Robot social: pubblicazione Instagram/TikTok non riuscita» (una per piattaforma, deduplicata) |

Nessuna credenziale passa dal repository: le sessioni stanno solo nel profilo
del browser sul Mac.

## Test

- `tests/social-robot.test.ts`: scelta dalla coda, cadenza e tetto giornaliero,
  marcatura solo dopo la conferma, issue su errore, interruttore, plist.
- `node scripts/social-robot/robot-e2e.mjs` (workflow `social-robot-e2e.yml`):
  i flussi Playwright su pagine locali che imitano Instagram e TikTok.
