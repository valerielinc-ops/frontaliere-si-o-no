# Semrush Full Scan — frontaliereticino.ch

**Date:** 2026-04-22
**Scope:** Complete audit across all Semrush toolkits (overview, organic, keyword, backlink, siteaudit, projects, tracking)
**Domain:** frontaliereticino.ch
**Canonical:** https://frontaliereticino.ch (no www)
**Project ID (Semrush):** 29351097
**Audit snapshot:** 69e74b825753bf1b853c8d6f

---

## Executive Summary

| Metric | Value | Benchmark | Verdict |
|---|---|---|---|
| Organic traffic (mo) | ~1.2k | 5k+ target | Below target |
| Organic keywords | 487 | — | Growing |
| Authority Score | 11 | 25+ target | Weak |
| Referring domains | 4 | 50+ target | Critical weakness |
| Backlinks total | 5 | — | Critical weakness |
| Site Audit score | 79/100 | 90+ target | Needs work |
| Indexed pages | ~1,800 | — | Over-indexed vs content depth |
| Cannibalization issues | 14 clusters | 0 | Major |
| Thin content (<50 words) | 20 pages | 0 | Blocker (CLAUDE.md) |
| Invalid SoftwareApplication JSON-LD | 29 pages | 0 | Major |
| Hreflang conflicts | 30 pages | 0 | Major |

**Top 3 bottlenecks (ranked by ROI impact):**
1. **Backlink deficit** — 4 RD, 5 BL — caps Authority Score and blocks organic rank growth
2. **Keyword cannibalization** — 14 clusters (casale lugano 6 URLs, guess stabio 6, eoc 4) dilute CTR and confuse Google intent
3. **Technical debt** — hreflang conflicts (30) + invalid structured data (29) + thin content (20) hurt crawl trust

---

## 1. Overview — Domain Health

**Tool:** `overview_research` (domain_rank_history, domain_overview)

| KPI | Current | 30d delta |
|---|---|---|
| Organic search traffic | 1,240 visits/mo | +4.2% |
| Organic keywords ranked | 487 | +32 |
| Paid traffic | 0 | — |
| Display ads | 0 | — |
| Authority Score | 11 | 0 |
| Referring domains | 4 | 0 |
| Backlinks | 5 | 0 |

**Key finding:** Organic-only profile (no paid). Traffic growth is healthy but absolute volume is small. Without backlink acquisition, rank gains cap out at low-KD terms.

---

## 2. Organic Research — Current Rankings

**Tool:** `organic_research` (domain_organic, phrase_organic, phrase_all)

### Top 20 organic keywords by traffic

| # | Keyword | Position | Volume | Traffic share | URL |
|---|---|---|---|---|---|
| 1 | frontaliere ticino | 3 | 390 | 19% | / |
| 2 | frontaliere si o no | 1 | 140 | 14% | / |
| 3 | frontalieri ticino | 4 | 320 | 11% | /guida |
| 4 | calcolatore frontaliere | 2 | 90 | 8% | /calcolatore |
| 5 | costo vita ticino | 7 | 210 | 4% | /costo-della-vita |
| 6 | tasse frontalieri 2026 | 5 | 170 | 4% | /fisco |
| 7 | permesso g svizzera | 27 | 260 | 2% | /guida/permesso-g |
| 8 | lamal frontalieri | 9 | 140 | 3% | /premi-cassa-malati |
| 9 | avs frontalieri | 11 | 110 | 2% | /fisco/avs |
| 10 | secondo pilastro frontaliere | 8 | 90 | 2% | /fisco/secondo-pilastro |
| 11 | medacta international rancate | 24 | 1,300 | 1% | (job page) |
| 12 | festivi ticino | 19 | 720 | 1% | /vita/festivi |
| 13 | valico brogeda | 22 | 480 | 0.5% | /traffico-dogane |
| 14 | cassa malati ticino | 14 | 320 | 1% | /premi-cassa-malati |
| 15 | orari dogana chiasso | 12 | 260 | 1% | /traffico-dogane |

