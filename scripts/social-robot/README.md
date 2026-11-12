# Robot social (Instagram e TikTok)

Il proprietario ha scelto il publisher web già autenticato per Instagram e
l'uploader browser già adottato per TikTok. I poster giornalieri generano le
code; il robot del Mac agenti le pubblica dal profilo persistente del browser.
La decisione è salvata in `DECISIONS.md` e usa flag Remote Config separati:
`SOCIAL_ROBOT_INSTAGRAM_BROWSER_PUBLISHING_OWNER_APPROVED` e
`SOCIAL_ROBOT_TIKTOK_BROWSER_PUBLISHING_OWNER_APPROVED`. È un'autorizzazione
del proprietario per questi percorsi web e non dichiara l'approvazione dei
rispettivi API di pubblicazione.

Instagram Reels usano il publisher web owner-approved e passano dal robot.
Insights e Community mantengono i propri flag Meta distinti. Per
TikTok, il workflow giornaliero/settimanale prepara video MP4 e accoda i post
per l'uploader browser; non legge token e non invoca il Content Posting API.

## Come funziona

1. Il poster Instagram (`scripts/post-to-instagram.mjs`, workflow
   `instagram-daily-broadcast.yml`) sceglie il carosello, genera le slide,
   le carica sulla CDN e, solo se la pubblicazione browser è autorizzata,
   mette il post pronto in `data/<canale>-queue.json` su `main`
   (`scripts/lib/social-publish-queue.mjs`). Il workflow TikTok
   `tiktok-daily-broadcast.yml` usa `post-to-tiktok.mjs` per preparare video MP4
   e metterli nella stessa coda TikTok. Il workflow schedulato
   `instagram-reel-experiment.yml` usa `scripts/post-to-instagram-reel.mjs` per
   generare cover e MP4 e mettere i Reel nella stessa coda del publisher web.
2. Il robot (`run.mjs`) legge da `origin/main` le code di entrambi i canali e
   pubblica i caroselli e i Reel Instagram, oltre ai video TikTok, dalla pagina
   web della piattaforma.
3. Solo dopo aver **visto la conferma** del carosello nella pagina,
   lancia `social-robot-confirm.yml`, che sposta il post dalla coda al ledger
   `data/<canale>-posted.json`. Un clic senza conferma visibile — o seguito da
   qualunque errore, anche una verifica o un muro di login — resta
   `unconfirmed`: il robot non lo ripubblica, apre una issue `needs-human` e
   **si ferma su quella piattaforma** finché un umano non risolve la riga.
   Non preme nemmeno un post successivo che ripete gli stessi articoli di un
   clic non ancora arrivato nel ledger. Dashboard Insights e community via
   browser vengono eseguiti solo se i rispettivi flag Meta sono attivi; in
   alternativa il community worker usa soltanto il Graph API esplicitamente
   selezionato.

Un esito browser ambiguo resta `unconfirmed`: il robot non ripete l'invio,
controlla prima la pagina dei post e registra nel ledger soltanto una conferma
visibile. La cadenza e i cap giornalieri esistenti continuano a valere per
entrambi i canali; un run del poster può indicare che un post è stato messo in
coda, non che la piattaforma l'abbia pubblicato.

Risolvere a mano un `unconfirmed` (nel journal
`~/Library/Application Support/frontaliere/social-robot/journal.json`):
se il post è online, registrarlo con `gh workflow run social-robot-confirm.yml`
(il ledger ne contiene allora l'id e il blocco cade da solo); se non lo è,
aggiungere `"resolvedAt": "<ora ISO>"` alla riga, o cancellarla.
Questo è solo il recupero di un errore del browser, non un passaggio della
gestione ordinaria dei contenuti.

## Interruttore (Firebase Remote Config)

`SOCIAL_ROBOT_PUBLISHING_MODE` controlla i poster e i click di pubblicazione:

| Valore | Poster Instagram/TikTok | Robot browser |
|---|---|---|
| `off` | non crea code web | non pubblica |
| `dry` (default: assente, vuoto o sconosciuto) | può preparare le code con il flag owner | preview, nessun click di pubblicazione |
| `live` | accoda i post usando i flag owner | pubblica le code solo per i canali autorizzati |

`SOCIAL_ROBOT_MODE` resta separato e controlla le altre attività del robot,
come Community e Insights. Attivare la pubblicazione non cambia quel valore.

I due flag owner autorizzano il publisher web per i canali scelti. I flag
`META_INSTAGRAM_BROWSER_INSIGHTS_APPROVED` e
`META_INSTAGRAM_BROWSER_COMMUNITY_APPROVED` sono separati e controllano solo
quelle funzionalità. `SOCIAL_ROBOT_INSIGHTS_SOURCE` seleziona ancora `browser`,
`graph` oppure `off`; Insights browser resta bloccato senza il relativo flag.

I valori sono tutti più corti di sei caratteri: il loader di Remote Config non
li maschera nei log di CI.

### Meta Insights e decisioni autonome

Il worker legge dal Professional Dashboard autenticato due finestre per ogni
post eleggibile: 24 ore per la diagnosi dell’hook e 72 ore per la decisione.
Le righe vengono salvate nella collezione privata Firestore
`social_native_insights/current`. Il workflow `instagram-insights-snapshot.yml`
esporta i dati solo in `$RUNNER_TEMP`, stampa uno scorecard descrittivo e mostra
candidati. `scripts/instagram-insights-decision.mjs` è un reporter legacy: il
gate `AUTONOMOUS_PROMOTION_PROTOCOL_READY=false` mantiene chiuse le scritture
Remote Config anche quando riceve `--apply`. Le vecchie soglie di 3
osservazioni, 15%/0,5 punti percentuali e 20% di esplorazione non sono policy
di promozione attiva.

Il motore autorevole per gli esperimenti sociali è il protocollo a campione
fisso schema v4 di `scripts/social-copy/experiment-protocol.mjs`, invocato dal
workflow `social-native-insights.yml` dopo la raccolta. Congela registrazioni,
valuta solo righe esatte e aggiorna la mappa Firebase soltanto quando campione,
copertura, guardrail e policy qualificano. Finché i grant e i campioni reali
non passano quei gate, i candidati restano descrittivi e l'assegnazione resta
deterministica. Il dettaglio del protocollo è in
`docs/social-ai-automation.md#learning-cadence-and-data-freshness`.

La configurazione `SOCIAL_ROBOT_INSIGHTS_SOURCE=browser` è solo una selezione:
il Dashboard reader resta spento finché
`META_INSTAGRAM_BROWSER_INSIGHTS_APPROVED` non è esattamente `true`. Graph API
è separata e richiede i grant documentati. Un esito browser vuoto, incompleto o
ambiguo resta non misurato: non viene convertito in zero e non abilita un
vincitore.

### Esperimento audio TikTok (archiviato)

La descrizione seguente è storica e non è operativa; l'esperimento audio è
archiviato e non rientra nella cadenza di pubblicazione attuale.

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

# Il workflow instagram-reel-experiment.yml prepara i Reel e li accoda al
# publisher web quando il flag owner Instagram è attivo.

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
- gli slot Reel sono coordinati con il broadcast giornaliero, per
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
