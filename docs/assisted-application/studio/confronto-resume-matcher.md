# Resume-Matcher (srbhr/Resume-Matcher) a confronto con la candidatura assistita

Data 2 ottobre 2026. Solo studio, nessuna modifica ai repository.
Ho letto Resume-Matcher (RM) a `main@9c05e423df`, che è anche l'ultimo commit (29 settembre 2026, merge della PR #1010). Il nostro codice l'ho letto su `origin/main@51ad234079` del sito.
I file di RM li ho scaricati con `gh api -H "Accept: application/vnd.github.raw" repos/srbhr/Resume-Matcher/contents/<path>?ref=main` in `research/rm/src/`. L'albero completo (539 file, `truncated:false`) è in `research/rm/tree.txt`.
Gli esperimenti sono in `research/rm/exp/`, usano solo `proto/synthetic.json` e non chiamano nessun LLM.
I percorsi `rm:` sono relativi a `research/rm/src/`.

---

## 1. Sintesi dell'architettura

- **Stack.** Backend FastAPI in Python 3.13, con LiteLLM (oltre 100 provider), SQLite, markitdown e pdfminer, Playwright. Frontend Next.js 16 con React 19 (`rm:docs/agent/scope-and-principles.md`, `rm:apps/backend/pyproject.toml`). Non usa embedding: `gh search code --repo srbhr/Resume-Matcher embedding` trova solo un file di design. I topic del repo («word-embeddings», «vector-search») sono storici.
- **Pipeline di tailoring.** È il preview di `rm:apps/backend/app/routers/resumes.py:1247-1565`. I passi:
  1. `extract_job_keywords`: LLM, con cache per hash del contenuto dell'annuncio.
  2. Selezione bullet, facoltativa: l'LLM dà **solo** un punteggio a ogni bullet; il codice sceglie i primi N e adatta il CV a una pagina con una ricerca binaria su render reali.
  3. `generate_skill_target_plan`: LLM.
  4. `verify_skill_target_plan`: codice.
  5. `generate_resume_diffs`: l'LLM produce un elenco di modifiche, non il CV.
  6. `apply_diffs`: codice, 4 cancelli.
  7. `verify_diff_result`: codice, solo avvisi.
  8. Ripristino di dati personali, date, skill e sezioni custom: codice.
  9. `refine_resume`: un solo passaggio LLM di «keyword injection», poi codice.
  10. `finalize_ai_resume` e `grounding_review_warnings`: codice.
  11. Punteggio ATS: codice.
  12. Preview registrata con l'hash del payload.

  Alla **conferma** (`resumes.py:1567-1723`) il server rivalida il payload, poi genera lettera, messaggio di outreach, titolo e preparazione al colloquio. Nel caso massimo sono 5 chiamate LLM nel preview e 4 alla conferma.
- **Principio di progetto.** «Diff-based»: l'LLM non riscrive mai il CV intero, propone modifiche puntuali `{path, action, original, value, reason}` e il codice decide quali applicare. Il razionale è in `rm:docs/superpowers/specs/2026-03-23-diff-based-improvement-design.md` §1: la riproduzione dell'intero CV è indicata come «root cause of hallucination».

---

## 2. Risposte puntuali

### 2.1 Pipeline di tailoring

**Estrazione delle keyword.** Una chiamata LLM con `EXTRACT_KEYWORDS_PROMPT` (`rm:app/prompts/templates.py:188-209`) produce `required_skills`, `preferred_skills`, `keywords`, `experience_years` e `seniority_level`. La validazione è in `improver.py:56-68`. Le skill dell'annuncio contano come «esplicite» solo se compaiono letteralmente nel testo dell'annuncio (`improver.py:791-810`, `refiner.py:82-99`), una piccola difesa contro le keyword allucinate dall'estrattore.

**Riscrittura.** `DIFF_IMPROVE_PROMPT` (`templates.py:560-635`) chiede «changes» con il testo originale copiato. `apply_diffs` (`improver.py:300-492`) applica 4 cancelli:
1. il path è in una whitelist: summary, bullet di esperienze e progetti, descrizione della formazione, liste `additional` (righe 146-157);
2. il path non è bloccato: `personalInfo`, `customSections`, `years`, `company`, `title`… (righe 160-211);
3. il path esiste nell'originale;
4. per `replace`, l'`original` coincide con il testo reale, dopo casefold e strip (righe 355-365).

