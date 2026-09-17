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

## 3. Numero che conta

OpusMT risolve **127/282** slot che Argos non risolve, cioè **45.0%** (intervallo Wilson 95%: **39.3%–50.9%**; N=282).

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

**SÌ** — soglia dichiarata: cambio giustificato solo se OpusMT recupera almeno **10%** dei rifiuti Argos **e** la stima sui 4900 slot resta entro il budget di 280.0 min. Risultato misurato: 127/282 = 45.0%; tempo stimato 102.3 min. **entrambe le condizioni della soglia sono soddisfatte**
