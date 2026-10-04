# career-ops upstream e il nostro port: cosa è cambiato, cosa conviene riprendere

Data: 2 ottobre 2026. Lavoro di sola lettura, più qualche esperimento locale usa e getta su dati sintetici.

Versioni lette:
- **Upstream:** `career-ops-hq/career-ops` @ `81053f9781` (HEAD di `main` del 2026-10-02T08:06Z, dopo il tag `career-ops-v1.35.0` del 2026-10-01). Licenza MIT, «Copyright (c) 2026 Santiago Fernández de Valderrama» (`src/LICENSE`).
- **Nostro codice:** `valerielinc-ops/frontaliere-si-o-no` @ `origin/main` `51ad234079`. I sei moduli del port sono identici a quelli usati dallo studio (`7823f78481`): `git diff --stat 7823f78481 origin/main -- <6 file>` è vuoto, e `diff` con `proto/baseline/src/` riporta «same».

I file upstream sono stati scaricati solo con `gh api -H "Accept: application/vnd.github.raw" repos/career-ops-hq/career-ops/contents/<path>?ref=81053f97…`, nella cartella `research/co/src/` (elenco in `files.txt`). I percorsi `co/…` in questo documento sono relativi a `la cartella di lavoro dello studio/research/`.

---

## 0. In sintesi

1. **Le tre falle del gate non sono correzioni upstream che ci siamo persi. Sono scostamenti del nostro port.** I file portati non sono cambiati upstream dopo il port:
   - `verify-cv-facts.mjs`: ultimo commit il 2026-09-25;
   - `verify-ats.mjs`: 2026-09-25;
   - `modes/cover.md`: 2026-08-04;
   - `modes/ats.md`: 2026-08-27.

   Upstream:
   - (a) controlla sempre gli strumenti, mentre noi lo saltiamo nel CV adattato;
   - (c) non usa mai l'annuncio come fonte dei fatti, mentre noi lo usiamo per i numeri della lettera.

   La falla (b) invece nasce dal port. Upstream riconosce come strumento una parola con sola maiuscola iniziale («Kubernetes»), ma soltanto dopo parole inglesi che introducono un elenco di strumenti («using», «built with», «Technologies:»). Togliendo quelle parole abbiamo perso anche le maiuscole iniziali.
2. **Sui nostri testi in italiano, tedesco e francese il gate di career-ops non è migliore del nostro.**
   - Dei casi sintetici che devono essere bloccati non ne blocca nessuno. Sui casi (3) e (6-IT) dà al massimo un `warn` di copertura.
   - In compenso blocca a torto il pensum «à 80 %».
   - È scritto per l'inglese: riconosce gli strumenti solo dopo parole come «using» e i conteggi solo con un elenco di nomi inglesi.
   - Il nostro gate proposto resta il migliore: 10 verdetti giusti su 10 nei casi dello studio. Su 17 casi, comprese le nuove sonde, ne sbaglia 4 (§2). Su 17, career-ops ne indovina 7 e il nostro gate attuale 8.
3. **Dopo il port upstream ha aggiunto poco che ci serva direttamente:**
   - `templates/ats-rules.yml` con `atsLint` (2026-10-01);
   - `cv-title-check.mjs` (2026-10-01);
   - `job_break_inside` facoltativo (2026-10-02);
   - modulo di candidatura compilato dal CV adattato (2026-10-01).

   Il valore maggiore sta in idee del 25-28 settembre che il port non ha preso:
   - l'eccezione «requisito citato» (#3917);
   - il vocabolario chiuso e gli alias degli strumenti (`skill-extract.mjs`);
   - la classificazione `gap` dell'annuncio (`jd-skill-gap.mjs`);
   - il limite di pagine e l'ordine cronologico inverso (`generate-pdf.mjs`, `cv-experience-order.mjs`).
4. **Ho trovato tre falle nuove** che lo studio non elencava:
   - (d) un datore o un titolo inventato nella lettera passa tutti i nostri gate, attuale e proposto;
   - (e) il gate proposto blocca a torto un numero dell'annuncio citato per ammettere una lacuna;
   - (f) Typst converte l'apostrofo di «CHF 80'000» in un primo (U+2032), quindi il testo estratto dal PDF diventa «80′000».

---

## 1. Cosa è cambiato upstream dal nostro port

Il nostro port risale al 2026-09-30:
- `736868f322` (merge alle 16:35Z) e `64e4ede2ad`;
- correzione `d5ef0d2a4f` (pensum nel titolo).

I commit non registrano lo SHA upstream portato: quale versione sia stata copiata è **non verificato**.

Commit upstream dal 2026-09-29: 74 (`co/commits-since-0929.tsv`). Storia per file in `co/path-history.tsv`.

