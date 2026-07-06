# Espansione modelli open-source / free locali — Studio

> Obiettivo: ridurre la dipendenza da provider remoti per **traduzioni** e
> **generazione articoli**, usando modelli open-source/free, idealmente
> eseguibili **localmente** (in CI o sulla macchina dell'agent), a costo $0 e
> senza consumare quota token.
>
> Data studio: 2026-06-22. Spunto utente: GLM-5.2 + alternative locali.

---

## TL;DR — Raccomandazione

| Dominio | Cosa fare | Sforzo | Costo | Note |
|---|---|---|---|---|
| **Traduzioni** | Aggiungere tier **Opus-MT** (Helsinki-NLP) ed eventualmente **NLLB-200-distilled-600M** eseguiti **localmente via `@huggingface/transformers` + `onnxruntime-node`** (già installati) | Basso | $0 | Le coppie del sito (IT↔EN/DE/FR) sono il *sweet spot* di Opus-MT. Sostituisce le istanze LibreTranslate pubbliche morte e riduce dipendenza dal cascade remoto. **Vince qui.** |
| **Generazione articoli** | **Non** locale in CI (HW insufficiente). Due strade: (B1) **self-hosted runner sul Mac** + `node-llama-cpp`/Ollama con Qwen3-class/Gemma; (B2) **free-API remote** (OpenRouter free, z.ai) come oggi, ampliando la chain. | Medio-Alto | $0 | Un 9B locale **non** eguaglia GPT-4o sul fact-grounding italiano. Tenere il gate fact-check (già model-agnostic). |
| **GLM-4.6 / GLM-5.2** | **Solo come API remota** (free/cheap), **mai locale** | — | varia | 355B+ param, richiede 8×H100. Fuori portata per Mac/CI. |

**Insight chiave:** il progetto **già esegue ML locale in produzione** — embedding
`multilingual-e5-small` (384-dim) via `@huggingface/transformers` +
`onnxruntime-node` (`scripts/lib/evidence/embeddingClient.mjs`). Quindi per le
**traduzioni** non serve nuova infrastruttura pesante: la stessa runtime ONNX
può caricare Opus-MT/NLLB. Questa è la leva a più alto ROI e va fatta per prima.

---

## 1. Stato attuale (cosa è già locale vs remoto)

### Traduzioni (contenuti job, non le UI string)
- **Cascade remoto free** — `scripts/lib/free-translate.mjs`: 10 tier, quasi tutti
  HTTP remoti (DeepL free, Azure F0, Google Cloud cap 16k/giorno, MyMemory,
  LibreTranslate pubblico, HF OPUS-MT remoto, proxy Mozhi/Lingva…). Costo $0 ma
  **fragile** (istanze pubbliche morte/lente, 429, SIGPIPE).
- **Argos Translate locale** — `scripts/local-mt-translate.py` (CTranslate2 int8,
  in-process, **$0, illimitato**), orchestrato da `scripts/local-mt-mopup.mjs`.
  Già il tier mop-up free e illimitato.
- **Ollama dormiente** — `scripts/lib/job-localization-pipeline.mjs:281`
  (`translateWithOllama`), inerte: nessun `JOBS_OLLAMA_MODEL` configurato.
- **UI string** (`services/locales/*.ts`): **scritte a mano**, nessuna MT.

### Generazione articoli
- **100% LLM remoti free-tier** — `scripts/create-article.mjs` → `callLLM`
  (`scripts/lib/ai-models.mjs`, "v15 free-only, 115+ modelli, 14 provider":
  GitHub Models, Gemini/Gemma, Groq, OpenRouter, Cerebras, Together, Fireworks,
  NVIDIA NIM, HF, SambaNova, Cohere, Cloudflare Workers AI, Mistral, Z.AI…).
  Fallback scored/self-healing. **Nessuna generazione locale.**
- **Gate fact-check** — `llmFactCheck` (`create-article.mjs:2319`): consenso
  multi-modello (GPT-4.1 / GPT-4o / Gemini-Flash), blocking. **Model-agnostic**:
  funziona con qualsiasi backend, incluso locale.

### Embedding (la prova che il locale funziona)
- **Locale ONNX**: `Xenova/multilingual-e5-small`, 384-dim, via
  `@huggingface/transformers` + `onnxruntime-node`
  (`embeddingClient.mjs:47-58`). Zero API key, zero quota. Ha **sostituito** la
  vecchia chain Mistral→Cohere→Gemini quando le free key sono morte.

### Dipendenze già presenti (`package.json`)
- `@huggingface/transformers ^4.2.0`, `onnxruntime-node ^1.26.0`.
- **Assenti**: `llama.cpp`, `node-llama-cpp`, `ollama`, file `.gguf`.

---

## 2. Vincolo hardware (la realtà che decide tutto)

Esistono **due ambienti di esecuzione**, e quasi ogni decisione dipende da quale:

1. **Runner GitHub-hosted** (dove girano `translate-pending.yml` e
   `generate-article.yml`): **2 core, no GPU, ~7GB RAM, gratis**. Va benissimo per
   modelli MT piccoli ONNX (Opus-MT 300MB, NLLB-600M). **Inadatto** a un LLM
   generativo 7B+ (troppo lento: minuti per articolo → timeout).
2. **Mac dell'utente (Apple Silicon, darwin)** — "l'agent": memoria unificata,
   MLX/Metal. **Può** far girare Qwen3/Gemma 9–31B a 17–35 tok/s. Ma la pipeline
   di generazione **oggi non gira qui** → richiederebbe un **self-hosted runner**.

Regola pratica per il "girare localmente":
- **MT (encoder-decoder piccoli)** → ovunque, anche sul runner 2-core. ✅
- **LLM generativo** → solo su Mac con self-hosted runner, **non** sul runner CI. ⚠️

---

## 3. Perché GLM-4.6 / GLM-5.2 NON è opzione locale

- **GLM-4.6**: ~357B parametri (MoE), licenza permissiva (MIT/Apache citate),
  ma per inferenza servono **8×H100 (FP8)** o **16×H100** a 128K contesto.
- **GLM-4.5**: 16–32×H100.
- **GLM-5.2 / GLM-4.7-Flash** (2026): marketing "più accessibili" ma restano
  classi di parametri impossibili su Mac consumer o runner CI. Le guide
  "self-host GLM-5.2" presuppongono **vLLM su cluster GPU**.

**Conclusione:** GLM è utilizzabile **solo come API remota** (es. z.ai o
OpenRouter). Su OpenRouter GLM-4.6 risulta **a pagamento** (i free sono DeepSeek
V3/R1, Qwen3-Coder-480B, ecc.). Quindi GLM **non** soddisfa "girare nell'agent /
non dipendere da provider remoti". Per il locale puntare su **Qwen3-class /
Gemma / Llama / Mistral-Nemo**.

---

## 4. Track A — Traduzioni locali (PRIORITÀ, ROI massimo)

### Idea
Aggiungere alla cascade un tier **MT locale ONNX** caricato con la runtime
**già installata** (`@huggingface/transformers`), prima dei tier remoti fragili.

### Modelli candidati
| Modello | Dimensione | Copertura | Qualità sulle coppie del sito (IT↔EN/DE/FR) | Velocità |
|---|---|---|---|---|
| **Opus-MT** (Helsinki-NLP) | ~300MB / direzione | per-coppia | **Ottima** sulle coppie comuni europee — il caso d'uso esatto | Molto veloce (batte LLM 14B) |
| **NLLB-200-distilled-600M** | ~2.5GB | 200 lingue | Buona, più versatile ma non sempre > Opus-MT sulle coppie comuni | Più pesante |
| Argos (già presente) | int8 piccolo | per-coppia (pivot EN) | Discreta (mop-up) | Veloce |

**Raccomandazione:** **Opus-MT** come tier locale primario (le 6 direzioni
IT↔EN/DE/FR sono poche, ~300MB ciascuna, cache una-tantum). NLLB come opzionale
per lingue future. Entrambi via `pipeline('translation', ...)` di transformers.js
→ stesso pattern di `embeddingClient.mjs`, zero nuove dipendenze pesanti.

### Vantaggi
- **$0, illimitato, offline, deterministico** — niente 429/SIGPIPE/istanze morte.
- Riduce il cascade remoto a fallback raro.
- Riusa infra ONNX già provata in prod → rischio basso.
- Throughput: non più limitato da rate-limit remoti (resta il cap 2-core, ma
  l'inferenza MT è leggera).

### Caveat / rischi
- **Qualità**: Opus-MT è solido sulle coppie comuni ma va validato vs glossario
  esistente (`scripts/lib/translation-glossary.mjs`) — i brand **non** si
  traducono (regola progetto). Tenere `applyGlossaryCorrections` a valle.
- **Cold-start**: download pesi una-tantum (cache `.cache/transformers`); su CI
  va cacheato come per gli embedding.
- **RAM runner**: Opus-MT 300MB ok su 7GB; caricare una direzione per volta.

### POC suggerito (mezza giornata)
1. Script standalone: carica `Xenova/opus-mt-it-en` (e it→de, it→fr) via
   transformers.js, traduce 50 job di test, confronta col cascade attuale.
2. Misura: qualità (spot-check IT madrelingua) + tempo/job + byte.
3. Se ok → inserire come **primo tier** in `free-translate.mjs` dietro flag env
   (`MT_LOCAL_OPUSMT=1`), fallback al cascade esistente.

---

## 5. Track B — Generazione articoli (più complesso)

Un LLM generativo di qualità **non gira sul runner CI 2-core**. Tre opzioni:

### B1 — Self-hosted runner sul Mac + LLM locale (vero "girare nell'agent")
- **Runtime**: `node-llama-cpp` (binding Node per llama.cpp, **JSON-schema
  enforcement a livello di generazione** — integra pulito nella pipeline `.mjs`
  senza daemon) **oppure** Ollama (API-first, Modelfile versionabile, comodo ma
  serve daemon). Su Apple Silicon **MLX** è il più veloce (+30–40% vs llama.cpp).
- **Modelli** (Italian-capable, locali): **Qwen3-class 9–14B**, **Gemma 4
  9–31B** (Apache-2.0), Llama-3.x-8B, Mistral-Nemo-12B. Su Mac 16GB → ~9B Q4
  (~22–28 tok/s); 32GB → 31B comodo.
- **Pro**: zero dipendenza remota, zero quota, vera sovranità.
- **Contro**: serve configurare un **self-hosted runner** (sicurezza: mai su
  runner pubblici di repo aperti); Mac deve essere acceso; qualità < GPT-4o;
  manutenzione.

### B2 — Restare su free-API remote, ampliando la chain (più semplice, già fatto)
- La chain `ai-models.mjs` è già free-only e self-healing. Ampliarla con:
  **OpenRouter free** (28+ modelli, 20 req/min, 50–1000 req/giorno, no carta:
  DeepSeek V3/R1, Qwen3-Coder-480B, Gemma…) e **z.ai** (GLM) se ottieni una key.
- **Pro**: zero infra, qualità alta (modelli enormi), già architettato.
- **Contro**: **non** soddisfa "non dipendere da remoto"; soggetto a
  quota-collapse (vedi commit 195b2c9e4af).

### B3 — Ibrido (consigliato come traguardo)
- **Bozza** generata da LLM locale (B1) → **fact-check / rifinitura** dal
  consenso remoto free esistente (gate `llmFactCheck`, già model-agnostic).
  Sposta il grosso del lavoro in locale, usa il remoto solo per verifica corta.
- Degrada con grazia: se il Mac è offline, la pipeline ricade interamente sul
  cascade remoto attuale.

### Caveat qualità (vale per tutta la Track B locale)
Un 9–14B locale produce italiano fluente ma è **più incline a invenzioni
fattuali** di GPT-4o → il gate fact-check multi-modello diventa **più**
importante, non meno. **Non** abbassare la soglia per far passare un modello
locale debole (Non-Negotiable #1 del progetto). Misurare il tasso di rejection
fact-check del modello locale prima di adottarlo.

---

## 6. Matrice decisionale

```
                       gira sul runner CI?   gira sul Mac?   soddisfa "no remoto"?   qualità
Opus-MT/NLLB locale          SÌ                  SÌ                 SÌ                MT: alta (coppie comuni)
Argos (oggi)                 SÌ                  SÌ                 SÌ                MT: media
Qwen3/Gemma locale           NO (lento)          SÌ                 SÌ                gen: media (< GPT-4o)
OpenRouter/z.ai free         SÌ                  SÌ                 NO                gen: alta
GLM-4.6/5.2 locale           NO                  NO                 —                 n/a (no HW)
GLM-4.6 via API              SÌ                  SÌ                 NO                gen: alta
```

---

## 7. Piano d'azione consigliato (in ordine)

1. **[Subito, alto ROI] Track A — Opus-MT locale per le traduzioni.** POC →
   tier locale in `free-translate.mjs` dietro flag, fallback cascade. Riusa
   infra ONNX esistente. Rende le traduzioni davvero offline/$0/robuste.
2. **[Medio] Track B2 — ampliare la chain free remota** (OpenRouter free,
   eventuale z.ai/GLM) per resilienza al quota-collapse, senza nuova infra.
3. **[Esplorativo] Track B1/B3 — self-hosted runner sul Mac + node-llama-cpp +
   Qwen3/Gemma** per generazione bozze locali, con fact-check remoto. Decisione
   strategica (HW sempre acceso, sicurezza runner) → richiede OK utente.

**Cosa NON fare:** non tentare GLM-4.6/5.2 in locale; non abbassare il gate
fact-check per accomodare un modello locale debole; non rimuovere il cascade
remoto finché il tier locale non è validato.

---

## 8. Issue #3656 — Eval mirata: solo la sotto-fase di riscrittura/ampliamento

**Data: 2026-07-06.** Segue #3090 (`## 5` sopra), che aveva bocciato un
tentativo di generazione locale (qwen2.5:7b, prompt "espandi con nuovi
contenuti", run 28371401498) per due motivi: budget di 55min sforato + una
riscrittura che aveva inventato un riferimento normativo fiscale inesistente.
#3656 chiede una domanda più stretta: **non generazione da zero**, ma solo
la sotto-fase di *riscrittura/allungamento* di un articolo già generato che
è risultato troppo corto (oggi `expandShortItalianContent` in
`scripts/create-article.mjs`, via remoto) — con modelli locali più piccoli/
veloci e uno scope esplicitamente "zero fatti nuovi", verificato dallo stesso
gate `llmFactCheck` di produzione (non un'approssimazione).

### Metodologia

- Harness: `scripts/eval-local-rewrite-llm.mjs` (nuovo file, incluso in questa
  PR come artefatto di ricerca riusabile).
- Riusa il path reale di produzione: `callLLM(messages, {model:
  AI_MODELS.LOCAL_FALLBACK, chain: [AI_MODELS.LOCAL_FALLBACK]})` da
  `scripts/lib/ai-models.mjs` per la generazione, e la funzione reale
  `llmFactCheck` (ri-esportata da `create-article.mjs` — pure re-export, zero
  cambio di comportamento per il caller interno di produzione) per la verifica
  — stesse regole di blocco (consenso, categorie high-trust, soglia di peso
  major ≥3.0) usate in produzione oggi.
- 5 campioni **reali**, presi da `services/locales/blog-body/it/*.ts` (body1
  pubblicato), scelti per diversità di dominio: fiscale
  (`730-precompilato-frontalieri-ticino-2026`, lo stesso dominio che aveva
  fatto fallire #3090), UE/politico (`accordi-svizzera-ue-parmelin-bruxelles`),
  sanitario/legale (`assicurazione-dentaria-obbligatoria-ticino-2026`),
  infrastrutturale (`autostrada-a9-disagi-frontalieri`), sociale
  (`adulti-genitori-sostegno-finanziario-ticino-2026`). Ogni campione troncato
  al ~58-65% a un confine di paragrafo, per simulare una bozza sotto-lunghezza
  realistica da amplificare.
- Prompt di riscrittura **deliberatamente più stretto** di quello di
  produzione (`expandShortItalianContent` oggi chiede esplicitamente di
  *aggiungere* contenuto — mismatch con lo scope "zero fatti nuovi" richiesto
  dall'issue, ed è probabilmente parte della causa dell'allucinazione fiscale
  in #3090): "riformula con parole diverse, NON introdurre alcun fatto/nome/
  cifra/data/percentuale nuovo, puoi allungare solo con connettivi/
  spiegazioni/transizioni che non aggiungono informazione".
- 3 modelli candidati via Ollama locale: `qwen2.5:0.5b`, `qwen2.5:1.5b`,
  `qwen2.5:3b` — tutti sensibilmente più piccoli/veloci del `qwen2.5:7b` di
  #3090, per testare l'ipotesi "modello più piccolo + scope più stretto
  compensa la propensione a inventare".
- **Gruppo di controllo per campione**: fact-check sull'input troncato **non
  riscritto** (zero modifiche del modello) — separa "il gate è di suo severo
  su questo dominio/campione" da "il modello ha introdotto un'allucinazione
  reale". Necessario per interpretare correttamente i FAIL.
- Euristica supplementare (debole, solo indicativa): conteggio di "nuovi
  token-fatto" (importi CHF, percentuali, anni, riferimenti `art.`, decimali)
  assenti dall'input — si è rivelata poco efficace nel catturare le vere
  allucinazioni osservate (nomi/istituzioni/persone inventate), che non sono
  numeriche; il verdetto autorevole resta `llmFactCheck`.

### Caveat espliciti di fedeltà

- **GPU/Metal (sandbox Mac) vs CPU-only (runner self-hosted di produzione,
  `docs/SELFHOSTED-RUNNER.md`)**: Ollama in questo sandbox carica i modelli su
  GPU Metal (confermato via `/api/ps`) — i tempi misurati sono ottimistici
  rispetto al runner CPU-only reale. Non è stato possibile forzare CPU-only
  attraverso il path reale di produzione: `_callOpenAICompatible` in
  `ai-models.mjs` costruisce un body di richiesta a forma fissa
  (`model/messages/temperature/max_tokens/response_format`), senza
  pass-through per opzioni Ollama-specifiche come `options.num_gpu`. Anche
  stimando un fattore 5-10× più lento su CPU-only, i tempi restano ordini di
  grandezza sotto al budget che aveva fatto fallire #3090 (vedi tabella sotto).
- **Fact-check con una sola famiglia di verificatori**: in questo sandbox non
  è disponibile un `GH_MODELS_PAT` → la cascata di verifica di `llmFactCheck`
  è stata soddisfatta solo da modelli Gemini/Gemma (i primi due verificatori
  configurati sono spesso esausti per quota/timeout nella sessione, con
  fallback automatico più in basso nella chain). Le regole di blocco sono le
  stesse di produzione, ma in produzione il set di verificatori reale è più
  ampio (GPT-4.1/4o + famiglia Gemini) — un consenso a 2 famiglie diverse è
  potenzialmente più severo o più permissivo di quanto misurato qui.

### Risultati misurati (run completo, 15 trial riscrittura+fact-check + 5 controlli)

```
CONTROLLO (input troncato, zero riscrittura): fact-check 4/5 PASS
(l'unico FAIL di controllo — accordi-svizzera-ue — indica che quel campione
è già borderline per il gate indipendentemente da qualunque modello)

qwen2.5:0.5b: media 11.3s/call | fact-check 3/5 PASS (60%) | 0 errori
qwen2.5:1.5b: media 14.7s/call | fact-check 2/5 PASS (40%) | 0 errori
qwen2.5:3b:   media 27.0s/call | fact-check 1/5 PASS (20%) | 0 errori

Totale reale: 6/15 trial PASS (40%) — nessun errore infra, nessun timeout.
```

Confronto diretto con #3090: **il problema del tempo è risolto.** Anche il
modello più lento testato (3b, 27.0s/call medi) è ~100× più veloce del
qwen2.5:7b che aveva sforato un budget di 55 minuti. Il problema del
**fact-check non lo è**: il tasso di successo (40% complessivo) è ben sotto
la soglia "zero fallimenti" richiesta per considerare l'integrazione, e
**peggiora** al crescere del modello (0.5b: 60% → 1.5b: 40% → 3b: 20%) — il
modello più piccolo testato è risultato il più "conservativo"/sicuro dei tre,
non il meno capace: contro-intuitivo rispetto all'assunto "modello più grande
= più sicuro", ma coerente con l'osservazione che un modello locale più
fluente è anche più incline a "riempire" con dettagli plausibili quando gli
viene chiesto di raggiungere una lunghezza target (vedi `## 5` caveat sopra,
già annotato prima di questo eval).

### Allucinazioni osservate (stesso pattern di #3090, su modelli diversi)

- **`assicurazione-dentaria-obbligatoria-ticino-2026`** (controllo: PASS
  pulito) — **tutti e 3** i candidati hanno inventato un/a politico/a
  ticinese inesistente con relativa citazione tra virgolette:
  `qwen2.5:0.5b` → *"Raffaella Zucchetti, granconsigliera della Lega, ha
  affermato: «Questa iniziativa...»"*; `qwen2.5:1.5b` e `qwen2.5:3b` →
  *"Raide Bassi, deputata UDC in Gran Consiglio, ha dichiarato: «Parliamo di
  un costo...»"*. Il fact-check reale (categoria `persone`, high-trust
  critical) ha bloccato tutte e 3 le generazioni. Nessuno di questi nomi
  esiste nella fonte troncata data in input — allucinazione genuina del
  modello, non un artefatto del checker (il controllo passa pulito).
- **`730-precompilato-frontalieri-ticino-2026`** (dominio fiscale, lo stesso
  di #3090) — `qwen2.5:3b` ha ripetuto **esattamente lo stesso tipo di
  errore** del tentativo precedente: *"Tutte le regole sono definite da un
  provvedimento firmato dal direttore dell'Agenzia [...] Vincenzo Carbone"* —
  nome inventato/obsoleto (il direttore reale è Ernesto Maria Ruffini),
  bloccato per consenso su categoria high-trust `persone`. `qwen2.5:0.5b` ha
  passato con soli warning; `qwen2.5:1.5b` è stato bloccato per soglia di peso
  major (8.0 ≥ 3.0) su ripetute segnalazioni di `rilevanza_topica` da un solo
  verificatore — un modo di fallire diverso (non un'invenzione fattuale, ma
  contenuto giudicato non pertinente al titolo/focus frontalieri).
- **`accordi-svizzera-ue-parmelin-bruxelles`** (controllo: già FAIL) — tutti
  e 3 i modelli hanno aggiunto le stesse tre voci fittizie in stile
  "Fatti chiave" (*"Investimenti Lugano: 150 milioni di franchi nel 2025"*,
  *"Scadenza documentazione: 30 aprile di ogni anno"*, *"Data seminario: 15
  novembre 2023"*), assenti dal controllo/input. Pattern distinto dalle altre
  due invenzioni: sembra "list-continuation" — il modello, sotto pressione di
  raggiungere la lunghezza target e trovandosi davanti a un elenco puntuale di
  fatti nel testo originale, lo estende con voci fittizie nello stesso
  formato "Etichetta: valore", indipendentemente dalla taglia del modello.
- **`autostrada-a9-disagi-frontalieri`** — unico campione pulito su tutti e 3
  i modelli (fact-check PASS, solo warning minori di elaborazione data/
  attribuzione, già presenti anche nel controllo). L'euristica di "nuovi
  token-fatto" aveva segnalato 2 falsi positivi qui (`qwen2.5:0.5b`, token
  "102, 96" da un'elaborazione di data non bloccante) — conferma che
  l'euristica supplementare è rumorosa e il verdetto autorevole resta
  `llmFactCheck`.
- **`adulti-genitori-sostegno-finanziario-ticino-2026`** — `0.5b` e `1.5b`
  passano (quest'ultimo con warning su un errore ortografico e un termine
  giudicante introdotti in riscrittura); `3b` bloccato per un critical isolato
  di `rilevanza_topica` (forzatura del nesso col target frontalieri) — di
  nuovo non un'invenzione di fatto, ma un problema di pertinenza.

### Decisione: RIGETTO — non integrare (nessun flag, nessun cambio di
`create-article.mjs` in produzione)

Il tempo **non è più un ostacolo** per nessuno dei 3 candidati testati. Ma il
tasso di successo del fact-check (40% complessivo, in peggioramento al
crescere della taglia del modello) è troppo lontano dalla barra "zero
fallimenti" richiesta per l'integrazione, e le allucinazioni osservate
replicano **la stessa classe di errore** documentata come motivo di rigetto
in #3090 (persone/istituzioni inventate su contenuto fiscale/legale/sanitario)
— nonostante un prompt deliberatamente più stretto ("zero fatti nuovi") e
modelli molto più piccoli. Il gate `llmFactCheck` ha catturato correttamente
100% delle allucinazioni reali osservate (nessun falso negativo rilevato) —
la sicurezza del gate non è in discussione, è il motivo per cui questo rigetto
è possibile senza rischio per la qualità editoriale pubblicata. Un tasso di
rejection del 60% renderebbe inoltre il local-rewrite-tier controproducente
anche solo come primo tentativo in un retry loop: la maggior parte dei
tentativi verrebbe scartata dal gate, consumando comunque il retry budget
prima di ricadere sul remoto.

**Non tentare di nuovo con questi stessi modelli/prompt.** Un nuovo tentativo
avrebbe senso solo con: (a) modelli locali specificamente fine-tuned per
fedeltà-al-testo/riassunto estrattivo (non generazione libera), o (b) un
approccio non generativo per l'allungamento (es. espansione a livello di
frase/sinonimi con librerie NLP deterministiche, senza free-generation) — non
esplorati in questo eval, entrambi fuori scope per #3656 così come definito.

---

## Fonti

- [GLM-4.6 open weights & hardware (IntuitionLabs)](https://intuitionlabs.ai/articles/glm-4-6-open-source-coding-model)
- [GLM-4.6 open weights, runs (implicator.ai)](https://www.implicator.ai/glm-4-6-puts-receipts-on-the-table-open-weights-real-coding-runs-cheaper-tokens/)
- [Self-host GLM-5.2: hardware/vLLM/cost (ofox.ai)](https://ofox.ai/blog/glm-5-2-self-host-vllm-hardware-cost-2026/)
- [Best open-source LLM for Italian 2026 (SiliconFlow)](https://www.siliconflow.com/articles/en/best-open-source-LLM-for-Italian)
- [Best local LLMs on Apple Silicon Mac 2026 (apxml)](https://apxml.com/posts/best-local-llms-apple-silicon-mac)
- [Apple Silicon LLMs / MLX guide 2026 (codersera)](https://codersera.com/blog/apple-silicon-llms-complete-guide-2026/)
- [Gemma 4 on Apple Silicon (SudoAll)](https://sudoall.com/gemma-4-31b-apple-silicon-local-guide/)
- [Open-source translation models mobile/embedded (Picovoice)](https://picovoice.ai/blog/open-source-translation/)
- [NLLB-200 with CTranslate2 (OpenNMT forum)](https://forum.opennmt.net/t/nllb-200-with-ctranslate2/5090)
- [Transformers.js docs (Hugging Face)](https://huggingface.co/docs/transformers.js/index)
- [OpenRouter free tier 2026 (Klymentiev)](https://klymentiev.com/blog/openrouter-free-tier)
- [OpenRouter free models list Jun 2026 (costgoat)](https://costgoat.com/pricing/openrouter-free-models)
- [GLM-4.6 API pricing (OpenRouter)](https://openrouter.ai/z-ai/glm-4.6)
- [node-llama-cpp (GitHub, withcatai)](https://github.com/withcatai/node-llama-cpp)
- [Ollama vs llama.cpp 2026 (Ganglani)](https://www.kunalganglani.com/blog/ollama-vs-llama-cpp)
</content>
</invoke>