Il `reorder` deve essere una permutazione: le voci nuove sono ammesse solo nelle skill e solo se verificate (righe 395-456).

**Il ciclo «migliora finché lo score sale» non c'è:**
- `refine_resume` (`refiner.py:102-247`) fa **un solo** tentativo di keyword injection (righe 136-165).
- `RefinementConfig.max_refinement_passes` è definito (`rm:app/schemas/refinement.py:12`) ma non è usato da nessuna parte: `grep -rn max_refinement_passes apps/backend` trova solo la definizione.
- La spec lo esclude in modo esplicito: «This is safer than retrying with feedback, which risks compounding hallucination. The worst case is "no changes applied" rather than "wrong changes applied."» (spec §8.2).

**Come limitano Goodhart:**
- L'injection usa solo le keyword «injectable», cioè assenti dal CV adattato ma presenti nel master (`refiner.py:250-299`).
- `validate_master_alignment` toglie skill, certificazioni e aziende inventate (`refiner.py:359-477`).
- `finalize_ai_resume` ripristina le righe con numeri nuovi (`resume_preservation.py:516-567`).

**Ma con una scappatoia voluta.** Le skill required e preferred dell'annuncio **non presenti nel CV** sono accettate come `jd_added` (`improver.py:867-879`). Il commento dice: «adding relevant JD skills is the product's purpose… The user reviews additions in the diff preview». `SKILL_TARGET_PLAN_PROMPT` lo chiede anche al modello (`templates.py:505`: «You may include JD skills that are missing from the resume skills list»). La stessa whitelist le salva dal controllo di allineamento (`refiner.py:191-195`). È il caso Kubernetes e AWS in forma istituzionalizzata.

**Fatti preservati.**
- `CRITICAL_TRUTHFULNESS_RULES_TEMPLATE` (`templates.py:211-240`) ha 9 regole: niente skill, numeri, aziende o termini nuovi, niente promozioni di livello, date copiate, niente skill rimosse. La regola 7 cambia con la strategia (`nudge`, `keywords`, `full`).
- Le regole sono solo il primo strato. Un test le «blocca» nel prompt, `rm:tests/unit/test_prompt_guardrails.py`: verifica che le clausole anti-invenzione restino nel testo.

**Controlli deterministici dopo l'LLM**, tutti in `rm:app/services/resume_preservation.py`:
- **Campi protetti.** Ripristinati per ogni voce: `id`, `title`, `company`, `location`, `years`… (righe 21-26, 400-404).
- **Numeri nuovi** (`_novel_numbers`, righe 168-211):
  - confronto con **la stessa voce**: righe dello stesso ruolo, oppure il summary contro il summary;
  - si conta la **molteplicità** (`Counter`);
  - valute, unità e scale sono normalizzate (k, m, %, x, ms, GB);
  - si escludono gli anni in contesto di data e le versioni («Python 3»);
  - un numero nuovo fa **ripristinare la riga originale**.
- **Somiglianza per riga** (`_similarity`, righe 128-143): sovrapposizione di token e `SequenceMatcher`, soglia `0.45` (riga 13).
  - In preview una riga poco somigliante resta, con l'avviso `GROUNDING_REVIEW_REQUIRED` (righe 722-860).
  - In modalità diretta (`allow_review_claims=False`) viene ripristinata.
- **Struttura.** Una riga del CV adattato corrisponde a una del sorgente (`_merge_description_rows`, righe 254-323). Le righe aggiunte sono ammesse solo se `allow_appended_rows` e se sono «grounded».
- **Conferma.** `validate_confirmed_resume` (righe 613-719) restituisce codici di violazione stabili sul payload di conferma.
- **Avvisi** di `verify_diff_result` (`improver.py:512-585`): numero di sezioni, campi identità, parole cresciute più di 1,8 volte, metriche nuove (`_METRIC_RE` alla riga 181). Sono solo informativi.

**Cosa non controllano.** Gli **strumenti e le skill inventati dentro la prosa**, cioè summary e bullet, non sono controllati: si veda l'esperimento al §3.

### 2.2 Scoring ATS

`rm:app/services/ats.py` è solo keyword, deterministico, senza embedding né LLM:
- **Formula.** `0,55·keyword_match + 0,25·skills_coverage + 0,20·section_completeness` (righe 18-22).
- **keyword_match.** Quota di required, preferred e keywords trovate come parola intera (`refiner.py:721-748`).
- **section_completeness.** Presenza di summary, esperienza, formazione e skill.