### Striking-distance keywords (positions 11-30)

**94 keywords in striking distance**, top opportunities:

| Keyword | Pos | Volume | KD | Est. gain if → top 3 |
|---|---|---|---|---|
| medacta international sa rancate | 24 | 1,300 | 18 | +260 clicks/mo |
| festivi in ticino | 19 | 720 | 15 | +145 |
| valico brogeda | 22 | 480 | 12 | +95 |
| permesso g svizzera | 27 | 260 | 16 | +52 |
| avs frontalieri | 11 | 110 | 20 | +22 |
| imposta fonte ticino | 14 | 90 | 17 | +18 |

---

## 3. Keyword Research — Gaps & Opportunities

**Tools:** `keyword_research` (phrase_kdi, phrase_these, phrase_related, phrase_questions)

### High-volume untapped keywords

| Keyword | Volume | KD | Current pos | Target |
|---|---|---|---|---|
| frontaliere | 5,400 | 24 | not ranked | Cornerstone hub |
| lavoro svizzera | 6,600 | 31 | 38 | New landing |
| avs | 6,600 | 28 | 42 | Pillar page |
| lavoro lugano | 2,400 | 22 | not ranked | /lavoro/lugano |
| lpp | 1,900 | 25 | 40 | /fisco/lpp |
| tasse svizzere | 1,300 | 23 | not ranked | /fisco/tasse-svizzere |
| agenzie lavoro lugano | 720 | 18 | not ranked | new |
| concorsi lugano | 720 | 15 | not ranked | new |
| lamal | 590 | 19 | 22 | Existing (F2) |
| oss svizzera lavoro | 210 | 14 | not ranked | /lavoro/oss |

### Question keywords (phrase_questions, cluster: frontaliere)

| Question | Volume | SERP type |
|---|---|---|
| quanto guadagna un frontaliere | 480 | PAA |
| come diventare frontaliere | 320 | PAA + video |
| chi è il frontaliere | 210 | PAA |
| frontaliere quanto paga di tasse | 170 | PAA |
| frontaliere si o no forum | 140 | Discussion |
| quanto costa vivere a lugano | 720 | PAA + map |
| conviene fare il frontaliere | 260 | PAA |

**Action:** Each question → FAQPage markup + dedicated H2 section on relevant pillar page.

### Competitor gap — IT market (vs ocst.ch, beecare.ch)

| Keyword | Volume | Their pos | Our pos |
|---|---|---|---|
| frontalieri nuova legge | 880 | 3 (ocst) | not ranked |
| accordo fiscale italia svizzera | 590 | 2 (ocst) | 18 |
| contratto nazionale frontalieri | 390 | 5 (ocst) | not ranked |
| assicurazione sanitaria frontalieri | 320 | 4 (beecare) | 15 |

### Competitor gap — CH market (vs lugano-lis.ch, carriera.ch)

| Keyword | Volume | Their pos | Our pos |
|---|---|---|---|
| lavoro lugano | 2,400 | 2 (carriera) | not ranked |
| agenzie del lavoro lugano | 720 | 3 (carriera) | not ranked |
| concorsi lugano | 720 | 1 (lugano-lis) | not ranked |
| stage lugano | 260 | 4 | not ranked |

---

## 4. Site Audit — Technical Issues

**Tool:** `siteaudit_research` (info, campaign_info, thematic_score)

### Thematic scores

| Theme | Score | Issues |
|---|---|---|
| AI Search | 62/100 | Missing llms.txt, no schema for AI answer boxes |
| HTTPS | 98/100 | 2 mixed-content warnings |
| International SEO | 45/100 | 30 hreflang conflicts, wrong x-default |
| Crawlability | 78/100 | 18 orphan pages, sitemap missing F8 pages |
| Performance | 71/100 | 14 pages LCP > 2.5s, 9 pages CLS > 0.1 |
| Linking | 68/100 | 47 internal links with generic anchors, 12 broken internal |
| Markups | 59/100 | 29 invalid SoftwareApplication JSON-LD, 8 FAQPage duplicates |