| SHA (data) | Cosa | Rilevanza per noi |
|---|---|---|
| `6f1a74e8e3` (10-01) | `atsLint` in `cv-templates.mjs` e **`templates/ats-rules.yml`**: le regole ATS di `modes/pdf.md` come dati. Ogni regola ha `severity`, `detect` (o `null` con `unimplemented_because`), la citazione letterale del punto di pdf.md e un contratto `must_not_flag`. In fondo c'è la sezione `cannot_catch`: contenuto generato con `::before` e `position:absolute`; frammentazione dei titoli con `letter-spacing` o small-caps, per cui «PROFESSIONAL SUMMARY» esce come «P R O F E S S I O N A L S U M M A RY». | **Media.** Il linter è per template HTML e a noi non serve. Ci servono il formato «regole come dati» e l'elenco `cannot_catch`, che dice cosa va misurato sul PDF reso (fase 2, §4). |
| `9f0eec7536` (10-01) | `cv-title-check.mjs`: il titolo di ogni esperienza del CV adattato deve coincidere con quello di `cv.md` per la stessa coppia {azienda, date}. Confronto esatto, solo maiuscole e spazi normalizzati; segnala e non blocca. | **Bassa.** Da noi i ruoli li copia il codice (`tailoredCvBlocks`). Resta scoperto il `headline`, che lo studio ha trovato gonfiato per l'apprendista: vedi fase 1. |
| `dc49e6bd51` (10-02) | `job_break_inside` diventa un'opzione dello stile, non più il default. | Bassa. Nota per il template Typst: un ruolo indivisibile può lasciare buchi a fine pagina. |
| `c2681c6de1` (10-01) | Modalità apply: i campi del modulo si compilano dal **CV adattato**, non da `cv.md`, così il modulo non contraddice l'allegato. Dove il CV adattato omette una sezione intera, conta `cv.md`. Nuovo passo 7b: prima di «Avanti» o «Invia» si controlla che ogni campo obbligatorio sia pieno. | Media, per il runner del portale (`scripts/assisted-application/lib/portal/*`). Fuori dal perimetro CV e lettera. |
| `1a9a76bc47` (10-01) | Tabella «Score Evidence» (`supported`, `partial`, `unknown`) e livello di confidenza della valutazione, distinto da Block G. | Bassa. Se ne servirà una, è un'idea per il match. |
| `bd24097db7` (10-01) | Marcatore `---DEAD_POSTING---`: un annuncio chiuso va confermato da un controllo di liveness deterministico, non dal solo modello. | Bassa. Il nostro `posting-liveness.mjs` è già deterministico. |
| `587cdd8303` (10-01) | Test di contratto per i pacchetti di template della lettera. | Nessuna. |

Commit di poco **precedenti** al port. Non sappiamo se siano entrati: **non verificato**.

| SHA (data) | Cosa | Nel nostro port? |
|---|---|---|
| `dbcf0737d1` (09-25) #3917 | `isDisclosedRequirement`: un numero dell'annuncio citato per ammettere una lacuna («without the 7+ years … this role calls for») non è un'affermazione del candidato (`verify-cv-facts.mjs:575-722`). | **No.** Noi usiamo l'annuncio come fonte dei numeri della lettera. |
| `e27c7b7520` (09-25) #4006 | Un frammento le cui parole sono tutte nelle fonti non è uno strumento; con un determinante in testa non è un elenco (`:48-52`, `:379-386`). | Non applicabile: non portiamo le parole che introducono gli elenchi. |
| `f814dbf441` (09-25) #4306 | Titoli di sezione ATS riconosciuti in tutte le lingue del repo. | Sì, nella forma (`HEADINGS` it/de/fr/en). Manca «percorso professionale». |
| `a73c855037` (09-28) #1297 | `keyword-match.mjs`: copertura ATS con `SYNONYMS` (k8s, aws, postgres, js, ts…) e parole intere. | Parziale: noi non usiamo sinonimi. |
| `b069f629f7` (09-28) #4489 | `cv-experience-order.mjs`: la generazione fallisce se le esperienze non sono dalla più recente. | No. Noi conserviamo l'ordine del profilo. |

---

## 2. Fact-check: career-ops, il nostro gate attuale e quello proposto

### Come funziona upstream (`verify-cv-facts.mjs`, 1458 righe, nessuna dipendenza npm)

- **Fonti.** Solo i file del candidato: `cv.md` e `article-digest.md` (`:40`). La lettera viene verificata sull'HTML intero con `assertFacts(html)` (`generate-cover-letter.mjs:371`) contro le stesse fonti. **L'annuncio non è mai una fonte.**
- **Numeri.** Le percentuali, le valute (`$ € £`, non CHF) e i moltiplicatori `x` sono neutri rispetto alla lingua (`:166-170`). I conteggi richiedono un numero legato al nome più vicino (finestra di 4 parole, `:120-153`), preso da `METRIC_NOUNS`, un elenco **inglese** (`:67-101`: users, engineers, patients… ma non «developers»). Gestisce:
  - le cifre non ASCII e i separatori delle migliaia `, . spazio nbsp`, ma non l'apostrofo svizzero (`:214-237`, `:326-331`);
  - i suffissi k/M/B;
  - le eccezioni «orizzonte di piano» («first 90 days» con «would»; `:567-573`) e «requisito citato» (`:605-606`).
- **Fatti non numerici.** Datore, titolo e strumento, solo dopo parole inglesi che li introducono:
  - `worked at`, `joined`, `Employer:`, `served as`, `Title:`, `Role:` (`:420`, `:438`);
  - `using`, `built with`, `worked with`, `Technologies:`, `tech stack:` (`:439`).

  Uno strumento è valido se ogni parola ha la maiuscola o se c'è una cifra (`looksToolShaped`, `:340-351`). Si tiene comunque se compare tale e quale nelle fonti (`:379`), e si scarta se tutte le sue parole sono nelle fonti (`:385`). C'è poi `delegatedAuthorshipClaims` (`:494`): segnala chi si attribuisce un lavoro che la fonte assegna a un fornitore.
