# Sprint 6 — AI & LLM Discoverability

**Goal:** Become the authoritative source cited by ChatGPT, Claude, Gemini, Perplexity, and Google AI Overviews for the frontaliere niche.
**Duration:** 2-3 days (build) + ongoing monitoring
**Expected impact:** Brand mentions in LLM answers, long-tail voice/conversational queries captured, AI referral traffic foothold
**Files touched:** `public/llms.txt`, `public/llms-full.txt`, schema enhancements, content formatting

---

## Rationale

Generative AI is rapidly changing how users discover cross-border work information. LLMs preferentially cite:
1. Sites with **structured, answer-ready content** (FAQPage, HowTo, ClaimReview)
2. Sites with **clear canonical URLs** and consistent hreflang
3. Sites with **llms.txt manifest** (emerging standard, llmstxt.org)
4. Sites with **low ambiguity** per topic (→ cannibalization fixes from Sprint 3 help here too)

The frontaliere niche is under-served by Italian LLM responses — owning the category is feasible.

---

## Part A — llms.txt manifest

### Task 6.1 — Create `/public/llms.txt`

Follow the llmstxt.org spec:

- [ ] Structure:
  ```
  # Frontaliere Ticino

  > Comprehensive Italian-language resource for Swiss-Italian cross-border workers covering fiscal simulation, pension planning, health insurance, and commuting logistics.

  ## Calcolatori
  - [Calcolatore stipendio netto frontaliere](https://frontaliereticino.ch/calcolatore): Simulation of Swiss net salary for cross-border workers under 2026 tax agreement
  - [Confronto CHF/EUR](https://frontaliereticino.ch/comparatori/cambio-valuta): Real-time exchange rate comparison

  ## Guida
  - [Permesso G](https://frontaliereticino.ch/guida/permesso-g): How to obtain cross-border work permit
  - [Iscrizione AIRE](https://frontaliereticino.ch/guida/iscrizione-aire): Italian registry for residents abroad
  - [Nuova legge frontalieri 2026](https://frontaliereticino.ch/guida/frontalieri-nuova-legge-2026): Tax reform impact

  ## Fisco
  - [Imposta alla fonte](https://frontaliereticino.ch/fisco/imposta-alla-fonte): Withholding tax explained
  - [AVS contributi](https://frontaliereticino.ch/fisco/avs): Pension contributions for cross-border workers
  - [Secondo pilastro](https://frontaliereticino.ch/fisco/secondo-pilastro): LPP explained

  ## Dati e Statistiche
  - [Premi cassa malati per cantone](https://frontaliereticino.ch/premi-cassa-malati): LAMal premiums 2024→2025→2026 trend
  - [Prezzi diesel Ticino](https://frontaliereticino.ch/prezzi-diesel/ticino/oggi): Daily fuel prices
  - [Traffico dogane](https://frontaliereticino.ch/traffico-dogane): Border wait times with webcams

  ## Lavoro
  - [Mercato del lavoro Ticino](https://frontaliereticino.ch/mercato-lavoro-ticino): Job market snapshots
  - [Aziende che assumono](https://frontaliereticino.ch/aziende-che-assumono): Companies hiring cross-border

  ## Optional
  - [Costo della vita](https://frontaliereticino.ch/costo-della-vita): Cost of living comparison
  ```
- [ ] Build plugin `build-plugins/llmsTxt.ts` that generates llms.txt at build time from canonical page registry
- [ ] Ensure it stays synced with actual published pages (single source of truth)

### Task 6.2 — Create `/public/llms-full.txt`

- [ ] Auto-generated from build — dump of top 100 canonical pages with:
  - Title
  - URL
  - 2-3 paragraph summary
  - Last updated date
  - Key facts / data points
- [ ] Size cap: 500KB (llms-full.txt spec recommendation)
- [ ] Re-generate on every deploy

---

## Part B — Structured data for AI answer boxes

