# Information Gain — come si misura, e cosa dice oggi

Riferimento per `npm run audit:information-gain` e per il blocco di confronto
`build-plugins/shared/nearestMunicipalityComparison.ts`. Issue: #5002.

Questo documento **non** è una strategia di contenuto. È la definizione
operativa di una metrica, il numero che quella metrica dà oggi su ogni famiglia
di pagine, e la procedura per rifare la misura.

## La domanda

Il brevetto Google US8140449B1 chiede, di una pagina: dato tutto quello che
l'utente **ha già visto**, quanto aggiunge questa? La riformulazione usata qui
— la sola calcolabile dall'HTML emesso, senza LLM e senza modelli di embedding
— è:

> tra le pagine costruite dallo **stesso template**, quale quota della prosa di
> questa pagina non è già sulle sorelle?

Se la risposta è «nessuna», togliere quella pagina dall'indice non rende il
corpus meno completo: è la definizione di gain zero.

## Perché serviva una misura nuova

`audit-content-duplicates.mjs` fa l'hash SHA-256 del corpo e segnala le
collisioni **esatte**. Una famiglia mail-merge non collide mai: cambi il nome
del comune e una cifra e l'hash è diverso. Misurato il 2026-08-24 in
produzione, le pagine `/tasse-frontalieri-comune/` erano tutte verdi su
content-duplicates **mentre cinque su sette portavano cifre identiche**
(`0,55 %`, `−647 €`) e prosa identica parola per parola. La quasi-duplicazione
non era coperta da nessun gate.

## Le due maschere

Confrontare il testo grezzo non funziona. Due pagine fiscali dicono:

```
A Tradate  l'addizionale comunale IRPEF è 0,7%.
A Bregnano l'addizionale comunale IRPEF è 0,55%.
```

Carattere per carattere sono diverse, quindi qualunque hash le chiama distinte
e la metrica premia il mail-merge — l'opposto di ciò che serve. Prima del
confronto ogni segmento passa da due maschere:

1. **Numeri → `#`.** Una cifra slottata è dato, non prosa. Il dato conta, ma
   conta una volta sola (campo `distinctDataValues`), non rendendo nuova la
   frase che lo contiene.
2. **Token identitari della pagina → `@`.** Presi da `<title>`, `<h1>` e slug
   URL, meno una stop-list. «Tradate» sulla pagina di Tradate e «Bregnano» su
   quella di Bregnano diventano entrambi `@`, e le due frasi collassano.

La maschera è **asimmetrica per costruzione**: ogni pagina è mascherata con i
*propri* token, mai con l'unione della coorte. Mascherare anche i vicini
cancellerebbe l'unica cosa che differenzia le pagine — una tabella che nomina i
comuni vicini è differenziazione vera e deve sopravvivere alla misura.

## Le coorti

La coorte non è una tabella di regex per famiglia, è derivata dalla pagina:
**locale + `<h1>` mascherato**. L'`h1` è emesso da un solo `copy.h1()` per
famiglia, quindi è identico su tutta la famiglia per costruzione e non cambia
se una pagina ha una sezione opzionale in più.

La prima versione usava lo scheletro completo degli heading e **frammentava**:
una sezione opzionale (la webcam che un comune ha e il vicino no) spezzava una
famiglia in tre coorti da quattro, tutte sotto `minCohortPages`, cioè un gate
che non misurava niente proprio dove la famiglia è più grande.

Una coorte da una pagina non viene valutata: senza sorelle non c'è ridondanza.

## Il gate

`scripts/audit-information-gain.mjs`, registrato in `scripts/audit-all.mjs`,
quindi gira in `post-deploy-validate-dist.yml` sul corpus **riassemblato**. Due
modi di fallire, entrambi **tassi** e non conteggi (AGENTS.md #1, eccezione
dist — un ratchet assoluto sfarfalla sotto `AUDIT_SAMPLE_RATE`):

