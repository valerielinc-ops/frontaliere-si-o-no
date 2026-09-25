// Critical above-the-fold Italian translations — loaded synchronously in the main bundle.
// This avoids the 3s skeleton timeout on mobile. All other translations are lazy-loaded.
// Generated from it-core.ts — keep in sync when updating translations.
//
// Trimming policy: this file should ONLY contain keys rendered in the first
// paint of the homepage (`/`) on a 375px mobile viewport AND on the calculator
// landing (`/calcola-stipendio`). Anything that lives in modals, the footer,
// sub-tab navigation under non-calculator tabs, or conditional banners belongs
// in `it-core.ts` (or the per-tab chunk) — the fallback chain in `t()` will
// pick those up once the lazy chunks resolve.
//
// Notably moved out of critical (May 2026):
// - `consent.*` (cookie banner is disabled site-wide; analytics is silently granted).
// - `app.fullscreen` / `app.exitFullscreen` / `app.resetConfirm` (no component references).
// - `cta.*` (rendered at the bottom of the calculator page, after results).
// - `common.*` (used in modals, dialogs and post-interaction UI — not first-paint).
// - `footer.*` (footer is below the fold by definition).
// - `guide.tabs.*`, `comparators.*`, `strumenti.*`, `stats.tab*`, `pension.pillar3`,
//   `taxCredit.navLabel`, `withholdingRates.navLabel`, `newFrontierTaxSim.navLabel`,
//   `salaryQuiz.navLabel` — sub-tab labels for non-calculator tabs; the SiteSearch
//   modal that references them is lazy-loaded, and the sub-tab navigation only
//   renders inside the corresponding lazy tab content.
// - `profile.title`, `profile.signIn`, `nav.dashboard`, `nav.blog`, `nav.support`,
//   `nav.strumenti`, `common.day` — not on first paint of `/`.
const criticalTranslations: Record<string, string> = {
 // App header / theme toggle (visible in navbar above the fold)
 'app.title': 'Frontaliere Ticino',
 'app.subtitle': 'Calcola e confronta il tuo stipendio netto come lavoratore frontaliero',
 'app.lightMode': 'Attiva tema chiaro',
 'app.darkMode': 'Attiva tema scuro',
 // Top-level navigation tabs (desktop navbar) — IMMEDIATELY visible
 'nav.simulator': 'Calcolatore',
 'nav.calculator': 'Calcolatore',
 'nav.comparators': 'Comparatori',
 'nav.confronti': 'Confronti',
 'nav.fisco': 'Fisco & Previdenza',
 'nav.pension': 'Pensione',
 'nav.guide': 'Guida',
 'nav.guida': 'Guida Pratica',
 'nav.vita': 'Vita Quotidiana',
 'nav.stats': 'Statistiche',
 // Mobile bottom-nav (visible above the fold on mobile)
 'nav.simulator.mobile': 'Calcolo',
 'nav.confronti.mobile': 'Confronti',
 'nav.fisco.mobile': 'Fisco',
 'nav.guida.mobile': 'Guida',
 'nav.vita.mobile': 'Vita',
 'nav.stats.mobile': 'Stats',
 // Navbar tagline under the brand
 'nav.subtitle': 'Analisi Fiscale 2026',
 // Calculator sub-tabs (rendered immediately on `/` since calculator is the default tab)
 'simulator.calculator': 'Calcolatore',
 'simulator.whatif': '✨ Cosa cambia se...',
 // Homepage H1 — above-the-fold SEO heading
 'seoContent.calculator.title': 'Calcolatore Stipendio Frontaliere Svizzera 2026',
 'seoContent.calculator.subtitle': 'Strumenti di simulazione fiscale precisi per lavoratori frontalieri: calcola stipendio netto, busta paga, pensione AVS/LPP e deduzioni fiscali.',
};

export default criticalTranslations;
