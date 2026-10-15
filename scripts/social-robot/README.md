# Robot social (Instagram e TikTok)

Pubblica i caroselli giornalieri (articoli e lavori più visti di ieri, dogane
più veloci della settimana) e i Reel sperimentali controllati su Instagram,
oltre ai contenuti TikTok, **dal browser reale** del Mac host agenti, con
Playwright e un profilo Chrome persistente. Il trasporto dei post, degli
Insights e della community passa dall'interfaccia visibile del browser; il
Graph API resta soltanto un fallback esplicito per le Stories.

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
   (`scripts/lib/social-publish-queue.mjs`). Il workflow schedulato
   `instagram-reel-experiment.yml` usa `scripts/post-to-instagram-reel.mjs` per
   generare una cover e un MP4 verticale, con `kind: reel` e ledger separato.
   Per TikTok la voce in coda porta anche un MP4 fatto dalle stesse slide,
   perché l'upload web accetta solo video. È la stessa deduplica e lo stesso
   ledger della pipeline, ma il robot non decide cosa pubblicare.
2. Il robot (`run.mjs`) legge la coda da `origin/main`, scarica le slide
   Instagram, il Reel MP4 verticale o l'MP4 TikTok verificato dalla CDN e li
   pubblica dalla pagina web della piattaforma. Una voce con `video` sul canale
   Instagram seleziona il composer Reel; senza `video` resta nel composer Post.
3. Solo dopo aver **visto la conferma** della piattaforma nella pagina,
   lancia `social-robot-confirm.yml`, che sposta il post dalla coda al ledger
   `data/<canale>-posted.json`. Un clic senza conferma visibile — o seguito da
   qualunque errore, anche una verifica o un muro di login — resta
   `unconfirmed`: il robot non lo ripubblica, apre una issue `needs-human` e
   **si ferma su quella piattaforma** finché un umano non risolve la riga.
   Non preme nemmeno un post successivo che ripete gli stessi articoli di un
   clic non ancora arrivato nel ledger. Subito dopo la pubblicazione il
   worker Chrome apre Inbox Instagram/Business Suite, risponde una sola volta
   per thread accessibile e registra gli Insights leggendo le metriche visibili
   nel Professional Dashboard.