È utile come metrica secondaria? **Solo in una forma che RM calcola ma non usa.**
- `analyze_keyword_gaps` separa le keyword mancanti in `injectable` (presenti nel master) e `non_injectable` (assenti, «cannot add truthfully»). Ne ricava `potential_match_percentage`, il **tetto onesto** (`refiner.py:288-299`, `schemas/refinement.py:15-35`).
- Una copertura del CV adattato **sopra il tetto** implica per costruzione un termine non sostenuto dal CV. Nell'esperimento del §3 la regola segnala esattamente i 3 casi di invenzione di keyword e nessuno dei 4 casi legittimi o numerici.

Rischi di usare lo score ATS così com'è:
- premia l'invenzione: 77,8 → 100 con Kubernetes e AWS nel sommario (§3);
- le raccomandazioni spingono a inventare, perché «Add these high-priority missing keywords» usa proprio le `non_injectable` (`ats.py:138-140`, `resumes.py:584-590`);
- la UI lo mostra in evidenza (`rm:apps/frontend/components/tailor/ats-score-card.tsx`).

### 2.3 Lettera

**Prompt e codice.**
- `COVER_LETTER_PROMPT` (`templates.py:365-387`): 100-150 parole, 3-4 paragrafi.
  - **Apertura:** «Reference ONE specific thing from the job description (product, tech stack, or problem)».
  - **Centro:** 1-2 qualifiche «reframed in the job's language/terminology where the candidate's proven experience supports it» (esempio: «automated data pipelines» → «ETL»).
  - **Chiusura:** disponibilità semplice.
  - Poi: la transizione di carriera va presentata come scelta, il nome dell'azienda va estratto dall'annuncio, «Do NOT invent information not in the resume», tono «Confident peer, not eager applicant», niente em dash.
- `rm:app/services/cover_letter.py:37-89`: chiamata `complete` con testo libero e **nessun controllo dopo l'LLM**, né sui fatti né sulla lunghezza. Si può sostituire il prompt dall'interfaccia (righe 18-34).
- **Lingue**: `LANGUAGE_NAMES` (`templates.py:4-12`) ha en, es, zh, ja, pt, fr e ko. **Mancano DE e IT.** La lingua è solo il nome iniettato nel prompt (`{output_language}`); non ci sono convenzioni per lingua.
- **PDF** (`rm:apps/frontend/app/print/cover-letter/[id]/page.tsx`): nome e contatti, data nel formato della lingua, paragrafi. Non ci sono destinatario, oggetto, formule di saluto, firma né allegati.

**Cosa prendere per i nostri template DE, FR e IT:**
- poco: l'apertura «una cosa specifica dell'annuncio» e il tono «da pari, non supplicante», che sono già vicini al nostro `documentsSystemPrompt` (200-320 parole e formule);
- l'idea di **lockare le clausole del prompt con un test**.

**Cosa non prendere:** il «reframe in the job's terminology». È proprio l'«eco dell'annuncio» che il gate proposto in fase 0 blocca: «ETL» non presente nel CV verrebbe segnalato come `tool`.

### 2.4 Interfaccia di revisione

**`DiffPreviewModal`** (`rm:apps/frontend/components/tailor/diff-preview-modal.tsx`):
- schede di riepilogo: skill aggiunte e rimosse, certificazioni, descrizioni modificate, «high risk»;
- sezioni ripiegabili per tipo;
- `ChangeItem`: originale barrato e nuovo testo, glifo `+`, `-` o `~`, icona di avviso sugli aggiunti ad alto rischio (righe 459-506);
- due soli pulsanti, **Reject** e **Confirm**, per tutto il blocco (righe 343-369).

**Nessuna accettazione o rifiuto per riga.** La doc lo dice: «send the complete, unchanged `resume_preview` returned by preview» (`rm:docs/agent/features/preview-confirmation.md`). Il server rifiuta un payload con un hash diverso da quello registrato (`rm:app/database.py:751-754`). Alla conferma rivalida anche che `finalize_ai_resume(original, payload) == payload` (`resumes.py:1607-1612`) e che `validate_confirmed_resume` non trovi violazioni.

**Il diff** è calcolato lato server da `calculate_resume_diff` (`improver.py:1264-1511`):
- `SequenceMatcher` sui bullet;
- confidenza `high` per skill, certificazioni, lingue e premi aggiunti;
- l'ordine delle skill è ignorato.

