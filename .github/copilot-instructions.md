# Copilot Instructions — Frontaliere Si o No?

## Project Overview

**Frontaliere Si o No?** is an Italian-language React SPA that helps Swiss-Italian cross-border workers ("frontalieri") compare the financial impact of living in Switzerland (Permit B) vs commuting from Italy (Permit G). It covers fiscal simulation, pension planning, health insurance, currency exchange, transport costs, and more.

- **Live site**: GitHub Pages (deployed via `main` branch push)
- **Primary language**: Italian (UI and domain), with i18n support for EN/DE/FR
- **Domain context**: Swiss/Italian tax law (2026 New Agreement), LAMal health insurance, AVS/LPP pensions, CHF-EUR exchange

---

## Architecture

### Single-file SPA — No Router Library

There is **no React Router**. All routing is hand-rolled in `services/router.ts`:

- `App.tsx` holds **all navigation state** as local `useState` hooks (no Redux, no Context, no Zustand).
- URL paths use locale-aware slugs: Italian has no prefix (`/comparatori/cambio-valuta`), others get `/{lang}/...` (`/en/comparators/currency-exchange`).
- Navigation: `pushRoute(route)` calls `history.pushState`; `popstate` listener re-parses URL.
- `ActiveTab` union type: `'calculator' | 'feedback' | 'stats' | 'pension' | 'guide' | 'comparatori' | 'privacy' | 'data-deletion' | 'api-status' | 'gamification'`
- Sub-tabs: `ComparatoriSubTab` (9 values), `SimulatorSubTab`, `PensionSubTab`, `GuideSection` (11 values)

**When adding a new tab:**
1. Add value to the `ActiveTab` type union in `services/router.ts`
2. Add slugs to all 4 locale `SlugTable` objects in `services/router.ts`
3. Add the reverse lookup entry in `buildTopLevelReverse()`
4. Add `case` in `buildPath()` switch
5. Add the component rendering branch in `App.tsx`'s content switch

### Component Layout

```
App.tsx              — Root. All state lives here. Renders tab-based content.
components/          — 32 feature components, one per file, default-exported.
services/            — Stateless service modules (no classes, just exported functions/objects).
  calculationService.ts — Swiss-Italian fiscal simulation engine
  router.ts             — URL routing, slug tables, path building/parsing
  i18n.ts               — 4-locale translations (~9000 lines), t() function, hooks
  analytics.ts          — Firebase GA4 wrapper
  firebase.ts           — Firebase init, Remote Config, App Check
  seoService.ts         — Meta tag management
  exchangeRateService.ts — Frankfurter API for CHF-EUR rates
  trafficService.ts     — Border crossing traffic data
  recaptchaService.ts   — reCAPTCHA v3 client
constants.ts         — Default simulation inputs, expense templates, tax parameters
types.ts             — SimulationInputs, SimulationResult, ExpenseItem interfaces
```

### Key Design Decisions

- **No build-time secrets**: All API keys (Google Maps, reCAPTCHA, Gemini, GitHub PAT) load from **Firebase Remote Config** at runtime. `.env` only has non-sensitive Firebase config. Never hardcode secrets.
- **Inline translations**: All i18n strings are in `services/i18n.ts` (not JSON files). Each locale is a flat `Record<string, string>` with dot-notation keys.
- **PWA**: `vite-plugin-pwa` with `registerType: 'prompt'`, `clientsClaim: true`, `skipWaiting: false`. The `PwaUpdateBanner` component handles update prompts.
- **GitHub Pages SPA**: `public/404.html` redirects all paths to `index.html` via sessionStorage. `index.html` restores the path on load.

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | React 19 | Function components only, hooks only |
| Language | TypeScript ~5.8 | `@/*` path alias → project root |
| Bundler | Vite 6 | Dev on port 3000 |
| Styling | Tailwind CSS 4 | Dark mode via class strategy |
| Charts | Recharts 3 | Used in ComparisonChart, ResultsView |
| Maps | Leaflet + react-leaflet | For TicinoCompanies, border crossings |
| PDF | jsPDF + jspdf-autotable | Client-side report generation |
| Icons | lucide-react | Tree-shakeable, import individually |
| Backend | Firebase (Analytics, Remote Config, App Check, Firestore) | No custom backend server |
| PWA | vite-plugin-pwa + Workbox | Service worker for offline |
| Testing | Vitest 4 + Testing Library + jsdom | `vitest.config.ts` separate from `vite.config.ts` |

---

## Developer Workflows

### Commands

