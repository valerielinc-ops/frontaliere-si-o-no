import React from 'react';

// ---- Skeleton Primitives ----

const pulse = 'animate-pulse bg-surface-raised rounded-lg';

export const SkeletonLine: React.FC<{ width?: string; height?: string; className?: string }> = ({ 
 width = 'w-full', height = 'h-4', className = '' 
}) => (
 <div className={`${pulse} ${width} ${height} ${className}`} />
);

export const SkeletonCircle: React.FC<{ size?: string; className?: string }> = ({ 
 size = 'w-10 h-10', className = '' 
}) => (
 <div className={`${pulse} rounded-full ${size} ${className}`} />
);

// ---- Skeleton Cards ----

export const SkeletonCard: React.FC<{ lines?: number }> = ({ lines = 3 }) => (
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 space-y-4">
 <div className="flex items-center gap-3">
 <SkeletonCircle size="w-8 h-8" />
 <SkeletonLine width="w-40" height="h-5" />
 </div>
 {Array.from({ length: lines }).map((_, i) => (
 <SkeletonLine key={i} width={i === lines - 1 ? 'w-3/4' : 'w-full'} />
 ))}
 </div>
);

export const SkeletonChart: React.FC = () => (
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 space-y-4">
 <div className="flex items-center gap-3 mb-6">
 <SkeletonCircle size="w-8 h-8" />
 <SkeletonLine width="w-48" height="h-5" />
 </div>
 <div className="flex items-end gap-3 h-48">
 {[60, 80, 45, 90, 70, 55, 85].map((h, i) => (
 <div key={i} className={`${pulse} flex-1 rounded-t-lg`} style={{ height: `${h}%` }} />
 ))}
 </div>
 <div className="flex justify-between mt-2">
 {Array.from({ length: 7 }).map((_, i) => (
 <SkeletonLine key={i} width="w-8" height="h-3" />
 ))}
 </div>
 </div>
);

export const SkeletonTable: React.FC<{ rows?: number; cols?: number }> = ({ rows = 4, cols = 4 }) => (
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 {/* Header */}
 <div className="flex gap-4 p-4 border-b border-edge bg-surface-alt">
 {Array.from({ length: cols }).map((_, i) => (
 <SkeletonLine key={i} width="flex-1" height="h-4" />
 ))}
 </div>
 {/* Rows */}
 {Array.from({ length: rows }).map((_, r) => (
 <div key={r} className="flex gap-4 p-4 border-b border-edge last:border-0">
 {Array.from({ length: cols }).map((_, c) => (
 <SkeletonLine key={c} width="flex-1" height="h-3" />
 ))}
 </div>
 ))}
 </div>
);

// ---- Page-level Skeletons ----

export const SkeletonComparator: React.FC = () => (
 <div className="min-h-[80vh] space-y-6">
 {/* Real heading for early LCP */}
 <div className="bg-gradient-to-br from-stripe-50 to-stripe-100 dark:from-slate-800 dark:to-slate-900 rounded-2xl p-6">
 <h2 className="text-2xl font-bold text-heading">Confronta Servizi per Frontalieri</h2>
 <p className="text-sm text-subtle mt-1">Assicurazioni, banche, cambio valuta e trasporti a confronto</p>
 </div>
 {/* Controls */}
 <div className="flex gap-3">
 <SkeletonLine width="w-32" height="h-10" className="rounded-xl" />
 <SkeletonLine width="w-32" height="h-10" className="rounded-xl" />
 <SkeletonLine width="w-24" height="h-10" className="rounded-xl" />
 </div>
 {/* Content cards */}
 <div className="grid md:grid-cols-2 gap-4">
 <SkeletonCard lines={4} />
 <SkeletonCard lines={4} />
 </div>
 <SkeletonCard lines={3} />
 </div>
);