Risolvere un `unconfirmed` (nel journal
`~/Library/Application Support/frontaliere/social-robot/journal.json`):
se il post è online, registrarlo con `gh workflow run social-robot-confirm.yml`
(il ledger ne contiene allora l'id e il blocco cade da solo); se non lo è,
aggiungere `"resolvedAt": "<ora ISO>"` alla riga, o cancellarla.
Questo è solo il recupero di un errore del browser, non un passaggio della
gestione ordinaria dei contenuti.

## Interruttore (Firebase Remote Config)

Parametro `SOCIAL_ROBOT_MODE`, letto dai poster in Actions e dal robot sul Mac:

| Valore | Poster | Robot |
|---|---|---|
| `off` | solo API, come prima | non fa nulla |
| `dry` (default: assente, vuoto o sconosciuto) | API se ha le credenziali, altrimenti coda | arriva al bottone di pubblicazione, screenshot, non preme |
| `live` | mai API, sempre coda | preme il bottone (se lanciato con `--publish`) |

In `live`, la stessa finestra avvia il worker browser di community e Insights.
Il profilo Chrome persistente è la sola autenticazione necessaria; se la
sessione mostra login o challenge il worker si ferma senza insistere e apre la
diagnosi locale. `SOCIAL_ROBOT_INSIGHTS_SOURCE` vale `browser` di default;
`graph` mantiene il vecchio percorso solo come fallback esplicito per la
community.

I valori sono tutti più corti di sei caratteri: il loader di Remote Config non
li maschera nei log di CI.

### Esperimento audio TikTok

Il robot può aprire automaticamente l’editor nativo `Suoni` di TikTok Studio,
selezionare il primo audio della scheda `Per te` (la libreria raccomandata dalla
piattaforma), salvarlo e poi pubblicare. Non scarica musica da fonti esterne e
non inserisce file audio nel video. La selezione resta nel trattamento, mentre
il controllo conserva l’audio originale del video.

| Parametro Firebase | Valori | Default locale |
|---|---|---|
| `TIKTOK_MUSIC_MODE` | `off` / `trend` | `off` |
| `TIKTOK_MUSIC_ROLLOUT_PERCENT` | `0`–`100` | `0` |

L’assegnazione è deterministica sull’id della coda: un retry resta nello stesso
braccio. Il journal locale conserva variante e descrizione del suono scelto,
mentre l’evidence di conferma la porta anche nel ledger. Se la libreria nativa
non espone una card selezionabile, il trattamento si ferma prima di premere
`Pubblica` e salva screenshot/HTML: non pubblica in silenzio una variante
diversa.

### Esperimento video TikTok

I video TikTok hanno ora un secondo test indipendente dall'audio nativo. Il
controllo resta il video composto dalle slide con dissolvenza; il trattamento
usa le stesse informazioni ma le presenta come motion graphic verticale, con
card flottante, forme animate, barra di avanzamento e transizioni più rapide.
Il renderer è deterministico e non scarica filmati o musica esterna.

| Parametro Firebase | Valori | Default locale |
|---|---|---|
| `TIKTOK_VIDEO_CREATIVE_MODE` | `off` / `motion` | `off` |
| `TIKTOK_VIDEO_CREATIVE_ROLLOUT_PERCENT` | `0`–`100` | `0` |

L'assegnazione usa l'id della coda in uno spazio hash separato da quello
dell'audio: un retry resta nello stesso braccio e i due esperimenti possono
essere letti separatamente. La variante finisce sia nel journal locale del Mac
sia nelle righe del ledger TikTok (`creativeVariant`, `creativeLabel`,
`creativeFormat`). Per il piano e la regola di lettura dei risultati vedere
`docs/tiktok-video-creative-experiment.md`.

## Comandi (sul Mac host agenti, dal checkout del sito)

```bash
# Una volta: il proprietario fa il login nel profilo, poi chiude la finestra.
node scripts/social-robot/run.mjs --login

# Prova a secco (default): fino al bottone di pubblicazione, con screenshot.
node scripts/social-robot/run.mjs --dry-run --platform=instagram

# Pubblicazione: preme solo se Remote Config dice `live`.
node scripts/social-robot/run.mjs --publish

# Il flag audio viene impostato in Firebase dal maintainer; questa prova mostra
# il comportamento fino al bottone senza pubblicare.
TIKTOK_MUSIC_MODE=trend TIKTOK_MUSIC_ROLLOUT_PERCENT=100 \
  node scripts/social-robot/run.mjs --dry-run --platform=tiktok

# Preview del prossimo Reel (non carica e non accoda nulla).
npx tsx scripts/post-to-instagram-reel.mjs --dry-run --kind=article

# La pubblicazione del Reel avviene dagli slot schedulati di
# instagram-reel-experiment.yml, con dry_run=false, e poi dal robot.

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
- dopo un muro di login o una verifica: piattaforma in pausa 12 ore;
- dopo un clic senza conferma: piattaforma ferma finché un umano non risolve;
- nel launch agent (`--jitter`) una sola prova a secco per post in coda, non
  una per finestra; a mano `--dry-run` la ripete sempre;
- il Reel non ha un cron autonomo: è uno slot dispatch-only scelto dal
  proprietario e sottoposto allo stesso tetto di 2 post Instagram al giorno;
- una conferma inviata che dopo 2 ore non è ancora nel ledger viene rinviata
  alla finestra successiva (fino a 7 giorni dal clic).

## Dove guardare

| Cosa | Dove |
|---|---|
| Log | `~/Library/Logs/frontaliere/social-robot.log` |
| Profilo, journal, diagnosi | `~/Library/Application Support/frontaliere/social-robot/` |
| Screenshot e HTML di un errore o di una prova a secco | `.../social-robot/diagnostics/<ora>-<canale>-<id>/` |
| Errori | issue «Robot social: pubblicazione Instagram/TikTok non riuscita» (una per piattaforma, deduplicata) |

Per ogni voce Instagram con metadati creativi, il log contiene anche una riga
`🧭 Instagram engagement` con l'hook, il loop e le finestre automatiche entro
24/48/72 ore. Lo stato di deduplica del worker è locale in
`.../social-robot/instagram-community-state.json` e conserva solo hash degli
ID Instagram: nessun testo di commenti, username o messaggio viene scritto.

Il worker invia un DM solo come risposta a una conversazione avviata dall’utente
o a una risposta privata a un commento; non fa outreach a freddo. Le Stories
sono follow-up visuali statici: il worker non finge di poter creare sticker
interattivi non esposti dal Content Publishing API.

Nessuna credenziale passa dal repository: la sessione web resta solo nel
profilo del browser sul Mac. Il Graph token opzionale, quando il fallback è
stato scelto esplicitamente, viene caricato in memoria da Firebase Remote
Config durante la finestra del launch agent.

## Test

- `tests/social-robot.test.ts`: scelta dalla coda, cadenza e tetto giornaliero,
  marcatura solo dopo la conferma, issue su errore, interruttore, plist.
- `tests/instagram-reel.test.ts`: tre trattamenti, card verticali, metadati e
  coda MP4.
- `node scripts/social-robot/robot-e2e.mjs` (workflow `social-robot-e2e.yml`):
  i flussi Playwright, inclusi dry-run e publish simulato del Reel, su pagine
  locali che imitano Instagram e TikTok.