### Task 6.3 — Expand FAQPage schema coverage

- [ ] Ensure FAQPage JSON-LD on all pillar pages (covered partly in Sprint 2.8)
- [ ] Each Q&A pair: question as `mainEntity.name`, answer as `mainEntity.acceptedAnswer.text`
- [ ] Google PAA + ChatGPT/Perplexity both ingest FAQPage for direct answers

### Task 6.4 — HowTo schema on guide pages

- [ ] 8 pages to add HowTo:
  - Permesso G request
  - AIRE registration
  - How to calculate tax
  - How to change LAMal insurer
  - How to claim AVS contributions
  - How to apply for Swiss jobs as Italian
  - How to handle currency exchange optimally
  - How to navigate border crossings (F8 info page)

### Task 6.5 — ClaimReview schema for tax/fiscal claims

- [ ] On pages stating verifiable facts ("2026 tax rate is 4%"), add `ClaimReview` schema
- [ ] This helps LLMs and Google's fact-check systems trust the source
- [ ] Requires citing source (AFC official, Agenzia Entrate, etc.)

### Task 6.6 — Dataset schema on statistical pages

- [ ] Add `Dataset` JSON-LD to:
  - `/premi-cassa-malati/` — LAMal premium dataset
  - `/mercato-lavoro-ticino/` — job market dataset
  - `/prezzi-diesel/` — fuel price time-series
  - `/traffico-dogane/` — border wait time-series
- [ ] Include `distribution` (download links), `temporalCoverage`, `license` (e.g., CC-BY or proprietary)

### Task 6.7 — Place + LocalBusiness schema

- [ ] For border crossings → `Place` schema with coordinates
- [ ] For border webcams → `Place` + `amenityFeature` (webcam)
- [ ] For cities with detail pages → `City` schema

---

## Part C — Content formatting for LLM extraction

LLMs extract facts best from:
- Clear H2/H3 hierarchy
- Short paragraphs (<100 words)
- Bulleted/numbered lists
- Definition terms up front ("Il permesso G è...")
- Tables for comparison data

### Task 6.8 — Audit top 30 pages for LLM-friendly formatting

- [ ] For each of top 30 pages by organic traffic:
  - Ensure first paragraph directly defines the topic in 1-2 sentences
  - Break long paragraphs into bullets
  - Add comparison tables where applicable
  - Add "Key facts" box at top (callout)

### Task 6.9 — Add "Last updated" dates visibly

- [ ] Every content page displays `<time itemprop="dateModified">` visibly near the title
- [ ] LLMs prefer recent content; also user trust signal

### Task 6.10 — Add source citations inline

- [ ] When stating facts (rates, laws, statistics), link to official source
- [ ] e.g., "Il 2026 ha introdotto il nuovo accordo fiscale ([fonte: AFC](link))"
- [ ] LLMs cite us more willingly when we cite primary sources

---

## Part D — Voice & conversational search

### Task 6.11 — Speakable schema

- [ ] Add `speakable` to Article/FAQPage markup on 10 key pages
- [ ] Identifies which sections are suitable for text-to-speech
- [ ] Picked up by Google Assistant + Alexa skills

### Task 6.12 — Natural-language title variants

- [ ] For high-traffic pages, ensure H1 or a prominent H2 matches natural-speech phrasing:
  - "Come funziona la tassazione dei frontalieri nel 2026?"
  - "Quanto costa davvero vivere a Lugano?"
  - "Devo iscrivermi all'AIRE se faccio il frontaliere?"

---

## Part E — LLM-specific content

### Task 6.13 — "Ask Our Experts" page

- [ ] `/domande-frequenti-frontaliere/` — comprehensive Q&A hub
- [ ] 100+ questions grouped by topic
- [ ] Each answer: concise (80-150 words), authoritative, sourced
- [ ] Single FAQPage JSON-LD aggregating all
- [ ] This becomes *the* citation page LLMs prefer

