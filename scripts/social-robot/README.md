# Robot social (Instagram; TikTok in sola lettura)

Il robot pubblica i caroselli giornalieri su Instagram dal browser del Mac
agenti. I Reel sperimentali usano la Graph API ufficiale e non passano dal
browser. TikTok è escluso dalla pubblicazione automatica:
il workflow `tiktok-daily-broadcast.yml` è ora solo un'anteprima manuale,
`post-to-tiktok.mjs` blocca ogni invio reale e il robot filtra TikTok anche
quando viene richiesto esplicitamente. La raccolta TikTok usa un workflow
separato e di sola lettura per gli Insights autorizzati.

La precedente decisione del 2026-10-04 su cadenza e rischio dell'automazione
descrive il comportamento storico. Non autorizza più l'invio automatico su
TikTok alla luce delle linee guida correnti per i client di pubblicazione.

## Come funziona

1. Il poster Instagram (`scripts/post-to-instagram.mjs`, workflow
   `instagram-daily-broadcast.yml`) sceglie il carosello, genera le slide,
   le carica sulla CDN e, quando il robot è il
   trasporto, mettono il post pronto in `data/<canale>-queue.json` su `main`
   (`scripts/lib/social-publish-queue.mjs`). Il workflow schedulato
   `instagram-reel-experiment.yml` usa `scripts/post-to-instagram-reel.mjs` per
   generare cover e MP4, pubblicarli con il container Graph API `REELS`, e
   registrare l'esatto `mediaId` restituito da Meta. Il workflow rilegge le
   vecchie voci Reel in coda e, se complete e ancora non pubblicate, le migra
   alla Graph API. Il workflow TikTok omonimo è solo un'anteprima manuale e
   non crea code.
2. Il robot (`run.mjs`) legge la coda Instagram da `origin/main` e pubblica i
   caroselli dalla pagina web della piattaforma. Eventuali voci Reel legacy
   restano in hold nel robot e vengono pubblicate solo dal workflow Graph API.
3. Solo dopo aver **visto la conferma** del carosello nella pagina,
   lancia `social-robot-confirm.yml`, che sposta il post dalla coda al ledger
   `data/<canale>-posted.json`. Un clic senza conferma visibile — o seguito da
   qualunque errore, anche una verifica o un muro di login — resta
   `unconfirmed`: il robot non lo ripubblica, apre una issue `needs-human` e
   **si ferma su quella piattaforma** finché un umano non risolve la riga.
   Non preme nemmeno un post successivo che ripete gli stessi articoli di un
   clic non ancora arrivato nel ledger. Subito dopo la pubblicazione il
   worker Chrome apre Inbox Instagram/Business Suite in sola lettura e registra
   gli Insights leggendo le metriche visibili nel Professional Dashboard. Le
   risposte community passano solo dal Graph API esplicitamente selezionato.

Le funzioni storiche di riconciliazione TikTok restano nel codice per leggere
eventuali record preesistenti, ma il robot non avvia più il browser TikTok e
non cerca né pubblica nuovi contenuti su quel canale.

