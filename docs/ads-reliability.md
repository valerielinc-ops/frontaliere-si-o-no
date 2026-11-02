# Recupero e diagnosi degli annunci

Il caricamento della libreria, la richiesta del singolo slot e il consenso sono
stati distinti. Uno script lento non dimostra un blocco pubblicitario; un replay
senza contenuto nell'iframe non dimostra l'assenza di annunci.

## Contratti di consegna

- Gli slot `in-article` richiedono almeno 250 px effettivi, misurati sia sull'ins
  sia nel contenuto del contenitore. Restano esclusi dalla coda implicita Google
  finché non hanno spazio e non si avvicinano al viewport. Un ridimensionamento
  può recuperarli senza una seconda richiesta sullo stesso nodo.
- Un singleton per libreria condivide caricamento e tentativi fra HTML statico
  e React: un tentativo iniziale e due retry, dopo 2 e 6 secondi, solo su errore
  effettivo. Dopo 12 secondi senza risposta lo stato è `waiting_response`:
  lo script rimane attivo e può completarsi, senza download duplicati.
- I retry verificano nuovamente consenso, entitlement e privacy del documento.
  Un segnale positivo di adblock interrompe i retry; il primo caricamento
  AdSense resta disponibile anche per Auto Ads.
- La decisione verificata dalla CMP rimane valida nel documento corrente anche
  quando localStorage rifiuta la scrittura. Non sopravvive a un nuovo documento
  senza conferma della CMP o persistenza riuscita.

## Recupero indipendente

`site-support-<hash>.js` viene pubblicato separatamente dal loader AdSense.
Avvia la CMP Google e osserva disponibilità del consenso, errori reali e
risultati degli slot. Il probe cosmetico locale deriva dal quick bait IAB,
non scarica liste o script remoti e restituisce `unknown` se il documento non
è misurabile. Le licenze delle integrazioni sono in `docs/licenses/`.

Un rilevamento positivo può mostrare una sola richiesta di autorizzazione per
sessione. Un errore reale usa un messaggio neutro. La UI spiega come autorizzare
il sito e ricaricare; il browser non permette a un sito di modificare in modo
universale la whitelist di estensioni e Shields. Il pulsante privacy apre la
CMP certificata Google: non scrive `granted` né costruisce stringhe TCF.

La promozione del servizio di ricerca lavoro è contenuto first-party esterno
agli slot Google. Compare per blocco, errore, dimensioni insufficienti o no-fill;
si rimuove quando un annuncio risulta effettivamente riempito. Messaggi Google
già visibili hanno precedenza. Un semplice ritardo o consenso ancora pendente
non produce la promozione. La UI resta chiudibile e non blocca la lettura.
Un vecchio no-fill non prevale su un caricamento o retry ancora in corso.

Nelle webview senza `MutationObserver`, gli slot mantengono la lettura delle
risposte tardive tramite polling, rilasciato alla rimozione dello slot o allo
stop del controller. Il recovery usa un solo heartbeat, sospeso sulle route
escluse e in background, che riparte sugli eventi di navigazione e ritorno
in primo piano. L'osservatore ordinario ignora le mutazioni estranee ad annunci,
script Google e messaggi CMP. Il bootstrap statico scopre anche slot aggiunti
dopo il caricamento, conserva un solo monitor di documento senza MutationObserver
e verifica di nuovo consenso, entitlement e privacy prima di ogni richiesta.

L'integrazione React è un adattamento locale MIT di `@ctrl/react-adsense`:
mantiene espliciti gli errori e usa il requester condiviso. La versione 3.x
richiede React 19.3, mentre il sito usa 19.2; non viene installata una dipendenza
con peer incompatibili. Il progetto IAB ha un contratto semplice e verificabile;
anzianità e stelle dei detector non dimostrano compatibilità con ogni blocker.

## Telemetria

Il segnale DOM `data-ft-ad-request-pending` rappresenta richieste effettivamente
avviate dal lifecycle, non lo stato grafico iniziale di un placeholder GPT.
Ogni controller rilascia il proprio segnale su fill, no-fill, errore, stop o
rinvio per larghezza insufficiente. Più controller sullo stesso contenitore
mantengono evidenze indipendenti; una risposta lenta rimane pending. Le shell
precedenti sono riconosciute anche tramite gli stati manuali e il query ID GPT,
senza assumere che ogni `data-ad-state="loading"` sia una richiesta già partita.

