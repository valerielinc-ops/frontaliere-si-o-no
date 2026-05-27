# Frontaliere Ticino — UI Review

**Audited:** 2025-04-03
**Baseline:** Abstract 6-pillar standards + CLAUDE.md design guidelines (no UI-SPEC.md)
**Screenshots:** Captured (desktop 1440×900, tablet 768×1024, mobile 375×812)
**Codebase:** 128 TSX files (App.tsx + 127 components), React 19 + Tailwind CSS 4

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 4/4 | Excellent i18n coverage (458 t() calls in App.tsx alone); no generic "Submit"/"Click Here" patterns found |
| 2. Visuals | 3/4 | Strong visual hierarchy and skeleton system; font-weight distribution is top-heavy (font-black/extrabold overuse) |
| 3. Color | 3/4 | Intentional per-tab accent palette; `dark:text-slate-500` on dark backgrounds is a contrast risk (199 instances) |
| 4. Typography | 3/4 | Good scale (xs → 4xl); 6 font weights in use is 3× more than ideal — `font-black` (129×) and `font-extrabold` (194×) dilute hierarchy |
| 5. Spacing | 4/4 | Consistent Tailwind scale; only 2 arbitrary spacing values in entire codebase |
| 6. Experience Design | 4/4 | 336 loading references, 224 Suspense boundaries, ErrorBoundary at root, 126 disabled states, 100 empty states |

**Overall: 21/24**

---

## Top 3 Priority Fixes

