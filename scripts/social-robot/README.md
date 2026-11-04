# Robot social (Instagram Graph API; TikTok in sola lettura)

Il robot Mac non pubblica caroselli né raccoglie Insights Instagram tramite
browser. Feed, Reel, Stories e attività community usano le route Graph API
ufficiali, quando grant e token sono pronti. Le vecchie voci in
`data/instagram-queue.json` restano in hold e non vengono drenate dal browser.
Senza token Graph il publisher schedulato fallisce in modo visibile; non lascia
una coda che possa sembrare una pubblicazione riuscita.

TikTok resta escluso dalla pubblicazione automatica: il workflow
`tiktok-daily-broadcast.yml` è un'anteprima, `post-to-tiktok.mjs` blocca gli
invii reali e il robot filtra il canale anche quando viene richiesto. La
raccolta TikTok usa un workflow separato per gli Insights autorizzati.

## Come funziona

1. `instagram-daily-broadcast.yml` seleziona e renderizza i caroselli, quindi
   li pubblica con Graph API. Il ledger registra il `mediaId` esatto restituito
   da Meta. Token/account mancanti e rifiuti definitivi fanno fallire il job;
   uno slot vuoto o un cap raggiunto restano skip espliciti.
2. `instagram-reel-experiment.yml` pubblica Reel con il container Graph API e
   registra l'ID nativo. Il worker community usa Graph API per le risposte e le
   Stories ammesse; non apre Chrome per leggere o pubblicare.
3. `social-native-insights.yml` raccoglie le metriche native via Graph API e
   salva dati privati. Le decisioni creative usano il protocollo a campione
   fisso v4; righe browser o attribuzioni senza ID media esatto non qualificano
   esperimenti o vincitori.

Non c'è approvazione manuale per ogni post. Se Graph accetta il post e
restituisce un `mediaId`, il publisher registra il risultato autonomamente.
Un esito finale ambiguo mantiene la prenotazione e non viene ritentato alla
cieca; finché non arriva una prova API positiva, il canale resta in hold per
evitare duplicati. L'abilitazione live dipende da Meta App Review, grant e
token effettivamente validi.

Le funzioni storiche di riconciliazione TikTok restano nel codice per leggere
eventuali record preesistenti, ma il robot non avvia più il browser TikTok e
non cerca né pubblica nuovi contenuti su quel canale.

Le vecchie righe `unconfirmed` del journal sono residui del trasporto browser
precedente. Non vengono ritentate dal publisher Graph e vanno riconciliate con
la verifica nativa prima di essere archiviate.

## Interruttore (Firebase Remote Config)

`SOCIAL_ROBOT_MODE` controlla il worker legacy e le azioni community; non può
attivare la pubblicazione browser Instagram. Il feed schedulato usa readiness
e token Graph indipendenti.

| Valore | Caroselli | Reel | Robot |
|---|---|---|---|
| `off` | Graph API nel workflow schedulato | Graph API se le credenziali sono configurate | community disattivata |
| `dry` (default: assente, vuoto o sconosciuto) | Graph API nel workflow schedulato | Graph API se le credenziali sono configurate | community in sola simulazione |
| `live` | Graph API nel workflow schedulato | Graph API se le credenziali sono configurate | solo azioni Graph consentite; TikTok resta filtrato |

`SOCIAL_ROBOT_INSIGHTS_SOURCE=browser`, se ancora presente in Remote Config,
non riattiva l'accesso browser: il worker ignora quel trasporto e il collector
Graph separato resta l'unica fonte automatica. Il worker non usa il profilo
Chrome per Instagram.

Il launcher Mac importa da Remote Config solo `FB_PAGE_ID`,
`FB_PAGE_ACCESS_TOKEN`, `FB_USER_ACCESS_TOKEN`, `INSTAGRAM_ACCESS_TOKEN`,
`INSTAGRAM_BUSINESS_ACCOUNT_ID` e `SOCIAL_ROBOT_MODE`. L'account di servizio
Firebase resta un file locale separato; il worker non carica nel proprio
ambiente le altre credenziali configurate dal sito.

I valori consentiti di `SOCIAL_ROBOT_MODE` sono più corti di sei caratteri; il
loader di Remote Config non li maschera nei log di CI.

### Meta Insights e decisioni autonome

