/**
 * useNavigationState — Manages all tab navigation state extracted from App.tsx
 *
 * Handles:
 * - All tab/sub-tab state: activeTab, calcolatoreSubTab, etc.
 * - Deep-link state: blogArticle, seoLanding, glossaryTerm, borderCrossing, jobSlug, taxReturnCountry
 * - Route initialization from URL
 * - Browser back/forward (popstate) handling
 * - Custom navigate-tab event handling (from child components)
 * - Legacy hash URL migration
 * - In-page hash navigation
 * - Sub-tab SEO effects (confronti, fisco, guida, vita, calcolatore, glossario, stats, blog)
 * - handleTabChange, handleSearchNavigate
 * - Gamification tab tracking
 * - API status URL parameter check
 */
import { useState, useEffect, useRef, useCallback, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import {
 parsePath, parseHashToPath, pushRoute, getSeoSection,
 updatePathForLocale, scrollToAnchor, AppRoute,
 preloadBlogData, resolveBlogSlug, getLocalizedJobSlug,
} from '@/services/router';
import type {
 ActiveTab, CalcolatoreSubTab, ConfrontiSubTab, FiscoSubTab,
 GuidaSubTab, VitaSubTab, StatsSubTab, BlogArticleId, SeoLandingId,
 GlossaryTermId, BorderCrossingId,
} from '@/services/router';
import { setLocale, onLocaleChange } from '@/services/i18n';
import { prefetchTab } from '@/services/prefetch';
import { enableRuntimeSeo, updateMetaTags, trackSectionView } from '@/hooks/seoHelpers';

// Apply noindex SEO for 404 pages — NOT gated by runtimeSeoEnabled because
// soft-404 noindex must be set immediately on initial load before any user interaction.
const applyNotFoundSeo = (path: string) => {
 import('@/services/seoService').then(m => m.applyNotFoundSeo(path)).catch(() => {});
};

import { Analytics, unlockAchievement } from '@/services/analyticsProxy';

export interface NavigationState {
 // State
 activeTab: ActiveTab;
 calcolatoreSubTab: CalcolatoreSubTab;
 confrontiSubTab: ConfrontiSubTab;
 fiscoSubTab: FiscoSubTab;
 guidaSubTab: GuidaSubTab;
 vitaSubTab: VitaSubTab;
 statsSubTab: StatsSubTab;
 blogArticle: BlogArticleId | null;
 seoLanding: SeoLandingId | null;
 glossaryTerm: GlossaryTermId | null;
 borderCrossing: BorderCrossingId | null;
 jobSlug: string | null;
 /** Author profile slug when activeTab === 'autore' (Google News A1). */
 author: string | null;
 taxReturnCountry: 'italia' | 'svizzera' | undefined;
 showApiStatus: boolean;
 notFoundPath: string | undefined;
 jobBoardFilterParams: { location?: string; query?: string } | null;
 /**
  * True when the current URL is a build-time static SEO page that renders
  * its own content OUTSIDE `#root` (see AppRoute.staticOverlay). App.tsx
  * uses this to render only header+nav (no main, no footer) so the static
  * SEO content stays visible without React's SPA tab content overwriting it.
  */
 staticOverlay: boolean;

 // Setters
 setActiveTab: Dispatch<SetStateAction<ActiveTab>>;
 setCalcolatoreSubTab: Dispatch<SetStateAction<CalcolatoreSubTab>>;
 setConfrontiSubTab: Dispatch<SetStateAction<ConfrontiSubTab>>;
 setFiscoSubTab: Dispatch<SetStateAction<FiscoSubTab>>;
 setGuidaSubTab: Dispatch<SetStateAction<GuidaSubTab>>;
 setVitaSubTab: Dispatch<SetStateAction<VitaSubTab>>;
 setStatsSubTab: Dispatch<SetStateAction<StatsSubTab>>;
 setBlogArticle: Dispatch<SetStateAction<BlogArticleId | null>>;
 setSeoLanding: Dispatch<SetStateAction<SeoLandingId | null>>;
 setGlossaryTerm: Dispatch<SetStateAction<GlossaryTermId | null>>;
 setBorderCrossing: Dispatch<SetStateAction<BorderCrossingId | null>>;
 setJobSlug: Dispatch<SetStateAction<string | null>>;
 setAuthor: Dispatch<SetStateAction<string | null>>;
 setTaxReturnCountry: Dispatch<SetStateAction<'italia' | 'svizzera' | undefined>>;
 setShowApiStatus: Dispatch<SetStateAction<boolean>>;
 setNotFoundPath: Dispatch<SetStateAction<string | undefined>>;
 setJobBoardFilterParams: Dispatch<SetStateAction<{ location?: string; query?: string } | null>>;

 // Refs
 suppressNextRouteSyncForTabRef: MutableRefObject<ActiveTab | null>;

 // Handlers
 handleTabChange: (tab: ActiveTab) => void;
 handleSearchNavigate: (tab: string, subTab?: string, filterParams?: { location?: string; query?: string }) => void;
}

export function useNavigationState(): NavigationState {
 // Read initial route from URL path. If parsePath flagged the URL as a
 // non-canonical variant of a known canton editorial-landing page
 // (e.g. `/cerca-lavoro-basilea/offerte-di-lavoro-ticino-oggi/` → the
 // canton's own `/cerca-lavoro-basilea/oggi/`), replace the URL before
 // any rendering so the browser lands on the real static HTML and Google
 // eventually drops the orphan.
 if (typeof window !== 'undefined') {
 const initialParsed = parsePath(window.location.pathname);
 if (initialParsed.redirectTo && initialParsed.redirectTo !== window.location.pathname) {
 window.location.replace(initialParsed.redirectTo + window.location.search + window.location.hash);
 }
 }
 const [initialRoute] = useState(() => {
 const parsed = parsePath(window.location.pathname);
 return { route: parsed.route, locale: parsed.locale };
 });

 const [activeTab, setActiveTab] = useState<ActiveTab>(initialRoute.route.activeTab);
 const [calcolatoreSubTab, setCalcolatoreSubTab] = useState<CalcolatoreSubTab>(initialRoute.route.calcolatoreSubTab || 'calculator');
 const [confrontiSubTab, setConfrontiSubTab] = useState<ConfrontiSubTab>(initialRoute.route.confrontiSubTab || 'exchange');
 const [fiscoSubTab, setFiscoSubTab] = useState<FiscoSubTab>(initialRoute.route.fiscoSubTab || 'tax-return');
 const [guidaSubTab, setGuidaSubTab] = useState<GuidaSubTab>(initialRoute.route.guidaSubTab || 'first-day');
 const [vitaSubTab, setVitaSubTab] = useState<VitaSubTab>(initialRoute.route.vitaSubTab || 'living-ch');
 const [statsSubTab, setStatsSubTab] = useState<StatsSubTab>(initialRoute.route.statsSubTab || 'overview');
 const [blogArticle, setBlogArticle] = useState<BlogArticleId | null>(initialRoute.route.blogArticle || null);
 const [seoLanding, setSeoLanding] = useState<SeoLandingId | null>(initialRoute.route.seoLanding || null);
 const [glossaryTerm, setGlossaryTerm] = useState<GlossaryTermId | null>(initialRoute.route.glossaryTerm || null);
 const [borderCrossing, setBorderCrossing] = useState<BorderCrossingId | null>(initialRoute.route.borderCrossing || null);
 const [jobSlug, setJobSlug] = useState<string | null>(initialRoute.route.jobSlug || null);
 const [author, setAuthor] = useState<string | null>(initialRoute.route.author || null);
 const [taxReturnCountry, setTaxReturnCountry] = useState<'italia' | 'svizzera' | undefined>(initialRoute.route.taxReturnCountry);
 const [showApiStatus, setShowApiStatus] = useState(false);
 const [notFoundPath, setNotFoundPath] = useState<string | undefined>(() => parsePath(window.location.pathname).notFoundPath);
 const [jobBoardFilterParams, setJobBoardFilterParams] = useState<{ location?: string; query?: string } | null>(null);
 // Lite-shell mode: starts true if the URL parses to a staticOverlay route
 // OR the DOM contains the static SEO marker `<main class="seo-static-content">`.
 // Goes back to false when the user navigates to any non-static route — at
 // which point we also remove the static SEO markup from the DOM so it doesn't
 // linger below the React shell.
 const [staticOverlay, setStaticOverlay] = useState<boolean>(() => {
 if (initialRoute.route.staticOverlay) return true;
 if (typeof document === 'undefined') return false;
 return !!document.querySelector('main.seo-static-content');
 });

 // Refs
 const isInitialMount = useRef(true);
 const suppressNextRouteSyncForTabRef = useRef<ActiveTab | null>(null);

 // Eagerly prefetch the active tab's component chunk on initial load
 useEffect(() => { prefetchTab(activeTab); }, []);

 // Check for hidden API status page via URL parameter
 useEffect(() => {
 const urlParams = new URLSearchParams(window.location.search);
 if (urlParams.get('debug') === 'api' || urlParams.get('status') === 'api') {
 setShowApiStatus(true);
 setActiveTab('api-status');
 }
 }, []);

 // Preload blog slug data and resolve any deferred blog slug from initial URL
 useEffect(() => {
 preloadBlogData().then(() => {
 const slug = initialRoute.route.blogSlug;
 if (slug && !initialRoute.route.blogArticle) {
 const resolved = resolveBlogSlug(slug, initialRoute.locale);
 if (resolved) setBlogArticle(resolved);
 }
 }).catch(() => {});
 }, []); // eslint-disable-line react-hooks/exhaustive-deps

 // Apply noindex SEO immediately on mount for 404 pages (soft-404 protection)
 useEffect(() => {
 if (notFoundPath) {
 applyNotFoundSeo(notFoundPath);
 }
 }, []); // eslint-disable-line react-hooks/exhaustive-deps

 // Auto-scroll active sub-tab chip into view on mobile (YouTube/Spotify peek pattern)
 const activeSubTab = activeTab === 'calcolatore' ? calcolatoreSubTab
 : activeTab === 'confronti' ? confrontiSubTab
 : activeTab === 'fisco' ? fiscoSubTab
 : activeTab === 'guida' ? guidaSubTab
 : activeTab === 'vita' ? vitaSubTab
 : activeTab === 'stats' ? statsSubTab
 : null;

 useEffect(() => {
 if (!activeSubTab) return;
 const timer = setTimeout(() => {
 const activeBtn = document.querySelector<HTMLElement>('[data-subtab-active="true"]');
 if (activeBtn?.scrollIntoView) {
 activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
 }
 }, 50);
 return () => clearTimeout(timer);
 }, [activeSubTab]);

 // Shared route application — used by popstate AND global click interceptor
 const applyRoute = useCallback((pathname: string) => {
 enableRuntimeSeo();
 const { route, locale: urlLocale, notFoundPath: parsedNotFoundPath, redirectTo } = parsePath(pathname);
 // Non-canonical canton editorial-landing URLs (e.g. a TI-form slug
 // nested under a non-TI canton section) parse to a redirectTo target.
 // Replace the URL so the browser fetches the canonical static HTML.
 if (redirectTo && redirectTo !== pathname) {
   window.location.replace(redirectTo + window.location.search + window.location.hash);
   return;
 }
 // Static SEO routes own their full HTML (rendered outside `#root`). When
 // navigating BACK into one (popstate) from elsewhere in the SPA, the
 // static content is no longer in the DOM and we cannot reconstruct it
 // client-side without re-fetching the per-page HTML. The cleanest
 // resolution is a full reload so the browser fetches the canonical
 // static page. This keeps URL/content always consistent and is rare in
 // practice (back-button after navigating away from an SEO landing).
 if (route.staticOverlay && typeof document !== 'undefined' && !document.querySelector('main.seo-static-content')) {
   window.location.reload();
   return;
 }
 setNotFoundPath(parsedNotFoundPath);
 // Toggle lite-shell mode based on the new route. When leaving a static
 // SEO page, we also remove the static `<main class="seo-static-content">`
 // from the DOM so it doesn't appear below the React shell.
 const nextOverlay = !!route.staticOverlay;
 setStaticOverlay(nextOverlay);
 if (!nextOverlay && typeof document !== 'undefined') {
   const staticMain = document.querySelector('main.seo-static-content');
   if (staticMain && staticMain.parentElement) {
     staticMain.parentElement.removeChild(staticMain);
   }
 }
 setActiveTab(route.activeTab);
 if (route.calcolatoreSubTab) setCalcolatoreSubTab(route.calcolatoreSubTab);
 if (route.confrontiSubTab) setConfrontiSubTab(route.confrontiSubTab);
 if (route.fiscoSubTab) setFiscoSubTab(route.fiscoSubTab);
 if (route.taxReturnCountry) setTaxReturnCountry(route.taxReturnCountry);
 if (route.guidaSubTab) setGuidaSubTab(route.guidaSubTab);
 if (route.vitaSubTab) setVitaSubTab(route.vitaSubTab);
 if (route.statsSubTab) setStatsSubTab(route.statsSubTab);
 setBlogArticle(route.blogArticle || null);
 // If blog data wasn't loaded yet, resolve the deferred slug
 if (route.blogSlug && !route.blogArticle) {
 preloadBlogData().then(() => {
 const resolved = resolveBlogSlug(route.blogSlug!, urlLocale);
 if (resolved) setBlogArticle(resolved);
 }).catch(() => {});
 }
 setSeoLanding(route.seoLanding || null);
 setGlossaryTerm(route.glossaryTerm || null);
 setBorderCrossing(route.borderCrossing || null);
 setJobSlug(route.jobSlug || null);
 setAuthor(route.author || null);
 setLocale(urlLocale);
 // Update SEO meta tags — use 404-specific noindex for unrecognized routes
 if (parsedNotFoundPath) {
 applyNotFoundSeo(parsedNotFoundPath);
 } else {
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 }
 // Skip auto-scroll when returning to job-board list — JobBoard restores scroll itself
 const isJobBoardReturn = route.activeTab === 'job-board' && !route.jobSlug;
 if (!isJobBoardReturn && !scrollToAnchor()) {
 window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }, []);

 // Listen for browser back/forward navigation
 useEffect(() => {
 const onPopState = () => applyRoute(window.location.pathname);
 window.addEventListener('popstate', onPopState);
 // When locale changes, rewrite current URL with new locale slugs.
 // Also sync jobSlug state: if the map is already loaded, update to the
 // target-locale slug immediately so canonical URLs and state stay consistent.
 const unsubLocale = onLocaleChange((newLocale) => {
 updatePathForLocale(newLocale);
 setJobSlug(prev => {
 if (!prev) return prev;
 return getLocalizedJobSlug(prev, newLocale) || prev;
 });
 });
 return () => {
 window.removeEventListener('popstate', onPopState);
 unsubLocale();
 };
 }, [applyRoute]);

 // Global click interceptor — catch <a href="/..."> internal links and navigate via SPA
 // This prevents the 404 flash on GitHub Pages where a full page navigation would trigger
 // 404.html → sessionStorage redirect → index.html → React re-init before showing the page.
 useEffect(() => {
 const onClick = (e: MouseEvent) => {
 // Skip if modifier keys are held (user wants new tab/window)
 if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;

 // Walk up from target to find the nearest <a> element
 let anchor = e.target as HTMLElement | null;
 while (anchor && anchor.tagName !== 'A') anchor = anchor.parentElement;
 if (!anchor) return;

 const a = anchor as HTMLAnchorElement;

 // Skip external links, new-tab links, download links, hash-only links, and non-http links
 if (a.target === '_blank' || a.hasAttribute('download')) return;
 if (a.origin !== window.location.origin) return;

 const href = a.getAttribute('href');
 if (!href || !href.startsWith('/')) return;

 // Skip static file links (sitemap.xml, robots.txt, etc.)
 if (/\.(xml|txt|json|pdf|png|jpg|jpeg|gif|svg|ico|webp|woff2?|css|js)(\?|$)/i.test(href)) return;

 const [beforeHash, hash] = href.split('#');
 // Strip query string so parsePath() never sees `?q=...` as a path segment
 // (would be misread as a job slug, e.g. /cerca-lavoro-ticino/?q=Infermieri).
 const pathname = beforeHash.split('?')[0];
 const search = a.search || '';

 // Resolve the target route from the URL.
 const { route } = parsePath(pathname);

 // BUG-1 fix (docs/seo/ROADMAP.md): programmatic SEO landings
 // (fuel-daily F6, LAMal F2, weekly-employers F5, job-market-snapshot F4,
 // border-wait F8, orphan-query F3b, SemRush, nursing landings) are
 // static HTML emitted OUTSIDE `#root` (see AppRoute.staticOverlay).
 // They are not part of the SPA component tree — there is no React
 // view that can render the per-station / per-canton / per-city body
 // client-side. The only way to display them is a full-page navigation
 // that loads the static HTML for that exact URL. Intercepting them in
 // the SPA click handler would either no-op (pushRoute early-returns
 // on staticOverlay) or, worse, swap the URL and leave the user
 // stranded on the home view (the bug observed live 2026-04-23).
 //
 // Detection: if the target is a staticOverlay route AND we're not
 // currently on that same static page, let the browser handle the
 // navigation natively (fall through without preventDefault).
 const targetIsStaticOverlay = !!route.staticOverlay;
 const onSamePath = window.location.pathname.replace(/\/$/, '') === pathname.replace(/\/$/, '');
 if (targetIsStaticOverlay && !onSamePath) {
 return;
 }

 // This is an internal SPA route — intercept it
 e.preventDefault();

 // Push the new URL and apply the route via SPA navigation
 pushRoute(route);

 // If the href included a query string, preserve it
 if (search) {
 const currentUrl = window.location.pathname + search + (hash ? `#${hash}` : '');
 history.replaceState(history.state, '', currentUrl);
 }

 applyRoute(pathname);

 // Handle hash anchors
 if (hash) {
 requestAnimationFrame(() => {
 const el = document.getElementById(hash);
 if (el) el.scrollIntoView({ behavior: 'smooth' });
 });
 }
 };
 document.addEventListener('click', onClick);
 return () => document.removeEventListener('click', onClick);
 }, [applyRoute]);

 // Handle in-page hash navigation
 useEffect(() => {
 const onHashChange = () => { scrollToAnchor(); };
 window.addEventListener('hashchange', onHashChange);
 if (window.location.hash && !window.location.hash.startsWith('#/')) {
 requestAnimationFrame(() => scrollToAnchor());
 }
 return () => window.removeEventListener('hashchange', onHashChange);
 }, []);

 // Listen for navigate-tab events from child components
 useEffect(() => {
 const onNavigateTab = (e: Event) => {
 const detail = (e as CustomEvent).detail;
 if (detail?.tab) {
 let tab = detail.tab as string;
 let subTab = detail.subTab as string | undefined;
 let guideSec = detail.guideSection as string | undefined;

 // Legacy mappings
 if (tab === 'comparatori') { tab = 'confronti'; }
 if (tab === 'pension') { tab = 'fisco'; subTab = subTab || 'pension'; }
 if (tab === 'guide') { tab = 'guida'; subTab = guideSec; }
 if (tab === 'strumenti') {
 if (subTab === 'permit-compare') { tab = 'guida'; subTab = 'permit-compare'; }
 else if (subTab === 'car-cost') { tab = 'guida'; subTab = 'car-cost'; }
 else { tab = 'guida'; subTab = 'car-cost'; }
 }

 setActiveTab(tab as ActiveTab);
 const route: AppRoute = { activeTab: tab as ActiveTab };
 if (tab === 'confronti' && subTab) { route.confrontiSubTab = subTab as ConfrontiSubTab; setConfrontiSubTab(subTab as ConfrontiSubTab); }
 if (tab === 'fisco' && subTab) { route.fiscoSubTab = subTab as FiscoSubTab; setFiscoSubTab(subTab as FiscoSubTab); }
 if (tab === 'guida' && subTab) { route.guidaSubTab = subTab as GuidaSubTab; setGuidaSubTab(subTab as GuidaSubTab); }
 if (tab === 'vita' && subTab) { route.vitaSubTab = subTab as VitaSubTab; setVitaSubTab(subTab as VitaSubTab); }
 if (tab === 'calculator' && subTab) { route.calcolatoreSubTab = subTab as CalcolatoreSubTab; setCalcolatoreSubTab(subTab as CalcolatoreSubTab); }
 if (tab === 'stats' && subTab) { route.statsSubTab = subTab as StatsSubTab; setStatsSubTab(subTab as StatsSubTab); }
 pushRoute(route);
 updateMetaTags(getSeoSection(route));
 trackSectionView(getSeoSection(route));
 window.scrollTo({ top: 0, behavior: 'instant' });
 }
 };
 window.addEventListener('navigate-tab', onNavigateTab);
 return () => window.removeEventListener('navigate-tab', onNavigateTab);
 }, []);

 // Migrate legacy hash-based URLs
 useEffect(() => {
 const search = window.location.search; // preserve query params (e.g. newsletter autologin ne/ac)
 const hash = window.location.hash;
 if (hash && hash.startsWith('#/')) {
 const newPath = parseHashToPath(hash);
 if (newPath) {
 history.replaceState(null, '', newPath + search);
 }
 }
 const p = window.location.pathname.replace(/\/$/, '').toLowerCase();
 const calcHomeSlugs: Record<string, string> = {
 '/calcola-stipendio': '/',
 '/en/calculate-salary': '/en/',
 '/de/gehalt-berechnen': '/de/',
 '/fr/calculer-salaire': '/fr/',
 };
 if (calcHomeSlugs[p]) {
 history.replaceState(null, '', calcHomeSlugs[p] + search);
 }
 const legacyRedirects: Record<string, string> = {
 '/calculator': '/',
 '/stats': '/statistiche',
 '/guide': '/guida-frontaliere',
 };
 if (legacyRedirects[p]) {
 history.replaceState(null, '', legacyRedirects[p] + search);
 }
 }, []);

 // handleTabChange — uses functional setter to capture previousTab without stale closure
 const handleTabChange = useCallback((tab: ActiveTab) => {
 enableRuntimeSeo();
 setActiveTab(prevTab => {
 Analytics.trackTabNavigation(prevTab, tab);
 if (tab === 'confronti') Analytics.trackFunnelStep('compare', { from_tab: prevTab });
 if (tab === 'guida') unlockAchievement('guide_reader');
 if (tab === 'feedback') unlockAchievement('feedback_giver');
 if (tab === 'stats') unlockAchievement('stats_checker');
 if (tab === 'fisco') unlockAchievement('pension_planner');
 return tab;
 });
 if (tab !== 'calculator') setSeoLanding(null);
 if (tab !== 'glossario') setGlossaryTerm(null);
 if (tab !== 'job-board') setJobSlug(null);
 if (tab !== 'autore') setAuthor(null);
 if (tab === 'blog') setBlogArticle(null);

 // Build route and push to history
 const route: AppRoute = { activeTab: tab };
 if (tab === 'confronti') route.confrontiSubTab = confrontiSubTab;
 if (tab === 'fisco') {
 route.fiscoSubTab = fiscoSubTab;
 if (fiscoSubTab === 'tax-return' && taxReturnCountry) route.taxReturnCountry = taxReturnCountry;
 }
 if (tab === 'guida') route.guidaSubTab = guidaSubTab;
 if (tab === 'vita') route.vitaSubTab = vitaSubTab;
 if (tab === 'calculator') {
 route.calcolatoreSubTab = calcolatoreSubTab;
 if (calcolatoreSubTab === 'calculator' && seoLanding) route.seoLanding = seoLanding;
 }
 if (tab === 'stats') route.statsSubTab = statsSubTab;
 if (tab === 'glossario' && glossaryTerm) route.glossaryTerm = glossaryTerm;
 if (tab === 'job-board' && jobSlug) route.jobSlug = jobSlug;
 pushRoute(route);
 // Always scroll to top on explicit top-nav tab changes
 window.scrollTo({ top: 0, behavior: 'instant' });

 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 }, [confrontiSubTab, fiscoSubTab, taxReturnCountry, guidaSubTab, vitaSubTab, calcolatoreSubTab, seoLanding, statsSubTab, glossaryTerm, jobSlug]);

 // handleSearchNavigate
 const handleSearchNavigate = useCallback((tab: string, subTab?: string, filterParams?: { location?: string; query?: string }) => {
 enableRuntimeSeo();
 suppressNextRouteSyncForTabRef.current = tab as ActiveTab;
 setActiveTab(tab as ActiveTab);
 if (tab !== 'calculator') setSeoLanding(null);
 if (tab !== 'glossario') setGlossaryTerm(null);
 if (tab !== 'blog') setBlogArticle(null);

 // Forward filter params to JobBoard when navigating to job-board
 if (tab === 'job-board' && filterParams) {
 setJobBoardFilterParams(filterParams);
 } else if (tab !== 'job-board') {
 setJobBoardFilterParams(null);
 }

 if (tab === 'calculator' && subTab) setCalcolatoreSubTab(subTab as CalcolatoreSubTab);
 else if (tab === 'confronti' && subTab) setConfrontiSubTab(subTab as ConfrontiSubTab);
 else if (tab === 'fisco' && subTab) setFiscoSubTab(subTab as FiscoSubTab);
 else if (tab === 'guida' && subTab) setGuidaSubTab(subTab as GuidaSubTab);
 else if (tab === 'vita' && subTab) setVitaSubTab(subTab as VitaSubTab);
 else if (tab === 'stats' && subTab) setStatsSubTab(subTab as StatsSubTab);
 else if (tab === 'blog' && subTab) setBlogArticle(subTab as BlogArticleId);
 else if (tab === 'glossario') setGlossaryTerm((subTab as GlossaryTermId) || null);

 const route: AppRoute = { activeTab: tab as ActiveTab };
 if (tab === 'calculator') route.calcolatoreSubTab = (subTab || calcolatoreSubTab) as CalcolatoreSubTab;
 if (tab === 'confronti') route.confrontiSubTab = (subTab || confrontiSubTab) as ConfrontiSubTab;
 if (tab === 'fisco') route.fiscoSubTab = (subTab || fiscoSubTab) as FiscoSubTab;
 if (tab === 'guida') route.guidaSubTab = (subTab || guidaSubTab) as GuidaSubTab;
 if (tab === 'vita') route.vitaSubTab = (subTab || vitaSubTab) as VitaSubTab;
 if (tab === 'stats') route.statsSubTab = (subTab || statsSubTab) as StatsSubTab;
 if (tab === 'blog') route.blogArticle = (subTab as BlogArticleId) || undefined;
 if (tab === 'glossario') route.glossaryTerm = (subTab as GlossaryTermId) || undefined;
 pushRoute(route);
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!window.location.hash) {
 window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }, [calcolatoreSubTab, confrontiSubTab, fiscoSubTab, guidaSubTab, vitaSubTab, statsSubTab]);

 // ── Sub-tab SEO effects ──

 // confronti
 useEffect(() => {
 if (activeTab === 'confronti') {
 if (suppressNextRouteSyncForTabRef.current === 'confronti') {
 suppressNextRouteSyncForTabRef.current = null;
 return;
 }
 const route: AppRoute = { activeTab: 'confronti', confrontiSubTab };
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!isInitialMount.current && !staticOverlay) {
 pushRoute(route);
 if (!window.location.hash) window.scrollTo({ top: 0, behavior: 'instant' });
 }
 unlockAchievement('comparator_curious');
 unlockAchievement('comparator_master');
 if (confrontiSubTab === 'exchange') unlockAchievement('currency_watcher');
 if (confrontiSubTab === 'health') unlockAchievement('health_researcher');
 }
 }, [confrontiSubTab]);

 // fisco
 useEffect(() => {
 if (activeTab === 'fisco') {
 if (suppressNextRouteSyncForTabRef.current === 'fisco') {
 suppressNextRouteSyncForTabRef.current = null;
 return;
 }
 const route: AppRoute = { activeTab: 'fisco', fiscoSubTab };
 if (fiscoSubTab === 'tax-return' && taxReturnCountry) route.taxReturnCountry = taxReturnCountry;
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!isInitialMount.current && !staticOverlay) {
 pushRoute(route);
 if (!window.location.hash) window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }
 }, [fiscoSubTab, taxReturnCountry]);

 // guida
 useEffect(() => {
 if (activeTab === 'guida') {
 if (suppressNextRouteSyncForTabRef.current === 'guida') {
 suppressNextRouteSyncForTabRef.current = null;
 return;
 }
 if (guidaSubTab !== 'border' && borderCrossing) {
 setBorderCrossing(null);
 }
 const route: AppRoute = { activeTab: 'guida', guidaSubTab };
 if (guidaSubTab === 'border' && borderCrossing) route.borderCrossing = borderCrossing;
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!isInitialMount.current && !staticOverlay) {
 pushRoute(route);
 if (!window.location.hash) window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }
 }, [guidaSubTab, borderCrossing]);

 // vita
 useEffect(() => {
 if (activeTab === 'vita') {
 if (suppressNextRouteSyncForTabRef.current === 'vita') {
 suppressNextRouteSyncForTabRef.current = null;
 return;
 }
 const route: AppRoute = { activeTab: 'vita', vitaSubTab };
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!isInitialMount.current && !staticOverlay) {
 pushRoute(route);
 if (!window.location.hash) window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }
 }, [vitaSubTab]);

 // calcolatore
 useEffect(() => {
 if (activeTab === 'calculator') {
 if (suppressNextRouteSyncForTabRef.current === 'calculator') {
 suppressNextRouteSyncForTabRef.current = null;
 return;
 }
 if (calcolatoreSubTab !== 'calculator' && seoLanding) {
 setSeoLanding(null);
 }
 const route: AppRoute = {
 activeTab: 'calculator',
 calcolatoreSubTab,
 seoLanding: calcolatoreSubTab === 'calculator' ? (seoLanding || undefined) : undefined,
 };
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!isInitialMount.current && !staticOverlay) {
 pushRoute(route);
 if (!window.location.hash) window.scrollTo({ top: 0, behavior: 'instant' });
 }
 if (calcolatoreSubTab === 'whatif') unlockAchievement('what_if_dreamer');
 }
 }, [activeTab, calcolatoreSubTab, seoLanding]);

 // glossario
 useEffect(() => {
 if (activeTab === 'glossario') {
 if (suppressNextRouteSyncForTabRef.current === 'glossario') {
 suppressNextRouteSyncForTabRef.current = null;
 return;
 }
 const route: AppRoute = { activeTab: 'glossario', glossaryTerm: glossaryTerm || undefined };
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!isInitialMount.current && !staticOverlay) {
 pushRoute(route);
 if (!window.location.hash) window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }
 }, [activeTab, glossaryTerm]);

 // stats
 useEffect(() => {
 if (activeTab === 'stats') {
 if (suppressNextRouteSyncForTabRef.current === 'stats') {
 suppressNextRouteSyncForTabRef.current = null;
 return;
 }
 const route: AppRoute = { activeTab: 'stats', statsSubTab };
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!isInitialMount.current && !staticOverlay) {
 pushRoute(route);
 if (!window.location.hash) window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }
 }, [statsSubTab]);

 // blog
 useEffect(() => {
 if (activeTab === 'blog') {
 if (suppressNextRouteSyncForTabRef.current === 'blog') {
 suppressNextRouteSyncForTabRef.current = null;
 return;
 }
 // When the lazy-loaded blog data hasn't resolved the URL slug yet,
 // the URL contains `/articoli-frontaliere/<slug>/` but `blogArticle`
 // is still null. Re-parse the current URL to recover the pending slug
 // and include it in the route, so `pushRoute` → `buildPath` preserves
 // it instead of rewriting the URL to the hub root.
 const pendingSlug = blogArticle
 ? undefined
 : parsePath(window.location.pathname).route.blogSlug;
 const route: AppRoute = {
 activeTab: 'blog',
 blogArticle: blogArticle || undefined,
 ...(pendingSlug ? { blogSlug: pendingSlug } : {}),
 };
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!isInitialMount.current && !staticOverlay) pushRoute(route);
 if (!window.location.hash) {
 window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }
 }, [blogArticle]);

 // Clear initial-mount flag AFTER all sub-tab effects have fired
 useEffect(() => { isInitialMount.current = false; }, []);

 // activeTab SEO (for tabs without sub-tab effects)
 useEffect(() => {
 if (!window.location.hash) {
 window.scrollTo({ top: 0, behavior: 'instant' });
 }
 const tabsWithSubEffects = ['confronti', 'fisco', 'guida', 'vita', 'calculator', 'stats', 'blog'];
 if (!tabsWithSubEffects.includes(activeTab)) {
 const route: AppRoute = { activeTab };
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 }
 }, [activeTab]);

 // Gamification tracking
 useEffect(() => {
 if (activeTab === 'vita') {
 if (vitaSubTab === 'schools') unlockAchievement('school_finder');
 if (vitaSubTab === 'places') unlockAchievement('map_explorer');
 }
 if (activeTab === 'fisco') {
 if (fiscoSubTab === 'calendar') unlockAchievement('tax_calendar_user');
 }
 }, [activeTab, guidaSubTab, vitaSubTab, fiscoSubTab]);

 return {
 activeTab, calcolatoreSubTab, confrontiSubTab, fiscoSubTab,
 guidaSubTab, vitaSubTab, statsSubTab,
 blogArticle, seoLanding, glossaryTerm, borderCrossing,
 jobSlug, author, taxReturnCountry, showApiStatus,
 notFoundPath, jobBoardFilterParams, staticOverlay,

 setActiveTab, setCalcolatoreSubTab, setConfrontiSubTab, setFiscoSubTab,
 setGuidaSubTab, setVitaSubTab, setStatsSubTab,
 setBlogArticle, setSeoLanding, setGlossaryTerm, setBorderCrossing,
 setJobSlug, setAuthor, setTaxReturnCountry, setShowApiStatus,
 setNotFoundPath, setJobBoardFilterParams,

 suppressNextRouteSyncForTabRef,

 handleTabChange, handleSearchNavigate,
 };
}
