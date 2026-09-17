# Argos vs OpusMT — misura 2026-09-17

## 1. Campione

- Strategia: `stratified`, round-robin per azienda, `per-company=1`.
- Dimensione: **362 slot** in 193 job, 193 aziende coperte; 362 output Argos validi e 0 fallimenti di chiamata esclusi dal confronto.
- Seed: **nessuno** — campionamento deterministico; ordine dei file da `listSliceFileNames`, aziende ordinate per bucket e nome.
- Corpus: snapshot `origin/main` estratto con `git archive` in una directory temporanea; nessuna scrittura in `data/`.

Il braccio OpusMT è stato eseguito solo sui **282** slot in cui Argos ha prodotto un output ma la decisione del guard non era `write`. Il confronto usa la stessa richiesta già costruita da `buildMopupRequest`, gli stessi token protetti e la stessa `classifyMopupWrite`/finalizzazione.

## 2. Matrice Argos × OpusMT

Base della matrice: 282 rifiuti Argos confrontabili.

| Decisione Argos | OpusMT: write | OpusMT: skip:candidate-untranslated | OpusMT: skip:source-copy | OpusMT: skip:existing-good | OpusMT: skip:finalize-empty | OpusMT: skip:source-locale | OpusMT: skip:empty-raw | Totale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skip:candidate-untranslated | 82 | 85 | 0 | 0 | 0 | 0 | 17 | 184 |
| skip:source-copy | 45 | 3 | 0 | 0 | 0 | 0 | 48 | 96 |
| skip:existing-good | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| skip:finalize-empty | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| skip:source-locale | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| skip:empty-raw | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## 3. Numeri che contano

### Stima pesata sulla produzione

Il numero di testa è una stima pesata sulla **composizione di produzione**, non sul campione round-robin: OpusMT recupererebbe **35,1%**, cioè circa **1.712 slot per run**. La ripesatura dei tassi di recupero per causa è:

```text
bucket candidate-untranslated (3.478):
  binnen-i              1.565 x  9,1% =   142
  compound-residue        887 x 42,7% =   379
  source-overlap          336 x 35,7% =   120
  source-function-word    335 x 88,9% =   298
  source-orthography      199 x 30,8% =    61
  source-copy             156 x 45,7% =    71
                                  tot = 1.071  (30,8%)
bucket source-copy separato (1.402) x 45,7% =   641  (45,7%)
TOTALE                              1.712 su 4.880 =  35,1%
```

### Tasso sul campione

Il **45,0% (127/282; IC95% Wilson 39,3%–50,9%; N=282)** resta nel report, ma va letto come **tasso pesato sul campione a parità di azienda (round-robin per company)**. Il round-robin evita che una singola fonte (per esempio fachkraft.ch) domini il campione, ma introduce una composizione per-causa diversa da quella di produzione: `binnen-i`, la causa più ostica (recupero 9,1%), è sotto-rappresentato di 7,5 volte nel campione (**11/184 = 6,0%** del bucket `skip:candidate-untranslated`) rispetto alla produzione (**1.565/3.478 = 45,0%**, dalla fase 2a della run GitHub Actions **35095698299**, blocco `Language arm`).

I tassi di recupero **per causa** nella tabella successiva sono il risultato trasferibile; l'aggregato sul campione **127/282** non lo è, perché il disegno round-robin ne altera la composizione per-causa.

> **Avvertenza per le ripesature future:** questi tassi vanno ripesati ogni volta sulla composizione per causa della run di produzione del momento, non sui numeri fissi del 2026-09-17, perché la distribuzione delle cause cambia da una run all'altra.

Distribuzione delle decisioni OpusMT sul braccio rifiutato:

| Decisione OpusMT | N | % |
| --- | --- | --- |
| write | 127 | 45.0% |
| skip:candidate-untranslated | 88 | 31.2% |
| skip:source-copy | 0 | 0.0% |
| skip:existing-good | 2 | 0.7% |
| skip:finalize-empty | 0 | 0.0% |
| skip:source-locale | 0 | 0.0% |
| skip:empty-raw | 65 | 23.0% |

## 4. Spaccato per causa e direzione

### Causa di scarto Argos

| Causa Argos | N rifiuti | OpusMT write | Recupero |
| --- | --- | --- | --- |
| binnen-i | 11 | 1 | 9.1% |
| compound-residue | 82 | 35 | 42.7% |
| source-overlap | 42 | 15 | 35.7% |
| source-function-word | 27 | 24 | 88.9% |
| source-orthography | 13 | 4 | 30.8% |
| source-copy | 105 | 48 | 45.7% |
| existing-good | 2 | 0 | 0.0% |

### Direzione linguistica

| Direzione | N rifiuti | OpusMT write | Recupero |
| --- | --- | --- | --- |
| de->en | 95 | 31 | 32.6% |
| de->it | 52 | 25 | 48.1% |
| de->fr | 44 | 20 | 45.5% |
| en->de | 38 | 21 | 55.3% |
| en->it | 21 | 13 | 61.9% |
| fr->en | 10 | 2 | 20.0% |
| en->fr | 8 | 4 | 50.0% |
| it->en | 5 | 4 | 80.0% |
| fr->it | 4 | 3 | 75.0% |
| it->fr | 3 | 2 | 66.7% |
| fr->de | 1 | 1 | 100.0% |
| it->de | 1 | 1 | 100.0% |

## 5. Costo

- Argos in questa misura: 332.3 s / 362 richieste = 0.918 s/slot.
- Riferimento reale della fase Argos: 690 s / 4920 richieste = 0.140 s/slot; estrapolazione a 4900 slot: **687.2 s (11.5 min)**.
- OpusMT: 353.4 s / 282 slot rifiutati = 1.253 s/slot; dtype `q8`, inclusa la prima inizializzazione/caricamento dei modelli nel processo.
- Estrapolazione lineare OpusMT a 4900 slot: **6139.9 s (102.3 min)** contro budget `16800000 ms` = 280.0 min.

## 6. Verdetto

**SÌ** — soglia dichiarata: cambio giustificato solo se OpusMT recupera almeno **10%** dei rifiuti Argos **e** la stima sui 4900 slot resta entro il budget di 280.0 min. Risultato operativo: **35,1% (~1.712 slot/run)** contro le **9 scritture/run** che Argos produce oggi, cioè un fattore di circa **190×**, ben sopra la soglia del 10%; tempo stimato 102.3 min. **Entrambe le condizioni della soglia sono soddisfatte**.