Risolvere a mano un `unconfirmed` (nel journal
`~/Library/Application Support/frontaliere/social-robot/journal.json`):
se il post è online, registrarlo con `gh workflow run social-robot-confirm.yml`
(il ledger ne contiene allora l'id e il blocco cade da solo); se non lo è,
aggiungere `"resolvedAt": "<ora ISO>"` alla riga, o cancellarla.
Questo è solo il recupero di un errore del browser, non un passaggio della
gestione ordinaria dei contenuti.

## Interruttore (Firebase Remote Config)

Parametro `SOCIAL_ROBOT_MODE`, letto dai poster in Actions e dal robot sul Mac:

| Valore | Caroselli | Reel | Robot |
|---|---|---|---|
| `off` | solo API | Graph API se le credenziali sono configurate | non fa nulla |
| `dry` (default: assente, vuoto o sconosciuto) | API se ha le credenziali, altrimenti coda | Graph API se le credenziali sono configurate | arriva al bottone dei caroselli, screenshot, non preme |
| `live` | sempre coda | Graph API se le credenziali sono configurate | pubblica solo caroselli Instagram in coda; TikTok è filtrato |

In `live`, la stessa finestra avvia il worker browser di community e Insights.
Il profilo Chrome persistente è la sola autenticazione necessaria; se la
sessione mostra login o challenge il worker si ferma senza insistere e apre la
diagnosi locale. `SOCIAL_ROBOT_INSIGHTS_SOURCE` vale `browser` di default;
`graph` mantiene il vecchio percorso solo come fallback esplicito per la
community.

I valori sono tutti più corti di sei caratteri: il loader di Remote Config non
li maschera nei log di CI.

### Meta Insights e decisioni autonome

Il worker legge dal Professional Dashboard autenticato due finestre per ogni
post eleggibile: 24 ore per la diagnosi dell’hook e 72 ore per la decisione.
Le righe vengono salvate nella collezione privata Firestore
`social_native_insights/current`. Il workflow `instagram-insights-snapshot.yml`
esporta i dati solo in `$RUNNER_TEMP`, calcola lo scorecard e applica decisioni
deterministiche già abilitate in Firebase Remote Config.

Una variante viene promossa soltanto con almeno tre osservazioni indipendenti,
un confronto con una seconda variante e un vantaggio che supera sia il 15%
relativo sia 0,5 punti percentuali assoluti. Con segnale nullo, dati scarsi o
un margine insufficiente il sistema mantiene la rotazione. Anche dopo una
promozione resta il 20% di esplorazione per continuare a provare formati e
sfondi nuovi. Le mappe pubblicate in Remote Config sono separate per
`kind + creativeBaseId + objective` (creatività) e `kind + creativeId +
objective` (sfondo); quando una coorte viene rivalutata senza segnale
sufficiente, il relativo vincitore viene rimosso invece di restare attivo.
Il Graph API resta un fallback esplicito: non si riusa il Page token come token
Insights.

### Esperimento audio TikTok (archiviato)

La descrizione seguente è storica e non è operativa. Nessun job o modalità del
robot lo applica a TikTok mentre la pubblicazione automatica è sospesa.

Storicamente il robot apriva l’editor nativo `Suoni` di TikTok Studio e
selezionava audio dalla scheda `Per te`.

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

### Formato TikTok «Risposta a voce» (archiviato)

Il formato e i relativi parametri sono conservati per riferimento; non
alimentano alcuna pubblicazione automatica. La descrizione qui sotto è storica.

`answer-voice-v1` risponde a una sola domanda presa dalla FAQ di un articolo
pubblicato: voce italiana (Gemini TTS), stesse parole a schermo, caption con la
domanda in prima riga. Il testo non viene riscritto. Il robot non applica suoni
di tendenza a questi video, perché sostituirebbero la voce.

| Parametro Firebase | Valori | Default locale |
|---|---|---|
| `TIKTOK_ANSWER_FORMAT_ROLLOUT_PERCENT` | `0`–`100` | `0` |

Vale per i post `article`. Senza una FAQ adatta o con la voce non disponibile,
il post torna al formato a slide e il ledger registra quello reale.

### Esperimento video TikTok (archiviato)

Il formato e i relativi parametri sono conservati per riferimento; non
alimentano alcuna pubblicazione automatica. La descrizione qui sotto è storica.

I video TikTok hanno ora un secondo test indipendente dall'audio nativo. Il
controllo resta il video composto dalle slide con dissolvenza; il pool di test
può usare una motion graphic verticale, un hook rapido di tre slide oppure uno
spotlight sulla statistica #1. Il renderer è deterministico e non scarica
filmati o musica esterna.

| Parametro Firebase | Valori | Default locale |
|---|---|---|
| `TIKTOK_VIDEO_CREATIVE_MODE` | `off` / `motion` / `experiment` | `off` |
| `TIKTOK_VIDEO_CREATIVE_ROLLOUT_PERCENT` | `0`–`100` non-control pool | `0` |
| `TIKTOK_VIDEO_CREATIVE_NEW_FORMAT_ROLLOUT_PERCENT` | `0`–`100` share of that pool | `0` |

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
node scripts/social-robot/run.mjs --publish --platform=instagram

# Anteprima testuale TikTok: non prepara o carica un contenuto multimediale.
node scripts/post-to-tiktok.mjs --dry-run --only=article

# Preview del prossimo Reel (non carica e non accoda nulla).
npx tsx scripts/post-to-instagram-reel.mjs --dry-run --kind=article

# La pubblicazione del Reel avviene dagli slot schedulati di
# instagram-reel-experiment.yml via Graph API; non richiede il robot.

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
- il limite giornaliero somma i post confermati nel ledger remoto e i pressi locali
  non ancora presenti lì, raggruppando i caroselli per media ID;
- gli slot Reel Graph API sono coordinati con il broadcast giornaliero, per
  restare entro due pubblicazioni Instagram nei giorni schedulati;
- 1,2-4,5 s fra un'azione e l'altra, digitazione carattere per carattere;
- 1,5-6 minuti fra i contenuti Instagram nella stessa finestra;
- dopo un muro di login o una verifica: piattaforma in pausa 12 ore;
- dopo un clic senza conferma: piattaforma ferma finché un umano non risolve;
- nel launch agent (`--jitter`) una sola prova a secco per post in coda, non
  una per finestra; a mano `--dry-run` la ripete sempre;
- i Reel hanno slot schedulati il lunedì e il venerdì; seguono lo stesso tetto
  di 2 post Instagram al giorno;
- una conferma inviata che dopo 2 ore non è ancora nel ledger viene rinviata
  alla finestra successiva (fino a 7 giorni dal clic).

## Dove guardare

| Cosa | Dove |
|---|---|
| Log | `~/Library/Logs/frontaliere/social-robot.log` |
| Profilo, journal, diagnosi | `~/Library/Application Support/frontaliere/social-robot/` |
| Screenshot e HTML di un errore o di una prova a secco | `.../social-robot/diagnostics/<ora>-<canale>-<id>/` |
| Errori | issue «Robot social: pubblicazione Instagram non riuscita» (deduplicata) |

Per ogni voce Instagram con metadati creativi, il log contiene anche una riga
`🧭 Instagram engagement` con l'hook, il loop e le finestre automatiche entro
24/48/72 ore. Lo stato del worker è locale in
`.../social-robot/instagram-community-state.json`: conserva hash degli ID,
timestamp e classi d'esito limitate; non salva testo di commenti, username o
messaggi. I conteggi settimanali aggregati e le latenze sono salvati solo nel
documento Firestore privato `social_native_insights/current`.

Il worker Graph invia un DM solo come risposta a una conversazione avviata
dall’utente e solo quando il Graph API fornisce un timestamp entro la finestra
automatica di 24 ore. Business Suite resta in sola lettura perché non espone in
modo affidabile chi ha scritto l'ultimo messaggio o quando. Graph risponde solo
a ringraziamenti/scelte brevi e semplici
richieste di link. Domande complesse, dati personali o richieste non coperte da
una fonte verificata restano da gestire da una persona; non fa outreach a
freddo. Le Stories sono follow-up visuali statici: il worker non finge di poter
creare sticker interattivi non esposti dal Content Publishing API.

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