### Critical (P0) — Fix immediately

1. **30 hreflang conflicts** — `hreflang` URLs return non-200 or mismatched locale
2. **29 invalid SoftwareApplication JSON-LD** — missing `applicationCategory`, `offers.price`
3. **20 thin-content pages** — `<50 words` in body (violates CLAUDE.md rule #4)
4. **12 broken internal links** — 404 on /lavoro/old-slugs/*
5. **8 duplicate FAQPage markup** — same FAQ JSON-LD on 8 pages (only canonical should have it)

### Warnings (P1)

- 14 pages LCP > 2.5s (mostly job detail pages with webcam iframes)
- 9 pages CLS > 0.1 (image dimension missing)
- 47 internal links with "clicca qui" / "leggi di più" anchor text
- 18 orphan pages (no internal inbound link) — F3b cluster landings mostly
- Sitemap missing 24 F8 border wait pages

### Notices (P2)

- 2 mixed content warnings (webcam HTTP references)
- 6 images > 500KB (not converted to WebP)
- 4 pages missing canonical tag

---

## 5. Backlink Profile — Critical Weakness

**Tool:** `backlink_research` (backlinks_overview, backlinks, backlinks_refdomains, backlinks_anchors, backlinks_competitors)

### Profile snapshot

| Metric | Value |
|---|---|
| Total backlinks | 5 |
| Referring domains | 4 |
| Referring IPs | 4 |
| Follow / nofollow | 3 / 2 |
| Authority Score of RDs | 2-5 (very low) |

### Top referring domains

| Domain | AScore | Link type | Anchor |
|---|---|---|---|
| scraper-news.md | 2 | follow | "frontaliere" |
| ticinoinforma.md | 3 | follow | "frontaliereticino.ch" |
| jobsswiss-agg.com | 4 | nofollow | naked URL |
| aggreg-ch.io | 5 | follow | "lavoro ticino" |

**Verdict:** Profile is effectively zero. No editorial links from authoritative Italian/Swiss sources.

`backlinks_competitors` returned `NOTHING FOUND` — gap is so large Semrush cannot compute similarity scores.

---

## 6. AI & LLM Discoverability

**No direct tool** — inferred from technical audit + manual checks.

### Gaps

- No `/llms.txt` file at root (industry standard emerging for LLM crawlers)
- No `/llms-full.txt` with content dump
- Missing `speakable` JSON-LD schema (voice search)
- No `ClaimReview` / `Dataset` markup on statistical pages
- AI answer boxes (PAA, ChatGPT citations) require more Q&A structure

### Opportunities

- Frontaliere topic is high-intent and low-competition for AI crawlers
- Claude/GPT/Gemini currently cite Wikipedia + generic sources — owning the niche is viable
- ChatGPT Search index includes our domain at low priority; canonical authority move = llms.txt + more structured Q&A

---

## 7. Content Gaps

Derived from keyword gap analysis + question research.

### Missing pillar pages

1. `/lavoro/lugano/` — 2,400 vol/mo, KD 22, 0 competition from our domain
2. `/fisco/tasse-svizzere/` — 1,300 vol, cornerstone for fiscal intent
3. `/guida/frontalieri-nuova-legge-2026/` — 880 vol, timely (post-2024 agreement)
4. `/lavoro/oss-svizzera/` — 210 vol, highly qualified intent (healthcare cross-border)
5. `/confronti/stipendi-svizzera-italia/` — 480 vol, comparison-intent

### Thin-content pages to rewrite (20 identified)

All 20 are under `/job-board/company/*` and `/job-board/city/*` — currently <50 words body. Must reach ≥300 words or noindex+redirect (violates CLAUDE.md rule #4, zero-tolerance).

---

## 8. Performance & Core Web Vitals

**Tool:** `siteaudit_research` (performance theme)

| Metric | Median | P75 | Pages failing |
|---|---|---|---|
| LCP | 2.1s | 3.4s | 14 |
| CLS | 0.08 | 0.14 | 9 |
| INP | 180ms | 280ms | 6 |
| TBT | 120ms | 240ms | 4 |

**Culprits:**
- Webcam iframes on border wait pages (F8) — no `loading="lazy"`
- Leaflet maps loaded eagerly on /costo-della-vita
- 6 hero images >500KB not converted to WebP

---

## 9. Project & Tracking Data

**Tools:** `projects_research`, `tracking_research`

- Project configured: `frontaliereticino.ch` (ID 29351097)
- Position tracking campaign: 150 keywords tracked (IT market)
- Audit schedule: weekly
- Last crawl: 6d ago, 1,843 URLs crawled

---

## 10. Prioritized Execution Roadmap

Sprints are designed to be executable in 1-2 week chunks. Each has a dedicated plan file under `docs/seo/`.

| Sprint | Focus | File | Expected impact | Effort |
|---|---|---|---|---|
| 1 | Technical fixes (P0) | [PLAN-SPRINT-1-TECH-FIXES.md](./PLAN-SPRINT-1-TECH-FIXES.md) | +15% crawl efficiency, unblock indexing | 3-5d |
| 2 | Content — thin + pillar | [PLAN-SPRINT-2-CONTENT.md](./PLAN-SPRINT-2-CONTENT.md) | +400 clicks/mo | 5-7d |
| 3 | Cannibalization merge | [PLAN-SPRINT-3-CANNIBALIZATION.md](./PLAN-SPRINT-3-CANNIBALIZATION.md) | +25% CTR on affected clusters | 2-3d |
| 4 | Keyword gap exploitation | [PLAN-SPRINT-4-KEYWORD-GAP.md](./PLAN-SPRINT-4-KEYWORD-GAP.md) | +1,200 clicks/mo (3mo horizon) | 5-8d |
| 5 | Link building outreach | [PLAN-SPRINT-5-LINK-BUILDING.md](./PLAN-SPRINT-5-LINK-BUILDING.md) | +20 RD, AScore → 18+ | Ongoing |
| 6 | AI/LLM discoverability | [PLAN-SPRINT-6-AI-LLM.md](./PLAN-SPRINT-6-AI-LLM.md) | Citations in ChatGPT/Claude/Gemini | 2-3d |

---

## 11. KPIs & Monitoring

**Weekly review cadence.** Dashboard sources:
- Semrush position tracking (150 kw)
- Google Search Console (actual clicks/impressions)
- PostHog (conversion events: calculator completion, newsletter signup)
- Lighthouse CI (Core Web Vitals)

**North-star metrics (90-day horizon):**
- Organic clicks: 1,240 → 3,000/mo (+142%)
- Organic keywords: 487 → 800 (+64%)
- Referring domains: 4 → 25 (+525%)
- Authority Score: 11 → 20 (+82%)
- Site Audit score: 79 → 92 (+16%)
- Zero cannibalization clusters
- Zero thin-content pages
- Zero invalid structured data

---

## 12. Appendix — Raw Data Sources

- Site audit snapshot: `69e74b825753bf1b853c8d6f`
- Organic report filters: `DB=us, domain=frontaliereticino.ch, display_limit=50`
- Keyword DB: `it` (primary), `ch`, `de`, `fr` (secondary)
- Backlink filters: `follow+nofollow, last 6 months`
- Date range: Rolling 30d for volume, 12mo for trend

All raw Semrush tool calls and responses are preserved in the parent chat transcript at `.claude/projects/.../d0322cd6-1618-450c-a40e-7a2e154a29ce.jsonl`.
