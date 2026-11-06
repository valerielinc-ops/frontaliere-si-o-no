# Strategia creativa Instagram — Frontaliere Ticino

> Studio e piano operativo aggiornati al 9 ottobre 2026. Questo documento
> separa ciò che è stato verificato da ciò che va ancora validato con i dati
> Insights dell’account.

## 1. Diagnosi

### Stato del profilo

Il profilo pubblico [@frontaliereticino](https://www.instagram.com/frontaliereticino/)
è in fase di avvio: al momento dell’audit mostrava 1 follower, 7 post e 0
following. La bio promette tre utilità concrete — simulatore netto stipendio,
lavoro, traffico ai valichi — ma il profilo non ha ancora una community
abbastanza grande da permettere conclusioni sui contenuti migliori.

La priorità, quindi, non è inseguire un’estetica perfetta: è rendere ogni post
riconoscibile, utile da salvare o condividere e capace di aprire una
conversazione reale.

### Stato della pipeline esistente

La pipeline in `scripts/post-to-instagram.mjs` già fa bene quattro cose:

- sceglie i lavori e gli articoli usando dati GA4 reali;
- genera carousel quadrati 1080×1080 e li pubblica tramite Instagram Graph API;
- usa UTM e un ledger per collegare il post al traffico e non ripetere sempre
  gli stessi elementi;
- pubblica anche una classifica settimanale delle dogane.

Il limite era editoriale: la stessa formula “top 5 + link in bio” veniva usata
per ogni slot. Una frequenza automatica senza variazione di promessa tende a
sembrare un bollettino, non una voce utile per chi vive il confine.

## 2. Cosa emerge dallo studio Instagram

Le fonti di piattaforma indicano due opportunità coerenti con il progetto:

1. Meta descrive i Trial Reels come uno spazio per provare nuovi temi e
   formati su non-follower, con metriche iniziali dopo circa 24 ore e una
   possibile distribuzione più ampia entro 72 ore: i Reel devono essere
   prodotti come esperimenti, non come campagne “perfette” al primo tentativo.
   [Fonte: Meta — Trial Reels](https://about.fb.com/news/2024/12/trial-reels-try-content-non-followers-first-see-what-perfoms-best/)
2. Meta ha introdotto repost e una sezione Friends nei Reels: i contenuti
   pubblici ricondivisi possono essere raccomandati ai follower di chi li
   riposta. Questo rende “mandalo alla persona che…” una richiesta più naturale
   per un contenuto utile, purché la promessa sia concreta.
   [Fonte: Meta — New Instagram Features to Help You Connect](https://about.fb.com/news/2025/08/new-instagram-features-help-you-connect/)
3. I benchmark di settore trattano i carousel come un formato forte per
   salvataggi e condivisioni perché permettono di distribuire una risposta in
   più passaggi. Il dato è direzionale, non un obiettivo universale: il
   riferimento finale deve essere il rapporto tra reach, salvataggi,
   condivisioni e commenti di questo profilo.
   [Fonte direzionale: Sprout Social — Instagram Carousel](https://sproutsocial.com/insights/instagram-carousel/)

### Conseguenza strategica

Non eliminiamo i carousel data-driven: li trasformiamo in tre promesse diverse.

| Trattamento | Promessa al lettore | Azione primaria | Metrica primaria |
|---|---|---|---|
| `proof` — Dato verificabile | “Qui trovi cosa è successo davvero” | passaparola | condivisioni |
| `save` — Guida da salvare | “Ti servirà quando dovrai decidere” | archivio personale | salvataggi |
| `question` — Domanda alla community | “La tua esperienza orienta il prossimo contenuto” | risposta | commenti |

La classifica e i numeri restano gli stessi; cambiano hook, cover, ultima
slide, caption e campo di misurazione.

## 3. Pilastri editoriali

### Utilità economica e fiscale

Netto stipendio, nuovo/vecchio frontaliere, cambio CHF/EUR, LAMal/SSN,
franchigie e scadenze. Sono contenuti da salvare: un singolo numero deve
portare a un calcolo o a una guida, mai a una promessa fiscale assoluta.

### Lavoro concreto

Offerte, settori, aziende, competenze richieste e micro-guide per candidarsi.
La domanda ricorrente deve essere: “Che ruolo stai cercando?”; le risposte
possono diventare il brief del post successivo.

### Vita oltre il confine

Dogane, orari, tragitti e costo del pendolarismo. Il valore è locale e
condivisibile: luogo + momento + dato, con tag geografico solo quando è
verificato.

### Community e voce umana

Risposte a domande reali, mini-interviste a frontalieri, errori frequenti e
storie anonime. È il pilastro che impedisce al profilo di diventare una bacheca
automatizzata.

## 4. Formati da produrre

### Carousel “dato → decisione”

- Slide 1: una domanda leggibile in un secondo.
- Slide 2–6: un dato per slide, con fonte/data o contesto minimo.
- Ultima slide: una sola azione coerente con l’obiettivo (`Condividi`, `Salva`
  oppure `Rispondi`).
- Caption: una sola idea, elenco breve, CTA esplicita, link in bio.

È il formato automatizzato in questa implementazione. Il carousel ora chiude con
una slide CTA e registra `creativeId`, obiettivo, metrica e meccanismo della CTA
nel ledger.

### Reel “un problema, un numero, una svolta”

Formato verticale da 9–12 secondi, da provare anche come Trial Reel:

1. 0–2 s: “Con CHF 5.000, quanto ti resta davvero?” oppure “Questa dogana ti
   fa perdere 20 minuti?”
2. 2–8 s: un dato reale o un titolo verificabile; testo leggibile anche senza
   audio.
3. 8–12 s: una sola azione misurabile.
4. Per il formato umano, “Scrivi `NETTO` / `DOGANA` nei commenti” solo se si è pronti a
   rispondere, oppure “salva il video”.

Il primo Reel automatizzato usa tre card verticali generate dai dati GA4; non
finge una testimonianza umana. I Reel con voce, riprese locali o risposta a un
commento restano un secondo filone editoriale e richiedono revisione umana.

### Stories “sondaggio → risposta”

Serie di 3–4 Stories dopo ogni contenuto forte:

- sondaggio: “LAMal o SSN?” / “Brogeda o Chiasso?”;
- box domande: “Qual è il dubbio che nessuno ti ha spiegato?”;
- risposta il giorno dopo con un dato o un link al contenuto completo;
- sticker link al percorso UTM tracciato.

Il sondaggio deve raccogliere una decisione vera, non un “like bait”.

### Comment-reply Reel

Una domanda utile ricevuta nei commenti diventa l’hook del Reel seguente. Si
mostra il commento (con permesso o anonimizzato), si risponde in 20 secondi e
si chiude con una domanda più precisa. È il ciclo più diretto per trasformare
engagement in nuova materia editoriale.

## 5. Implementazione presente

Il modulo `scripts/lib/instagram-creative.mjs` contiene una matrice 3 × 3:
tre obiettivi (`proof`, `save`, `question`) e tre varianti di hook per ciascun
obiettivo. La rotazione è deterministica per data e tipo di contenuto.

- gli slot articolo e lavoro dello stesso giorno ricevono trattamenti diversi;
- lo slot dogane ruota per settimana, quindi un retry del lunedì non cambia
  creatività;
- il caption esplicita l’azione primaria;
- `utm_content` include creatività + slug;
- il ledger conserva `creativeId`, `creativeBaseId`, `creativeVariant`,
  `creativeObjective`, `primaryMetric` e `engagementMechanic`;
- `social-carousel-image.mjs` aggiunge una slide finale CTA senza superare il
  limite di 10 elementi del carousel;
- `scripts/lib/instagram-reel-creative.mjs` definisce tre varianti separate:
  domanda immediata (`comments`), numero in primo piano (`shares`) e
  promemoria pratico (`saves`);
- la domanda immediata riduce la fatica del commento con una parola-chiave:
  `GUIDA` per gli articoli e `LAVORO` per le offerte; il ledger conserva anche
  il meccanismo (`keyword-comment`, `direct-share` o `save-reminder`) così la
  risposta non viene confusa con quella di una CTA diversa, sia per carousel
  sia per Reel;
- la conferma del robot arricchisce anche i Reel già in coda prima
  dell’introduzione di `engagementMechanic`, usando solo la matrice nota dei
  Reel; i carousel storici non vengono classificati retroattivamente dalla
  sola metrica;
- `scripts/lib/social-reel-image.mjs` compone tre card 1080×1920 e il poster
  `scripts/post-to-instagram-reel.mjs` genera un MP4 verificato, una cover e una
  voce di coda distinta (`kind: reel`);
- `instagram-reel-experiment.yml` mantiene il dispatch manuale ma riserva anche
  due slot automatici a settimana (articolo il lunedì, lavoro il venerdì),
  prima della coda carousel quotidiana: usa uno dei due slot del robot e non
  aggiunge un terzo post giornaliero;
- il generatore non sostituisce una coorte Reel pending e aspetta 72 ore dalla
  pubblicazione precedente prima di aprire la successiva, così il confronto
  resta leggibile nel tempo;
- il robot riconosce il file video, seleziona il composer Reel e attende la
  conferma “Il tuo reel è stato condiviso” prima di inviare il ledger;
- la rotazione è pura e non introduce esperimenti PostHog: l’eventuale test
  futuro va letto da Instagram Insights + GA4. Se si introduce un flag remoto,
  dovrà passare da Firebase Remote Config secondo le regole del workspace.

## 5 bis. Primo test live verificato — 10 ottobre 2026

Il primo ciclo della matrice è stato pubblicato dal robot locale con il profilo
Instagram autenticato. La catena operativa è quindi verificata end-to-end:
selezione della creatività, generazione del carousel, upload nel browser,
pressione di `Condividi`, conferma visibile e registrazione nel ledger.

- `article-2026-10-09`: 5 elementi con `question-choice` / “Scelta guidata”;
- `job-2026-10-09`: 5 elementi con `question-story` / “Esperienza personale”;
- tutti i 10 elementi hanno evidenza `Post condiviso` e la coda Instagram è
  vuota dopo la conferma;
- non viene ancora dichiarato un vincitore: i campi `views` del ledger sono
  visualizzazioni del contenuto sul sito, non reach, commenti o condivisioni
  Instagram.

Il prossimo passo non è aumentare la frequenza a caso: la rotazione deterministica
continua con i trattamenti successivi e ogni trattamento resta eleggibile solo
dopo almeno tre osservazioni comparabili nella stessa finestra di 72 ore. Il
Reel è ora un asse separato e controllato: il workflow manuale resta disponibile
per preview e coorti scelte, mentre la pianificazione automatica apre al massimo
due slot settimanali; il robot pubblica solo quando c’è uno slot utile, e hook,
durata, CTA e metrica restano separati dal confronto carousel.

La cadenza automatica riserva due slot settimanali (articolo il lunedì e lavoro
il venerdì), con una guardia di 72 ore tra pubblicazioni successive.

I test offline e il browser E2E verificano già tre card verticali, il render
JPEG, il percorso MP4, il dry-run del Reel, la conferma simulata e il mancato
invio in preview. La prima pubblicazione reale del Reel resta il prossimo
passo operativo, dopo aver scelto uno slot senza sovrapporlo ai due carousel
quotidiani.

La validazione operativa è positiva; la validazione di performance è ancora
aperta perché il collector read-only non dispone del token Meta necessario a
leggere gli Insights. In assenza di quel dato non si usa il successo tecnico
come prova di engagement.

## 6. Piano di test di 30 giorni

Il primo ciclo è una baseline creativa, non una dichiarazione di vittoria.

### Cadenza

- mantenere i carousel automatici quotidiani di lavori e articoli;
- mantenere il carousel dogane settimanale;
- aggiungere manualmente 2 Reel a settimana: uno economico/fiscale e uno
  lavoro/pendolarismo;
- aggiungere Stories interattive nei giorni dei Reel;
- rispondere ai commenti entro 24 ore, con una risposta informativa e una sola
  domanda di approfondimento.

### Scheda di rilevazione

Per ogni post, osservare due finestre separate nel Meta Professional Dashboard
o nel dataset automatico:

- a 24 h: segnale diagnostico per capire se hook, copertina e CTA stanno
  generando la prima reazione;
- a 72 h: finestra decisionale da usare per confrontare le varianti.

In entrambe le finestre registrare:

- reach totale e reach non-follower;
- like, commenti, salvataggi, condivisioni e visite al profilo;
- per Reel: visualizzazioni, tempo medio e completamento;
- clic al sito per `utm_campaign` + `utm_content` in GA4;
- eventuali domande ricevute e numero di risposte utili generate.

Confrontare i trattamenti per tasso, non per conteggio assoluto:

- proof: `condivisioni / reach`;
- save: `salvataggi / reach`;
- question: `commenti / reach`.

Non scegliere un vincitore dopo un solo post. Servono almeno tre osservazioni
per trattamento nello stesso tipo di contenuto; poi si mantiene il migliore e
si riscrive quello debole. Un miglioramento del 20% è un buon segnale operativo,
non una prova statistica con un profilo appena avviato.

La raccolta ora è automatizzata dal workflow `Instagram Insights Snapshot`,
una volta al giorno. Nel run standard il workflow raccoglie sia la finestra
diagnostica a 24 ore sia quella decisionale a 72 ore; le righe restano separate
tramite `windowHours` e non vengono mai aggregate insieme. Legge il ledger dei
post confermati, interroga soltanto le superfici read-only di Meta e salva
`data/instagram-insights.json` quando ciascuna finestra è stata raggiunta. Il
comando locale equivalente per una singola finestra è:

```bash
node scripts/instagram-insights-snapshot.mjs \
  --ledger data/instagram-posted.json \
  --output data/instagram-insights.json \
  --window-hours 72 \
  --dry-run
```

Per un controllo diagnostico anticipato usare `--window-hours 24`; la finestra
a 24 ore serve a correggere rapidamente hook e CTA, non a dichiarare il
vincitore. La decisione editoriale resta ancorata alla finestra a 72 ore e ad
almeno tre post comparabili.

Il collector usa l’`instagramMediaId` già presente quando possibile; per i post
confermati dal robot che non lo conservano, cerca un solo media dell’account
compatibile con l’orario di conferma. Non attribuisce il dato se trova più
possibilità, se il media dichiarato non ritorna dall’account o se mancano i
metadati della creatività. `snapshotAgeHours` e il metodo di riconciliazione
restano nel dataset per audit; per i nuovi post, `engagementMechanic` segue il
post fino allo snapshot e alla scorecard (`keyword-comment`, `direct-share` o
`save-reminder`). I post storici senza questo campo restano
senza attribuzione della meccanica, per non confondere una metrica con una CTA.
La tolleranza anticipata è disattivata di default; si può usare solo
esplicitamente per una prova diagnostica.

## 7. Aggiornamento dello studio pubblico e matrice sperimentale

Lo studio iniziale va letto insieme a questi segnali pubblici, che non sono
benchmark di performance dell’account ma indicano quali promesse vale la pena
mettere alla prova:

- Meta presenta i Trial Reel come un modo per testare nuovi temi e formati sui
  non-follower, con un primo controllo dopo circa 24 ore e una possibile
  condivisione più ampia entro 72 ore. Per questo i Reel sperimentali devono
  avere un hook misurabile, non essere semplicemente “contenuti extra”.
  [Meta — Trial Reels](https://about.fb.com/news/2024/12/trial-reels-try-content-non-followers-first-see-what-perfoms-best/)
- Meta segnala che repost, tab Friends e contenuti con localizzazione possono
  favorire conversazioni e scoperta locale. Le CTA di condivisione diventano
  quindi più precise: “ripostalo a chi attraversa questo valico”, non un
  generico “metti like”.
  [Meta — New Instagram Features](https://about.fb.com/news/2025/08/new-instagram-features-help-you-connect/)
- TIResidenti si presenta come community ticinese attiva su Facebook e
  Instagram, vende pubblicazioni come Reel e sottolinea revisione editoriale e
  moderazione. Il segnale competitivo è chiaro: per distinguersi da un feed di
  annunci serve presidio umano, non solo frequenza.
  [TIResidenti — media kit/community](https://www.tiresidenti.ch/)
- UFIS dichiara di aver ricevuto richieste su fiscalità, regimi vecchi e nuovi,
  previdenza, NASpI, sanità, smart working e pratiche amministrative. È una
  fonte di temi ricorrenti, non una stima della dimensione di mercato: questi
  problemi vanno trasformati in domande circoscritte e verificabili.
  [UFIS — un anno dalla parte dei frontalieri](https://www.ufis.it/ufis-un-anno-dalla-parte-dei-frontalieri/)
- Frontalieri-Jobs segmenta per regione, ruolo, lingua e permesso G. Questo
  suggerisce hook più specifici di “nuove offerte”: ruolo + area + requisito.
  [Frontalieri-Jobs](https://frontalieri-jobs.it/)

La prima batteria controlla il template grafico e varia intenzionalmente
promessa, hook, copertina, caption, domanda e slide finale. Tenere il layout
costante nella prima batteria è voluto: permette di capire se cambia la risposta
alla promessa, senza confondere il risultato con un cambio di design.

| Obiettivo | Varianti implementate | Ipotesi da verificare | Metrica primaria |
|---|---|---|---|
| `proof` | baseline, `local`, `surprise` | territorio e sorpresa aumentano il passaparola | condivisioni/reach |
| `save` | baseline, `checklist`, `moment` | checklist e utilità situazionale aumentano i salvataggi | salvataggi/reach |
| `question` | baseline, `choice`, `story` | scelta facile e esperienza personale riducono la fatica del commento | commenti/reach |

Ogni variante ha un ID stabile nel ledger. La rotazione quotidiana di articoli
e lavori e quella settimanale delle dogane producono osservazioni ripetibili;
non viene introdotto un flag PostHog né una variazione casuale non ricostruibile.
Per considerare una variante eleggibile servono almeno tre post osservati nello
stesso tipo di contenuto e nella stessa finestra. Sono quindi necessarie almeno
tre osservazioni per ciascun ID e tipo prima di prendere una decisione
editoriale.

### Scorecard ripetibile

Il report offline importa un export JSON del Professional Dashboard senza
chiamare Meta e senza stampare identificativi personali:

```bash
node scripts/instagram-insights-report.mjs \
  --input data/instagram-insights.json \
  --ledger data/instagram-posted.json \
  --json
```

L’input accetta una lista (o `{ "posts": [...] }`) con una riga per post e
almeno `creativeId`/ID riconciliabile col ledger, `reach`, `shares`, `saves` e
`comments`. `windowHours` è opzionale e vale 72; finestre diverse non vengono
mai aggregate insieme. Il report conserva separati creatività, tipo di contenuto
e finestra di misurazione; non mette nello stesso confronto un articolo, un
lavoro e una classifica di dogane. Conserva quindi:

- metrica primaria della variante (`shares`, `saves` o `comments`) / reach;
- meccanica della CTA (`keyword-comment`, `direct-share` o `save-reminder`), per
  distinguere l’azione richiesta dalla sola metrica osservata;
- tasso comune di interazioni (`shares + saves + comments`) / reach, usato solo
  come confronto esplorativo;
- stato `needs-N-more` finché non sono presenti tre osservazioni comparabili
  nello stesso tipo di contenuto.

Il tasso comune non sostituisce l’obiettivo: non si dichiara vincitore un
contenuto “proof” solo perché ha più commenti di un contenuto “question”, né si
confrontano direttamente tipi di contenuto diversi.

### Stato operativo dell’esperimento

Il report di stato separa l’unità editoriale dall’unità tecnica del ledger. Un
carousel con cinque card è un solo post Instagram e quindi può generare una
sola osservazione per ciascuna finestra; non viene contato come cinque prove
indipendenti. Il workflow stampa entrambe le finestre; il comando locale
equivalente per la decisione è:

```bash
node scripts/instagram-experiment-status.mjs \
  --ledger data/instagram-posted.json \
  --queue data/instagram-queue.json \
  --insights data/instagram-insights.json
```

Per vedere il segnale iniziale aggiungere `--window-hours 24`. La scorecard può
mostrare entrambe le finestre, ma il report non le fonde: ogni variante deve
raggiungere tre post distinti nella stessa finestra prima di diventare
`ready-to-compare`.

Il report rende visibili coda pendente, creatività pubblicate, osservazioni
attribuite, finestra non ancora raggiunta e credenziali mancanti. Una coorte
passa a `ready-to-compare` solo dopo almeno tre post distinti nella stessa
combinazione di obiettivo, formato e finestra; prima mostra `awaiting-*` o
`needs-N-more`. Gli snapshot duplicati, con identità media o coda ripetuta, non
aumentano il campione.

## 8. Azioni di community

1. Fissare tre post in alto: “cosa trovi qui”, simulatore netto, guida
   “nuovo frontaliere”.
2. Aggiornare la bio con una promessa e una CTA: “Dati e strumenti per chi
   lavora tra Italia e Svizzera · calcola il netto ↓”.
3. Creare highlight `Netto`, `Lavoro`, `Dogane`, `Domande`.
4. Ogni settimana pubblicare una risposta a una domanda reale, non solo un
   nuovo riepilogo dati.
5. Invitare frontalieri, commercialisti e realtà locali a co-creare un Reel o
   una risposta; chiedere sempre consenso scritto per volto, voce, targhe,
   cedolini e dati personali.
6. Lasciare commenti utili su pagine locali e professionali senza inserire il
   link come risposta automatica. Il link va usato quando risolve davvero la
   domanda.

## 9. Limiti dichiarati

La repository può automatizzare carousel, caption, UTM, la generazione del
Reel verticale e la sua pubblicazione via browser robot. Non può dimostrare da
sola che un Reel sia stato visto, salvato o condiviso:
quei dati vivono in Instagram Insights e richiedono il token read-only di Meta.
La pipeline resta fail-soft finché le credenziali necessarie non sono
disponibili: senza token o ID dell’account il workflow non scrive un dataset
vuoto. Inoltre, i post storici privi di `creativeId` non vengono
retro-etichettati; il campione valido parte dai post prodotti dalla matrice
creativa. Il test di trasporto Graph API, il test creativo offline e il primo
test live del robot sono verificati; resta aperta soltanto la validazione
quantitativa nel tempo tramite Insights.
