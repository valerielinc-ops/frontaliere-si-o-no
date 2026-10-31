# Recupero automatico dei guasti di rete e del provider CAPTCHA

Il dispatcher normale può affidare un invio a un Mac già autorizzato quando il
browser ha provato un guasto infrastrutturale prima del click finale. La policy
vale per tutti gli ordini: non contiene identificativi di candidati o datori.
Non acquista crediti, non configura chiavi NopeCHA e non cambia provider.

## Contratto di esecuzione

- `ASSISTED_APPLICATION_REMOTE_EXECUTOR` in Firebase Remote Config ha default
  locale vuoto, quindi disattivato. L'unico valore attivo è `mac-agenti`.
  Dispatcher e worker leggono direttamente il parametro, senza esportarlo in env.
- Il workflow hosted conserva il gruppo di concorrenza per ordine. Pubblica e
  rinnova l'autorità del controller nello stesso documento privato
  `automation/execution`; il Mac la consuma in uscita, con un solo slot globale.
- La richiesta lega dispatch, nonce, SHA di `main`, round e hash dei materiali
  approvati. La claim transazionale consuma un tentativo e assegna token e
  generazione monotona. Senza heartbeat valido del controller non si arma un click.
- Pagamento, CV verificato, mandato, ritiro, conservazione, approvazione e prove
  di invio vengono riesaminati prima del browser e nella transazione del click.
  Eventi, release e ricevute di una vecchia generazione sono rifiutati.
- Il solo `order.submittedAt` storico indica anche il caricamento del CV al
  servizio. Le prove di invio sono status canonico, flow/history, draft.sent e
  ledger di invio. Non si cancella né si modifica quel timestamp storico.
- La conservazione deve avere una scadenza canonica finita ancora futura, oppure
  un consenso talent pool attivo. Una scadenza non calcolabile resta sconosciuta
  e impedisce l'ammissione; la deadline viene ricontrollata al click.

## Classi di recupero

`portalInfrastructureEvidence.js` riconosce risposte strutturate del provider e
codici di navigazione finiti. Un testo generico del modello non autorizza il
cambio di host. Le vecchie ragioni `captcha`, `portal_needs_candidate` e
`portal_antibot` richiedono la stessa prova verificata; `posting_mismatch` resta
distinto anche se nella pagina compaiono errori del provider.

Per i record storici privi della nuova prova, il normale riconciliatore può
effettuare un riesame limitato dopo un nuovo fingerprint del motore. La sola
ragione storica non avvia il Mac. Hard fact, documenti, consenso e un click dal
risultato ambiguo non vengono aggirati.

Un host offline non consuma ammissioni Mac. Una consegna scaduta torna al clock
normale soltanto con prova transazionale di mancato invio. Il limite è due
ammissioni effettive per round in 24 ore; il backoff e la deduplicazione delle
notifiche restano quelli della coda esistente. Il retry infrastrutturale è
periodico: 5 minuti, 30 minuti, poi 2 ore anche dopo il terzo passaggio, sempre
soggetto ai controlli di consenso, conservazione, ritiro, annuncio e mancato
invio. I tre intervalli non sono un limite globale di tre tentativi. Il budget
delle ammissioni Mac è distinto dal clock delle consegne.

I report di stop/pass già redatti
tornano allo step hosted di correzione automatica; la conclusione del worker
non costituisce di per sé una ricevuta del datore.

La ricevuta resta del normale submission guard: `markSent` registra prima
l'invio provato, poi evento, stato ed email vengono riconciliati. Una risposta
HTTP riuscita, il completamento del processo o un token CAPTCHA non bastano.
L'esito ambiguo dopo un click rimane fermo finché una prova attendibile lo
risolve; non si cancella il ledger per ottenere un altro tentativo. Fatti,
consensi e documenti mancanti passano alle domande o alla verifica previste dal
workflow. Le notifiche tecniche conservano l'idempotenza per ordine/round e
indicano il prossimo tentativo pianificato, senza promettere invii o retry
infiniti all'utente.

## Installazione e attivazione

Usare esclusivamente il clone del sito e il service account già autorizzati sul
Mac. Dopo il merge e il fetch di `origin/main`, eseguire dall'host autorizzato:

```bash
bash scripts/assisted-application/install-mac-executor.sh "$PWD"
```

L'installer crea un LaunchAgent utente che esegue una release privata di sorgenti
Git approvati, senza il checkout mutabile né i node_modules condivisi. Le
dipendenze private vengono installate da lock con gli script npm disattivati;
servono almeno 5 GiB liberi. L'installazione non attiva il parametro Remote Config.
Un aggiornamento del trasporto richiede prima lo svuotamento e l'arresto del
vecchio worker; non si sovrappongono due installazioni.