export const SkeletonGuide: React.FC = () => (
 <div className="min-h-[80vh] space-y-6">
 {/* Real heading for early LCP */}
 <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-slate-800 dark:to-slate-900 rounded-2xl p-6">
 <h2 className="text-2xl font-bold text-heading">Guida Completa per Frontalieri</h2>
 <p className="text-sm text-subtle mt-1">Tutto quello che devi sapere per lavorare in Svizzera dall'Italia</p>
 </div>
 <div className="space-y-4">
 {Array.from({ length: 5 }).map((_, i) => (
 <SkeletonCard key={i} lines={2} />
 ))}
 </div>
 </div>
);

export const SkeletonDashboard: React.FC = () => (
 <div className="min-h-[80vh] space-y-6">
 <div className={`${pulse} h-32 rounded-2xl`} />
 <div className="grid md:grid-cols-3 gap-4">
 <SkeletonCard lines={2} />
 <SkeletonCard lines={2} />
 <SkeletonCard lines={2} />
 </div>
 <SkeletonChart />
 </div>
);

export const SkeletonFisco: React.FC = () => (
 <div className="min-h-[80vh] space-y-6">
 {/* Real heading for early LCP */}
 <h2 className="text-2xl font-bold text-heading">Fisco e Previdenza Frontalieri</h2>
 <p className="text-sm text-subtle">Tasse, pensioni e pianificazione finanziaria per lavoratori transfrontalieri</p>
 {/* Sub-tab pills */}
 <div className="flex gap-2 overflow-x-auto">
 {Array.from({ length: 5 }).map((_, i) => (
 <SkeletonLine key={i} width="w-24" height="h-9" className="rounded-full flex-shrink-0" />
 ))}
 </div>
 {/* Form area */}
 <SkeletonCard lines={5} />
 <SkeletonCard lines={3} />
 <SkeletonTable rows={4} cols={3} />
 </div>
);

export const SkeletonStats: React.FC = () => (
 <div className="min-h-[80vh] space-y-6">
 {/* Real heading for early LCP */}
 <h2 className="text-2xl font-bold text-heading">Statistiche Frontalieri</h2>
 <p className="text-sm text-subtle">Dati aggiornati su flussi, stipendi e tendenze del lavoro transfrontaliero</p>
 <div className={`${pulse} h-24 rounded-2xl`} />
 <div className="grid md:grid-cols-2 gap-4">
 <SkeletonChart />
 <SkeletonCard lines={4} />
 </div>
 <SkeletonTable rows={5} cols={4} />
 </div>
);

/** Read article title seeded by ogPagesPlugin for immediate H1 on article pages. */
const getSeededArticleTitle = (): string | null => {
 try {
 const t = (window as unknown as Record<string, unknown>).__ARTICLE_TITLE__;
 if (typeof t === 'string' && t.length > 0) return t;
 } catch { /* SSR or missing */ }
 return null;
};

/** True when the URL is a specific article page (not the blog listing). */
const isArticlePage = (): boolean => {
 const segs = window.location.pathname.replace(/^\/+|\/+$/g, '').split('/');
 // Italian: articoli-frontaliere/{slug}, EN/DE/FR: {lang}/cross-border-articles/{slug}
 return segs.length >= 2 && segs.some(s =>
 s === 'articoli-frontaliere' || s === 'cross-border-articles' ||
 s === 'grenzgaenger-artikel' || s === 'articles-frontalier'
 );
};