**Altri componenti:**
- **Evidenziazione delle keyword** in `JDComparisonView` e `HighlightedResumeView`, con `keyword-matcher.ts`. È solo ASCII: `split(/[^a-z0-9-]+/)` alla riga 213 spezza «Zuverlässigkeit» e «compétences».
- **Rigenerazione per voce** su istruzione del candidato: `regenerate-dialog.tsx` e `regenerate-diff-preview.tsx`, con accetta o rifiuta l'insieme.
- **Modifiche libere** dopo la conferma nel builder. `update_resume_endpoint` valida solo lo schema (`resumes.py:1990-2048`).

**È un modello per la nostra fase 4?** Sì per la **forma dei dati**: l'originale verificato in ogni modifica, il `reason`, la classe di rischio, la rivalidazione lato server. Sì in parte per la **presentazione**: originale barrato e nuovo accanto, rischio evidenziato. No per l'**interazione**: tutto o niente, mentre noi vogliamo righe accettabili singolarmente e modificabili.

### 2.5 Parsing e import

- **Conversione.** `MarkItDown().convert()` per PDF, DOC e DOCX (`rm:app/services/parser.py:726-751`), con `markitdown[docx]==0.1.4` e `pdfminer.six` (`pyproject.toml`).
  - Prima della conversione validano molto i container: limiti di decompressione, header CFB per i DOC (righe 317-455).
  - Non c'è OCR.
  - Se markitdown estragga davvero testo dai .doc legacy non l'ho verificato.
- **Struttura.** Poi `PARSE_RESUME_PROMPT` (`templates.py:162-186`) porta il testo nello schema `ResumeData` (`rm:app/schemas/models.py:144-422`):
  - `personalInfo`: nome, titolo, email, telefono, località e link;
  - `summary`, `workExperience`, `education`, `personalProjects`;
  - `additional`: skill, lingue, certificazioni, premi;
  - `customSections`: chiave libera e tipo `text`, `itemList` o `stringList`.
  - I mesi persi dall'LLM sono ripristinati in codice (`restore_dates_from_markdown`), ma la regex dei mesi è **solo inglese** (`parser.py:470-490`).
- **Mancano** data di nascita, nazionalità, permesso e foto: le convenzioni svizzere non sono coperte. Il nome «swiss-single» si riferisce allo stile tipografico, non al CV svizzero (`rm:docs/agent/design/template-system.md`).

### 2.6 Template PDF

- **Gli asset** `assets/pdf-templates/*.pdf` sono **solo esempi** per il README, alle righe 162-169.
- **Il PDF** lo stampa Chromium con Playwright, partendo dalla route Next `/print/resumes/[id]`: `page.pdf(format, print_background=True)` (`rm:app/pdf.py:344-420`, `rm:docs/agent/design/pdf-template-guide.md`).
- **I template** sono 7 componenti React (`components/resume/*.tsx`):
  - a una colonna: swiss-single, modern, latex, clean;
  - a due colonne: swiss-two-column, modern-two-column, vivid.
- **i18n**: solo la lingua dell'interfaccia (7 file `messages/*.json`) e i font CJK.
- **Verifica con pdf.js** (unpdf) sui due esempi (`exp/rm_pdf_order.out`):
  - una pagina, testo estraibile, font incorporati come subset;
  - ordine di lettura sequenziale anche nella versione a due colonne (prima la colonna principale, poi la laterale);
  - i font sono quelli dell'host (`.SFNS`, Georgia, Menlo), quindi l'output dipende dalla macchina che stampa.

### 2.7 Test e valutazione