- **Esito.** `pass`, `warn` o `block`. Il `warn` scatta per le `warn_phrases` della configurazione e per `diagnoseCoverage` (`:857`), che segnala «2+ conteggi presenti ma nessuno letto, l'elenco di nomi è solo inglese». Il blocco scatta per numeri, fatti o `forbidden_phrases`.
- **Self-test:** `node verify-cv-facts.mjs --self-test` dà «88 passed, 0 failed» in 0,23 s.

### Confronto voce per voce con `assistedApplicationAiFactCheck.js`

| Aspetto | career-ops | Nostro attuale | Commento |
|---|---|---|---|
| Fonti dei numeri nella lettera | Solo il candidato | Candidato **più annuncio** e riga d'ordine (`AiDraftCore.js:367`) | Falla (c): siamo noi a esserci allontanati da upstream. |
| Fonti nel CV adattato | Candidato, con strumenti sempre controllati | Candidato, ma senza `claimSources` (`TailoredCv.js:190`), quindi `checkGeneratedFacts` salta gli strumenti (`AiFactCheck.js:194`) | Falla (a): upstream non ha questo buco. |
| Numeri | Numero più nome (solo inglese) per i conteggi; %, valute e x neutri | **Ogni** numero deve comparire nelle fonti, anche spezzato in parti, con `'` e `’` come separatori | Il nostro regge meglio in più lingue e con le traduzioni (vedi caso e2). È più debole sul senso: un «5» qualsiasi nelle fonti basta. |
| Apostrofo svizzero («80'000») | Non gestito (`normalizeClaim`, `:329`) | Gestito (`NUMBER_RE`, `:14`) | Meglio il nostro. |
| Strumenti | Dopo parole inglesi, maiuscola iniziale ammessa | Senza parole introduttive: solo sigle, cifre e maiuscole interne (`toolShape`, `:61-67`); «Salesforce» è dichiarato prosa (`:76`) | Falla (b). In una frase italiana nessuno dei due vede «Kubernetes». |
| Strumento corto presente nel CV («Git») | Si tiene se sta nelle fonti (`:379`) | `groundedInCv` lo scarta: niente parole da 4 lettere e nessuna forma da strumento (`TailoredCv.js:118-127`) | Correzione banale (§2, sonda «Git»). |
| Datore e titolo | Dopo parole inglesi | **Nessun controllo** | Falla nuova (d). |
| Lavoro delegato riscritto come proprio | Regex in inglese | Solo nel prompt («Never claim the candidate built…») | Idea per le fasi 0/1, effort medio. |
| Frasi vietate o di avviso | `forbidden_phrases` e `warn_phrases` in `config/cv-facts.json` | Nella lettera solo nel prompt. Il follow-up ha già `BANNED` in codice (`assistedApplicationFollowup.js:133-147`). | Riusiamo il nostro schema del follow-up. |
| Esito a tre livelli | `pass`, `warn` o `block`, più la copertura | Booleano `ok` | Serve alla decisione 8 dello studio (l'eco blocca o segnala?). |

### Esperimento: i nostri casi sui tre gate

Script e output:
- `co/exp/run-gates.mjs`, con output in `co/exp/gates-out.txt`;
- sonde in `co/exp/probe.mjs`, `probe-out.txt`, `fp-probe.mjs`, `fp-probe-out.txt`, `git-probe.mjs`, `git-probe-out.txt`.

Il gate upstream gira:
- importato da `co/src/verify-cv-facts.mjs`, con le fonti scritte su file temporanei;
- con la configurazione assente;
- in due varianti di fonti: solo il CV (come `cv.md`), oppure il CV più la riga d'ordine (titolo, azienda, nome).

Il nostro gate attuale usa:
- `checkDraftFacts` per la lettera;
- per il CV adattato, `checkGeneratedFacts(…, buildFactIndex([candidato]))`, come fa `checkTailoredCvFacts`.

Il gate proposto è copiato da `proto/baseline/gate-proposed.mjs`, e il suo output coincide con `proto/baseline/out/gate-proposed.txt` sui 10 casi comuni.

| # | Caso | Atteso | career-ops (CV) | career-ops (CV + ordine) | Nostro attuale | Nostro proposto |
|---|---|---|---|---|---|---|
| 6 | Lettera buona DE (apprendista) | ok | pass | pass | ok | ok |
| 6 | Lettera buona FR (infermiera) | ok | pass | pass | ok | ok |
| 6 | Lettera buona IT (sviluppatore) | ok | **warn** (3 conteggi non letti) | warn | ok | ok |
| 1 | Sommario: «…uso quotidiano di Kubernetes e AWS» | blocca | **pass ✗** | pass ✗ | ok ✗ | BLOCCA tool:AWS, eco Kubernetes e AWS |
| 2 | Bullet «Deploy su Kubernetes … del 40%» | blocca | **pass ✗** | pass ✗ | ok ✗ | BLOCCA eco Kubernetes |
| 3 | «team di 5 sviluppatori … 400 clienti» (5 solo nell'annuncio) | blocca | warn (2 conteggi non letti) ✗ | warn ✗ | ok ✗ | BLOCCA number:5 |
| 4 | «plus de 3 ans d'expérience» (3 solo nell'annuncio) | blocca | **pass ✗** | pass ✗ | ok ✗ | BLOCCA number:3 |
| 5 | «gute Noten in Mathematik und Englisch» | blocca | **pass ✗** | pass ✗ | ok ✗ | BLOCCA eco Mathematik |
| x | «à 80 %» (pensum dal titolo «80-100%») | ok | **BLOCK ✗** metric «80 %» | BLOCK ✗ («80-100%» dà solo «100%») | ok | ok |
| x | «Python und JavaScript» (JS solo nell'annuncio) | blocca | **pass ✗** | pass ✗ | BLOCCA tool:JavaScript | BLOCCA |
| i1 | «presso Initech come Head of Engineering» (inventati) | blocca | pass ✗ | pass ✗ | **ok ✗** | **ok ✗** |
| i2 | «Pur non avendo ancora i 5 anni di esperienza richiesti…» | ok | pass | pass | ok | **BLOCCA ✗** number:5 |
| e5 | «I do not have the 5 years this role requires…» | ok | pass (eccezione #3917) | pass | ok | **BLOCCA ✗** number:5 |
| e1 | «…using TypeScript, React, Node.js, Kubernetes and AWS…» | blocca | **pass ✗** | pass ✗ | ok ✗ | BLOCCA |
| e2 | «led a team of 5 engineers … 400 customers» | blocca (solo 5) | BLOCK 5 engineers **e 400 customers ✗** | idem | ok ✗ | BLOCCA number:5 |
| e3 | «Worked at Initech as Head of Engineering» | blocca | **BLOCK** employer, title | BLOCK | ok ✗ | ok ✗ |
| e4 | «…built with Git and Docker» | ok | pass | pass | ok | ok |

Verdetti giusti (✗ indica un errore):

| Gate | Casi dello studio (10) | Nuove sonde (7) | Totale (17) |
|---|---|---|---|
| career-ops (solo CV) | 3 | 4 | 7 |
| Nostro attuale | 5 | 3 | 8 |
| Nostro proposto | 10 | 3 | **13** |

I casi dello studio sono le prime dieci righe della tabella. Le nuove sonde sono i1, i2, e5, e1, e2, e3, e4. Il caso e2 conta come errore per career-ops: il verdetto `BLOCK` è giusto, ma include il falso «400 customers». Il gate proposto sbaglia i1, e3 (datore e titolo inventati), i2 ed e5 (requisito citato).

Il conteggio del gate attuale è 5 su 10, non i 4 su 10 dello studio. La differenza è il caso «à 80 %», che deve passare e passa. Il conteggio di career-ops prende il `warn` di (3) come errore e quello della lettera IT come esito accettabile.

Cosa mostrano le estrazioni (`gates-out.txt`, sezione «estrazioni»):
- Nei casi 1-5, x, i1 e i2 career-ops non estrae **nessun** fatto non numerico e nessun conteggio. Dei numeri legge solo le percentuali e «12 patients»: il francese «patients» coincide con il nome inglese.
- **Bug upstream (caso e1):** il catturatore degli strumenti si ferma al punto di «Node.js» (`[^.;\n]+?`, `:439`), quindi Kubernetes e AWS, che vengono dopo, non vengono mai estratti. Senza «Node.js» la stessa frase li estrae e li blocca (`probe-out.txt`, righe 1-2).
- «Led a team of 5 developers» non produce alcun conteggio: «developers» non è in `METRIC_NOUNS` (`probe-out.txt`).
- **Falso positivo tra lingue (e2):** il CV dice «400 clienti», la frase inglese «400 customers», e il legame numero-nome di upstream li considera fatti diversi. Da noi la lettera segue la lingua dell'annuncio e il CV può essere in un'altra: il nostro confronto sui soli numeri è la scelta giusta.

### Falsi positivi del gate proposto (`fp-probe-out.txt`)

L'eco dell'annuncio (parola maiuscola presente nell'annuncio e assente dal candidato) segnala anche parole che non sono fatti:
- «Gerne sende ich Ihnen meine Zeugnisse der letzten **Semester**» dà eco `Semester`;
- «…correspond à mon **Profil**» dà `Profil`;
- «**Cerchiamo** insieme…» dà `Cerchiamo`;
- «il mio **Permesso** G è in fase di richiesta» dà `Permesso`. Questo è difendibile, perché lo stato del permesso deve venire dalle risposte del candidato.

Upstream mitiga lo stesso problema in `jd-skill-gap.mjs` con due mezzi:
1. un **vocabolario chiuso** (`skill-extract.mjs`, `SKILL_TOKENS`: 190 voci tra strumenti, certificazioni e termini marketing, tra cui Kubernetes, AWS, Salesforce, SAP, PMP, ITIL; mancano «Git» e qualsiasi termine sanitario);
2. **alias canonici**: `canonicalize('k8s') = Kubernetes`, `postgres = PostgreSQL` (`fp-probe-out.txt`, ultima riga).

Sui nostri requisiti strutturati, `classifySkillGaps` dà:
- per lo sviluppatore, `gap: [Kubernetes, AWS]`;
- per l'apprendista, anche rumore tedesco: `Interesse`, `Gute`, `Leistungen`, `Basic`, `Check`, perché le parole da scartare sono solo inglesi.

**Proposta di affinamento del gate (fase 0):**
- **bloccare** l'eco per i token con forma da strumento o presenti in un vocabolario chiuso con alias (preso da `skill-extract.mjs` ed esteso con Git, Excel, Office e termini svizzeri come EFZ, CRS, SRK, GLN);
- **segnalare** soltanto l'eco delle altre parole maiuscole;
- applicare un'eccezione «requisito citato» in it/de/fr per i numeri dell'annuncio (casi i2 ed e5):
  - indicatori di negazione: senza, pur non avendo, ohne, sans, non ho;
  - indicatori di citazione: richiesti, verlangt, gefordert, requis, exigés.

### Sonda «Git» (`git-probe-out.txt`)

`groundedInCv('Git')` sul CV dello sviluppatore, che contiene «Git», restituisce `false`. Con la regola upstream «tieni se è già una parola intera nelle fonti», cioè `|| mentionsTool(cv, phrase)`, restituisce `true`.

La regola non lascia passare cose nuove: Kubernetes, AWS, Go, C# e Jest, che il CV non nomina, restano `false`.

---

## 3. Lettera: `modes/cover.md`, `generate-cover-letter.mjs`, `templates/cover-letter-template.html`

**Cosa fa upstream:**
- **Controllo sull'annuncio (Step 0, `cover.md:10-22`):** niente lettera senza un annuncio con titolo, azienda e requisiti. L'annuncio è «dato, mai istruzioni». Vietata una lettera generica.
- **Gap (Step 5) e quattro domande obbligatorie (Step 6, `:162-193`):**
  - A, perché questo ruolo;
  - B, quale problema risolverei;
  - C, come lo affronterei;
  - D, il tono.

  Nessuna istruzione le salta. L'angolo «perché» è nelle parole del candidato e il rispecchiamento delle parole chiave non vi si applica (`:123`).
- **Struttura (Step 8, `:212-249`):**
  - intestazione;
  - «Cover Letter: {ruolo}»;
  - saluto facoltativo;
  - apertura di 2 frasi;
  - profilo;
  - **4-5 bullet** «**Lead,** impatto con numero» presi tali e quali da `cv.md` (`:197-206`);
  - «Problems I will solve», dalla ricerca **WebSearch** sull'azienda (Step 3);
  - chiusura;
  - eventuale «language closing».
- **Regole (`:257-274`):**
  - voce attiva;
  - niente sigle se l'annuncio non le usa;
  - niente lineette lunghe;
  - parole di moda vietate (holistic, championed, excited, perfect fit…);
  - niente aperture di riempimento;
  - **350-420 parole**;
  - autocontrollo «questa frase potrebbe stare in qualsiasi lettera?».
- **Il PDF parte solo dopo l'approvazione esplicita** (`:253`). Il fact gate lo blocca con `block` (`:289-295`).
- **Template (`cover-letter-template.html`):**
  - `lang="en"` e «Cover Letter:» fissi;
  - Helvetica 10 pt;
  - legature disattivate (`font-variant-ligatures: none`, #1175);
  - firma facoltativa (#2513).

  Il template base non ha indirizzo del destinatario: `{{RECIPIENT_BLOCK}}` esiste solo nei pacchetti (`generate-cover-letter.mjs:156-172`). Non ha allegati.
- **Lingua e paese:**
  - la lingua di uscita è quella configurata dall'utente («the JD language … never override», `pdf.md:29`);
  - il formato carta dipende dal paese dell'azienda (Letter per USA e Canada, A4 altrove, `pdf.md:30-32`);
  - nessuna convenzione svizzera.

**Cosa manca a noi e conviene prendere:**
- **Regole rigide della lettera in codice** (fase 0c):
  - frasi vietate per lingua, con lo schema `BANNED` del nostro follow-up;
  - conteggio delle parole (200-320, dalle fonti svizzere dello studio, non i 350-420 upstream);
  - niente lineette lunghe.

  Upstream le ha nel prompt e, per le frasi, nella configurazione del gate.
- **Esito a tre livelli** `pass`, `warn`, `block` con distinzione tra testo «non letto» e «pulito» (`configMissing`, `coverage`). Utile perché la lettera **segnala** all'operatore, mentre il CV **scarta**.
- **Angolo «perché questa azienda» nelle parole del candidato** (fase 4): una domanda facoltativa sulla pagina di revisione al posto dell'invenzione del modello. È coerente con la regola dello studio, che esclude `whyCompany` dall'eco.

**Cosa non prendere:**
- i bullet di risultati nella lettera e la sezione «Problems I will solve» basata su WebSearch: rischio di invenzioni, ed è un formato non svizzero (non verificato che sia accettato in CH);
- 350-420 parole;
- il template HTML inglese.

Dalla nostra parte la lettera ha già formule, oggetto e layout per lingua (studio §5).

---

## 4. CV e PDF: `modes/pdf.md`, `generate-pdf.mjs`, template ATS

**Regole upstream attuali:**
- **Layout** (`pdf.md:76-86`):
  - una colonna;
  - titoli standard;
  - le sezioni vuote spariscono con il titolo;
  - niente dati critici in intestazione o piè di pagina;
  - testo selezionabile UTF-8;
  - niente tabelle annidate;
  - parole chiave nel sommario (prime 5), nel primo bullet di ogni ruolo e nelle competenze;
  - niente testo nascosto.
- **Pagine:** soglia di **2 pagine** con avviso; `--max-pages=1` per i mercati che vogliono una pagina; `--strict-pages` per il limite rigido (`pdf.md:69-71`, `enforcePageBudget` in `generate-pdf.mjs:1086`).
- **Ordine:** la generazione **fallisce** se le esperienze non vanno dalla più recente (`pdf.md:72`, `cv-experience-order.mjs`).
- **Font e rendering:**
  - Space Grotesk e DM Sans (`pdf.md:105-108`);
  - legature disattivate;
  - `normalizeTextForATS` (`generate-pdf.mjs:182-244`): lineette, virgolette curve, zero-width, nbsp, frecce, `·` e `•` sostituiti con «|», `€` con «EUR».
- **Foto** (`pdf.md:267-274`): facoltativa, disattivata di default; «DACH (Germany, Austria, **Switzerland**): a professional photo is standard and often expected».

**Misure mie sul prototipo Typst dello studio** (`co/exp/glyphs*`, `lig*`):
- **Legature:** con Source Sans 3 e Typst 0.15, né pdftotext né pdf.js (unpdf) estraggono caratteri U+FB00-FB06 da «Zertifikat qualifiziert Pflegefachfrau officina efficace…», con o senza `ligatures: false`. Il problema upstream è di Chromium e a noi non serve la correzione, ma conviene un test di regressione.
- **nbsp** (`81~%`): estratto come spazio normale da entrambi gli estrattori. Va bene per lo spazio indivisibile dello studio.
- **`·`, `–`, `•`, `«»`, `č ć`:** estratti correttamente da entrambi. La sostituzione upstream non serve per pdf.js e pdftotext. Per altri ATS: non verificato.
- **Falla (f):** con `smartquote` attivo (il default), «CHF 80'000» diventa «CHF 80′000» (U+2032, primo) e «J'ai» diventa «J’ai». Con `#set smartquote(enabled: false)` restano «80'000» e «J'ai» (`glyphs-smartquote.txt`). I template `ch-cv-inline.typ` e `ch-letter.typ` non impostano `smartquote`: va aggiunto nella fase 2, almeno per le cifre.

**Da prendere per la fase 2:**
- limite di pagine (2, e 1 per gli apprendisti) con avviso e opzione rigida;
- ordine dalla più recente con date numeriche (`04.2026`, `03/2021`). L'analisi upstream conosce solo i mesi inglesi;
- test dell'ordine di lettura con **marcatori** (`tests/cv-visual/pdf-reading-order.spec.mjs`): si riempie il template con `HEADINGMARK1/BODYMARK1…`, si estrae con `pdftotext -raw` e si controlla l'ordine. Prenderei solo l'idea, non il codice: usa Playwright;
- titoli senza `letter-spacing` e senza small-caps (dal `cannot_catch` di `ats-rules.yml`).

---

## 5. Controllo ATS: `verify-ats.mjs` e `modes/ats.md` contro `assistedApplicationAts.js`

Upstream:
- Pesi: testo 15, titoli 20, contatto 15, layout 20, immagini 10, font 10, UTF-8 5, testo nascosto 5.
- Lo controllo gira sull'**HTML** generato:
  - `<table>`;
  - `column-count`;
  - `position:absolute`;
  - font fuori da `ATS_SAFE_FONTS`;
  - `display:none`, `visibility:hidden`, `font-size:0`;
  - testo bianco negli stili inline;
  - email dentro `<header>` o `<footer>` (`verify-ats.mjs:400-640`).
- Ultima modifica il 2026-09-25: niente di nuovo dopo il port.

Il nostro port è fedele per testo, titoli, email e immagini (OCR). Dichiara `notChecked: single_column, fonts, utf8, hidden_text` e riscala il punteggio su 60 (`Ats.js:57-87`).

**Verifiche misurabili dal PDF** che upstream non fa (lui ha l'HTML) e che coprirebbero i nostri `notChecked`. Le idee vengono da `verify-ats` e da `ats-rules.yml` (`cannot_catch`):
1. **Font incorporati e mappa Unicode:** font non incorporati, oppure U+FFFD, `?` o caratteri dell'area d'uso privato al posto di lettere nel nome (il caso «Kova?evi?» dello studio).
2. **Colonne:** gruppi di coordinate x degli elementi di testo per pagina con sovrapposizione verticale, cioè due flussi paralleli. Lo studio ha già `tools/node/ats-order.mjs` per le coppie data-ruolo.
3. **Testo nascosto:** dimensione di font sotto 1 pt, testo fuori dalla pagina, colore di riempimento bianco (richiede `getOperatorList` di pdf.js: non verificato quanto costi).
4. **Titoli frammentati:** regex su sequenze di 5 o più lettere singole separate da spazi («P R O F I L»).
5. **Contatti solo in intestazione o piè di pagina:** email o telefono che stanno solo nella fascia alta o bassa di ogni pagina.

Effort: 2-3 giorni, fase 2. Si applica sia al CV del candidato sia al nostro. Da aggiungere ai titoli: «percorso professionale». Alias delle parole chiave (`SYNONYMS` di `keyword-match.mjs`) per la copertura, che resta solo informativa.

---

## 6. Test e fixture riutilizzabili come corpus di regressione

| File upstream | Cosa contiene | Riuso |
|---|---|---|
| `verify-cv-facts.mjs --self-test` (`:1057-1382`) | 88 asserzioni in inglese: separatori delle migliaia, suffissi k/M/B, nome più vicino, numero che fa da barriera, orizzonte di piano, allow-list, organico non software, cifre non ASCII | **Le forme sì, il testo no.** Da tradurre in it/de/fr e adattare al confronto sui soli numeri. Le più utili: barriera tra due numeri, gonfiamento con suffisso, organico («Managed 45 staff» contro 20). |
| `tests/nonmetric-fact-gate.test.mjs` | 37 `pass(...)` su datore, titolo, strumento, determinanti e lavoro delegato | Forme per la falla (d) e per il lavoro delegato. Solo in inglese. |
| `tests/fact-gate-language-coverage.test.mjs` | 7 test, compresi «Leitete 45 Mitarbeiter an 3 Standorten» e «Gestioné 45 empleados» | Da prendere come casi tedeschi: il nostro gate li blocca se 45 non è nelle fonti (non eseguito su questo caso: **non verificato**). |
| `tests/cover-fact-gate.test.mjs` | Lettera con «25 users» contro «26 users» | Banale. |
| `tests/ats-lint.test.mjs` (45 test), `ats-lint-shipped-templates` | Linter di template HTML | Non applicabile a Typst. |
| `tests/cv-visual/*` | Screenshot Playwright e ordine di lettura con marcatori | Solo l'idea dei marcatori. |
| `evals/fixtures/*` | Stub per la valutazione delle offerte | Nessuno. |

Non ho scaricato `test-all.mjs` (1 MB), che contiene altre regressioni del gate: **non verificato**.

Il corpus di regressione multilingue va costruito da noi, partendo da `proto/synthetic.json` e dalle 17 righe di §2. Le forme upstream servono come lista di controllo.

---

## 7. Altri moduli (solo se migliorati dopo il port)

Verificato con `gh api "repos/…/commits?path=<p>&since=2026-09-29T00:00:00Z"`:
- **Nessuna modifica:** `modes/interview-prep.md`, `modes/followup.md`, `followup-cadence.mjs`, `liveness-core.mjs`, `check-liveness.mjs`, `modes/email.md`, `modes/_writing.md`, `jd-skill-gap.mjs`, `skill-extract.mjs`. I nostri port di follow-up, colloquio e liveness non sono indietro.
- **`modes/oferta.md`:** solo il marcatore DEAD_POSTING, la tabella della confidenza e gli archetipi. La logica di Block G non è cambiata, quindi `assistedApplicationLegitimacy.js` è allineato.
- **`modes/apply.md`:** due modifiche, utili per il runner del portale:
  - i campi del modulo coerenti con il CV adattato allegato;
  - il controllo che i campi obbligatori siano pieni prima di «Avanti».
- **Modalità localizzate `modes/de|fr|it/`:** non hanno regole svizzere.
  - DE è tarato sulla Germania (`de/_shared.md:126-141`): AGG «(m/w/d)», Tarifvertrag, VWL, bAV, «13. Monatsgehalt … oft im November».
  - IT è tarato sull'Italia: RAL, CCNL, TFR, e `it/candidarsi.md:74` dice «Permesso di lavoro: … "Nessun visto richiesto (cittadino UE)"». Per un frontaliere è **sbagliato**: serve il permesso G.
  - FR cita la Svizzera romanda solo nel README (`fr/README.md:3`).
  - Le tabelle legali `templates/protected-grounds.yml`, `immigration-status-requirements.yml` e `jurisdiction-prohibited-content.yml` coprono US, CA-ON, JP e DE. **Nessuna voce CH.**

---

## 8. Cosa riusare: file, fase, effort, obblighi MIT

Le fasi sono quelle del §6 dello studio (`report-cv-lettera.md`). Effort indicativo per una persona.

| Elemento upstream | Uso da noi | Fase | Effort | Codice copiato? |
|---|---|---|---|---|
| Fonti dei fatti = solo il candidato (`verify-cv-facts.mjs:40`; `generate-cover-letter.mjs:371`) | Togliere `posting` dagli indici dei numeri (`AiDraftCore.js:367`); tenere la riga d'ordine | 0 | 2 h e test | No |
| Controllo strumenti sempre attivo | `claimSources` in `checkTailoredCvFacts` (`TailoredCv.js:190`) | 0 | 1 h | No |
| `isDisclosedRequirement` #3917 (`:575-722`) | Eccezione «requisito citato» in it/de/fr per i numeri dell'annuncio (casi i2, e5) | 0 | 0,5-1 g | Struttura delle regex adattata: nota MIT consigliata |
| `isLikelyTool`: «tieni se è già nelle fonti» (`:379`) | `groundedInCv(...) || mentionsTool(cv, phrase)` («Git») | 0 | 1 h | No |
| `skill-extract.mjs` (`SKILL_TOKENS`, `CANONICAL`) e `keyword-match.mjs` (`SYNONYMS`) | Vocabolario chiuso con alias: l'eco blocca solo questi token e quelli con forma da strumento; le altre parole maiuscole vengono segnalate. Alias anche per `mentionsTool` (CV «Postgres», testo «PostgreSQL») e per la copertura ATS | 0 | 1 g | **Sì, dati**: conservare copyright e testo MIT |
| `factClaims` employer e title (`:420`, `:438`) | Controllo datore e titolo con parole introduttive multilingue: presso, bei, chez, come, als, en tant que | 0 (o 1) | 0,5-1 g | Solo l'idea |
| `forbidden_phrases`, `warn_phrases`, esito `pass`/`warn`/`block` | Frasi vietate e conteggio delle parole della lettera in codice (schema `BANNED` del nostro follow-up); esito a tre livelli | 0c | 0,5 g | No |
| `delegatedAuthorshipClaims` (`:494`) | Lavoro delegato riscritto come proprio, con verbi it/de/fr | 1 | 1 g | Idea |
| `cv-title-check.mjs` | Controllo del `headline`: uguale a `profile.headline` o a un ruolo del profilo, altrimenti segnalazione | 1 | 2 h | Idea |
| `cv-experience-order.mjs`, `enforcePageBudget` | Ordine dalla più recente e limite di 2 pagine (1 per gli apprendisti) | 2 | 0,5 g | Idea |
| `ats-rules.yml` (`must_not_flag`, `cannot_catch`) | Regole ATS come dati; detector sul PDF (§5) | 2 | 2-3 g | Formato: nota MIT se si copia il testo |
| `pdf-reading-order.spec.mjs` | Test dell'ordine di lettura con marcatori sui template Typst | 2 | 0,5 g | Idea |
| `normalizeTextForATS` (solo virgolette e apostrofi) | `#set smartquote(enabled: false)` nei template Typst (falla f) | 2 | 1 h | No |
| Foto «DACH incl. Switzerland» opt-in (`pdf.md:267-274`) | Conferma il default regionale della fase 3 | 3 | — | No |
| `cover.md` Step 6A e regola «why-angle nelle parole dell'utente» (`:123`, `:169-176`) | Domanda facoltativa «perché questa azienda» al candidato | 4 | 1 g | No |
| `apply.md` 4b e 7b (`c2681c6de1`) | Runner del portale: campi coerenti con il CV adattato; campi obbligatori pieni | Fuori dalle fasi 0-5 (runner) | 0,5-1 g | No |

**Obblighi MIT:** chi copia «substantial portions» deve includere il copyright e il permission notice.
- Il nostro codice cita «career-ops (MIT)» nei commenti, per esempio `assistedApplicationAiPrompts.js:9-10` («MIT, © Santiago Fernández de Valderrama»).
- Ma in `origin/main` **non c'è** un file NOTICE, THIRD_PARTY o LICENSE né nella root né in `functions/`. Verificato con `git ls-tree --name-only origin/main` e `origin/main functions/`.
- I prompt contengono frasi copiate testualmente da career-ops, per esempio «NEVER add skills that the candidate does not have» (`TailoredCv.js:54`).
- Consiglio un `THIRD_PARTY_NOTICES` con il testo MIT di career-ops prima di copiare altri dati come `SKILL_TOKENS`. Va deciso insieme alla licenza del repo (studio §7.7).

---

## 9. Cosa non riusare e perché

- **I `METRIC_NOUNS` e il legame numero-nome in inglese:**
  - nessun conteggio letto in it/de/fr (casi 3 e 6-IT);
  - un falso positivo quando il CV e il testo sono in lingue diverse (e2: «400 customers» contro «400 clienti»).

  Il nostro confronto sui soli numeri è più adatto a lettere tradotte.
- **L'estrazione di strumenti, datori e titoli con parole introduttive inglesi così com'è:** zero estrazioni sui nostri testi e il bug del punto in «Node.js» (e1).
- **`diagnoseCoverage`:** serve a chi non sa leggere i conteggi. Il nostro controllo sui numeri non dipende dalla lingua.
- **`foldDigits` e l'eccezione «orizzonte di piano»:** le cifre non ASCII non ci riguardano; i nostri prompt non chiedono piani a 90 giorni.
- **`cover-letter-template.html`, `generate-pdf.mjs`, la pipeline Playwright e `atsLint`:**
  - template inglese, USA e HTML;
  - richiede Chromium;
  - noi andiamo su Typst (studio §4).
- **Struttura della lettera upstream** (bullet di risultati, «Problems I will solve» con WebSearch, 350-420 parole): non è svizzera e la ricerca web aumenta il rischio di fatti non verificabili.
- **Modalità `modes/de|fr|it/`:** regole tedesche e italiane, nessuna svizzera; quella IT dà una risposta sbagliata sul permesso per i frontalieri.
- **Sostituzioni ATS di `generate-pdf`** (`·` con «|», `€` con «EUR», nbsp con spazio): con Typst, pdf.js e pdftotext non servono (misurato). Fanno eccezione virgolette e apostrofi (falla f).

---

## Appendice: riproducibilità

Comandi `gh`, tutti dalla root `~/Projects/frontaliere` e tutti attraverso lo shim:
- `gh repo view career-ops-hq/career-ops --json …`
- `gh api "repos/career-ops-hq/career-ops/releases?per_page=8"`
- `gh api "repos/…/git/trees/81053f97…?recursive=1"` → `co/tree.tsv`
- `gh api "repos/…/commits?since=2026-09-29T00:00:00Z&per_page=100"` → `co/commits-since-0929.tsv`
- `gh api "repos/…/commits?path=<p>&per_page=4"` e `…&since=…` → `co/path-history.tsv`
- `gh api repos/…/commits/<sha>` → `co/commits/<sha>.json`
- `gh api -H "Accept: application/vnd.github.raw" "repos/…/contents/<path>?ref=81053f97…"` → `co/src/<path>`

Esperimenti in Node v26, senza installare nulla:
- `node co/exp/run-gates.mjs`
- `node co/exp/probe.mjs`
- `node co/exp/fp-probe.mjs`
- `node co/exp/git-probe.mjs`
- `node co/src/verify-cv-facts.mjs --self-test`

Typst 0.15 dal venv dello studio (`tools/venv`), font Source Sans 3 di `rendercv_fonts`, estrazione con `tools/xpdf-tools-mac-4.06/bin64/pdftotext` e con unpdf da `tools/node/node_modules`.

Limiti:
- casi sintetici e pochi (17);
- testi del modello scritti a mano;
- nessuna chiamata a Codex;
- il gate proposto è il prototipo dello studio, non un'implementazione;
- i falsi positivi dell'eco sono misurati su 7 frasi, quindi il tasso reale è **non verificato**;
- per il test con pdf.js ho creato e cancellato subito un file temporaneo in `tools/node/` (comando con `cp` e `rm`). Tutti gli altri file sono in `co/`.