1. una coorte **non** nell'inventario scende sotto `MEDIAN_IGS_FLOOR_PCT` (5 %);
2. una coorte **nell'inventario** peggiora oltre `REGRESSION_TOLERANCE_PCT`
   (1,5 punti) rispetto al valore registrato.

`KNOWN_LOW_GAIN_COHORTS` è lo stesso dispositivo di
`tests/gate-wiring-baseline.json`: l'inventario di un difetto preesistente,
reso visibile perché smetta di crescere, che può solo **scendere**. Una coorte
che risale sopra il floor non fa fallire la run — stampa una riga «togli questa
riga dall'inventario». Su un dist riassemblato (pagine emesse mesi fa da codice
che non esiste più) un'uguaglianza su un tasso sfarfallerebbe per il solo churn
del corpus, e un gate che sfarfalla viene spento entro una settimana.

La tabella completa per coorte è **stampata a ogni run**, così la soglia
successiva si stringe su un dato.

### Perché il floor è 5 % e non il 40 % della issue

La issue chiedeva IGS > 40 % sulle pagine chiave. Nessuna famiglia del sito ci
arriva oggi, e una soglia che nessuno rispetta è una soglia che viene abbassata,
non raggiunta. Il 40 % resta **riportato** per coorte
(`cohortsBelowIssueTarget40`), il gate morde a 5 %: «la pagina mediana ha almeno
una frase su venti che le sorelle non hanno».

## La baseline misurata (2026-08-24, produzione)

Campione: 12 URL per famiglia dalle sitemap di produzione, equispaziati (40 per
le tre famiglie chiave), scaricati e passati all'auditor.

| coorte | median IGS | pagine | pagine a gain zero |
|---|---|---|---|
| `it:/aziende/` (profili datore) | **50,0-52,2 %** | 13 + 15 | 0 |
| `it:/lavoro-ticino-` (professioni) | 21,4 % | 3 | 0 |
| `it:/vivere-in-ticino/comuni-di-frontiera/` | 11,5-15,4 % | 12 + 32 | 0 |
| `it:/vivere-in-germania-lavorare-in-svizzera/` | 5,1 % | 6 | 0 |
| `it:/vivere-in-austria-lavorare-in-svizzera/` | 1,8 % | 8 | 0 |
| `it:/tasse-frontalieri-comune/` | **0,0 %** | 30 | **29** |
| `it:/vivere-in-liechtenstein-lavorare-in-svizzera/` | **0,0 %** | 8 | **8** |
| `it:/vivere-in-francia-lavorare-in-svizzera/` | **0,0 %** | 3 | 3 |
| `it:/stipendio-medio-svizzera-` | 0,0 % | — | — |

**La famiglia dei profili datore è il controllo.** Stesso shell, stessa nav,
stesso footer delle altre, ma un payload per pagina reale (le posizioni aperte
di quel datore): 50 %, otto volte le famiglie comunali. È questo che dice che
la metrica misura il payload e non la cromatura.

Le famiglie comunali erano mail-merge: `irpefAddizionale` prende **nove** valori
distinti su 518 comuni (346 righe condividono 0,55 %), quindi nemmeno i numeri
differenziavano le pagine.

## Cosa è cambiato con #5002

Le sei famiglie comunali hanno preso
`build-plugins/shared/nearestMunicipalityComparison.ts`: i sei comuni
geograficamente più vicini, le cifre che tra loro differiscono davvero, e la
prosa che dice dove sta **questo** comune in quel gruppo. È page-specific per
costruzione — l'insieme dei vicini di un comune è unico di quel comune — non
per scrittura.

Quattro famiglie su sei avevano al suo posto
`X_ABOVE_FLOOR.filter(self).slice(0, 6)`: gli **stessi sei link su ogni
pagina**, cioè lo stesso difetto che la PR #5107 ha rimosso dagli articoli
(3.070 su 3.086 senza un link in entrata perché ogni pagina linkava le stesse
cinque). Quel costrutto è ora vietato da un test sui sorgenti
(`tests/nearest-municipality-comparison.test.ts`).