Il workflow `instagram-insights-snapshot.yml` esporta le osservazioni native
solo in `$RUNNER_TEMP`, stampa uno scorecard descrittivo e mostra candidati.
`scripts/instagram-insights-decision.mjs` è un reporter legacy: il gate
`AUTONOMOUS_PROMOTION_PROTOCOL_READY=false` mantiene chiuse le scritture
Remote Config anche quando riceve `--apply`. Le vecchie soglie non sono policy
di promozione attiva.

Il motore autorevole per gli esperimenti sociali è il protocollo a campione
fisso schema v4 di `scripts/social-copy/experiment-protocol.mjs`, invocato dal
workflow `social-native-insights.yml` dopo la raccolta. Congela registrazioni,
valuta solo righe esatte e aggiorna la mappa Firebase soltanto quando campione,
copertura, guardrail e policy qualificano. Finché i grant e i campioni reali
non passano quei gate, i candidati restano descrittivi e l'assegnazione resta
deterministica. Il dettaglio del protocollo è in
`docs/social-ai-automation.md#learning-cadence-and-data-freshness`.

Graph API è l'unica fonte automatica di Insights. Le righe storiche browser
possono restare in archivio, ma non sono prova di crescita né qualificano un
vincitore; token e grant Meta devono essere verificati prima di chiamare il
dato live.

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
# Diagnostica i canali browser; Instagram e TikTok in hold non aprono Chrome.
node scripts/social-robot/run.mjs --login

# Preview del worker (nessun browser Instagram e nessun publish Graph).
node scripts/social-robot/run.mjs --dry-run --platform=instagram

# Community Graph API: le azioni reali richiedono Remote Config `live`.
node scripts/social-robot/run.mjs --publish --platform=instagram

# Anteprima testuale TikTok: non prepara o carica un contenuto multimediale.
node scripts/post-to-tiktok.mjs --dry-run --only=article

# Preview del prossimo Reel (non carica e non accoda nulla).
npx tsx scripts/post-to-instagram-reel.mjs --dry-run --kind=article

# La pubblicazione del Reel avviene dagli slot schedulati di
# instagram-reel-experiment.yml via Graph API; non richiede il robot.

# Launch agent: due finestre community al giorno (default 11:30 e 18:30 ora
# locale, SR_WINDOWS="HH:MM HH:MM" per cambiarle), più fino a 20 minuti casuali.
bash scripts/social-robot/launchd.sh install
bash scripts/social-robot/launchd.sh status
bash scripts/social-robot/launchd.sh uninstall
```

Il launch agent non esegue il working tree del checkout (che può essere su un
altro ramo): a ogni finestra estrae i file del worker da `origin/main` in uno
snapshot nella cartella di stato e usa i `node_modules` del checkout. Le azioni
Instagram usano token Graph da Remote Config e non richiedono una sessione
grafica o un profilo browser.

## Cadenza (`lib/cadence.mjs`)

- Instagram feed/Reel restano entro due post al giorno; il limite vive nelle
  prenotazioni condivise Graph API e non dipende dal robot browser;
- gli slot Reel Graph API sono coordinati con il broadcast giornaliero, per
  restare entro due pubblicazioni Instagram nei giorni schedulati;
- le pause di battitura e i tempi browser documentano il vecchio trasporto e
  non vengono applicati ai publisher Graph;
- i Reel hanno slot schedulati il lunedì e il venerdì; seguono lo stesso tetto
  di 2 post Instagram al giorno;
- una conferma inviata che dopo 2 ore non è ancora nel ledger viene rinviata
  alla finestra successiva (fino a 7 giorni dal clic).

## Dove guardare

| Cosa | Dove |
|---|---|
| Log | `~/Library/Logs/frontaliere/social-robot.log` |
| Journal e stato community | `~/Library/Application Support/frontaliere/social-robot/` |
| Diagnostica locale di un run browser legacy | `.../social-robot/diagnostics/<ora>-<canale>-<id>/` |
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

Nessuna credenziale passa dal repository: il token Graph viene caricato in
memoria da Firebase Remote Config durante la finestra del launch agent.

## Test

- `tests/social-robot.test.ts`: scelta dalla coda, cadenza e tetto giornaliero,
  marcatura solo dopo la conferma, issue su errore, interruttore, plist.
- `tests/instagram-reel.test.ts`: tre trattamenti, card verticali, metadati e
  coda MP4.
- `node scripts/social-robot/robot-e2e.mjs` (workflow `social-robot-e2e.yml`):
  i flussi Playwright, inclusi dry-run e publish simulato del Reel, su pagine
  locali che imitano Instagram e TikTok.