export const SkeletonBlog: React.FC = () => {
 const articleTitle = isArticlePage() ? getSeededArticleTitle() : null;

 if (articleTitle) {
 // Article-specific skeleton: H1 from seeded data + article body placeholder
 return (
 <div className="min-h-[80vh] space-y-6 max-w-3xl mx-auto">
 <h1 className="text-2xl font-bold text-heading">{articleTitle}</h1>
 <div className={`${pulse} h-5 w-48`} />
 <div className={`${pulse} h-64 sm:h-80 rounded-2xl`} />
 <div className="space-y-3">
 <div className={`${pulse} h-4 w-full`} />
 <div className={`${pulse} h-4 w-11/12`} />
 <div className={`${pulse} h-4 w-10/12`} />
 <div className={`${pulse} h-4 w-full`} />
 </div>
 </div>
 );
 }

 // Blog listing skeleton
 return (
 <div className="min-h-[80vh] space-y-6">
 <h2 className="text-2xl font-bold text-heading">Articoli e Notizie per Frontalieri</h2>
 <p className="text-sm text-subtle">Approfondimenti su tassazione, permessi, vita quotidiana e normative 2026</p>
 <div className={`${pulse} h-64 sm:h-80 rounded-2xl`} />
 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
 {Array.from({ length: 6 }).map((_, i) => (
 <div key={i} className={`${pulse} h-[280px] rounded-xl`} />
 ))}
 </div>
 </div>
 );
};

export const SkeletonVita: React.FC = () => (
 <div className="min-h-[80vh] space-y-6">
 {/* Real heading for early LCP */}
 <h2 className="text-2xl font-bold text-heading">Vivere in Ticino</h2>
 <p className="text-sm text-subtle">Costo della vita, alloggi, trasporti e qualità della vita nel Canton Ticino</p>
 <div className={`${pulse} h-28 rounded-2xl`} />
 <div className="grid md:grid-cols-2 gap-4">
 <SkeletonCard lines={3} />
 <SkeletonCard lines={3} />
 </div>
 <SkeletonCard lines={4} />
 </div>
);

// ---- Inline ticker / bar skeletons (CLS-safe fixed height) ----

/** Matches NewsFeed height (~34px) */
export const SkeletonNewsTicker: React.FC = () => (
 <div className={`${pulse} h-[34px] rounded-xl`} />
);

/** Matches WeeklyFact height (~34px) */
export const SkeletonWeeklyFact: React.FC = () => (
 <div className={`${pulse} h-[34px] rounded-xl`} />
);

/** Matches InputCard approximate height — tall form with 8+ fields */
export const SkeletonInputCard: React.FC = () => (
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 space-y-4">
 {/* Real H1 text to serve as LCP: large text element renders before lazy InputCard chunk loads */}
 <h1 className="text-[30px] font-extrabold text-heading leading-tight">
 Calcola Stipendio Netto Frontaliere
 <span className="block text-lg font-bold mt-1">Svizzera–Italia (Ticino)</span>
 </h1>
 <p className="text-[13px] text-muted leading-relaxed">Simulatore reddito netto, costo della vita e guida completa per frontalieri Italia-Svizzera</p>
 <div className="flex items-center gap-3">
 <SkeletonCircle size="w-8 h-8" />
 <SkeletonLine width="w-32" height="h-5" />
 </div>
 {/* Section toggle */}
 <div className="flex gap-2">
 <SkeletonLine width="w-28" height="h-9" className="rounded-xl" />
 <SkeletonLine width="w-28" height="h-9" className="rounded-xl" />
 </div>
 {/* Form fields — 8 field pairs (label + input) matching real InputCard */}
 {Array.from({ length: 8 }).map((_, i) => (
 <div key={i} className="space-y-1.5">
 <SkeletonLine width="w-24" height="h-3" />
 <SkeletonLine height="h-10" className="rounded-xl" />
 </div>
 ))}
 {/* Calculate button */}
 <SkeletonLine height="h-12" className="rounded-xl mt-2" />
 </div>
);

