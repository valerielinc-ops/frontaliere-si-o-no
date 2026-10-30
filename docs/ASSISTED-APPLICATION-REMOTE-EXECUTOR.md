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

Un host offline non consuma tentativi. Una consegna scaduta torna al clock
normale soltanto con prova transazionale di mancato invio. Il limite è due
ammissioni effettive per round in 24 ore; il backoff e la deduplicazione delle
notifiche restano quelli della coda esistente. I report di stop/pass già redatti
tornano allo step hosted di correzione automatica; la conclusione del worker
non costituisce di per sé una ricevuta del datore.

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
Browser e agente deterministico hanno home private e profili Seatbelt distinti;
il browser non eredita ambiente, service account o socket del broker. Il normale
agente deterministico conserva l'accesso al solo file del service account
esistente per usare Admin SDK. Questa superficie richiede review prima
dell'attivazione sul Mac; non è una credenziale passata al modello.

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