- **Test.** 74 file di test nel backend e 69 nel frontend (conteggio da `tree.txt`). L'unico workflow CI è `docker-publish.yml`: i test girano solo nel `pre-push` locale (`uv run pytest`, `vitest run`), che si può saltare con `--no-verify`.
- **Eval in due strati** (`rm:apps/backend/tests/evals/README.md`):
  1. **Scorer strutturali deterministici** (`scorers.py`): `sections_preserved`, `no_fabricated_employers`, `jd_keywords_present`, `is_valid_resume`, `personal_info_unchanged`.
     - Ogni scorer ha un test che lo fa scattare su un input volutamente sbagliato («anti-theater proof»).
     - I golden case (`golden/cases.py:367-394`) distinguono `jd_keywords` (tutte le keyword di riferimento) da `grounded_keywords` (quelle sostenute dall'originale). Il caso 1 ha Kubernetes tra le `jd_keywords` ma non tra le `grounded_keywords`.
  2. **LLM come giudice**, solo su richiesta (`RM_RUN_PAID_EVAL=1`, marker `eval`, mai in CI). Rubrica: «the JOB DESCRIPTION is a target, not evidence of experience… never infer… counts or proficiency from a skill or job requirement» (`rm:e2e_monitor/judge.py:8-16`). Però permette «explicitly allowed JD skills».
- **Monitor end-to-end** (`rm:e2e_monitor/`): bundle di evidenze, baseline versionata con `floor` e `judge_tolerance`. Il baseline attuale ha un giudizio di **2/5 in 3 annunci su 4** e una copertura minima di 0,5 (`baseline/baseline.json`): la qualità non è dimostrata.
- **Riusabile come corpus?** No: 2 golden case e 4 annunci, tutti in inglese e su ruoli tech USA. Come **schema per la nostra CI** sì: golden sintetici DE, FR e IT con `tailored_good` e `tailored_bad`, scorer puri, test di regressione sui prompt, giudice opzionale fuori dalla CI.

### 2.8 Licenza e attività

**Licenza: Apache-2.0** (`gh repo view` → `licenseInfo.key: apache-2.0`).
- Il `LICENSE` ha l'appendice non compilata: «Copyright [yyyy] [name of copyright owner]».
- **Non c'è un file NOTICE** e nessun file sorgente letto ha header di copyright o SPDX (`grep` su `templates.py` e `resume_preservation.py`).

**Obblighi concreti se copiamo testo di prompt o codice** (Apache-2.0 §4). Il nostro repo `valerielinc-ops/frontaliere-si-o-no` è **PUBLIC e senza licenza** (`gh repo view … --json visibility,licenseInfo`): pubblicarlo è distribuzione, quindi gli obblighi valgono anche per il solo push.

| Obbligo | Cosa significa per noi |
|---|---|
| (a) copia della licenza | Testo Apache-2.0 accanto al codice copiato, per esempio `THIRD_PARTY_LICENSES/resume-matcher-LICENSE`. |
| (b) indicazione delle modifiche | Commento in testa al file tradotto o modificato: origine (repo, path, commit `9c05e423df`) e «modificato». |
| (c) conservare le note | Non ci sono note da conservare oltre alla licenza; conviene citare comunque «Resume-Matcher, Saurabh Rai e contributori». |
| (d) NOTICE | Non serve: RM non ha un file NOTICE. |
| Marchi (§6) | Niente nome «Resume Matcher» nel prodotto, solo nell'attribuzione. |
| Brevetti (§3) | Licenza brevetti inclusa; decade se si fa causa per brevetti sull'opera. |

- **Idee reimplementate da zero** in JS (località dei numeri, tetto onesto, soglia di somiglianza): non generano obblighi. Come per career-ops, conviene un commento di cortesia.
- **Testi di prompt copiati alla lettera**: vanno trattati come codice; conservativamente valgono (a) e (b).
- **Liste brevi** (frasi tipiche dell'AI): bassa originalità, ma vanno comunque attribuite se copiate.
- Questo non è un parere legale: per i casi dubbi decide il proprietario, come nella decisione 7 dello studio.

**Attività del repo:**
- ultimo commit `9c05e423df` del 2026-09-29;
- ultima release `v1.3.0` «1.3 Crescendolls» del 2026-09-06;
- 88 contributori; `srbhr` ha 1217 contributi, il secondo è dependabot con 90;
- 28 569 stelle, 5062 fork, 59 issue aperte, creato nel 2020.

Il progetto è attivo, ma dipende quasi tutto da una persona.

---

## 3. Esperimento: lo strato deterministico di RM sui nostri casi sintetici

**Gli script:**
- `exp/rm_gate_on_synthetic.py` importa i moduli **reali** di RM (`resume_preservation`, `refiner`, `improver`) e sostituisce con stub solo pydantic, LiteLLM e markitdown;
- `exp/our_gate_number_locality.mjs` usa il nostro gate (la copia di `origin/main` in `proto/baseline/src`).

**Dati:** `developer_it` di `synthetic.json`, con varianti «adattate» scritte a mano. Output in `exp/*.out`.

| Variante del CV adattato | Copertura RM (originale 77,8; tetto onesto 77,8) | `finalize_ai_resume` di RM | Nostro gate attuale |
|---|---|---|---|
| Sommario «…uso quotidiano di Kubernetes e AWS» | 100 (**sopra il tetto**) | tenuto, 0 avvisi ✗ | non provato qui (lo studio: passa, `claimSources` assente) |
| Bullet «Deploy su Kubernetes…» | 88,9 (**sopra**) | tenuto, 0 avvisi ✗ | passa (lo studio: `toolTokens` non vede le parole con la sola iniziale maiuscola) |
| Skill «Kubernetes, AWS» aggiunte | 100 (**sopra**) | **tenute per scelta** (`jd_added`) ✗ | scartate (`groundedInCv`) ✓ |
| «team di 5» (5 solo nell'annuncio) | entro il tetto | **riga ripristinata** ✓ | `number:5` bloccato ✓ |
| «40%» spostato dal ruolo 1 al ruolo 2 | entro il tetto | **ripristinata**, 1 avviso ✓ | **passa** (`ok=true`) ✗ |
| «400 clienti» spostato sul ruolo 2 | — | `_novel_numbers=True` ✓ | **passa** (`ok=true`) ✗ |
| Riscrittura buona | entro il tetto | tenuta ✓ | — |
| Prosa lontana dalla fonte, senza numeri | entro il tetto | tenuta con avviso (preview), ripristinata (strict) | — |

`verify_skill_target_plan` accetta `Kubernetes` e `AWS` come `jd_added` e rifiuta `Terraform`, che non è né nell'annuncio né nel CV.

**Conclusioni.** I due gate sono **complementari**:
- RM coglie i numeri spostati tra ruoli, grazie alla località e alla molteplicità; noi no.
- Noi cogliamo gli strumenti in forma di sigla e le skill non presenti; RM no.
- Nessuno dei due coglie da solo «Kubernetes» nella prosa.
- La regola «copertura oltre il tetto onesto», o meglio il suo equivalente per insiemi descritto al §4, segnala tutte e 3 le invenzioni di keyword.

---

## 4. Cosa riusare

Le fasi sono quelle del §6 dello studio. Sono tutte idee da reimplementare in JS nei nostri moduli, salvo dove è indicato «porting».

| # | Elemento di RM (prova) | Nostra fase e file | Effort | Obblighi Apache |
|---|---|---|---|---|
| 1 | **Numeri locali e contati**: `_novel_numbers` confronta la riga con **la stessa voce**, con molteplicità e normalizzazione di unità e scale (`resume_preservation.py:168-211`) | **Fase 0**: in `sanitizeTailoredCv` e `checkTailoredCvFacts`, i numeri di un bullet devono stare in `highlights` dello **stesso ruolo** o nelle risposte; il sommario contro il CV intero. Chiude il caso «40%» e «400 clienti» spostati (§3) | 0,5-1 g | Nessuno se reimplementato; porting della funzione → (a)+(b) |
| 2 | **Tetto onesto**: `injectable` e `non_injectable`, `potential_match_percentage` (`refiner.py:250-299`). Nella nostra forma per insiemi: `termini_inventati = coperti(adattato) − coperti(CV+profilo+risposte)` | **Fase 0** come gate («eco dell'annuncio», già proposto) e **misura** (§6, «Come misurare»): riportare la copertura **sul solo insieme ancorato** più il conteggio dei termini sopra il tetto, che deve essere 0. Sostituisce «50→58, 78→100» come numero mostrato. In `assistedApplicationAts.js` (`keywordCoverage`) e nella pagina di revisione | 0,5-1 g | Nessuno (idea) |
| 3 | **Somiglianza riga per riga** con la fonte (`_similarity`, soglia 0,45, `GROUNDING_REVIEW_REQUIRED`: `resume_preservation.py:13,128-143,722-860`) | **Fase 0** come avviso all'operatore; **fase 4** come etichetta «da rivedere» sulla riga. Soglia da ricalibrare su IT, DE e FR: le stopword di RM sono inglesi (righe 34-51) | 0,5-1 g | Nessuno se reimplementato |
| 4 | **Ogni riscrittura dichiara la sua fonte**: `original` copiato e verificato (gate 4, `improver.py:355-365`), più `reason` | **Fase 0 e 4**: in `TAILORED_CV_SCHEMA` ogni bullet porta `sourceIndex` (l'highlight riscritto) e `requirementIndex` (il requisito fissato in pass 1, con la citazione verbatim già disponibile). Il gate confronta la riga **con la sua fonte**; la UI mostra «originale → nuovo, perché: requisito "…"» | 1-1,5 g | Nessuno (idea) |
| 5 | **Conferma rivalidata lato server**: hash della preview (`database.py:751-754`), `finalize(original, payload) == payload` e `validate_confirmed_resume` (`resumes.py:1607-1612`) | **Fase 4**: `assistedApplicationCandidateEdits.js` e `assistedApplicationReview.js` rieseguono il gate sul CV modificato dal candidato prima della ricompilazione. Va deciso dal proprietario se un'aggiunta del candidato diventa una «fonte dichiarata», registrata come tale | 1 g | Nessuno (idea) |
| 6 | **Presentazione del diff**: originale barrato e nuovo accanto, glifo `+`, `-` o `~`, raggruppamento per sezione, rischio alto evidenziato (`diff-preview-modal.tsx:459-506`) | **Fase 4**, `AssistedApplicationReview.tsx`. In più rispetto a RM: **accetta o rifiuta per riga** e conferma esplicita delle righe con un termine dell'annuncio (terza via fra «blocca» e «segnala», decisione 8 dello studio) | incluso nei 3-5 g della fase 4 | Solo idea di UI; il codice TSX non va copiato (stile e stack diversi) |
| 7 | **Domande al candidato invece di inventare**: `ANALYZE_RESUME_PROMPT` (al massimo 6 domande su metriche, strumenti e scala) e `ENHANCE_DESCRIPTION_PROMPT` («only use information provided by the candidate») in `rm:app/prompts/enrichment.py`; `skill_gaps` come «preparation targets only» (`templates.py:422-427`) | **Fase 1 e 4**: per un requisito `missing` o `partial` di importanza alta, chiedere «L'annuncio chiede Kubernetes: l'hai usato? Dove?». La risposta entra nelle `answers`, che sono già fonte del gate. È l'unico modo **onesto** per alzare la copertura | 1-2 g (le domande del match esistono già, `assistedApplicationAiPrompts.js:208`) | Prompt da riscrivere, non copiare; se copiati → (a)+(b) |
| 8 | **Sezioni custom generiche** (`text`, `itemList`, `stringList` con il nome originale della sezione: `templates.py:164-183`, `schemas/models.py:268-306`) | **Fase 1**: Schnupperlehre, hobby, referenze e test attitudinali senza far esplodere `PROFILE_SCHEMA`; il CV adattato le copia in codice, come i ruoli | 1 g | Nessuno (idea di schema) |
| 9 | **L'LLM assegna solo il punteggio, il codice sceglie e adatta alla pagina**: `BULLET_RELEVANCE_PROMPT`, `select_bullets`, `fit_to_one_page` con ricerca binaria e al massimo 6 render (`bullet_selector.py`, `tailor_selection.py`) | **Fase 2**: una pagina per apprendisti e primo impiego con typst.ts (1-6 ms a compilazione, quindi la ricerca binaria costa poco) | 1-1,5 g | Porting della funzione → (a)+(b); reimplementazione → nessuno |
| 10 | **Eval a due strati**: scorer puri con test «fallisce sull'input sbagliato», golden con `jd_keywords` e `grounded_keywords`, giudice opzionale fuori dalla CI con rubrica «JD is a target, not evidence» (`tests/evals/`, `e2e_monitor/judge.py:8-16`) | **Misura** (§6): golden sintetici DE, FR e IT per tipo (apprendista, infermiera, IT) con `tailored_good` e `tailored_bad`, richiamo dei fatti, termini sopra il tetto = 0, ordine di lettura. Giudice LLM solo su richiesta (non in CI, niente API esterne nei test) | 1-2 g | Nessuno (idea); i golden di RM non servono (inglesi, USA) |
| 11 | **Test di regressione sui prompt** che verificano la presenza delle clausole anti-invenzione (`tests/unit/test_prompt_guardrails.py`) | **Fase 0**: un test su `tailoredCvSystemPrompt` e `documentsSystemPrompt` | 0,25 g | Nessuno |
| 12 | **Filtro di frasi tipiche dell'AI in codice, salvo quelle presenti nell'annuncio** (`remove_ai_phrases`, `refiner.py:302-356`; liste in `prompts/refinement.py:4-134`) | **Fase 0 e 2**, lettera e CV: liste **nostre** in DE, FR e IT («Hiermit bewerbe ich mich», «Mit grossem Interesse», «Con la presente», «Je me permets»), come segnalazione o sostituzione. La lista inglese di RM non serve | 0,5 g | Nessuno se le liste sono nostre |

---

## 5. Cosa non riusare e perché

- **Il piano skill `jd_added`** (`improver.py:867-879`, `templates.py:505`) e la whitelist nel controllo di allineamento (`refiner.py:191-195`): reintroducono per scelta le skill dell'annuncio non possedute, cioè proprio il caso Kubernetes e AWS.
- **La keyword injection «DEFAULT across all sections»** e il «reframe in JD terminology» (`prompts/refinement.py:138-161`, `templates.py:573`, `templates.py:379`): spingono l'eco dell'annuncio nella prosa.
- **Lo score ATS composito e le sue raccomandazioni** (`ats.py`): premia l'invenzione (§3) e invita a «aggiungere» le keyword `non_injectable`.
- **L'unione tra riparazione e prompt in una riscrittura completa** (`improve_resume` in fallback, `IMPROVE_RESUME_PROMPT_*`): noi abbiamo già i fatti copiati in codice. È più robusto del ripristino a valle.
- **L'interfaccia «tutto o niente»** e la validazione per hash del payload intero: con la revisione per riga della fase 4 serve rivalidare **le righe**, non confrontare l'hash.
- **I template React, il rendering con Chromium e Playwright, la route di stampa Next**: stack pesante (Chromium, server Next attivo per stampare), font dell'host, schema senza i campi svizzeri. Lo studio ha già scelto Typst.
- **Il PDF della lettera**: niente destinatario, oggetto, firma o allegati; non conforme alle convenzioni CH.
- **Il parser**: markitdown con estrazione LLM, regex dei mesi solo inglese, nessun OCR; non aggiunge nulla al nostro `readCvText`.
- **La sanificazione anti-injection a regex** (`improver.py:31-40,128-136`): fragile; abbiamo già «data, never instructions» e `aiDirectedQuote`.
- **Il matcher di keyword del frontend** (`keyword-matcher.ts:213`): solo ASCII, sbaglia sugli accenti.

---

## 6. Rischi

1. **Filosofia diversa.** RM considera accettabile aggiungere skill dell'annuncio non possedute, a patto che l'utente le veda nel diff. Copiare la pipeline o il prompt di pianificazione senza leggere queste righe riporterebbe l'invenzione. Ogni porting va confrontato con il nostro gate (niente fonti dall'annuncio).
2. **Euristiche anglocentriche.** Sono solo inglesi stopword, mesi, lista di frasi AI e matcher del frontend. La soglia di somiglianza 0,45 va ricalibrata su IT, DE e FR, dove la flessione e i composti tedeschi abbassano la sovrapposizione dei token. Va misurato il tasso di falsi positivi prima di farne un blocco.
3. **Falsi negativi residui** anche combinando i due gate: un nome proprio di strumento con la sola iniziale maiuscola («Kubernetes», «Salesforce») scritto nella prosa passa entrambi. Lo prende solo il controllo per insiemi sui termini dell'annuncio, che sta già nel gate proposto. Uno strumento **non** presente nell'annuncio e scritto così resta scoperto.
4. **Qualità non dimostrata.** Il loro baseline ha il giudizio LLM a 2/5 su 3 annunci su 4 e non ci sono test in CI. Si possono prendere i pattern, non conclusioni sulla resa.
5. **Licenza.** Il nostro repo è pubblico e senza licenza. Un porting letterale senza la copia di Apache-2.0 e senza la nota «modificato» viola §4(a) e §4(b). Le idee reimplementate non hanno vincoli.
6. **Bus factor.** Un manutentore principale (1217 contributi). Non ha importanza se prendiamo solo idee, perché non nasce nessuna dipendenza a runtime.

---

## 7. Non verificato

- Il rendimento reale del giudice LLM e la qualità dell'output di RM con modelli attuali: non ho chiamato LLM.
- L'estrazione dei `.doc` legacy con markitdown 0.1.4.
- Il comportamento della pipeline completa di RM su testi DE e IT: l'esperimento usa solo lo strato deterministico, con varianti scritte a mano.
- Le date esatte dei PR che hanno introdotto `jd_added`: ho letto il codice e il piano `docs/superpowers/plans/2026-05-06-resume-tailor-verifier-loop.md`, non la cronologia git.