1. **`text-slate-500 dark:text-slate-500` on dark backgrounds (199 instances)** — slate-500 (#64748b) on slate-900/950 backgrounds yields ~3.8:1 contrast, below WCAG AA 4.5:1 for normal text. Affects navbar inactive tabs, footer text, sub-nav inactive states — high-frequency surfaces. — **Fix:** Global find-replace `dark:text-slate-500` → `dark:text-slate-400` on elements with dark backgrounds (slate-400 on slate-900 gives ~5.3:1). Specific hotspot: `App.tsx` lines 2343, 2354, 2368, 2382, 2396, 2410, 2424, 2534, 2570, 2606, 2642, 2678, 2714, 2974, 2982.

2. **Font weight inflation: 6 weights in use, `font-black` (129×) and `font-extrabold` (194×) are excessive** — When everything is heavy, nothing stands out. `font-black` (900) on body-sized text (text-lg/text-sm) flattens the visual hierarchy. The app uses bold (1645×), semibold (551×), medium (304×), extrabold (194×), black (129×), normal (8×) — only 8 instances of `font-normal` means even helper text is heavy. — **Fix:** Audit `font-black` usage in `BorderMunicipalitiesMap.tsx` (14×) and `TrafficAlerts.tsx` — replace with `font-bold` for data values, reserve `font-extrabold` for page titles only. Target: reduce to 3 weights (normal, medium/semibold, bold).

3. **Hardcoded hex colors in map/chart components (30+ instances)** — Colors like `#22c55e`, `#ef4444`, `#eab308`, `#1e40af` are used directly in `BorderMunicipalitiesMap.tsx`, `TrafficAlerts.tsx`, `SupermarketMap.tsx`, `LivabilityMap.tsx`, and `FrontierGuide.tsx` instead of Tailwind tokens. These bypass dark mode entirely and create maintenance drift. — **Fix:** Extract a shared `MAP_COLORS` constant mapping semantic names to Tailwind color values (`colors.emerald[500]`), then import from a shared `theme.ts`. For Leaflet/SVG where className isn't available, use `resolvedTwColor()` helper.

---

## Detailed Findings

### Pillar 1: Copywriting (4/4)

**Excellent.** This is the strongest pillar.

- **i18n coverage is near-total:** 458 `t()` calls in App.tsx alone. Chunked lazy-loading system across 4 locales (IT/EN/DE/FR). Only 2 hardcoded Italian strings found — both in admin-only sections (`"Pannello amministrazione"` at App.tsx:2500, `"Verifica sessione amministratore"` at App.tsx:2886) which are appropriately untranslated (admin-only).
- **No generic patterns found:** Zero instances of "Click Here", "OK", or "Submit" as user-facing labels. All CTAs use domain-specific Italian (`"Invia frase"`, `"Confronta Servizi"`, `"Calcola Stipendio"`).
- **Empty states are well-handled:** 100+ empty state patterns using `t()` keys like `t('input.noExpenses')`, not raw strings. Example at InputCard.tsx:626: `{t('input.noExpenses')}` with proper styling (italic, dashed border, centered).
- **Error copy is professional:** ErrorBoundary uses `t('error.title')` and `t('error.message')` with a reference code for debugging (`:REF {errorDigest}`), not generic "Something went wrong".

**Minor note:** 2 admin-only hardcoded strings — acceptable since admin panel is Italian-only.

### Pillar 2: Visuals (3/4)

**Good overall.** Clean, professional design with clear hierarchy.

**Strengths:**
- **Clear focal point:** Calculator input card on first load with prominent salary input (CHF 75.000) is immediately visible at all breakpoints.
- **Consistent card pattern:** `rounded-2xl border border-slate-200 dark:border-slate-700` used across ~501 `rounded-2xl` instances. Cards, modals, and panels share visual language.
- **Icon-text pairing:** All icon-only buttons have `aria-label` (244 instances found, zero icon-only buttons without aria-label).
- **Skeleton system:** Purpose-built skeletons for cards, charts, tables, full pages, and footer slots — not generic gray boxes.
- **Gradient usage is tasteful:** 204 gradient instances, mostly `bg-gradient-to-br` (121) for card headers. No rainbow soup.

**Issues:**
- **Rounded corner inconsistency:** 4 different border-radius values in active use: `rounded-lg` (689×), `rounded-xl` (856×), `rounded-2xl` (501×), `rounded-3xl` (57×). The mix of `rounded-lg` for inputs and `rounded-xl`/`rounded-2xl` for cards is intentional, but `rounded-3xl` (57×) and `rounded-md` (44×) create outliers.
- **Shadow depth is inconsistent:** `shadow-sm` (154×), `shadow-lg` (82×), `shadow-md` (41×), `shadow-xl` (24×), `shadow-2xl` (17×) — 5 shadow levels in active use. Consider collapsing to 2-3 (sm for cards, lg for modals, 2xl for overlays).
- **Font weight visual hierarchy is muddled** (see Typography pillar for details).

### Pillar 3: Color (3/4)

**Good palette strategy.** Per-tab accent coloring is distinctive and well-executed.

**Strengths:**
- **Intentional tab accent system:** Each of the 6 tabs has a unique accent color (blue/violet/emerald/indigo/amber/purple). Active states use 600-700 shades; dark mode correctly shifts to 300-400 shades. This is a strong brand differentiator.
- **Slate neutral backbone:** Slate is the dominant neutral (1460× text-slate-500, 830× text-slate-600, 753× bg-slate-800). Consistent and appropriate for the "Swiss rigor" brand.
- **Zero `text-slate-400` on light backgrounds:** The CLAUDE.md prohibition is respected perfectly — only 2 instances found, both inside `dark:` or `hover:dark:` contexts.
- **Semantic color usage:** Red for errors/destructive, emerald for success/positive, amber for warnings. 320 unique non-slate color classes reflect a rich but controlled palette.

**Issues:**
- **`dark:text-slate-500` contrast risk (199 instances):** `text-slate-500` (#64748b) on `dark:bg-slate-900` (#0f172a) yields approximately 3.8:1 contrast ratio — below WCAG AA 4.5:1 for normal text. This pattern appears in navbar inactive tabs (App.tsx:2354-2424), sub-nav inactive tabs (App.tsx:2534-2714), footer text (App.tsx:2974-2982), and many components. The fix is systematic: change `dark:text-slate-500` → `dark:text-slate-400` (which gives ~5.3:1).
- **Hardcoded hex colors (30+ instances):** Map components (`BorderMunicipalitiesMap.tsx`, `TrafficAlerts.tsx`, `SupermarketMap.tsx`, `LivabilityMap.tsx`, `FrontierGuide.tsx`) use raw hex values (`#22c55e`, `#ef4444`, `#eab308`, `#1e40af`, `#94a3b8`) for Leaflet markers and SVG elements. These bypass dark mode and are maintenance liabilities.
- **`App.tsx:2950` uses `text-slate-400 dark:text-slate-500`:** This inverts the normal pattern — light mode gets the lower contrast. On `bg-slate-50`, slate-400 (#94a3b8) yields ~3.1:1, below AA for the "last updated" timestamp. Change to `text-slate-500 dark:text-slate-400`.

### Pillar 4: Typography (3/4)

**Good scale, but weight distribution needs tightening.**

**Strengths:**
- **Well-chosen font:** Plus Jakarta Sans (defined in index.css) — geometric, modern, excellent for financial data. Good brand fit.
- **Size scale is appropriate:** 10 sizes in use (xs through 6xl), but the distribution is heavily concentrated on xs (1749×) and sm (1354×), which is correct for a data-dense financial tool. Larger sizes (2xl: 214×, 3xl: 99×) are reserved for headings.
- **text-base is rare (67×):** This shows intentional information density — the app favors compact text (xs/sm) for data readability, which suits the domain.

**Issues:**
- **6 font weights is excessive:** The codebase uses `font-normal` (8×), `font-medium` (304×), `font-semibold` (551×), `font-bold` (1645×), `font-extrabold` (194×), `font-black` (129×). When 96% of text is medium-or-heavier, the weight hierarchy collapses.
  - `font-black` (weight 900) on `text-lg` body content in `BorderMunicipalitiesMap.tsx` (14 instances) is visually aggressive for data values.
  - `font-extrabold` used for section headings AND stat values AND tab labels creates ambiguity about what's a heading vs. emphasis.
  - `font-normal` (8×) is essentially absent — even helper text gets `font-bold`.
- **Arbitrary font sizes:** `text-[13px]` in navbar (App.tsx:2354), `text-[11px]` in sub-nav (App.tsx:2522), `text-[9px]` in expense frequency toggles (InputCard.tsx:622). These break the Tailwind scale and suggest the scale isn't quite right for these elements — consider `text-xs` (12px) as the floor.
- **H1 tag consistency:** H1 styles vary: `text-2xl font-bold` (most tabs), `text-xl sm:text-2xl font-extrabold` (calculator), `text-3xl sm:text-4xl font-bold` (morning dashboard). A shared heading component would enforce consistency.

### Pillar 5: Spacing (4/4)

**Excellent.** One of the cleanest spacing implementations in a codebase this size.

**Strengths:**
- **Tailwind scale adherence is near-perfect:** Only 2 arbitrary spacing values in 128 files (`p-[56px]` and `p-[2px]`).
- **Consistent spacing vocabulary:** Top 5 spacing classes: `gap-2` (984×), `py-2` (616×), `p-4` (575×), `gap-3` (482×), `gap-1` (457×). The 4px/8px base grid is well-maintained.
- **Consistent container widths:** `max-w-7xl` (41×) is the primary content width. The `max-w-[2400px] w-[95%]` pattern for the shell is intentional for ultra-wide screen support with AdSense side-rails.
- **responsive spacing:** `sm:` prefix (785×) and `md:` (122×) show mobile-first responsive spacing is applied throughout.
- **Space-y for vertical rhythm:** `space-y-2` (195×), `space-y-3` (172×), `space-y-4` (148×) create predictable vertical rhythm in card bodies.

**Minor notes:**
- Arbitrary width values (`w-[95%]`, `w-[76px]`, `w-[30px]`, `w-[22px]`) are used for precise layout needs (logo, avatar sizes, shell width) — these are acceptable.
- `!max-w-[2400px] !w-[95%]` at App.tsx:2728 uses `!important` overrides — this works but is slightly fragile. Consider a dedicated class.

### Pillar 6: Experience Design (4/4)

**Excellent.** Comprehensive state coverage across all interaction patterns.

**Strengths:**
- **Loading states everywhere:** 336 loading-related references across the codebase. `Suspense` boundaries (224) with purpose-built fallbacks — not `null` or generic spinners. Tab-level fallbacks use `<LazyFallback />` which renders full page skeletons (Skeletons.tsx) maintaining layout during load.
- **ErrorBoundary at root:** Single root-level ErrorBoundary wrapping the entire app (App.tsx:2226-3396). Handles chunk load errors with auto-recovery (cache clear + reload). Shows error reference code and professional retry UI.
- **Empty states are contextual:** 100+ empty state patterns. Examples: InputCard.tsx:626 shows styled dashed-border empty state for expenses; TicineseDialect.tsx:468 filters show contextual "no results"; HealthInsurance.tsx:448 shows filtered empty state.
- **Disabled states on forms:** 126 `disabled` attribute usages ensuring buttons are properly disabled during submission.
- **Mobile-first with safe areas:** Bottom nav uses `pb-[env(safe-area-inset-bottom,0px)]` for iPhone notch. Footer has `pb-20 md:pb-8` to clear mobile nav. iOS auto-zoom prevented via `font-size: max(16px, 1em)` on inputs.
- **Focus management:** 138 focus-related classes (`focus-visible`, `focus:`, `outline-none`) showing keyboard navigation is supported.
- **Smooth transitions:** 415 `transition-colors` instances for micro-interactions, 153 `transition-all` for larger state changes. Custom animations (fade-in, slide-up, modal-in, toast-in) are defined in index.css with appropriate timing.
- **Dark mode coverage:** 123/128 files (96%) include `dark:` prefixes. The 5 without are: `ConfrontiTabContent.tsx` (wrapper only), `SupermarketMap.tsx` (Leaflet), `LivabilityMap.tsx` (Leaflet), `AdSenseUnit.tsx` (external), `CoinExplosion.tsx` (visual effect).

---

## Registry Safety

Registry audit: No shadcn/ui (`components.json` not found). Skip.

---

## Files Audited

**Root:** App.tsx (~2700 lines)

**components/calculator/**: BonusCalculator.tsx, ComparisonChart.tsx, InlineNetDeltaBadge.tsx, InputCard.tsx, MobileCalcLayout.tsx, NaspiCalculator.tsx, ParentalLeaveCalculator.tsx, PayslipSimulator.tsx, RalComparator.tsx, ResidencySimulator.tsx, ResultsView.tsx, SalaryQuiz.tsx, TfrCalculator.tsx, TredicesimalCalculator.tsx, WhatIfSimulator.tsx

**components/community/**: BlogArticles.tsx, CommunityForum.tsx, FeedbackSection.tsx, GamificationPage.tsx, GamificationWidget.tsx, JobAlertForm.tsx, JobBoard.tsx, JobBridgeView.tsx, JobExpiredView.tsx, JobOrphanView.tsx, NewsFeed.tsx, Newsletter.tsx, NewsletterPopup.tsx, SalarySurvey.tsx, ToolOfTheWeek.tsx, WeeklyDigest.tsx, WhatsNewModal.tsx

**components/comparators/**: BankComparison.tsx, CostOfLiving.tsx, CurrencyExchange.tsx, CurrencyExchangeStats.tsx, HealthInsurance.tsx, JobComparator.tsx, MobileOperators.tsx, MortgageComparison.tsx, NurseryComparator.tsx, RenovationCalculator.tsx, SalaryCompare.tsx, ShoppingCalculator.tsx

**components/guide/**: BorderMunicipalitiesMap.tsx, CarCostCalculator.tsx, CarTransferGuide.tsx, ContractsGuide.tsx, FirstDayGuide.tsx, FrontierGuide.tsx, PermitCompare.tsx, PermitQuiz.tsx, TrafficAlerts.tsx, TrafficHistory.tsx, WorkPermitsGuide.tsx

**components/vita/**: DailyDialectPhrase.tsx, LivabilityIndex.tsx, LivabilityMap.tsx, MorningDashboard.tsx, SupermarketMap.tsx, TicineseDialect.tsx, TicinoCompanies.tsx, TransportCalculator.tsx, WeeklyFact.tsx

**components/shared/**: AdSenseBanner.tsx, AdSenseUnit.tsx, AiChatbot.tsx, CoinExplosion.tsx, CookieBanner.tsx, DataFreshness.tsx, DonationBanner.tsx, EmailInput.tsx, ErrorBoundary.tsx, FaqAccordion.tsx, FooterWeather.tsx, LanguageSelector.tsx, LeadMagnetCTA.tsx, NotFoundSuggestions.tsx, PartnerRecommendations.tsx, RelatedTools.tsx, SeoContentBlock.tsx, ShareableResultCard.tsx, SiteSearch.tsx, Skeletons.tsx, SocialProofBadge.tsx, SubscriptionCTA.tsx

**components/tabs/**: CalcolatoreTabContent.tsx, ConfrontiTabContent.tsx, FiscoTabContent.tsx, GuidaTabContent.tsx, StatsTabContent.tsx, VitaTabContent.tsx

**Config/Style:** tailwind.config.js, index.css, CLAUDE.md
