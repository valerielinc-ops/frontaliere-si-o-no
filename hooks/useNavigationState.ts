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
} from '@/services/router';
import type {
 ActiveTab, CalcolatoreSubTab, ConfrontiSubTab, FiscoSubTab,
 GuidaSubTab, VitaSubTab, StatsSubTab, BlogArticleId, SeoLandingId,
 GlossaryTermId, BorderCrossingId,
} from '@/services/router';
import { setLocale, onLocaleChange } from '@/services/i18n';
import { prefetchTab } from '@/services/prefetch';
import { enableRuntimeSeo, updateMetaTags, trackSectionView } from '@/hooks/seoHelpers';

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
 taxReturnCountry: 'italia' | 'svizzera' | undefined;
 showApiStatus: boolean;

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
 setTaxReturnCountry: Dispatch<SetStateAction<'italia' | 'svizzera' | undefined>>;
 setShowApiStatus: Dispatch<SetStateAction<boolean>>;

 // Refs
 suppressNextRouteSyncForTabRef: MutableRefObject<ActiveTab | null>;

 // Handlers
 handleTabChange: (tab: ActiveTab) => void;
 handleSearchNavigate: (tab: string, subTab?: string) => void;
}

export function useNavigationState(): NavigationState {
 // Read initial route from URL path
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
 const [taxReturnCountry, setTaxReturnCountry] = useState<'italia' | 'svizzera' | undefined>(initialRoute.route.taxReturnCountry);
 const [showApiStatus, setShowApiStatus] = useState(false);

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

 // Shared route application — used by popstate AND global click interceptor
 const applyRoute = useCallback((pathname: string) => {
 enableRuntimeSeo();
 const { route, locale: urlLocale } = parsePath(pathname);
 setActiveTab(route.activeTab);
 if (route.calcolatoreSubTab) setCalcolatoreSubTab(route.calcolatoreSubTab);
 if (route.confrontiSubTab) setConfrontiSubTab(route.confrontiSubTab);
 if (route.fiscoSubTab) setFiscoSubTab(route.fiscoSubTab);
 if (route.taxReturnCountry) setTaxReturnCountry(route.taxReturnCountry);
 if (route.guidaSubTab) setGuidaSubTab(route.guidaSubTab);
 if (route.vitaSubTab) setVitaSubTab(route.vitaSubTab);
 if (route.statsSubTab) setStatsSubTab(route.statsSubTab);
 setBlogArticle(route.blogArticle || null);
 setSeoLanding(route.seoLanding || null);
 setGlossaryTerm(route.glossaryTerm || null);
 setBorderCrossing(route.borderCrossing || null);
 setJobSlug(route.jobSlug || null);
 setLocale(urlLocale);
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!scrollToAnchor()) {
 window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }, []);

 // Listen for browser back/forward navigation
 useEffect(() => {
 const onPopState = () => applyRoute(window.location.pathname);
 window.addEventListener('popstate', onPopState);
 const unsubLocale = onLocaleChange((newLocale) => {
 updatePathForLocale(newLocale);
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

 // This is an internal SPA route — intercept it
 e.preventDefault();

 const [pathname, hash] = href.split('#');
 const search = a.search || '';

 // Push the new URL and apply the route via SPA navigation
 const { route } = parsePath(pathname);
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
 const hash = window.location.hash;
 if (hash && hash.startsWith('#/')) {
 const newPath = parseHashToPath(hash);
 if (newPath) {
 history.replaceState(null, '', newPath);
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
 history.replaceState(null, '', calcHomeSlugs[p]);
 }
 const legacyRedirects: Record<string, string> = {
 '/calculator': '/',
 '/stats': '/statistiche',
 '/guide': '/guida-frontaliere',
 };
 if (legacyRedirects[p]) {
 history.replaceState(null, '', legacyRedirects[p]);
 }
 }, []);

 // handleTabChange
 const handleTabChange = useCallback((tab: ActiveTab) => {
 enableRuntimeSeo();
 const previousTab = activeTab;
 setActiveTab(tab);
 if (tab !== 'calculator') setSeoLanding(null);
 if (tab !== 'glossario') setGlossaryTerm(null);
 if (tab !== 'job-board') setJobSlug(null);
 if (tab === 'blog') setBlogArticle(null);
 Analytics.trackTabNavigation(previousTab, tab);

 if (tab === 'confronti') Analytics.trackFunnelStep('compare', { from_tab: previousTab });
 if (tab === 'guida') unlockAchievement('guide_reader');
 if (tab === 'feedback') unlockAchievement('feedback_giver');
 if (tab === 'stats') unlockAchievement('stats_checker');
 if (tab === 'fisco') unlockAchievement('pension_planner');

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

 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 }, [activeTab, confrontiSubTab, fiscoSubTab, guidaSubTab, vitaSubTab, calcolatoreSubTab, statsSubTab, seoLanding, glossaryTerm, jobSlug, taxReturnCountry]);

 // handleSearchNavigate
 const handleSearchNavigate = useCallback((tab: string, subTab?: string) => {
 enableRuntimeSeo();
 suppressNextRouteSyncForTabRef.current = tab as ActiveTab;
 setActiveTab(tab as ActiveTab);
 if (tab !== 'calculator') setSeoLanding(null);
 if (tab !== 'glossario') setGlossaryTerm(null);
 if (tab !== 'blog') setBlogArticle(null);

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
 if (!isInitialMount.current) {
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
 if (!isInitialMount.current) {
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
 if (!isInitialMount.current) {
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
 if (!isInitialMount.current) {
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
 if (!isInitialMount.current) {
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
 if (!isInitialMount.current) {
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
 if (!isInitialMount.current) {
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
 const route: AppRoute = { activeTab: 'blog', blogArticle: blogArticle || undefined };
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 if (!isInitialMount.current) pushRoute(route);
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
 jobSlug, taxReturnCountry, showApiStatus,

 setActiveTab, setCalcolatoreSubTab, setConfrontiSubTab, setFiscoSubTab,
 setGuidaSubTab, setVitaSubTab, setStatsSubTab,
 setBlogArticle, setSeoLanding, setGlossaryTerm, setBorderCrossing,
 setJobSlug, setTaxReturnCountry, setShowApiStatus,

 suppressNextRouteSyncForTabRef,

 handleTabChange, handleSearchNavigate,
 };
}