Gli eventi GA4 `ad_script_state`, `ad_slot_waiting_width`, `ad_slot_error`,
`ad_slot_width_timeout`, `ad_cmp_state`, `ad_cmp_recovery`, `ad_block_probe` e
`ad_reliability_state` distinguono libreria, tentativo, geometria e causa.
`ad_recovery_prompt`, `ad_recovery_action` e `ad_recovery_outcome` separano la
richiesta di aiuto dal risultato: solo un DOM Google filled conferma
`ads_restored`. `ad_fallback_shown/click/dismiss` misurano il servizio alternativo.
Nei report GA4, filtrare per `eventName` e usare le dimensioni EVENT già
registrate: `reason` per la causa, `action` per state/outcome/result o azione,
`component` per la libreria e `cta_surface` per la superficie del fallback.
I parametri originari restano nell'evento. Questa mappatura evita di inviare
stati e risultati consultabili solo nel debug quando la quota dimensioni è piena.
`ad_unavailable` registra subito i fallimenti degli slot anche quando la
riserva visibile viene mantenuta per evitare CLS.

Non vengono inviati errori grezzi, query string, TC string o identificatori dei
replay. Anche la telemetria può essere bloccata: i conteggi osservati non sono
una stima completa degli utenti o dei ricavi persi. Valutare insieme richieste,
impression, viewability e ricavi AdSense, senza promettere un recupero percentuale.

## Cloudflare

La CDN accelera gli asset del sito. I nomi SHA-256 a 12 caratteri di gtag-init,
adsense-loader, partnerize-tag e site-support ricevono cache immutabile per un
anno; gli alias stabili restano a 600 secondi. Il percorso rapido pubblica e
verifica gli asset prima dell'HTML che li cita, anche nel corpus. Le verifiche
usano GET: HEAD può rispondere DYNAMIC con le regole della zona.

Non fare proxy o cache di gpt.js, pubads_impl o adsbygoogle.js. Non usare Rocket
Loader per differire il bootstrap del recupero (`data-cfasync="false"` nel tag
HTML). Zaraz non sostituisce automaticamente AdSense/GPT o una CMP certificata
da Google. La CDN non rimuove filtri del browser, rifiuti del consenso o no-fill.

## Verifica e rollback

I test coprono 161/249/250 px, padding del contenitore, idempotenza statico/React,
errore temporaneo, retry esauriti, successo tardivo, consenso revocato, storage
non scrivibile, adblock positivo/unknown, CMP visibile e pagina già filled.
Verificare il popup in italiano/inglese/tedesco/francese, a 275 e 390 px e su
desktop, con navigazione da tastiera. In produzione controllare hash, HTTP 200
e cache degli asset, caricamento Google e assenza di duplicati.

Se il recupero copre messaggi Google o annunci funzionanti, correggere/revertire
il produttore site-support e rigenerare nello stesso giro snapshot e fingerprint
del corpus. Se le nuove chiavi rispondono 404, fermare la pubblicazione HTML e
ripristinare gli asset prima di riprendere; non rimuovere i gate. Un aumento
misurato di richieste senza impression/viewability richiede verifica del
scheduler, non la disattivazione di Auto Ads.

## Fonti

- [Dimensione minima in-article](https://support.google.com/adsense/answer/9274522?hl=en-GB)
- [Best practice GPT: caricamento diretto da Google](https://developers.google.com/publisher-tag/guides/general-best-practices)
- [Fine del one-click allowlisting](https://support.google.com/admanager/answer/10954990?hl=en-0)
- [Requisiti CMP certificata Google](https://support.google.com/admanager/answer/13554116?hl=en)
- [Esclusione da Rocket Loader](https://developers.cloudflare.com/speed/optimization/content/rocket-loader/ignore-javascripts/)
- [Strumenti supportati da Zaraz](https://developers.cloudflare.com/zaraz/reference/supported-tools/)
- [Brave e blocco cookie notice](https://brave.com/privacy-updates/21-blocking-cookie-notices/)
- [Fallback EthicalAds](https://ethical-ad-client.readthedocs.io/en/stable/#showing-content-when-there-isn-t-an-ad)