Effetto misurato rendendo le pagine nuove e ripassandole all'auditor:

| coorte | prima | dopo | pagine a gain zero |
|---|---|---|---|
| `it:/tasse-frontalieri-comune/` | 0,0 % | **9,1 %** | 29 → **0** |
| `it:/vivere-in-ticino/comuni-di-frontiera/` | 11,5-15,4 % | **15,6 %** | 0 → 0 |

Il numero che conta più della percentuale è la colonna a destra: **nessuna
pagina resta senza niente di proprio**.

## Rifare la misura

Sul dist di una build (il modo canonico, quello che gira in CI):

```bash
node scripts/audit-information-gain.mjs path/to/dist
# oppure dentro il giro unico:
node scripts/audit-all.mjs --audits=information-gain --dist=path/to/dist
```

Su un campione live, quando non c'è un dist a portata di mano — è così che è
stata presa la baseline qui sopra. Serve un albero di file **identico a
`dist/`** (`<path>/index.html`), perché l'auditor deriva locale e coorte dal
percorso:

```bash
# 12 URL equispaziati da una sitemap, scaricati in un albero dist-like
curl -s https://frontaliereticino.ch/sitemap-comuni-fiscale.xml \
  | grep -o '<loc>[^<]*</loc>' | sed 's/<[^>]*>//g' \
  | awk 'NR%6==1' | head -12 \
  | while read -r u; do
      rel=$(echo "$u" | sed 's#https://frontaliereticino.ch/##; s#/$##')
      mkdir -p "sample/$rel" && curl -sL -o "sample/$rel/index.html" "$u"
    done
node scripts/audit-information-gain.mjs sample
```

Attenzione a due cose che falsano la misura:

- **Mescolare i locali** in un campione piccolo. Frasi in lingue diverse non si
  somigliano mai, quindi ogni pagina risulta unica e la coorte segna ~100 %.
  L'auditor separa per locale da sé, ma un campione di 12 URL sparsi su quattro
  locali lascia tre pagine per coorte, sotto la soglia di gating.
- **Campionare con `head -N` sulla sitemap.** Le prime N URL di una sitemap
  sono ordinate, quindi sono la stessa provincia o lo stesso cantone: la coorte
  che ne esce non è la famiglia.

## Se devi alzare il gain di una famiglia

Nell'ordine, dal più efficace al meno:

1. **Dagli un payload che solo noi abbiamo.** Offerte reali, snapshot di dati
   nostri, il confronto con i vicini. È ciò che porta i profili datore a 50 %.
2. **Togli i blocchi identici su ogni pagina.** Contano nel denominatore e non
   nel numeratore: rimuoverne uno alza il gain due volte.
3. **Fai dire alla prosa i numeri della pagina**, con i nomi delle entità
   coinvolte. «La differenza rispetto a Cairate vale circa 22 € l'anno» è
   page-specific; «confronta almeno tre comuni» è template.

Ciò che **non** funziona, ed è il motivo per cui la metrica maschera i numeri:
allungare il testo, riscrivere lo stesso contenuto con parole diverse,
aggiungere una sezione uguale su tutte le pagine.

## Ciò che la metrica non misura

- **Unicità rispetto al resto del web.** La coorte è il nostro sito. Una
  famiglia può segnare 50 % qui e ripetere quello che dicono i primi dieci
  risultati di Google. Serve un confronto SERP, che non è automatizzabile da
  qui.
- **Verità dei contenuti.** È coperta altrove
  (`audit-article-factuality.mjs`, `audit-articles-factcheck.mjs`).
- **Esperienze dirette, interviste, commenti di esperti.** La issue le chiede e
  restano da raccogliere: non sono generabili, e generarle sarebbe fabbricare
  testimonianze. Nessuno script in questo repo può chiuderle.