```bash
npm run dev          # Vite dev server on port 3000
npm run build        # Production build → dist/
npm run preview      # Preview production build
npm test             # npx vitest run (single run)
npm run test:watch   # npx vitest (watch mode)
```

### Pre-push Hook

`.githooks/pre-push` runs `npm test` then `npx vite build --logLevel error`. Push is blocked if either fails. Activate with:
```bash
git config core.hooksPath .githooks
```

### Deployment

Push to `main` → GitHub Actions workflow (`.github/workflows/deploy.yml`) → `npm ci && npm run build` → deploy to GitHub Pages via `peaceiris/actions-gh-pages@v3`.

### Build Verification

After any code change, always verify:
1. **TypeScript**: `npx tsc --noEmit` — pre-existing errors in ErrorBoundary/ShoppingCalculator/TaxCalendar are known, ignore those.
2. **Build**: `npx vite build` — must exit 0.
3. **Tests**: `npx vitest run` — all tests must pass.

---

## Testing Conventions

### Test Structure

```
tests/
  setup.tsx                    — Global mocks (matchMedia, localStorage, Firebase, Analytics, Leaflet)
  __mocks__/virtual-pwa-register.ts — Mock for vite-plugin-pwa
  *.test.ts / *.test.tsx       — Test files
```

### Configuration (`vitest.config.ts`)

- `globals: true` — `vi`, `describe`, `it`, `expect` available without imports
- `environment: 'jsdom'`
- `@/` alias resolves to project root
- `virtual:pwa-register` aliased to mock

### What's Mocked in Setup

- `window.matchMedia` — always returns `{ matches: false }`
- `localStorage` — in-memory store (cleared between tests via `localStorage.clear()` in `beforeEach`)
- `@/services/firebase` — `{ app: {}, analytics: null, db: {} }`
- `@/services/analytics` — all `Analytics` methods as `vi.fn()`
- `@/services/seoService` — `updateMetaTags`, `trackSectionView` as `vi.fn()`
- `leaflet` / `react-leaflet` — stub implementations

### Testing Rules

**Every new feature or component MUST include tests.** Follow this checklist:

1. **Write tests** for new logic/components in `tests/` directory
2. **Run tests**: `npx vitest run` — all must pass
3. **Check console**: Look for warnings or unexpected errors during test runs
4. **Run the application**: `npm run dev` — verify it works visually
5. **Fix bugs and warnings** before proceeding
6. **Build**: `npx vite build` — must succeed
7. **Commit and push**: Only after all above pass

### Test Patterns by Type

- **Pure logic** (calculation, gamification, health insurance): Import and test exported functions directly. See `calculationService.test.ts`, `gamification.test.ts`, `healthInsurance.test.ts`.
- **Router**: Test `buildPath`/`parsePath` roundtrips for all locales. See `router.test.ts`.
- **i18n**: `i18n-completeness.test.ts` auto-scans source for `t()` calls and verifies all keys exist in all 4 locales. Adding a `t('new.key')` without translations will fail this test.
- **Smoke tests**: `app-smoke.test.tsx` renders App with each tab and checks for crashes.
- **Security**: `no-secrets-in-build.test.ts` scans the `dist/` folder for leaked secrets.

---

## i18n — Adding Translations

All translations live in `services/i18n.ts` inside the `translations` object.

1. Choose a dot-notation key: `'section.subsection.label'`
2. Add the key+value to **all 4 locale blocks** (IT, EN, DE, FR) — they start at approximately:
   - IT: line ~105
   - EN: line ~2250
   - DE: line ~4500
   - FR: line ~6750
3. Use in components: `const { t } = useTranslation(); ... t('section.subsection.label')`
4. `t()` supports interpolation: `t('key', { name: 'value' })` replaces `{name}` in the string
5. Fallback chain: current locale → Italian → raw key string
6. **`i18n-completeness.test.ts` will catch missing keys** — run tests after adding `t()` calls

---

## Gamification System

### How It Works

- 20 achievements across 4 categories: `explorer`, `calculator`, `expert`, `social`
- State persisted to `localStorage('frontaliere_achievements')`
- Listener pattern: components call global `unlockAchievement(id)` from anywhere
- Each unlock awards 50 XP; 10-level progression system

### Adding a New Achievement

1. Add entry to `ACHIEVEMENTS` array in `components/GamificationWidget.tsx`
2. Add `unlockAchievement('new_id')` call at the appropriate trigger point
3. Add i18n keys: `gamification.achievement.new_id` and `gamification.achievementDesc.new_id` in all 4 locales
4. Add test in `tests/gamification.test.ts` verifying the ID exists in ACHIEVEMENTS