/** Mobile calc layout skeleton — matches MobileCalcLayout compact input card */
export const SkeletonMobileCalc: React.FC = () => (
 <div className="space-y-4 pb-3">
 <div className="bg-surface rounded-2xl shadow-lg border border-edge p-4 space-y-3">
 {/* Salary label + stepper */}
 <SkeletonLine width="w-20" height="h-3" />
 <div className="flex items-stretch gap-2">
 <div className={`w-12 h-14 ${pulse} rounded-xl`} />
 <div className={`flex-1 h-14 ${pulse} rounded-xl`} />
 <div className={`w-12 h-14 ${pulse} rounded-xl`} />
 </div>
 {/* Quick salary pills */}
 <div className="flex gap-1.5">
 {Array.from({ length: 7 }).map((_, i) => (
 <div key={i} className={`${pulse} h-7 w-10 shrink-0 rounded-lg`} />
 ))}
 </div>
 {/* Frontier type selector */}
 <div className={`h-14 ${pulse} rounded-xl mt-2`} />
 </div>
 </div>
);


/** Height-reserving placeholder for lazy footer sections (Newsletter ~200px, Weather ~36px, Donation ~48px) */
export const SkeletonFooterSlot: React.FC<{ height: string }> = ({ height }) => (
 <div className={`${height} rounded-xl`} aria-hidden="true" />
);

/**
 * CLS-safe skeleton for the job detail page.
 * Mirrors the header card + description area structure so that when auth
 * resolves and the full detail layout mounts, there is no large layout shift.
 */
export const SkeletonJobDetail: React.FC = () => (
 <div className="space-y-4">
 {/* Back button */}
 <div className={`${pulse} w-32 h-5 rounded`} />

 {/* Job header card — logo + title + meta badges */}
 <div className="bg-surface rounded-2xl border border-edge p-5 space-y-3">
 <div className="flex items-start gap-4">
 <div className={`${pulse} w-12 h-12 rounded-lg flex-shrink-0`} />
 <div className="flex-1 min-w-0 space-y-2">
 <SkeletonLine height="h-6" width="w-4/5" />
 <div className="flex flex-wrap gap-3">
 <SkeletonLine height="h-4" width="w-28" />
 <SkeletonLine height="h-4" width="w-20" />
 <SkeletonLine height="h-4" width="w-16" />
 </div>
 </div>
 </div>
 {/* Description preview area (~5 lines, matching blurred teaser min-height) */}
 <div className="mt-3 space-y-2">
 <SkeletonLine height="h-4" />
 <SkeletonLine height="h-4" />
 <SkeletonLine height="h-4" width="w-11/12" />
 <SkeletonLine height="h-4" />
 <SkeletonLine height="h-4" width="w-3/4" />
 </div>
 </div>

 {/* Apply / action button row */}
 <SkeletonLine height="h-12" className="rounded-xl" />

 {/* Secondary content block */}
 <SkeletonCard lines={3} />
 </div>
);

export const SkeletonJobBoard: React.FC = () => (
 <div className="space-y-4 min-h-[80vh]">
 {/* Header */}
 <div className="bg-gradient-to-br from-teal-50 to-stripe-50 dark:from-slate-800 dark:to-slate-900 rounded-2xl p-6">
 <h2 className="text-2xl font-bold text-heading">Offerte di Lavoro Ticino</h2>
 <p className="text-sm text-subtle mt-1">Trova lavoro in Svizzera come frontaliere</p>
 </div>
 {/* Search + filters bar */}
 <div className="flex gap-3">
 <SkeletonLine width="flex-1" height="h-10" className="rounded-xl" />
 <SkeletonLine width="w-24" height="h-10" className="rounded-xl" />
 </div>
 {/* Job cards */}
 {Array.from({ length: 6 }).map((_, i) => (
 <div key={i} className={`${pulse} h-[72px] rounded-xl`} />
 ))}
 </div>
);

// ── Route-aware skeleton fallback ───────────────────────────────
// Detects the current URL path and shows the matching page skeleton
// to minimise CLS when React hydrates over the static HTML shell.

/** Strip /en/, /de/, /fr/ locale prefix from pathname */
function stripLocalePrefix(path: string): string {
 return path.replace(/^\/(en|de|fr)(\/|$)/, '/');
}

