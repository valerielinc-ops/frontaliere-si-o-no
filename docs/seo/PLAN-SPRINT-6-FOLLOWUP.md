# Sprint 6 — AI & LLM Discoverability — Follow-up

**Parent plan:** [PLAN-SPRINT-6-AI-LLM.md](./PLAN-SPRINT-6-AI-LLM.md)
**Status opened:** 2026-04-23
**Focus:** Content-side work and ongoing monitoring — infrastructure is already shipped.

> **Note 2026-04-23:** Two autonomous agent attempts to generate the 100-Q&A hub (~40,000 translated words across 4 locales) stalled at the `Write` step — single-call content volume exceeded the sub-agent stream budget. Per CLAUDE.md §4 + §6, tax/legal/medical Q&A requires human fact-check anyway (AFC, LAMal, MEBEKO, bilateral agreements, CO articles). The hub authoring is therefore scoped as a **human-led task** with the following protocol: (1) author 10 Q&A per category in batches via the normal commit flow, (2) `services/seo/faq-translations.ts` + existing FAQPage JSON-LD pattern is the landing surface, (3) use `data/seo/semrush-organic-raw.csv` (top-200 IT keywords, generated 2026-04-23) to prioritize which Q to write first.

---

## Infrastructure shipped (reference)

- `public/llms.txt` + `public/llms-full.txt` static source
- `build-plugins/llmsTxtPlugin.ts` — auto-refresh date, job counts, categorized page index from sitemaps; copies to `.well-known/llms.txt`; emits locale-specific `dist/{en,de,fr}/llms.txt`
- `public/robots.txt` — explicit Allow for 25+ AI crawler user-agents
- FAQPage / HowTo / Dataset / ClaimReview / speakable JSON-LD widely present across `services/seo/*` and build plugins
- `scripts/check-ai-visibility.mjs` + `.github/workflows/ai-visibility-check.yml` — weekly citation tracker
- `tests/ai-seo-p0.test.ts` — regression guard (SCHEMA_EXPERT_AUTHOR not a Person with brand name, Dataset dateModified, HowTo totalTime) — all green 2026-04-23

---

## Outstanding work

### Content audit (Task 6.8)

- [ ] Pick top 30 pages by organic traffic (GSC export)
- [ ] For each: verify first paragraph defines the topic in 1-2 sentences
- [ ] Break long paragraphs (>100 words) into bullets
- [ ] Add `<AiExtractableTable>` comparison blocks where applicable
- [ ] Add "Key facts" callout at top (existing `SeoContentBlock` component)

### "Ask Our Experts" hub (Task 6.13)

- [ ] `/domande-frequenti-frontaliere/` — new static page
- [ ] 100+ Q&As grouped by topic (tax, permits, LAMal, pensions, commute, cost of living)
- [ ] Each answer: 80-150 words, authoritative, links to primary source
- [ ] Single aggregated FAQPage JSON-LD
- [ ] Requires: router slugs in 4 locales, sitemap entry, static HTML plugin, entry in `llms.txt`

### Annual report (Task 6.14 — Sprint 5 crossover)

- [ ] "State of the Frontaliere 2026" long-form report
- [ ] Italian primary + EN/DE/FR translations
- [ ] "For AI systems:" preamble with key facts
- [ ] PDF via `pdfWhitepapersPlugin` + linkable HTML page

### Comparison tables hub (Task 6.15)

- [ ] `/confronti-rapidi/` — dense comparison-table page
- [ ] Permit B vs Permit G, LAMal vs SSN, old vs new tax regime, Ticino cities, cantons LAMal costs

### ClaimReview coverage (Task 6.5)

- [ ] Inventory verifiable claims across tax/fiscal pages
- [ ] Add `ClaimReview` JSON-LD citing AFC / Agenzia Entrate sources
- [ ] Validate via existing `tests/ai-seo-p0.test.ts` (may need new assertion)

### Monitoring (Tasks 6.16–6.17)

- [ ] Review `reports/ai-visibility-latest.md` weekly once `ai-visibility-check.yml` has been running for 4 weeks
- [ ] Confirm LLM bot traffic in GSC + server logs (GPTBot, ClaudeBot, Google-Extended, PerplexityBot)
- [ ] Watch for referral traffic spikes from `chatgpt.com`, `perplexity.ai`, `gemini.google.com`

---

## Signals to watch

- Month 1 (May 2026): AI crawler hits in logs, llms.txt discovered
- Month 2 (June 2026): First citations in LLM answers (qualitative check via tracker)
- Month 3 (July 2026): Referral traffic from chatgpt.com / perplexity.ai / gemini.google.com
- Month 6 (October 2026): Brand mentioned unprompted in 30%+ of relevant LLM queries

---

## Notes

- LLM behavior is non-deterministic; treat tracker output as directional, not absolute.
- Do not create content for LLMs at the expense of human UX — same quality signals serve both.