Prima di caricare credenziali il worker deve superare il controllo della quota
free del provider, il probe del CLI Codex fissato alla stessa versione del
broker e la fixture locale dell'estensione. Il probe verifica lettura positiva,
negazione di una canary esterna, scrittura negata e rete negata nel modello.
Su Darwin il pin Codex 0.153.4 aggiunge permessi scratch a `:minimal`: il profilo
mantiene `:minimal` e nega esplicitamente i quattro glob `/tmp/**`,
`/private/tmp/**`, `/var/tmp/**`, `/private/var/tmp/**`. Runtime, home di login e
workspace stanno in cache privata del proprietario a modo 0700; solo il socket
IPC resta nel percorso temporaneo corto. Il profilo Linux resta invariato.
La sandbox del CLI non nega la lettura dell’ambiente di processi dello stesso
utente su questo macOS. Il modello concierge non riceve quindi strumenti:
un catalogo del tag ufficiale fissato conserva modello, provider, effort e Lite,
ma disabilita shell, patch, REPL, agenti, ricerca e utility. Solo il broker
concierge usa questa modalità; le review agentiche Linux conservano il contratto
precedente. Prima dell’autenticazione una fixture locale verifica la lista vuota
anche dentro `additional_tools` del protocollo Lite e il rifiuto di chiamate
shell/patch inventate senza effetti. Non si dichiara isolamento OS del modello.
Manager e agente deterministico SUBMIT hanno home e ambiente privati, ma
l’agente Node è codice fidato senza sandbox filesystem aggiuntiva. Il browser
applica direttamente il proprio primo profilo Seatbelt stretto; non eredita
ambiente dell’agente, service account o accesso al socket del broker. Un gate
di uscita temporaneo del manager ascolta solo su loopback e inoltra esclusivamente
HTTP/CONNECT verso IP pubblici verificati al momento della connessione. Rifiuta
DNS misto, LAN, Tailscale, indirizzi locali e IPv6 che incorporano indirizzi
privati; non intercetta TLS né registra header, URL o contenuti. Seatbelt
permette al browser solo la porta del gate, con proxy fisso e nessun DIRECT/PAC.
La fixture locale ha un'eccezione limitata al suo esatto host/porta; in produzione
non esiste questa eccezione. Anche le fetch Node dei posting usano DNS/IP pinning.

Manager e agente Node deterministico immutabile costituiscono il codice fidato:
l'agente può leggere il service account esistente tramite Admin SDK: non
si dichiara una whitelist filesystem sull’agente. L’ammissione remota esclude
draft, LibreOffice e codice generato; parser e template fissi sono dipendenze fidate. Browser e modello restano fuori da quel confine. Questa superficie richiede review prima
dell'attivazione sul Mac; non è una credenziale passata al modello.

Il wrapper registra atomicamente PID, gruppo e identità di partenza di ogni
Chrome prima dell'exec. Il manager chiude nuove registrazioni e termina tutti
i gruppi posseduti prima del cleanup e del prossimo job, anche dopo la morte
dell'agente. Una registrazione parziale con gruppo certamente morto viene recuperata
automaticamente. Con un gruppo vivo servono identità attuali provate: il nome
del marker non autorizza segnali. Se il leader Chrome è morto, il manager
verifica UID, PGID, eseguibile reale nel bundle approvato e witness privato
ereditato da un helper; confronta in memoria senza registrare ambiente o
argomenti. Un’identità sconosciuta o un gruppo non terminabile impediscono
una nuova esecuzione. Il riavvio riconcilia gli stessi marker privati.

Attivare il parametro solo dopo verifica reale dei probe sul Mac, heartbeat
`ready` fresco e deploy del backend e del workflow della stessa versione. La
modifica Remote Config deve preservare il template e usare il relativo ETag.
Il default vuoto arresta nuove ammissioni senza autorizzare reinvii ambigui.

## Prove richieste

I test riproducono i metadati sanitizzati dei precedenti errori 403 free-IP,
fencing di generazione, scadenza controller, ritiro e cambio materiali, host
offline senza consumo del budget, click ambiguo e scansione oltre un batch.
Syntax e fixture in-memory non certificano il sandbox di macOS o l'invio reale:
servono probe sul Mac e una ricevuta persistita dal normale submission guard.
I probe nativi devono dimostrare lettura positiva e negazione del cookie-canary,
TCP diretto e socket Unix privati negati con listener vivi prima e dopo il test,
CONNECT pubblico attraverso il gate funzionante e destinazioni private negate.
Il browser deve inoltre negare la lettura dell’ambiente di un processo Node
sintetico esterno, con controllo positivo non isolato sullo stesso PID. La
canary legge soltanto dati fittizi e analizza i confini NUL dell’ambiente:
non usa argomenti, errori o mancato avvio come prova di negazione. La lettura
possibile o una prova sconosciuta fermano il worker prima dell’autenticazione.
Questo confine del browser rimane distinto dalla modalità senza strumenti del
modello: il successo della seconda non certifica la prima.
Un errore di compilazione, timeout o un controllo positivo fallito significa
prova sconosciuta e impedisce readiness; non equivale a isolamento dimostrato.
