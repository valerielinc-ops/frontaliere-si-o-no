# Mappa topical authority — frontaliereticino.ch

Deliverable Fase 1 di issue #5003 ("Costruire Topical Authority"). Misurato sul
corpus live (`packages/articles/content`, sezioni `frontaliere` + `svizzera`),
non dedotto dai nomi dei file. Rimisura con `npx tsx` + `computeSectionTopicAssignment`
(`packages/articles/engine/articleHubPagesPlugin.ts`) se questo documento invecchia.

## Cosa chiedeva #5003 vs cosa esiste

L'issue disegnava 5 pillar aspirazionali e un'architettura pillar→cluster→subpage
mai esistita sotto quei nomi. Il sito ha costruito, per altre issue, un sistema
diverso ma equivalente nella sostanza:

| Chiesto da #5003 | Realizzato da | Dove |
|---|---|---|
| 5 pillar page (`docs/topical-clusters-frontalieri.md`, `src/content/pillars/`) | 1 pillar orchestratore "frontaliere" (#3393) | `build-plugins/frontalierePillarPlugin.ts`, 4 locali su `/frontaliere/` |
| Cluster tematici con subpage dedicate | 14 topic cluster curati × 2 sezioni × 4 locali = hub pages | `packages/articles/engine/topicTaxonomy.ts` + `topicClusters.ts` (#5001) |
| Internal linking pillar↔subpage, 2-3 link/pagina | Related-articles TF-IDF topic-ranked (#5107) + link articolo→hub (questa PR) | `packages/articles/engine/relatedArticlesIndex.ts`, `ogPagesPlugin.ts` |
| E-E-A-T: bio autore, "chi siamo", fonti | Già live: 6 autori con schema `Person`, `/chi-siamo/`, `dateModified` per articolo | `data/authors.ts`, `components/pages/ChiSiamo.tsx`, `services/authorProfileService.ts` |
| Mappa cluster/pillar/stato | **Questo file** | `docs/topical-authority-map.md` |
| Keyword research per cluster, backlink outreach, cadenza mensile KPI | Non implementato — vedi «Fuori dallo scope di una PR di codice» | — |

## I 14 topic cluster e la loro copertura reale

Misurato il 2026-08-24 su `computeSectionTopicAssignment('frontaliere')` /
`('svizzera')` — la stessa chiamata che alimenta sia gli hub (`topicClusterHubsPlugin.ts`)
sia, da questa PR, il link articolo→hub in `ogPagesPlugin.ts`.

| Topic (slug IT) | frontaliere | svizzera | Floor indicizzabile |
|---|---:|---:|---|
| confine-dogana | 605 | 52 | ✅ |
| accordi-politica | 238 | 121 | ✅ |
| salute-assicurazione | 230 | 91 | ✅ |
| salari-stipendi | 227 | 87 | ✅ |
| fiscalita | 222 | 122 | ✅ |
| sicurezza-cronaca | 196 | 22 | ✅ |
| famiglia-scuola | 192 | 108 | ✅ |
| trasporti | 178 | 66 | ✅ |
| franco-prezzi | 138 | 58 | ✅ |
| lavoro-mercato | 135 | 80 | ✅ |
| pensioni | 117 | 116 | ✅ |
| energia-carburanti | 78 | 20 | ✅ |
| permesso-g | 74 | 95 | ✅ |
| casa-affitti | 57 | 82 | ✅ |

`TOPIC_HUB_MIN_ARTICLES = 8`. **Tutti e 14 i topic superano il floor in
entrambe le sezioni** — il criterio di accettazione "ogni pillar ha almeno 5-7
articoli di supporto" è già soddisfatto ovunque, col margine più stretto a 20
(`energia-carburanti`, sezione svizzera).

## Il buco: ~20% del corpus non ha un topic

`assignArticlesToTopics` lascia senza cluster **845/3.539 (23,9%)** articoli
della sezione frontaliere e **221/1.341 (16,5%)** della sezione svizzera —
misurato il 2026-08-24, stessa chiamata della tabella sopra.

**Esperimento fatto e scartato, non solo ipotizzato**: ho provato ad aggiungere
3 topic candidati (`comuni-confine`, `cultura-eventi`, `economia-imprese`) alla
tassonomia e a rimisurare `assignArticlesToTopics` sull'intero corpus. Risultato:
la copertura sale (75,9% → 80,1% su frontaliere) ma **153 dei 222 nuovi membri
di `comuni-confine` non erano affatto orfani — sono stati sottratti ad altri
topic**, spesso in modo palesemente sbagliato (es. "Arresto a Ponte Tresa: 100
chili di hashish" finiva in `comuni-confine` per la sola menzione del toponimo).
Aggiungere topic a bassa specificità peggiora la precisione dei 14 esistenti
più di quanto risolva gli orfani. **Non ritentare questa fix senza prima
rifare questa misura** — il codice della prova è nella cronologia di questa
sessione, non nel repo.

Guardando i titoli campione, il grosso dei non-assegnati è: cronaca locale
(arresti, incidenti, tribunale), eventi/cultura (festival, mostre, sagre),
economia d'impresa locale (fatturati aziendali, aperture attività) — contenuto
adiacente al bacino "Ticino/fascia di confine" ma non strettamente sui
frontalieri. Il principio #1 della issue originale lo dice esplicitamente:
*"Evitare dispersione su argomenti non strettamente collegati"*. Lasciare
questo 20% fuori dai 14 cluster core è quindi coerente con l'obiettivo della
issue, non un gap da chiudere — ma resta un fatto misurato da tenere aggiornato,
non un giudizio definitivo.

## Internal linking: lo stato dopo questa PR

- **Articolo → articolo** (#5107, 2026-08-05): related-articles TF-IDF
  topic-ranked con floor anti-orfano. 0% di articoli senza link in entrata
  (era 99,48%).
- **Articolo → hub del proprio topic** (questa PR): ogni articolo con un
  topic assegnato ora linka la propria hub page (`/articoli-frontaliere/argomenti/<topic>/`)
  come primo elemento della lista "Articoli correlati", in tutti e 4 i locali.
  Prima di questa PR il link esisteva solo nella direzione hub→articolo
  (26 articoli linkati per hub) e mai articolo→hub — zero occorrenze di
  `argomenti/` in un `<a href>` su una pagina articolo pubblicata.
- **Hub → articolo** (#5001): ogni hub page linka fino a 24 articoli membri
  per pagina, con paginazione.
- **Hub → hub gemello** (bridge sotto il floor): i topic sotto
  `TOPIC_HUB_MIN_ARTICLES` emettono comunque una pagina `noindex,follow` che
  linka in avanti — nessuna URL storica torna 404.

Il grafo pillar↔spoke che l'issue chiedeva ("ogni articolo deve linkare alla
pagina pillar del cluster") è quindi ora bidirezionale sul ~76-84% del corpus
coperto da un topic.

## Segnali E-E-A-T già live (non aggiunti da questa PR)

- 6 autori con profilo (`data/authors.ts`), schema `Person` +
  `worksFor.Organization` in ogni articolo, pagina `/autori/<slug>/`.
- `/chi-siamo/` — mission, fonti, expertise, contatti (`ChiSiamo.tsx`, si
  autodescrive nel commento come requisito E-E-A-T per gli OG `article:author`).
- `dateModified` per articolo, coerente tra JSON-LD e testo visibile.
- **Non presente**: un segnale "revisionato da un esperto" per contenuti
  fiscali/legali (`reviewedBy` in JSON-LD). Richiederebbe un vero workflow
  editoriale di revisione che oggi non esiste — aggiungere il campo schema
  senza una revisione reale dietro sarebbe uno structured-data falso, che
  Google penalizza. Non implementato — **blocked**: serve prima un processo
  editoriale reale, non codice.

## Fuori dallo scope di una PR di codice

Le Fasi 2-4 della issue originale sono lavoro editoriale/di business
development ricorrente, non uno stato terminale che un commit possa
raggiungere:

- **Produzione di 5-7+ articoli per cluster, cadenza 1-2/settimana** — già
  soddisfatto oggi (vedi tabella sopra) e mantenuto dalla pipeline di
  generazione esistente, non da un nuovo script.
- **Backlink da siti esterni, outreach, guest post** — richiede negoziare con
  terzi; nessun agente può "implementarlo" scrivendo codice in questo repo.
- **Review mensile delle metriche, aggiornamento del piano contenuti** — un
  processo umano ricorrente, non un artefatto di codice. L'infrastruttura dati
  che lo alimenterebbe (GSC, `data/gsc-*.json`) esiste già per altri scopi nel
  repo.

`per scelta`: questi tre punti restano fuori — non per pigrizia, ma perché non
hanno una forma di "fatto" raggiungibile da una modifica al repository.
