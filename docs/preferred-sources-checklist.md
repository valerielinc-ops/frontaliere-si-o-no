# Checklist — Google Preferred Sources (AI Overviews / AI Mode)

> Deliverable della **fase 1** della issue 5004 («Implementazione Google Preferred
> Sources per AI Overviews e AI Mode»). La issue e' stata chiusa `completed` il
> 2026-08-05 dalla PR #5104, insieme a #5098 e #5101, ma quelle tre PR coprono
> **solo** gap della fase 2 (freschezza di `sitemap-news.xml`/`llms.txt`, hero
> image statica in-articolo, entita' `#organization` unificata in
> `NewsMediaOrganization`). Questa checklist — il deliverable esplicito della
> fase 1 — non era mai stata creata: `git log --all --grep` non ha un solo hit
> sul suo path. Questo documento la scrive per la prima volta, come **audit
> onesto punto per punto**: cosa e' verificato nel codice, e cosa resta fuori
> dalla portata di una PR.

Preferred Sources non ha un interruttore da accendere. Ha due meta' distinte, e
confonderle e' il modo in cui questa issue e' rimasta aperta dentro una issue
chiusa:

- **Eleggibilita' tecnica ed editoriale** — la parte che il repo controlla. E'
  quella auditata sotto, ed e' completa.
- **Selezione da parte dell'utente** — Preferred Sources e' una preferenza che
  ogni persona imposta nel **proprio** account Google. Nessun sito puo' farlo al
  posto suo; il massimo che il sito puo' fare e' portarla al pannello giusto con
  un click. Fino alla PR che accompagna questo documento, **nessuna superficie
  del sito lo faceva**.

Il deep link canonico e':

```
https://www.google.com/preferences/source?q=frontaliereticino.ch
```

Il parametro `q` porta il **dominio canonico senza `www`** (vedi
`AGENTS.md` → `## Architecture`), che e' l'hostname che serviamo davvero: la
variante con `www` viene 301-redirectata all'edge, quindi passarla qui
significherebbe chiedere a Google di preferire un hostname che non e' quello
canonico.

## 1. Criteri di eleggibilita' — stato verificato

### ✅ Schema `Article`/`NewsArticle` valido

Emesso da `packages/articles/engine/ogPagesPlugin.ts` (`'@type': 'NewsArticle'`,
riga ~1234): include `datePublished`, `dateModified`, `author` con `sameAs`,
`publisher`, `image` con `width`/`height` espliciti, e `mainEntityOfPage`
puntato alla URL piena (riga ~1261). L'entita' autore — `sameAs` e `url` della
`Person`, piu' il riferimento `worksFor` a `#organization` — vive in
`services/seo/seo-authors.ts`.

**Nessuna azione.** Questa parte non e' stata toccata dalla PR che accompagna il
documento, proprio perche' l'audit la trova a posto: modificarla sarebbe stato
churn su una superficie SEO funzionante.

### ✅ `robots.txt` — crawler AI ammessi

`public/robots.txt`, sezione **«AI Crawlers & LLM Agents»**: `GPTBot`,
`Google-Extended`, `ClaudeBot` e `PerplexityBot` hanno tutti `Allow: /`. Il
commento in quel blocco spiega la ratio — sono crawler di **citazione e
visibilita'**, non di sola estrazione, quindi bloccarli chiuderebbe il canale
che Preferred Sources alimenta.

Da non confondere con i crawler bloccati piu' sotto nello stesso file (es.
`Amazonbot`): quelli non portano un canale di visibilita' e restano fuori per
scelta.

### ✅ Sitemap aggiornata e fresca

La freschezza di `sitemap-news.xml` e di `llms.txt` e' garantita dalla **PR
#5098**: la sitemap news e' pubblicata all'edge a ogni deploy e su dispatch,
invece di dipendere da un solo passaggio di build. Era il gap piu' concreto
della fase 2 e la sua chiusura e' reale.

### ✅ Ownership del dominio verificata in Search Console

Record `TXT` DNS `google-site-verification` presente sul dominio — misurato e
riportato in `docs/audit-google-discover.md` §1, che documenta anche
l'integrazione GSC del repo (script di monitor, ingest e refresh).

**Attenzione a non dedurne troppo**: questa ownership e' quella di *Search
Console*, non quella del *Publisher Center*, che e' un tool separato con una sua
verifica. Vedi §2.

### ✅ Entita' organization coerente

Unificata in una singola `NewsMediaOrganization` sotto `#organization` dalla **PR
#5104** — la stessa PR che ha chiuso la issue. Prima c'erano dichiarazioni
divergenti tra le superfici; ora l'entita' e' una.

### ✅ Cadenza di pubblicazione

Il minimo richiesto per questo genere di programmi e' dell'ordine di 1-2
pubblicazioni a settimana. La pipeline articoli del progetto pubblica con
cadenza **ampiamente superiore a quel minimo** — vedi
`docs/ARTICLE-LEARNING-LOOP.md` per il ciclo di generazione e pubblicazione.

