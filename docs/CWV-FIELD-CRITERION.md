# Criterio di performance per #5001 — campo vincolante, laboratorio anti-regressione

Sostituisce «PageSpeed Insights score > 90 mobile» come criterio di accettazione
dell'issue #5001. Tutti i numeri qui sotto sono **misurati il 2026-08-07**, non
stimati; ogni fonte è dichiarata con l'esito del suo accesso.

Verifica ripetibile — non ricalcolare a mano:

```bash
source bin/rc-env.sh                  # dalla radice del workspace
npm run check:cwv-field               # tabella leggibile, exit 0/1/2
node scripts/check-cwv-field-criterion.mjs --json
node scripts/check-cwv-field-criterion.mjs --markdown
```

Automatizzato in `.github/workflows/cwv-field-criterion.yml` (cron settimanale
giovedì 07:55 UTC + `workflow_dispatch`).

---

## 1. Perché il punteggio di laboratorio non può decidere

Su questo sito il punteggio lab indica la pagina sbagliata, e lo fa in
**entrambe** le direzioni:

| Pagina | Lab mobile | Campo reale (CrUX PHONE p75) |
|---|---|---|
| `/cerca-lavoro-ticino/` | perf **0,03** | **miglior LCP del sito**: 1700 ms, 89% buone |
| `/cerca-lavoro-svizzera/` | perf **0,94** | **INP 4085 ms** — la pagina peggiore del sito |

Due pagine, verdetti lab opposti, e in tutti e due i casi il lab inverte quello
che ottiene l'utente. Un criterio costruito sul punteggio lab avrebbe inseguito
la prima e non avrebbe **mai** guardato la seconda.

Il lab resta utile per una cosa sola, ed è quella per cui viene tenuto: dire che
un deploy ha peggiorato le cose rispetto al deploy precedente, a hardware e rete
costanti. Non è la stessa domanda di «gli utenti stanno bene».

## 2. Le fonti — cosa ha funzionato e cosa no

| Fonte | Esito | Cosa dà |
|---|---|---|
| **CrUX API** (`records:queryRecord`, `records:queryHistoryRecord`) | ✅ funziona | p75 di campo, origine + 9 URL, serie storica settimanale da 2026-02-14 |
| **Search Console** (`sc-domain:frontaliereticino.ch`, siteOwner) | ✅ funziona | impression/clic/CTR/posizione, per pagina e per giorno |
| **Cloudflare GraphQL** (zona `435c32ec…`) | ⚠️ parziale | solo volume (`httpRequests1dGroups`). I dataset RUM (`rumPerformanceEventsAdaptiveGroups`, `rumWebVitalsEventsAdaptiveGroups`) rispondono `unknown field`: **nessun CWV da Cloudflare**, coerente con l'ingest Web Analytics dichiarato defunto su questa zona (issue 3558/3503) |
| **GA4 Data API** | ✅ funziona, **ma serve lo scope esplicito** | traffico + engagement. Vedi §2.1 |
| **PostHog** | ⚠️ vivo ma **cieco dal 2026-07-23** | vedi §2.2 |
| **Clarity** | ✅ funziona | proxy comportamentali: dead click 8,45% delle sessioni, rage click 0,16%, scroll medio 33%, engagement 71 s totali / 31 s attivi |

### 2.1 GA4: il token di default non basta

`gcloud auth print-access-token` produce un token con scope `cloud-platform`, e
l'API Analytics lo rifiuta:

```
403 PERMISSION_DENIED — ACCESS_TOKEN_SCOPE_INSUFFICIENT
```

Il service account **ha** l'accesso alla property; manca solo lo scope sul token.
Va chiesto esplicitamente:

```bash
gcloud auth print-access-token --scopes="https://www.googleapis.com/auth/analytics.readonly"
```

Con quello la Data API risponde. Chi legge il 403 come «il SA non ha accesso a
GA4» si ferma un passo prima del vero.

### 2.2 Le due gambe di telemetria di campo del sito erano entrambe morte

`services/webVitals.ts` raccoglie LCP/INP/CLS/FCP/TTFB con `web-vitals/attribution`
e li manda a GA4 (tutte le sessioni) e a PostHog (campione 20%). Misurato il
2026-08-07, **nessuna delle due gambe consegnava**:

- **GA4 — zero eventi `web_vitals` in 90 giorni**, e zero `mobile_ux`. Causa:
  `services/webVitals.ts` e `services/mobileUxMonitor.ts` chiamavano
  `(Analytics as any).log?.('web_vitals', …)`, ma l'oggetto `Analytics` non ha
  mai esposto un membro `log` — l'optional call risolveva `undefined` e non
  faceva nulla, in silenzio. La prova per differenza: `dead_click`, che chiama la
  `log()` privata del modulo direttamente, nello stesso periodo ha **8.477**
  eventi. Il codice era spedito nel bundle, costava agli utenti il download di
  `web-vitals`, e non riportava niente. **Corretto** nella stessa PR di questo
  documento (membro `log` esposto e tipizzato, `as any` + `?.` rimossi da
  entrambi i chiamanti, così una prossima rottura fallisce in build).
