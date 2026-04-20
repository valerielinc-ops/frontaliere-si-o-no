# Revenue Optimization — Remaining Tasks

Completed 2026-04-20. These items follow up on the 8 fixes already shipped in commit `6532f7063`.

---

## 1. Blog Auth Gate: Add Google/LinkedIn Sign-In

**Priority**: High (auth gate RPM 800+ — higher conversion = more gated impressions)

**Current state**: `BlogArticles.tsx` lines ~2101-2143 show a simple email form for the content gate. The job auth gate in `JobBoard.tsx` lines ~5562-5824 has Google Sign-In (GIS SDK), LinkedIn button, AND email form.

**What to do**:
- In `BlogArticles.tsx`, find the content gate block (search for `contentGateApplies`)
- Replace the simple email form with the same 3-method auth UI used in `JobBoard.tsx`:
  1. Google Sign-In button (uses GIS SDK, look for `google.accounts.id` in JobBoard)
  2. LinkedIn Sign-In button (conditional, look for LinkedIn OAuth flow in JobBoard)
  3. Email form (already present)
- Add trust signals below ("Gratis, nessuna registrazione richiesta", checkmarks)
- Add social proof badge showing total user count

**Files**: `components/community/BlogArticles.tsx`
**Test**: Verify in incognito that the gate appears on articles with 5+ segments, all 3 sign-in methods work

---

## 2. Striking Distance: Content Enrichment (3 Pages)

**Priority**: Medium (push 3 pages from position 8-9 to page 1)

### 2a. Dogana Chiasso Brogeda
- **Page**: `/guida-frontaliere/tempi-attesa-dogana/chiasso-centro/`
- **Target query**: "traffico dogana chiasso brogeda" (105 imp, pos 8.6)
- **Action**: Add 200-300 words covering:
  - Orari di punta (mattina 7-9, sera 17-19)
  - Differenza tra valico Chiasso Centro e Brogeda
  - Consigli per evitare la coda (valichi alternativi: Ponte Chiasso, Novazzano)
  - Link alla webcam o stato traffico in tempo reale
- **File**: Find the component rendering this border crossing page (likely data-driven from the border crossings system)

### 2b. Calcolo Tasse Frontalieri Oltre 20 km
- **Page**: `/calcola-stipendio/nuovi-frontalieri-oltre-20-km/`
- **Target query**: "calcolo tasse frontalieri oltre 20 km" (24 imp, pos 8.5)
- **Action**: Add 200-300 words to the `NewFrontierOver20KmHub` component explaining:
  - Come funziona la tassazione concorrente per chi abita oltre 20 km
  - Differenza con i vecchi frontalieri (ante 2023)
  - Esempio pratico con numeri (stipendio 5000 CHF, tasse CH + IT)
- **File**: `components/calculator/NewFrontierOver20KmHub.tsx`

### 2c. Parole in Dialetto Ticinese
- **Page**: `/dialetto-ticinese/`
- **Target query**: "parole in dialetto ticinese" (42 imp, pos 9.6)
- **Action**: Add 200-300 words to the dialect page:
  - Intro paragrafo su origini del dialetto ticinese (lombardico occidentale)
  - Sezione "Le 10 espressioni più usate al lavoro in Ticino"
  - Differenze tra dialetto ticinese e italiano standard
- **File**: Find the component for `/dialetto-ticinese/` (likely `components/vita/DailyDialectPhrase.tsx` or a dedicated page component)

---

## 3. Tests for New Features

**Priority**: Medium (required by CLAUDE.md for all new features)

### 3a. Blog Content Gate Test
```
File: tests/community/BlogArticles.content-gate.test.tsx

Test cases:
- Article with <5 segments: no gate shown, all content visible
- Article with 5+ segments, no auth: gate shown, only first ceil(n/2) segments visible
- Article with 5+ segments, ft_job_email set: no gate, all content visible
- Article with 5+ segments, crawler UA: no gate, all content visible
- Email form submission sets localStorage and triggers reload
- Auth gate ad slots (JOBDETAIL_AUTH_GATE, AUTHGATE_END_MULTIPLEX) render when gated
```

### 3b. Calculator Inline Ad Test
```
File: tests/calculator/inline-ads.test.tsx

Test cases:
- PayslipSimulator renders ARTICLE_INLINE_MOBILE ad slot
- RalComparator renders ARTICLE_INLINE_MOBILE ad slot
- WhatIfSimulator renders ARTICLE_INLINE_MOBILE ad slot
- CurrencyExchange renders ARTICLE_INLINE_MOBILE ad slot on overview tab
- ConfrontiTabContent renders HOMEPAGE_MID_DISPLAY when sub-tab active
```

### 3c. Sticky Sidebar Test
```
File: tests/community/JobBoard.sticky-sidebar.test.tsx

Test cases:
- Authenticated job detail sidebar has sticky positioning class
- Sidebar contains JOBDETAIL_SIDEBAR and JOBDETAIL_SIDEBAR_2 ad slots
```

---

## 4. Revenue Monitoring Dashboard

**Priority**: Low (nice-to-have, data already accessible via APIs)

Set up a scheduled check (GitHub Action or cron) that runs weekly and compares:

| Metric | Source | Baseline (Apr 6-19) |
|--------|--------|---------------------|
| AdSense revenue/day | AdSense API | 0.87 CHF |
| AdSense RPM | AdSense API | 0.91 CHF |
| Desktop RPM | AdSense API | 1.10 CHF |
| Auth gate impressions | AdSense API (JOBDETAIL_AUTH_GATE unit) | 1,235 |
| GSC clicks/day | GSC API | 323 |
| GSC avg position | GSC API | 5.7 |
| CLS p75 (job pages) | PostHog web vitals | 0.58 |
| Blog bounce rate | GA4 | 8% |

**How**: Create a script `scripts/revenue-monitor.mjs` that queries all 4 APIs and outputs a comparison table. Could run as a GitHub Action on a weekly cron.

---

## Execution Order

1. **Blog auth gate Google/LinkedIn** — highest revenue impact
2. **Striking distance content** — SEO takes 2-4 weeks to kick in, start early
3. **Tests** — cover the new code
4. **Monitoring** — set up after 1 week to have baseline data