### Exported API (`components/GamificationWidget.tsx`)

```ts
unlockAchievement(achievementId: string)  // Call from any component
addXp(amount: number)                      // Direct XP addition
loadState(): GamificationState             // Read current state
getLevel(xp: number): { level, currentXp, nextLevelXp }
ACHIEVEMENTS: Achievement[]               // All achievement definitions
LEVEL_TITLES: string[]                     // Level name by index
```

---

## Health Insurance Comparator

The `components/HealthInsurance.tsx` module exports:
- `INSURERS` — 14 real Swiss LAMal insurer profiles
- `calculatePremium(insurerId, canton, model, franchise, ageGroup, withAccident)` — returns monthly CHF premium or null
- `FRANCHISES`, `FRANCHISES_CHILD`, `MODEL_DISCOUNT`, `FRANCHISE_ADJUSTMENT`, `CANTONS`

Premium calculation: `base × (1 - modelDiscount) × (1 + franchiseAdjustment) × ageMultiplier × (1 + accidentCover)`

Cantons with data: TI, GR, VS, ZH, GE, BE, LU.

---

## Fiscal Calculation Engine

`services/calculationService.ts` → `calculateSimulation(inputs: SimulationInputs): SimulationResult`

- Swiss social deductions: AVS (5.3%), AC (1.1%), LAA (0.7%), IJM (0.8%), LPP (age-bracketed)
- Ticino imposta alla fonte: interpolated from A/B/C/H tax tables based on marital status + children
- Italian IRPEF: 2026 scaglioni with €10,000 franchigia for new frontalieri, addizionale regionale
- Per-child discount on Swiss withholding tax
- CHF→EUR conversion for Italian tax calculations

---

## Critical Patterns

### Import Alias

All imports use `@/` which resolves to the project root:
```ts
import { calculateSimulation } from '@/services/calculationService';
import HealthInsurance from '@/components/HealthInsurance';
```

### Component Convention

- One component per file in `components/`
- Default export for page-level components
- Named exports for shared utilities
- Named exports for sub-components only when used by a single parent
- Tailwind classes directly in JSX — no CSS modules, no styled-components
- Dark mode: always include `dark:` variants for backgrounds, text, borders

### State Management

- **No global state library**. All state lives in `App.tsx` as `useState` hooks
- Child components receive state via props
- Side effects (analytics, SEO, routing) are in `useEffect` hooks in `App.tsx`
- Cross-component communication for gamification uses the global `unlockAchievement()` function pattern

### Error Handling

- `ErrorBoundary` component wraps content in `App.tsx`
- Firebase/API calls use try-catch with console warnings
- External API failures degrade gracefully (e.g., simulated traffic data when Google Maps API unavailable)

### Security Rules

- **Never** commit API keys, tokens, or secrets to source
- All sensitive values load from Firebase Remote Config at runtime
- `tests/no-secrets-in-build.test.ts` verifies the `dist/` folder is clean
- Firebase config in `.env` is considered non-sensitive (project identifiers only)

---

## File Reference Quick Guide

| What you need | Where to find it |
|--------------|-------------------|
| Add a new tab/page | `services/router.ts` (type + slugs) → `App.tsx` (rendering) |
| Add translations | `services/i18n.ts` (all 4 locale blocks) |
| Modify tax calculation | `services/calculationService.ts` + `constants.ts` |
| Add analytics event | `services/analytics.ts` (add method) → component (call it) |
| Add achievement | `components/GamificationWidget.tsx` → trigger point → i18n |
| Change PWA behavior | `vite.config.ts` (VitePWA plugin) + `components/PwaUpdateBanner.tsx` |
| Add test | `tests/*.test.{ts,tsx}` — follow existing patterns |
| Mock a new service | `tests/setup.tsx` |
| Border crossing data | `data/borderCrossings.ts` |
| Default expenses | `constants.ts` → `calculateDynamicExpenses()` |
| SEO/meta tags | `services/seoService.ts` + `index.html` (structured data) |

---

## Completion Checklist — Before Every PR

- [ ] New functionality has corresponding tests in `tests/`
- [ ] All tests pass: `npx vitest run`
- [ ] No console errors or warnings during test run
- [ ] Application runs correctly: `npm run dev` and check manually
- [ ] Any bugs or warnings found are fixed
- [ ] Build succeeds: `npx vite build`
- [ ] If `t()` keys were added, all 4 locales (IT/EN/DE/FR) have the translation
- [ ] No secrets or API keys in source code
- [ ] Commit and push to repo