- **PostHog — ingest fermo dal 2026-07-23.** Tutti gli eventi sono crollati da
  ~90-100k/giorno a <30/giorno; sopravvive in pratica solo `$exception`.
  Conseguenza diretta: `data/cwv-monitor-history.json` registra `n=0` per **tutte
  e nove** le pagine il 2026-08-05, e `scripts/cwv-monitor-check.mjs` continua a
  girare scrivendo `null` senza che nulla diventi rosso. Causa probabile: tetto
  del piano gratuito (1M eventi/mese) — il 2026-07-20 da solo ha fatto 175.446
  eventi. **Non corretto qui**: è un problema di piano/quota, non di codice.

Da qui la scelta di **costruire il criterio su CrUX**: è l'unica fonte di campo
che oggi funziona, non dipende dalla pipeline del sito, non può essere affamata
da un tetto di fatturazione, ed è la fonte su cui Google stesso classifica.
Prezzo da pagare: ogni lettura è una finestra mobile di 28 giorni, quindi una
correzione che atterra oggi si vede in parte dopo ~7 giorni e del tutto dopo ~28.

## 3. Baseline di campo (CrUX PHONE, finestra 2026-07-09 → 2026-08-05)

| | LCP p75 | INP p75 | CLS p75 |
|---|---|---|---|
| **origine** | 1543 (86% buone) | **440 (52%)** | **0,17 (61%)** |
| `/` | 2319 (79%) | 322 (46%) | 0,10 (75%) |
| `/cerca-lavoro-ticino/` | 1700 (89%) | 697 (44%) | 0,23 (62%) |
| `/cerca-lavoro-svizzera/` | 2001 | **4085** | 0,46 |
| `/cerca-lavoro-ticino/infermieri/` | 1137 | 568 | 0,13 |
| `/cerca-lavoro-ticino/case-anziani/` | 911 | 501 | 0,21 |

### La tendenza è la parte che conta

Serie settimanale dell'origine, PHONE p75:

```
              04-04  04-18  05-02  05-16  05-30  06-13  06-27  07-11  07-25  08-01
INP p75         158    185    241    291    299    319    347    367    402    426
CLS p75        0.60   0.62   0.69   0.74   0.76   0.25   0.17   0.18   0.18   0.18
LCP p75        1106   1060   1021    991   1053   1175   1216   1385   1527   1541
```

Tre storie diverse:

- **INP: degrado monotono, 17 finestre consecutive, 158 → 426 ms (~+16 ms a
  settimana), nessuna inversione.** Le buone sono passate dall'83% al 53%. Non
  c'è oggi niente che lo stia fermando. È il problema principale del sito ed è
  esattamente ciò che il gate lab non ha mai visto.
- **CLS: una vittoria vera, poi un plateau.** 0,76 → 0,17 in cinque settimane
  (giugno), poi **0,17-0,18 per sei settimane consecutive**, buone ferme al 60%.
- **LCP: degrado lento e silenzioso**, 992 → 1541 ms. Ancora verde, nessuno lo
  guarda.

Anche le sottopagine job peggiorano tutte su INP: `infermieri/` 391 → 592,
`case-anziani/` 328 → 448 negli ultimi due mesi. È una regressione **di
template**, non di una pagina.

## 4. Il criterio

### Vincolante per la chiusura di #5001

CrUX, `formFactor: PHONE`, **livello origine**, p75, sostenuto su **due finestre
consecutive** (una finestra sola che scende sotto la soglia è rumore, non una
correzione — è la stessa regola «una settimana è rumore, due sono reali» che il
monitor CWV già usa, applicata in direzione positiva):

| Metrica | Soglia | Baseline 2026-08-07 | Distanza |
|---|---|---|---|
| **INP p75** | ≤ **200 ms** | 440 ms | −240 ms |
| **CLS p75** | ≤ **0,15** | 0,17 | −0,02 |
| **LCP p75** | ≤ **2500 ms** | 1543 ms | già verde (*hold*) |

