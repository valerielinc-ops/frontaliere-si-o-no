# Studio creativo Instagram e piano di sperimentazione

Studio operativo del 10 ottobre 2026 per trasformare la pubblicazione
automatica in un sistema di apprendimento: una promessa per post, una CTA,
un loop di relazione e una metrica primaria.

Il documento precede e accompagna l'implementazione del piano operativo e va aggiornato
quando arrivano gli Insights reali. I numeri di ledger e coda riportati qui
sono una fotografia del 10 ottobre 2026; per lo stato corrente usare
`instagram-experiment-status.mjs`.

## 1. Evidenze e diagnosi

La pipeline ha già una base utile:

- carousel quotidiani per articoli e lavoro, carousel settimanale per i valichi;
- matrice di 9 trattamenti (`proof`, `save`, `question`, con due varianti oltre
  alla baseline) e 3 trattamenti Reel;
- ledger che collega ogni card al post e al relativo `creativeId`;
- raccolta separata a 24 ore e 72 ore, senza mescolare le finestre.

Lo stato del ledger su `origin/main` è 41 righe distribuite su 9 post. I primi
due post del nuovo ciclo sono:

| Post | Creatività | Stato |
|---|---|---|
| `article-2026-10-09` | `question-choice` | pubblicato dal robot e confermato |
| `job-2026-10-09` | `question-story` | pubblicato dal robot e confermato |

È inoltre presente un Reel `reel-2026-10-09` con `reel-number` in coda, in
attesa di pubblicazione/conferma. I sette post storici senza metadati creativi
non vengono classificati retroattivamente: farlo dalla sola metrica GA4
confonderebbe il test.

Il dataset Instagram Insights non è ancora disponibile. Il preflight Remote
Config ora trova l'identificativo pubblico `INSTAGRAM_BUSINESS_ACCOUNT_ID`, ma
`INSTAGRAM_ACCESS_TOKEN` resta assente. La pipeline continua quindi a preparare
e pubblicare creatività, ma non dichiara vincitori finché il collector non può
leggere reach, salvataggi, condivisioni e commenti.

La verifica read-only del 10 ottobre ha separato i due casi: senza il token il
collector restituisce `credentials-missing` senza chiamare Meta; usando il
`FB_PAGE_ACCESS_TOKEN` come sostituto, Meta risponde `400 Unsupported get
request` sull'oggetto Instagram. Il Page token non viene quindi riutilizzato
come token Insights. Per sbloccare la scorecard occorre completare il
collegamento/permessi Meta e salvare il token Instagram in Remote Config come
`SERVER_INSTAGRAM_ACCESS_TOKEN`; fino ad allora lo stato corretto è
`blocked: Meta Insights`, non una conclusione sulla creatività.

## 2. Cosa insegna la piattaforma

Le indicazioni ufficiali di Meta sono coerenti con un sistema di test leggero:

1. I Trial Reels possono essere mostrati prima a non-follower e offrono segnali
   iniziali dopo circa 24 ore; l'eventuale condivisione automatica ai follower
   avviene entro una finestra successiva. Sono un canale di esplorazione, non
   una garanzia di performance: [Meta — Trial Reels](https://about.fb.com/news/2024/12/trial-reels-try-content-non-followers-first-see-what-perfoms-best/).
2. Repost e Friends tab rendono naturale progettare contenuti che una persona
   possa mandare a un collega, a un gruppo di pendolari o a chi vive lo stesso
   problema: [Meta — New Instagram Features to Help You Connect](https://about.fb.com/news/2025/08/new-instagram-features-help-you-connect/).
3. Il Professional Dashboard raccoglie Best Practices personalizzate su
   creazione, engagement e reach: [Meta — Best Practices for Creators](https://about.fb.com/news/2024/10/best-practices-education-hub-creators-instagram/).

La conseguenza pratica è usare il formato per una promessa precisa, non per
pubblicare la stessa classifica con parole diverse.

## 3. Alternative creative da testare

Ogni direzione cambia soprattutto un asse. Il dato sorgente e la frequenza
restano il più possibile fissi; così un risultato è interpretabile.

| Priorità | Direzione | Hook nei primi secondi | CTA/loop | Metrica primaria |
|---:|---|---|---|---|
| 1 | Numero utile da condividere | “Questo è il dato che avrei voluto sapere prima” | condividi con chi ne ha bisogno → Story-sondaggio | `shares / reach` |
| 2 | Scelta a bassa frizione | “1, 2 o 3: quale viene prima per te?” | commenta una sola opzione → Story-risultato | `comments / reach` |
| 3 | Checklist da conservare | “Salvalo prima di candidarti/partire” | salva e torna nel momento giusto → Quiz/Reminder | `saves / reach` |
| 4 | Risposta a una domanda | “Rispondo al dubbio che torna più spesso” | commento → risposta editoriale entro 72h | `comments / reach` |
| 5 | Prova locale e sorprendente | “Il dato del Ticino non è quello che immagini” | condividi e fai una previsione → sondaggio | `shares / reach` |

### 3.1 Numero utile da condividere

Pubblico: frontaliere che deve inoltrare un’informazione concreta. Cover con un
solo numero, fonte/data leggibili e una sola conseguenza pratica. Evitare
“virality bait”: il motivo della condivisione deve essere la sua utilità.

### 3.2 Scelta a bassa frizione

Pubblico: persona che non scriverebbe un commento lungo. Tre opzioni reali,
risposta breve e follow-up promesso solo se è già assegnato. Le risposte
diventano il brief del contenuto successivo, non un voto fittizio.

### 3.3 Checklist da conservare

Pubblico: chi dovrà riprendere la decisione più avanti. Una voce per slide,
ordine operativo e link alla guida completa. Un salvataggio vale solo se il
contenuto è abbastanza chiaro da essere riaperto senza contesto.

### 3.4 Risposta a una domanda

Pubblico: chi ha già espresso un dubbio. Selezionare commenti senza dati
personali, chiedere consenso quando il commento è riconoscibile e rispondere
con fonte/data. Tre domande simili in 30 giorni diventano un nuovo contenuto.

### 3.5 Prova locale e sorprendente

Pubblico: pendolare che riconosce luogo e situazione. Usare territorio, fascia
oraria e dato verificato; non mostrare targhe, percorsi individuali o dettagli
identificativi. Il tag geografico è subordinato alla disponibilità del dato e
al rollout della piattaforma.

## 4. Matrice di produzione

Il sistema registra ora quattro dimensioni oltre alla CTA:

- `hookType`: forma dell’apertura (`single-number`, `forced-choice`,
  `checklist`, `lived-experience`…);
- `attentionMechanic`: perché fermarsi (`single-number-proof`,
  `low-friction-choice`, `moment-relevance`…);
- `engagementLoop`: come il post genera il prossimo gesto (`share-to-help`,
  `comment-to-content`, `save-then-return`…);
- `followUpFormat`: formato del seguito (`story-poll`, `story-result`,
  `comment-reply-reel`, `carousel-checklist`…).

Questi ID sono stabili e vanno nel ledger, nella coda, negli snapshot e nei
report. La pipeline varia hook, promessa, CTA e loop, mantenendo il layout del
carousel controllato: è una scelta metodologica per non confondere il test del
messaggio con quello della grafica. I Reel restano un formato/coorte separato.

La ripartizione editoriale resta 60/30/10:

- 60% utilità verificabile: netto, lavoro, fisco, dogane;
- 30% community: domande circoscritte, sondaggi, risposte a commenti;
- 10% esplorazione: Trial Reel, hook locali, risposta a domande e nuove
  composizioni.

## 5. Sistema di engagement automatico via Graph API

Il comando read-only `node scripts/instagram-engagement-plan.mjs` genera per
la data e il formato scelti il prompt, la CTA, il follow-up e la metrica. Esempi:

```bash
node scripts/instagram-engagement-plan.mjs --date=2026-10-10 --kind=article
node scripts/instagram-engagement-plan.mjs --date=2026-10-10 --kind=reel --source-kind=job --json
```

Il piano operativo viene eseguito dal worker del robot, senza un passaggio
umano per ogni post:

1. entro 24 ore: leggere i commenti e pubblicare una sola risposta pubblica
   idempotente per oggetto, usando una risposta breve coerente con la metrica;
2. quando il commento contiene una richiesta azionabile: inviare una sola
   risposta privata collegata al post, senza chiedere o conservare dati
   sensibili;
3. per le conversazioni avviate dall'utente: rispondere solo al messaggio in
   ingresso più recente e solo entro la finestra consentita, mai fare outreach
   a freddo;
4. entro 24/72 ore: per i formati `story-*`, pubblicare il follow-up visuale
   statico associato, se il post ha un'immagine valida e non è già stato
   pubblicato;
5. registrare solo hash degli ID degli oggetti già gestiti, così riavvii e
   cadenze successive non duplicano commenti, DM o Stories.

Il worker usa il Graph API ufficiale e il flag Firebase `SOCIAL_ROBOT_MODE`:
`live` abilita le chiamate, mentre `dry`/valore assente non inviano nulla.
Le Stories sono visuali statiche: gli sticker interattivi non vengono simulati
quando il Content Publishing API non li espone. Il log locale stampa lo stesso
brief accanto all'ID della coda, più i contatori delle azioni eseguite e degli
errori, nella riga `🤖 Instagram community automation`.

## 6. Disegno del test nel tempo

Ogni coorte è confrontata solo con la stessa combinazione di:
`creativeId + content kind + measurement window`.

- 24h è diagnostica: segnala se hook e cover fermano l’attenzione;
- 72h è la finestra decisionale;
- `shares/reach`, `saves/reach` e `comments/reach` restano obiettivi diversi;
- servono almeno 3 osservazioni indipendenti per variante prima di parlare di
  leader;
- non si sommano carousel e Reel, né finestre 24h e 72h;
- un risultato negativo porta a cambiare una sola variabile dominante nel giro
  successivo: hook, CTA, loop oppure formato.

Il report deve mostrare anche hook e loop, non solo la percentuale, così la
decisione successiva è: “ripetiamo questa promessa per questo pubblico”, non
“copiamo il post con più like”.

Quando il token Meta non è ancora disponibile, la verifica può continuare con
un export CSV del Professional Dashboard. Il report è read-only, non chiama
Meta e collega ogni riga al ledger tramite `media id` o `queue id`:

```bash
node scripts/instagram-insights-report.mjs \
  --input /percorso/export-instagram.csv \
  --ledger data/instagram-posted.json \
  --window-hours=72
```

Sono accettati CSV separati da virgola o punto e virgola; le colonne metriche
minime sono `Post ID`/`Media ID`, `Reach`, `Shares`, `Saves` e `Comments`.
Se l'export non contiene `creativeId`, il ledger deve contenere l'ID del post
o della coda. Le righe senza attribuzione verificabile vengono rifiutate e non
entrano nella classifica.

La cadenza protegge anche l’unità del test: il poster consente una sola
pubblicazione per `kind + day`. Se una classifica aggiornata ricrea la coda
dello stesso giorno dopo una pubblicazione già confermata, la nuova esecuzione
non ripubblica il contenuto e rimuove solo l’entry stale corrispondente; un
eventuale item più recente dello stesso tipo resta intatto.

## 7. Roadmap di 30 giorni

| Periodo | Esecuzione | Decisione |
|---|---|---|
| Giorni 1–9 | completare il primo giro dei 9 carousel ID per articoli e lavoro; pubblicare il Reel in coda; usare il piano 24/48/72h | nessun vincitore; controllare qualità del loop e risposta entro SLA |
| Giorni 10–14 | ripetere le promesse con lo stesso obiettivo su articoli e lavoro; mantenere separata la rotazione settimanale dei valichi | accumulare la seconda osservazione senza dichiarare vincitori |
| Giorni 15–21 | inserire un comment-reply e un Trial Reel se l'account lo consente | confrontare non-follower, reach e metrica primaria, separando il formato |
| Giorni 22–27 | completare la terza osservazione delle coorti quotidiane e continuare il loop commento → risposta | arrivare a 3 osservazioni comparabili per ogni ID quotidiano; eliminare solo hook che non genera il gesto previsto |
| Giorni 28–30 | consolidare i due loop migliori e provare una variante locale/sorprendente | aggiornare la matrice; non aumentare la frequenza senza capacità di risposta |

La coorte `border` è settimanale: un giro completo dei 9 ID richiede 63
giorni, quindi non viene dichiarata comparabile con quella quotidiana entro il
primo mese. La decisione sui valichi resta separata finché non ha le sue 3
osservazioni per trattamento.

Decision rules:

- se la metrica primaria cresce ma non ci sono domande/ritorni, mantenere il
  contenuto utile e migliorare il follow-up;
- se arrivano commenti ma nessuno riceve risposta entro 24h, ridurre le CTA
  conversazionali fino a ripristinare la capacità operativa;
- se una variante è sotto baseline in tre osservazioni comparabili, cambiare
  una sola variabile e non cancellare il dato storico;
- se il collector è ancora senza credenziali, stato `blocked: Meta Insights`
  operativo, nessuna conclusione di performance.

## 8. Criterio di successo

Il successo del primo mese non è un singolo post virale. È avere:

- almeno tre osservazioni comparabili per le prime coorti;
- un loop commento → risposta → contenuto successivo realmente eseguito;
- una risposta entro 24 ore alle domande pubbliche;
- reach non-follower e metrica primaria raccolte a 24/72 ore;
- una decisione editoriale motivata per il mese successivo.