// Italian slug → skeleton mapping (first segment after /)
const SLUG_SKELETON_MAP: Record<string, React.FC> = {
 'calcola-stipendio': SkeletonInputCard,
 'compara-servizi': SkeletonComparator,
 'tasse-e-pensione': SkeletonFisco,
 'guida-frontaliere': SkeletonGuide,
 'vivere-in-ticino': SkeletonVita,
 'statistiche': SkeletonStats,
 'articoli-frontaliere': SkeletonBlog,
 'cerca-lavoro-ticino': SkeletonJobBoard,
 // EN slugs
 'calculate-salary': SkeletonInputCard,
 'compare-services': SkeletonComparator,
 'taxes-and-pension': SkeletonFisco,
 'frontier-guide': SkeletonGuide,
 'living-in-ticino': SkeletonVita,
 'statistics': SkeletonStats,
 'frontier-articles': SkeletonBlog,
 'find-jobs-ticino': SkeletonJobBoard,
 // DE slugs
 'gehalt-berechnen': SkeletonInputCard,
 'dienste-vergleichen': SkeletonComparator,
 'steuern-und-rente': SkeletonFisco,
 'grenzgaenger-leitfaden': SkeletonGuide,
 'leben-im-tessin': SkeletonVita,
 'statistiken': SkeletonStats,
 'grenzgaenger-artikel': SkeletonBlog,
 'jobs-im-tessin': SkeletonJobBoard,
 // FR slugs
 'calculer-salaire': SkeletonInputCard,
 'comparer-services': SkeletonComparator,
 'impots-et-retraite': SkeletonFisco,
 'guide-frontalier': SkeletonGuide,
 'vivre-au-tessin': SkeletonVita,
 'statistiques': SkeletonStats,
 'articles-frontalier': SkeletonBlog,
 'trouver-emploi-tessin': SkeletonJobBoard,
 // Shared / common
 'glossario-frontaliere': SkeletonGuide,
 'domande-frequenti-frontalieri': SkeletonGuide,
 'community': SkeletonDashboard,
 'profilo': SkeletonDashboard,
};

/** Detect first URL segment (after stripping locale prefix). */
function getFirstSegment(): string {
 let path = '/';
 if (typeof window !== 'undefined') {
 path = stripLocalePrefix(window.location.pathname);
 }
 return path.split('/').filter(Boolean)[0] ?? '';
}

const SkeletonFallback: React.FC = () => {
 const firstSegment = getFirstSegment();
 const Skeleton = SLUG_SKELETON_MAP[firstSegment];
 if (Skeleton) return <Skeleton />;

 // Default: calculator page (homepage) — matches real layout's full-width grid
 return (
 <div className="min-h-[80vh] space-y-6">
 <SkeletonInputCard />
 </div>
 );
};

// ── Slugs for pages that have sub-tab navigation ──────────────
const SUB_TAB_SLUGS = new Set([
 '', // homepage = calculator
 'calcola-stipendio', 'calculate-salary', 'gehalt-berechnen', 'calculer-salaire',
 'compara-servizi', 'compare-services', 'dienste-vergleichen', 'comparer-services',
 'tasse-e-pensione', 'taxes-and-pension', 'steuern-und-rente', 'impots-et-retraite',
 'guida-frontaliere', 'frontier-guide', 'grenzgaenger-leitfaden', 'guide-frontalier',
 'vivere-in-ticino', 'living-in-ticino', 'leben-im-tessin', 'vivre-au-tessin',
 'statistiche', 'statistics', 'statistiken', 'statistiques',
]);

// ── Slugs for calculator pages (show news ticker placeholders) ──
const CALC_SLUGS = new Set([
 '', 'calcola-stipendio', 'calculate-salary', 'gehalt-berechnen', 'calculer-salaire',
]);

/**
 * Full-page skeleton shell with nav + sub-tab chrome.
 * Matches the loading shell dimensions (h-20 nav, sub-tab grid, mobile nav)
 * so that React hydration does NOT cause layout shifts.
 * Used when `translationsReady` is false (before Italian core translations load).
 */
