# GSC content-gap playbook

Processo ripetibile per migliorare posizionamento e CTR di pagine già
performanti, usando le query di Google Search Console (GSC) per individuare
gap informativi reali e proporre integrazioni editoriali verificabili.
Nato da issue #6221.

**Guardrail non negoziabili:**
- Nessuna modifica automatica in produzione: gli script qui sotto sono
  read-only (fetch GSC → CSV/report), l'LLM propone, un umano approva.
- Niente keyword stuffing: si aggiungono sezioni solo dove c'è un gap
  informativo reale, non per infilare query a forza.
- Ogni nuovo claim fattuale nel contenuto aggiunto deve avere una fonte
  ufficiale o va rimosso.
- Controllo anti-cannibalizzazione contro le altre URL del sito prima di
  pubblicare.
- Versionare CSV, prompt, output LLM e decisione editoriale (PR + questo
  repo sono l'audit trail — non serve uno storage esterno).

## Fase 1 — Selezione pagine candidate (automatica, read-only)

```
node scripts/gsc-content-opportunity-score.mjs [--days=90] [--top=15] [--weights=path.json]
```

Interroga GSC a livello di `page` (finestra di default 90gg), filtra alle
pagine editoriali (articoli, guide, statistiche, tool, glossario, home —
esclude job-board/account/community/marketing, generati/gestiti altrove) e
calcola uno score per ciascuna:

```
opportunity_score =
  normalized_impressions * 0.35 +
  ctr_gap               * 0.25 +
  position_opportunity  * 0.20 +
  business_value        * 0.10 +
  content_gap_confidence * 0.10
```

- `normalized_impressions` — impressioni della pagina / max impressioni nel set.
- `ctr_gap` — quanto il CTR della pagina è sotto la mediana dei suoi peer
  (altre pagine con posizione simile, ±3) nello stesso export. Deliberatamente
  auto-referenziale: una curva CTR-per-posizione "di settore" inventata
  sarebbe un dato non verificabile, il confronto contro i propri peer no.
- `position_opportunity` — 0 fuori dalla banda [4,20], cresce verso 1
  avvicinandosi a posizione 4 (query quasi in prima pagina = spinta minore
  per un guadagno grande).
- `business_value` — neutro (0.5) di default; puoi pesare una sezione del
  sito passando `--weights=path.json` con `{"/guida-frontaliere": 0.8}`.
- `content_gap_confidence` — neutro (0.5): richiede di leggere il contenuto
  attuale, non è calcolabile solo dai numeri GSC. Fase 3 lo raffina.

Output: `data/gsc-content-refresh/opportunity-report.{md,json}` — lista
ordinata di pagine candidate, MAI un contenuto già scritto.

## Fase 2 — Export query per pagina (automatica, read-only)

Per ogni pagina candidata dal report di Fase 1:

```
node scripts/gsc-page-query-export.mjs --page=/guida-frontaliere/permesso-g [--days=90]
```

Esporta le query GSC filtrate su quella URL esatta in
`data/gsc-content-refresh/<slug>.csv` (query, clic, impressioni, CTR,
posizione, flag `nearWin`) più un sidecar `<slug>.json` con i metadati
dell'export (periodo, conteggio righe) per l'audit trail.

## Fase 3 — Analisi contenuto + query (assistita da AI, umana)

Passa a un LLM il contenuto della pagina **e** il CSV di Fase 2 usando il
prompt in `docs/gsc-content-refresh-template.md`. L'output atteso è una
tabella di proposte (cluster, query, impressioni, gap, sezione proposta,
valore utente, rischio, fonti richieste, priorità) — mai una riscrittura
diretta della pagina.

## Fase 4 — Revisione umana obbligatoria

Prima di modificare una pagina:
- ogni sezione proposta risponde a una domanda reale e coerente con l'intento della pagina;
- fonti, dati e riferimenti normativi verificati;
- nessun overlap con altre URL del sito (se l'intento merita una pagina
  dedicata, preferire una nuova URL + internal link a un'espansione forzata);
- preferire merge/rafforzamento della pagina esistente a sezioni ridondanti.

## Fase 5 — Implementazione e misurazione

- Salvare baseline GSC (28/90/180gg) prima del change — riusa
  `node scripts/analytics-report.mjs --gsc` per uno snapshot rapido, oppure
  l'export di Fase 2 stesso come baseline.
- PR con: query cluster usate, sezioni aggiunte, fonti, data, ipotesi.
- Confrontare a 28/60/90 giorni dal rilascio (stesso comando di baseline).

## Roadmap non implementata in questo giro

- **Fase automatizzata** (job settimanale schedulato + PR/issue draft
  automatiche): per scelta non incluso in questa iterazione — il processo
  descritto dall'issue stessa lo condiziona a un pilot manuale riuscito su
  poche pagine prima di schedulare un job ricorrente (costo LLM + rischio di
  automatizzare un processo non ancora validato). Gli script di Fase 1/2
  sono pensati per essere invocabili anche da un workflow futuro senza
  modifiche, quando la decisione "scalare" sarà presa.