**Perché INP 200 e non una soglia intermedia.** Perché non è un obiettivo nuovo:
questa origine ha misurato **158 ms il 2026-04-04** ed è rimasta sotto 200 fino
al 2026-04-18. È una regressione da disfare, con una causa trovabile, non una
capacità da costruire. L'attribuzione PostHog (finestra 07-11→07-23, l'ultima
utile) dice anche dove guardare: sul p75 mobile di 296 ms, `inp_input_delay` vale
32 ms, `processing` 112 ms, `presentation` 74 ms, ma `totalScriptDuration` vale
**252 ms** — è tempo di script, non di layout. Al ritmo simmetrico a quello con
cui il degrado si è accumulato (~16 ms/settimana) il recupero è ~15 settimane,
più la finestra CrUX di 28 giorni: **primo verde plausibile ~2026-12**.

**Perché CLS 0,15 e non lo 0,10 di Google.** Perché 0,10 su questa origine non è
mai stato raggiunto: il minimo storico è **0,17**, ed è fermo lì da sei
settimane. Un plateau di sei settimane dopo un miglioramento reale è la prova che
le vittorie facili sono spese e che il residuo è strutturale. L'attribuzione
nomina i responsabili: app shell (0,172), footer (0,286-0,302), rail grid AdSense
(0,126-0,278). Il rail è AdSense, e il Non-Negotiable #7 vieta di sopprimerlo:
l'unica correzione lecita è **riservare lo spazio**, che ha un tetto a quanto può
recuperare. 0,15 sta sotto il pavimento delle sei settimane — non lo si
raggiunge per rumore, lo si raggiunge lavorando. **0,10 resta l'obiettivo
successivo**, in una issue successiva, non questo cancello.

**Perché LCP è nel criterio pur essendo già verde.** È un *hold*, non un
target. Sta degradando (992 → 1541 ms) ed è la cosa più ovvia da sacrificare
mentre si insegue INP — per esempio spostando lavoro fuori dal thread principale
in modi che ritardano il paint. Bloccarlo impedisce quello scambio.

### Ratchet intermedio — progresso, non chiusura

**INP p75 ≤ 300 ms entro il 2026-10-02.** #5001 non chiude su questo. Serve
perché un criterio a cinque mesi resti leggibile: se a ottobre l'INP non è sotto
300, l'approccio non sta funzionando e va ripensato invece di continuare.

### Watchlist per-URL — informativa, non vincolante

Le 5 URL di §3, con soglia di deriva **+15%** dalla baseline 2026-08-07. Non è
vincolante di proposito: **CrUX ha dati a livello di URL solo per 9 delle prime
60 landing organiche** — le altre 51 rispondono `404 data not found`, sotto la
soglia di reporting. Un cancello per-URL sarebbe un cancello su un campione
arbitrario. Serve invece a intercettare il whack-a-mole: p75 di origine che
migliora mentre un singolo template marcisce.

## 5. Il legame con il traffico organico: **non si vede nei dati**

Questa è la parte che è stato chiesto di verificare e non di costruire. La
risposta onesta è **no**.

**Test 1 — serie temporale.** 16 finestre di 28 giorni in cui CrUX e GSC
coprono entrambe l'intero periodo, correlazione di rango di Spearman fra metrica
di campo ed esito organico (mobile):

| | clic | impression | CTR | posizione |
|---|---|---|---|---|
| INP | **+0,99** | **+1,00** | −0,41 | +0,46 |
| CLS | −0,76 | −0,75 | +0,77 | −0,39 |
| LCP | +0,87 | +0,87 | −0,69 | +0,28 |

INP dice «peggiore = più traffico», CLS dice «migliore = più traffico». I segni
si contraddicono, ed è la firma tipica della **confusione temporale**, non di un
effetto: nello stesso periodo l'organico è cresciuto da 11.217 a 44.084 clic
(+293%) mentre INP peggiorava e CLS migliorava. Entrambe le serie sono monotone
nel tempo, quindi correlano con qualsiasi cosa lo sia.

**Test 2 — trasversale**, che non soffre di quella confusione. Fra le 9 pagine
con dati CrUX, quelle con INP peggiore hanno il CTR **migliore**:

| pagina | INP | CTR | posizione |
|---|---|---|---|
| `/cerca-lavoro-ticino/infermieri/` | 568 | **17,32%** | 3,9 |
| `/cerca-lavoro-ticino/` | 697 | 10,92% | 10,1 |
| `/cerca-lavoro-ticino/case-anziani/` | 501 | 9,01% | 4,5 |
| `/` | 322 | 6,08% | 6,1 |

E a posizione confrontabile (6,1-7,1) il CTR varia da 1,53% a 6,08% senza alcun
ordinamento per velocità: la varianza è guidata dall'intento della query (le
pagine job convertono, le pagine prezzi-carburante no), non dalla performance.

**Conclusione.** Con questi dati non è identificabile alcuna relazione causale
fra CWV di campo e performance organica su questo sito. Chi volesse usare
«perdiamo posizioni perché siamo lenti» come motivazione **non ha evidenza**.