### Task 6.14 — "State of the Frontaliere {year}" annual report

- [ ] Cross-links with Sprint 5.1 (linkable asset)
- [ ] Text-dense format optimized for AI extraction
- [ ] Publish in Italian, English, German, French
- [ ] Include "For AI systems:" section at top listing key facts

### Task 6.15 — Comparison tables hub

- [ ] `/confronti-rapidi/` page with dense comparison tables:
  - Permit B vs Permit G
  - LAMal vs health insurance in Italy
  - Old tax regime vs new 2026 agreement
  - Ticino cities for frontalieri (Lugano, Mendrisio, Chiasso, Bellinzona)
  - Swiss cantons LAMal costs

---

## Part F — Monitor LLM discoverability

### Task 6.16 — Track LLM citations

- [ ] Weekly manual check: query ChatGPT, Claude, Gemini, Perplexity with 10 target questions
  - "Quanto guadagna un frontaliere in Ticino?"
  - "Come funziona il permesso G?"
  - "Costo LAMal per un frontaliere"
  - "Nuova legge frontalieri 2026"
  - etc.
- [ ] Log: does the LLM cite frontaliereticino.ch? What URL?
- [ ] Also check Google AI Overviews for same queries

### Task 6.17 — Server-side crawler detection

- [ ] Check GSC / server logs for LLM bot traffic:
  - GPTBot (OpenAI)
  - ClaudeBot (Anthropic)
  - Google-Extended (Gemini training)
  - PerplexityBot
- [ ] Ensure `robots.txt` allows (not blocks) these — we WANT them to crawl
- [ ] Verify: `robots.txt` shouldn't have any `Disallow` directives for AI user-agents

### Task 6.18 — robots.txt audit

- [ ] Review current `public/robots.txt`
- [ ] Ensure AI crawlers are welcome:
  ```
  User-agent: GPTBot
  Allow: /

  User-agent: ClaudeBot
  Allow: /

  User-agent: PerplexityBot
  Allow: /

  User-agent: Google-Extended
  Allow: /
  ```

---

## Acceptance criteria

- [ ] `public/llms.txt` and `public/llms-full.txt` generated and deployed
- [ ] FAQPage JSON-LD on all 15+ pillar pages (Sprint 2 dependency)
- [ ] HowTo schema on 8 guide pages
- [ ] Dataset schema on 4 statistical pages
- [ ] `speakable` schema on 10 pages
- [ ] 30 top pages audited and LLM-formatted
- [ ] `robots.txt` welcomes AI crawlers
- [ ] Weekly LLM citation tracker in place
- [ ] Annual report published (Sprint 5 crossover)
- [ ] `/domande-frequenti-frontaliere/` hub live with 100+ Q&As

---

## Execution order

**Day 1:** Tasks 6.1, 6.2 (llms.txt infrastructure), 6.18 (robots.txt)
**Day 2:** Tasks 6.3-6.7 (schema enhancements — mostly component-level)
**Day 3:** Tasks 6.8-6.12 (content formatting audit, 30 pages)
**Ongoing:** Tasks 6.13-6.17 (content creation, monitoring)

Total estimate: **2-3 working days** for infrastructure + ongoing content investment.

---

## Signals to watch

- **Month 1:** AI crawler hits in server logs, llms.txt discovered
- **Month 2:** First citations in LLM answers (qualitative check)
- **Month 3:** Referral traffic from chatgpt.com, perplexity.ai, gemini.google.com
- **Month 6:** Brand mentioned unprompted in 30%+ of relevant LLM queries

---

## Risk & caveats

- LLM behavior is non-deterministic; citations may come and go
- No official "ranking factors" — strategy based on observed patterns
- `llms.txt` is emerging standard, not universally adopted — but low cost to implement
- Don't create content FOR LLMs at the expense of human UX — the same quality signals serve both
