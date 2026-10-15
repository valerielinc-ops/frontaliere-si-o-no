# GSC content-gap — template di analisi per pagina

Usato nella Fase 3 di `docs/gsc-content-refresh-playbook.md`. Compilare una
copia per ogni pagina analizzata e allegarla alla PR come evidenza/audit
trail della decisione editoriale.

## Metadati

- **Pagina**: `<path>`
- **Periodo export**: `<start>` → `<end>` (da `data/gsc-content-refresh/<slug>.json`)
- **Score opportunità** (da `opportunity-report.md`): `<score>`
- **Data analisi**: `<YYYY-MM-DD>`

## Prompt LLM standard

```text
Sto allegando il contenuto della pagina e un CSV delle query di Google Search Console filtrate su questa URL.

Analizza le query rispetto al contenuto esistente.
1. Raggruppa le query per intent e cluster semantico.
2. Evidenzia soltanto cluster con impressioni sufficienti e intent coerente con lo scopo della pagina.
3. Identifica i gap informativi realmente non coperti o coperti in modo insufficiente.
4. Proponi nuove sezioni H2/H3, FAQ, tabelle, esempi o elementi pratici.
5. Per ogni proposta indica: query rappresentative, impressioni aggregate, intento, evidenza nel contenuto attuale, valore utente, rischio di cannibalizzazione e priorità.
6. Non proporre sezioni basate su query fuori tema, ambigue, navigazionali o che richiedano informazioni non verificabili.
7. Non inventare fatti: indicare fonti ufficiali o dati richiesti per ogni nuovo claim fattuale.

Restituisci una tabella con colonne: cluster, query, impressioni, CTR, posizione, gap, proposta sezione, valore utente, rischio, fonti richieste, priorità.
```

## Output atteso

| Cluster | Query rappresentative | Impressioni | CTR | Posizione | Gap | Proposta sezione | Valore utente | Rischio cannibalizzazione | Fonti richieste | Priorità |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

## Decisione editoriale

- [ ] Sezione approvata per l'implementazione
- [ ] Sezione scartata — motivo: `<...>`
- [ ] Necessita URL dedicata invece di espansione (link interno da aggiungere)

**Note revisore**: `<...>`