### Il legame col traffico che invece si vede, ed è quello vero

Non è una relazione di ranking, è di **esposizione**: le pagine lente sono
esattamente quelle che portano il traffico.

- I template job-search raccolgono il **56,0% dei clic organici mobile** e il
  45,6% delle impression (7.890 clic su 14.099, finestra 2026-07-07→08-03).
- La search appearance `JOB_LISTING` da sola vale **670.395 impression e 27.541
  clic**, la superficie dominante del sito.
- E sono gli stessi template con INP 501-4085 ms, tutti in peggioramento.

Il caso per correggere INP e CLS quindi **non è** «ci costa posizionamento» — non
è dimostrabile. È: il danno di esperienza è concentrato sulle pagine che
raccolgono la maggioranza dei clic, ed è misurabile fuori dal ranking. Clarity
sulle stesse sessioni riporta **8,45% di sessioni con dead click** e scroll medio
al 33%. E il CLS ha una via monetaria diretta e già riconosciuta in AGENTS.md
(#7): lo shift di layout degrada l'RPM AdSense, ~95% del ricavo.

## 6. Il guardiano di laboratorio (anti-regressione, non decide)

Resta in `lighthouserc.json` (mobile, quello che conta) e
`lighthouserc.desktop.json` (desktop). Entrambi sono **baseline-locking**:
soglia = peggior mediana per-URL misurata, più margine per la dispersione fra
run. Rilevano che un deploy ha peggiorato le cose; non definiscono «fatto».

La gamba mobile era già stata tarata nella PR #5308. La gamba **desktop** no, ed
era **cronicamente rossa**: asseriva `performance >= 0.60` e `LCP <= 2500`
uniformemente, mentre `/cerca-lavoro-ticino/` in produzione misura 0,23 e 3108 ms.
Falliva a **ogni** run e apriva ogni volta la stessa issue. Un cancello sempre
rosso non riporta nulla — non distingue una regressione vera dallo stato
corrente, e abitua chi lo triaga a chiudere l'issue senza leggerla. Peggio di
nessun cancello.

Ritarata qui sulle mediane reali del run `31177021266` (2026-08-07, 6 URL × 3
run), con la stessa struttura `assertMatrix` della gamba mobile: un gruppo per le
cinque pagine sane, un blocco separato per `/cerca-lavoro-ticino/` che è un
**marcatore di debito, non un'esenzione** — quando la pagina è corretta, quel
blocco va cancellato così ricade nel gruppo più severo.

| | perf | FCP | LCP | TBT | CLS | SI (warn) | TTI (warn) |
|---|---|---|---|---|---|---|---|
| 5 pagine sane — peggior mediana | 0,75 | 691 | 1259 | 320 | 0,121 | 3676 | 5297 |
| 5 pagine sane — **soglia** | 0,65 | 900 | 1600 | 450 | 0,15 | 4300 | 6200 |
| `/cerca-lavoro-ticino/` — mediana | 0,23 | 1428 | 3108 | 814 | 0,586 | 2748 | 4830 |
| `/cerca-lavoro-ticino/` — **soglia** | 0,20 | 1700 | 3600 | 1000 | 0,70 | 3200 | 5600 |

Il margine è ~15% sulle metriche stabili e ~40% su TBT: a valori assoluti così
piccoli (0-320 ms) poche decine di ms di rumore del runner sono uno scarto
proporzionale grande, e un flap di TBT farebbe fallire la gamba per nulla.

## 7. Cosa NON è coperto

- **`/cerca-lavoro-svizzera/` non è nella lista URL di Lighthouse CI** e non è
  stata aggiunta qui. Non per dimenticanza: PSI le dà lab mobile **0,94**, quindi
  un gate lab non la segnalerebbe comunque — è precisamente la pagina che dimostra
  perché il lab non basta. Vive nella watchlist di campo, dove il suo INP 4085 ms
  è visibile. Aggiungerla al lab richiederebbe prima misurarla col runner LHCI
  (PSI e LHCI divergono molto: sulla stessa pagina PSI dà 0,94 dove LHCI dà 0,03
  per `/cerca-lavoro-ticino/`), quindi tararla su numeri PSI la renderebbe rossa
  a caso.
- **L'ingest PostHog resta fermo.** È quota/piano, non codice.
- **Le dimensioni custom GA4 di `web_vitals` non sono registrate**
  (`metric_name`, `metric_value`, `metric_rating`, `device_type` non esistono fra
  le 35 custom dimension della property; le custom metric sono 0). Ora che gli
  eventi arrivano davvero, senza registrarle la Data API può contarli ma non
  spaccarli per metrica o valore. Registrazione = lavoro in console GA4, non nel
  repo.