export const SkeletonPageShell: React.FC = () => {
 const firstSegment = getFirstSegment();
 const hasSubTabs = SUB_TAB_SLUGS.has(firstSegment);
 const isCalcPage = CALC_SLUGS.has(firstSegment);

 return (
 <div className="min-h-screen relative flex flex-col font-sans text-strong overflow-hidden">
 {/* Background gradient — matches real layout + loading shell */}
 <div className="absolute inset-0 bg-gradient-to-br from-teal-50 via-slate-50 to-emerald-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 -z-20" style={{ contain: 'strict' }} />

 {/* Skeleton Nav — matches loading shell sticky nav h-20 (80px) */}
 <nav className="sticky top-0 z-50 bg-surface/95 border-b border-edge/50 shadow-sm">
 <div className="max-w-[2400px] w-[95%] mx-auto px-4 sm:px-6">
 <div className="flex justify-between h-20 items-center">
 {/* Logo placeholder */}
 <div className="flex items-center gap-3">
 <div className="w-[38px] h-[38px] bg-surface rounded-xl ring-1 ring-edge" />
 <div className="hidden sm:block space-y-1">
 <div className="w-[140px] h-[18px] bg-surface-raised rounded" />
 <div className="w-[100px] h-[10px] bg-surface-raised rounded" />
 </div>
 </div>
 {/* Nav link placeholders — hidden mobile, flex md+ */}
 <div className="hidden md:flex items-center gap-1 mx-2 lg:mx-4 flex-1 min-w-0 justify-between">
 {Array.from({ length: 6 }).map((_, i) => (
 <div key={i} className="flex-1 min-w-0 flex justify-center">
 <div className="w-10 h-10 bg-surface-raised rounded-lg" />
 </div>
 ))}
 </div>
 {/* Action button placeholders — hidden mobile, flex md+ */}
 <div className="hidden md:flex items-center gap-2 pl-4 border-l border-edge shrink-0">
 <div className="w-[76px] h-9" aria-hidden="true" />
 <div className="w-[34px] h-[34px] bg-surface-raised rounded-xl" />
 <div className="w-[34px] h-[34px] bg-surface-raised rounded-xl" />
 </div>
 </div>
 </div>
 </nav>

 {/* Sub-tab bar — matches real sub-nav: py-2.5 gap-1 grid-cols-4/8 */}
 {hasSubTabs && (
 <div className="border-t border-edge bg-surface">
 <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5">
 <div className="grid grid-cols-4 md:grid-cols-8 gap-1">
 {Array.from({ length: 8 }).map((_, i) => (
 <div key={i} className={`${pulse} h-[52px] rounded-xl`} />
 ))}
 </div>
 </div>
 </div>
 )}

 {/* Main content — route-aware skeleton */}
 <main className="flex-1 max-w-[2400px] w-[95%] mx-auto px-2 sm:px-4 py-6">
 {/* News ticker + weekly fact placeholders — desktop only (mobile defers these) */}
 {isCalcPage && (
 <div className="hidden md:flex flex-col gap-2 mb-4">
 <div className={`${pulse} h-[34px] rounded-xl`} />
 <div className={`${pulse} h-[34px] rounded-xl bg-warning-subtle`} />
 </div>
 )}
 <SkeletonFallback />
 </main>

 {/* Mobile bottom nav — matches loading shell fixed h-14, hidden md+ */}
 <nav className="fixed bottom-0 left-0 right-0 z-50 bg-surface/95 border-t border-edge/50 md:hidden h-14 grid grid-cols-6 items-center" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
 {Array.from({ length: 6 }).map((_, i) => (
 <div key={i} className="flex flex-col items-center gap-0.5">
 <div className="w-5 h-5 bg-surface-raised rounded" />
 <div className="w-8 h-2 bg-surface-raised rounded" />
 </div>
 ))}
 </nav>
 </div>
 );
};

export default SkeletonFallback;