Numeri precisi non sono riportati qui **deliberatamente**: una cifra copiata da
una misura vecchia in un documento di checklist invecchia in silenzio e diventa
una fonte di verita' falsa. Se serve il dato, va rimisurato al momento.

### ✅ CTA utente verso il pannello Preferred Sources — *in questa PR*

Era la **fase 4** della issue, ed era il buco piu' grande: verificato con un
grep repo-wide (`preferences/source`, `PreferredSource`, «fonti preferite») che
prima di questa PR **non esisteva una sola riga di codice funzionante**. L'unico
match era un commento in `tests/organization-entity-consolidation.test.ts` che
citava il numero della issue.

Tre touchpoint, tutti con tracking distinto per superficie:

| Superficie | File | `cta_id` |
|---|---|---|
| Footer del sito | `App.tsx` (footer inline, accanto a `DonationBanner`) | `footer_preferred_source_cta` |
| Fine di **ogni** articolo | `components/community/BlogArticles.tsx` | `article_preferred_source_cta` |
| Newsletter (HTML email) | `services/newsletter-template.mjs` | link diretto, email |

Il componente e' `components/shared/PreferredSourceCTA.tsx`, in 4 locali
(`it`/`en`/`de`/`fr`). A differenza di `ConsultingCTA` **non** e' gateato per
categoria di articolo: la selezione come fonte preferita vale per il dominio
intero, quindi ogni articolo e' un punto di contatto legittimo.

L'osservatore che impedisce la regressione e'
`tests/preferred-source-cta.test.tsx`: verifica il deep link, il `rel` sicuro,
il tracking, **il montaggio effettivo** in footer e fine-articolo, e l'esistenza
di questo documento. La parte sul montaggio e' quella che conta: un componente
corretto e non montato e' esattamente il difetto che la issue 5004 aveva.

## 2. Cosa resta fuori — e perche' non e' automatizzabile

### 🔲 `blocked: richiede azione manuale del proprietario su publishercenter.google.com`

Il Publisher Center e' un tool Google separato da Search Console, con la sua
verifica e il suo login. Nessuno di questi passi e' raggiungibile da codice:
richiedono una sessione umana autenticata con l'account Google che amministra il
dominio.

Passi che il proprietario deve fare a mano, in ordine:

1. **Accedere** a `https://publishercenter.google.com` con l'account Google che
   amministra `frontaliereticino.ch`.
2. **Creare la publication** per il sito, se non esiste ancora.
3. **Verificare l'ownership** dentro il Publisher Center. La verifica di Search
   Console (§1) **non si trasferisce**: e' un flusso distinto, e va completato
   li'.
4. **Caricare il logo** nei formati richiesti dal tool (rettangolare e
   quadrato). Il logo di riferimento e' quello gia' dichiarato nell'entita'
   `#organization` — usare lo stesso asset, altrimenti l'entita' e la
   publication divergono.
5. **Dichiarare le categorie** editoriali: **Lavoro**, **Finanza**, **Diritto**.
6. **Confermare** la publication e attendere la revisione Google.

Finche' questi passi non sono fatti, l'eleggibilita' tecnica del §1 resta
condizione necessaria e non sufficiente. Non c'e' modo di sbloccarlo dal repo, e
non c'e' un gate CI sensato da scrivere: non esiste un'API pubblica del
Publisher Center da interrogare per sapere se la publication e' stata approvata.

### 🔲 `blocked: editoriale, non codice`

Un **post social dedicato** che spieghi ai lettori come selezionare il sito come
fonte preferita — richiesto dalla fase 4 della issue accanto alla CTA in-app.

La CTA in-prodotto (§1, ultima voce) copre chi e' gia' sul sito o iscritto alla
newsletter. Il post social copre chi non lo e' ancora, ed e' l'unica meta' della
fase 4 che una PR di codice non puo' consegnare: e' contenuto editoriale
pubblicato su canali esterni, con copy e timing che non stanno in questo repo.
Il deep link da usare nel post e' quello in testa a questo documento.

## 3. Come rileggere questo documento

Se torni qui per capire «Preferred Sources e' fatto?», la risposta e' in due
righe:

- **Il repo ha finito**, con l'eccezione di nulla: eleggibilita' tecnica
  completa (§1) e le tre superfici di CTA live.
- **Restano due voci fuori dal repo** (§2), entrambe `blocked` su qualcosa che
  richiede una persona: un login al Publisher Center e un post editoriale.

E la lezione di processo, che vale oltre questa issue: la 5004 e' stata chiusa
`completed` da una PR che ne copriva una fase su cinque, e nessun gate se ne e'
accorto perche' **non esisteva un test di cio' che mancava**. La checklist da
sola non basta a impedirlo — per questo l'osservatore
(`tests/preferred-source-cta.test.tsx`) verifica anche che *questo file* esista.
