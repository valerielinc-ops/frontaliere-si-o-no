import React, { useState, useEffect, useRef, useMemo, useCallback, Suspense, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import { lazyRetry } from '@/services/lazyRetry';
// Analytics proxy: lazy, fire-and-forget, deferred to user interaction (FRO-367)
import { Analytics } from '@/services/analyticsProxy';
import { useUIState } from '@/hooks/useUIState';
// TabContentContext: passes app-level state to lazy tab content components (FRO-367)
import { TabContentContext } from '@/services/TabContentContext';
import type { TabContentState } from '@/services/TabContentContext';

import { ErrorBoundary, SilentErrorBoundary } from '@/components/shared/ErrorBoundary';

import { reportCaughtError } from '@/services/errorReporter';
// Gamification lazily loaded — all calls are fire-and-forget
const unlockAchievement = (id: string) => {
 import('@/services/gamificationService').then(m => m.unlockAchievement(id)).catch(() => {});
};


const GamificationWidget = lazyRetry(() => import('@/components/community/GamificationWidget'));
const NewsletterPopup = lazyRetry(() => import('@/components/community/NewsletterPopup'));
const NewsletterInline = lazyRetry(() => import('@/components/community/Newsletter'));
const NewsletterMount = lazyRetry(() => import('@/components/community/NewsletterMount'));
const LanguageSelector = lazyRetry(() => import('@/components/shared/LanguageSelector'));
const SiteSearch = lazyRetry(() => import('@/components/shared/SiteSearch'));
const WhatsNewModal = lazyRetry(() => import('@/components/community/WhatsNewModal'));
const WhatsNewBellLazy = lazyRetry(() => import('@/components/community/WhatsNewModal').then(m => ({ default: m.WhatsNewBell })));

// Lazy-loaded components — still used in secondary tabs / non-extracted sections
const FeedbackSection = lazyRetry(() => import('@/components/community/FeedbackSection').then(m => ({ default: m.FeedbackSection })));
const ApiStatus = lazyRetry(() => import('@/components/pages/ApiStatus'));
const PrivacyPolicy = lazyRetry(() => import('@/components/pages/PrivacyPolicy').then(m => ({ default: m.PrivacyPolicy })));
const TermsOfService = lazyRetry(() => import('@/components/pages/TermsOfService').then(m => ({ default: m.TermsOfService })));
const ChiSiamo = lazyRetry(() => import('@/components/pages/ChiSiamo').then(m => ({ default: m.ChiSiamo })));
const AutorePage = lazyRetry(() => import('@/components/pages/AutorePage').then(m => ({ default: m.AutorePage })));
const Correzioni = lazyRetry(() => import('@/components/pages/Correzioni').then(m => ({ default: m.Correzioni })));
const Metodologia = lazyRetry(() => import('@/components/pages/Metodologia').then(m => ({ default: m.Metodologia })));
const DataDeletion = lazyRetry(() => import('@/components/pages/DataDeletion').then(m => ({ default: m.DataDeletion })));
const EmailConfirmed = lazyRetry(() => import('@/components/pages/EmailConfirmed').then(m => ({ default: m.EmailConfirmed })));
const NewsletterPreferences = lazyRetry(() => import('@/components/pages/NewsletterPreferences').then(m => ({ default: m.NewsletterPreferences })));
const GamificationPage = lazyRetry(() => import('@/components/community/GamificationPage'));
const CommunityForum = lazyRetry(() => import('@/components/community/CommunityForum'));
const ContactPage = lazyRetry(() => import('@/components/pages/ContactPage'));
const PartnerServices = lazyRetry(() => import('@/components/pages/PartnerServices'));
const DonationBanner = lazyRetry(() => import('@/components/shared/DonationBanner'));
const ConsultingPage = lazyRetry(() => import('@/components/pages/ConsultingPage'));
const PressKit = lazyRetry(() => import('@/components/pages/PressKit'));
const JobBoard = lazyRetry(() => import('@/components/community/JobBoard'));
const FooterWeather = lazyRetry(() => import('@/components/shared/FooterWeather'));
const MorningDashboard = lazyRetry(() => import('@/components/vita/MorningDashboard'));
// UserProfile component is lazy-loaded; utility functions loaded on demand
const UserProfile = lazyRetry(() => import('@/components/pages/UserProfile'));
const BlogArticles = lazyRetry(() => {
 // Prefetch blog meta translations in parallel with component chunk
 import('@/services/i18n').then(m => m.loadBlogMeta()).catch(() => {});
 return import('@/components/community/BlogArticles');
});
const AdminPanel = lazyRetry(() => import('@/components/pages/AdminPanel'));
const Glossary = lazyRetry(() => import('@/components/pages/Glossary'));
const TicineseDialect = lazyRetry(() => import('@/components/vita/TicineseDialect'));
const FaqSection = lazyRetry(() => import('@/components/pages/FaqSection'));
const SiteMapPage = lazyRetry(() => import('@/components/pages/SiteMapPage'));
const ContractsGuide = lazyRetry(() => import('@/components/guide/ContractsGuide'));
const Sindacati = lazyRetry(() => import('@/components/pages/Sindacati'));
const TfrCalculator = lazyRetry(() => import('@/components/calculator/TfrCalculator'));
const PermitQuiz = lazyRetry(() => import('@/components/guide/PermitQuiz'));
const TredicesimalCalculator = lazyRetry(() => import('@/components/calculator/TredicesimalCalculator'));
const WeeklyDigest = lazyRetry(() => import('@/components/community/WeeklyDigest'));
const ToolOfTheWeek = lazyRetry(() => import('@/components/community/ToolOfTheWeek'));
const AiChatbot = lazyRetry(() => import('@/components/shared/AiChatbot'));
const NotFoundSuggestions = lazyRetry(() => import('@/components/shared/NotFoundSuggestions'));
const SeoDailyBanner = lazyRetry(() => import('@/components/shared/SeoDailyBanner'));
const QuickLinksGrid = lazyRetry(() => import('@/components/shared/QuickLinksGrid'));
const WeeklyEmployersTeaser = lazyRetry(() => import('@/components/shared/WeeklyEmployersTeaser'));

// Lazy tab content components (FRO-367): each owns its own sub-components + rendering.
// This moves InputCard, MobileCalcLayout, FrontierGuide, and 40+ other components
// out of the critical bundle — they only parse when their tab is first visited.
const CalcolatoreTabContent = lazyRetry(() => import('@/components/tabs/CalcolatoreTabContent'));
const ConfrontiTabContent = lazyRetry(() => import('@/components/tabs/ConfrontiTabContent'));
const FiscoTabContent = lazyRetry(() => import('@/components/tabs/FiscoTabContent'));
const GuidaTabContent = lazyRetry(() => import('@/components/tabs/GuidaTabContent'));
const VitaTabContent = lazyRetry(() => import('@/components/tabs/VitaTabContent'));
const StatsTabContent = lazyRetry(() => import('@/components/tabs/StatsTabContent'));

// Simulation state hook: manages inputs, result, handleCalculate, URL hydration, SEO presets
import { useSimulationState } from '@/hooks/useSimulationState';
import { useNavigationState } from '@/hooks/useNavigationState';
import { setDefaultConsent } from '@/services/consentService';
import { prefetchTab } from '@/services/prefetch';
import { initPostHog } from '@/services/posthog';
import { useSeoPageTracking } from '@/hooks/useSeoPageTracking';
import { useKillSwitches } from '@/hooks/useKillSwitches';
// CookieBanner removed — consent is silently granted by default (see consentService.ts)
// Set consent defaults ASAP (before any analytics/ad scripts load)
setDefaultConsent();
// Initialize PostHog EU Cloud analytics (async, non-blocking)
initPostHog();
// SEO helpers live in hooks/seoHelpers.ts — shared between App.tsx and extracted hooks.
import { updateMetaTags, trackSectionView } from '@/hooks/seoHelpers';
import { useTranslation, getCantonI18nParams } from '@/services/i18n';
// Static-page path builders for footer SEO cross-links (Layer 2A — internal linking).
import { buildFuelTodayPath } from '@/build-plugins/fuelDailyData';
import { buildCurrentWeekPath } from '@/build-plugins/weeklyEmployersData';
import { buildHubPath as buildJobMarketHubPath } from '@/build-plugins/jobMarketSnapshotData';
import { buildHealthPremiumsCantonPath } from '@/build-plugins/healthPremiumsData';
import { HUB_SLUGS as SEO_HUB_SLUGS, FOOTER_TOP_SECTORS as SEO_FOOTER_TOP_SECTORS, FOOTER_TOP_CITIES as SEO_FOOTER_TOP_CITIES, HUB_SECTORS as SEO_HUB_SECTORS, type HubLocale as SeoHubLocale } from '@/build-plugins/seoHubsData';
import { SECTOR_HUB_KEYS, buildSectorHubPath, type SectorHubKey } from '@/build-plugins/jobSectorLanding';
import { pushRoute, buildPath, getSeoSection, AppRoute, parsePath } from '@/services/router';
import type { ActiveTab, CalcolatoreSubTab, ConfrontiSubTab, FiscoSubTab, GuidaSubTab, VitaSubTab, StatsSubTab, BlogArticleId, GlossaryTermId } from '@/services/router';
import { NavigationContext } from '@/services/NavigationContext';
import type { NavigationContextType } from '@/services/NavigationContext';
import type { UserProfileData } from '@/components/pages/UserProfile';
import type { ContactPrefill } from '@/components/pages/ContactPage';
import { SubTabNav } from '@/components/navigation/SubTabNav';
import type { SubTabItem } from '@/components/navigation/SubTabNav';
import {
 useAuth,
 getUserPhotoURL,
 getUserDisplayName,
 promptOneTap,
 cancelOneTap,
 getAuthEmail,
 eagerAuth,
 renderGoogleButtonWithReadiness,
 signInWithCustomAuthToken,
 exchangeLinkedInCode,
 saveUserProfileToFirestore,
 consumeAuthJobContext,
} from '@/services/authService';
import type { AuthJobContext } from '@/services/authService';
import {
 upsertNewsletterSubscriber as upsertNewsletterSubscriberRecord,
 normalizeNewsletterEmail,
 markNewsletterSubscribedLocally,
 recordNewsletterClick,
 recordNewsletterEvent,
 confirmNewsletterSubscription,
 clearNewsletterPendingLocally,
} from '@/services/newsletterSubscribers';
// Icons used directly in App.tsx for tab navigation and UI chrome.
// NOTE: All lucide-react icons (including those only used by lazy components) are
// consolidated into a single 'vendor-icons' chunk via manualChunks in vite.config.ts.
// This eliminates 39+ tiny shared chunks that would each require a separate HTTP request.
import {
 Moon, Sun, Calculator, HelpCircle, BarChart2, PiggyBank, BookOpen, Facebook, Newspaper,
 ArrowRightLeft, Phone, Car, Heart, Building2, AlertTriangle, Layers, Briefcase,
 Sparkles, TrendingUp, MapPin, ShoppingCart, Euro, ClipboardList, Baby, Map,
 Home, Timer, Users, Calendar, Shield, Mountain, GraduationCap,
 LifeBuoy, Rocket, Mail, Bug, Sunrise, User as UserIcon, LogIn,
 FileText, Gift, Hammer, BookA, School, Database, Clock, Receipt, Languages, BarChart3,
 Banknote, Fuel, Scale, Loader2, Menu, X, ScrollText, Info
} from 'lucide-react';

import SkeletonFallback, { SkeletonPageShell, SkeletonComparator, SkeletonGuide, SkeletonDashboard, SkeletonFisco, SkeletonStats, SkeletonBlog, SkeletonVita, SkeletonNewsTicker, SkeletonWeeklyFact, SkeletonInputCard, SkeletonFooterSlot } from '@/components/shared/Skeletons';

const LazyFallback = () => <SkeletonFallback />;
const ADMIN_EMAIL_WHITELIST = ['luigisag@gmail.com', 'valerielinc@gmail.com'];

const App: React.FC = () => {
 const { t, locale } = useTranslation();
 const {
 user: authUser,
 loading: authLoading,
 signIn: googleSignIn,
 signInFacebook: facebookSignIn,
 signInEmail,
 } = useAuth();

 // Navigation state: tabs, sub-tabs, deep links, popstate, SEO effects, etc.
 const {
 activeTab, calcolatoreSubTab, confrontiSubTab, fiscoSubTab,
 guidaSubTab, vitaSubTab, statsSubTab,
 blogArticle, seoLanding, glossaryTerm, borderCrossing,
 jobSlug, author, taxReturnCountry, showApiStatus, notFoundPath,
 jobBoardFilterParams, staticOverlay,
 setActiveTab, setCalcolatoreSubTab, setConfrontiSubTab, setFiscoSubTab,
 setGuidaSubTab, setVitaSubTab, setStatsSubTab,
 setBlogArticle, setSeoLanding, setGlossaryTerm, setBorderCrossing,
 setJobSlug, setAuthor, setTaxReturnCountry, setShowApiStatus,
 setNotFoundPath, setJobBoardFilterParams,
 suppressNextRouteSyncForTabRef,
 handleTabChange: navHandleTabChange, handleSearchNavigate,
 } = useNavigationState();

 // UI state: dark mode, translations, deferred widgets, analytics init
 const { isDarkMode, isFocusMode, showDeferredHomeWidgets, translationsReady, toggleTheme, setIsFocusMode } = useUIState(activeTab);
 useSeoPageTracking();
 // Runtime kill-switches (Firebase Remote Config) for the 5 SEO feature link
 // surfaces. When a flag is flipped to true in the RC console, every SPA link
 // to that feature is hidden within ~1 minute (RC cache). Default-safe:
 // defaults to false on RC failure so links stay SHOWN.
 const killSwitches = useKillSwitches();

 const { inputs, setInputs, result, setResult, handleCalculate, urlHydrated } = useSimulationState(activeTab, seoLanding);
 const deferredResult = useDeferredValue(result);
 const isResultStale = deferredResult !== result;

 // Wrap the hook's handleTabChange to also close the mobile menu
 const handleTabChange = useCallback((tab: ActiveTab) => {
 setMobileMenuOpen(false);
 navHandleTabChange(tab);
 }, [navHandleTabChange]);

 const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
 const [contactPrefill, setContactPrefill] = useState<ContactPrefill | null>(null);
 const [enablePersonalization, setEnablePersonalization] = useState(false);
 const [adminGoogleButtonReady, setAdminGoogleButtonReady] = useState(false);
 const adminGoogleButtonRef = useRef<HTMLDivElement | null>(null);
 const [linkedInCallbackProcessing, setLinkedInCallbackProcessing] = useState(false);
 const [linkedInCallbackError, setLinkedInCallbackError] = useState<string | null>(null);

 const upsertNewsletterSubscriber = useCallback(async (
 email: string,
 source: 'signup' | 'signup_linkedin' | 'chatbot_google' | 'chatbot_facebook' | 'chatbot_email',
 displayName?: string | null,
 jobContext?: AuthJobContext | null,
 ): Promise<boolean> => {
 const deactivateLegacyDuplicates = async (
 db: any,
 normalizedEmail: string,
 reason: string,
 ): Promise<void> => {
 try {
 const { collection, query, where, getDocs, setDoc } = await import('firebase/firestore');
 const snap = await getDocs(query(collection(db, 'newsletter_subscribers'), where('email', '==', normalizedEmail)));
 if (snap.empty) return;
 const nowIso = new Date().toISOString();
 await Promise.all(
 snap.docs
 .filter((d) => d.id !== normalizedEmail)
 .map((d) =>
 setDoc(
 d.ref,
 {
 email: normalizedEmail,
 isActive: false,
 active: false,
 mergedInto: normalizedEmail,
 legacyMergedAt: nowIso,
 legacyMergeReason: reason,
 updatedAt: nowIso,
 },
 { merge: true },
 ),
 ),
 );
 } catch {
 // Non-blocking cleanup
 }
 };

 try {
 const normalizedEmail = normalizeNewsletterEmail(email);
 if (!normalizedEmail || !normalizedEmail.includes('@')) return false;
 const [{ getFirestore }, { getApp }] = await Promise.all([
 import('firebase/firestore'),
 import('@/services/firebase'),
 ]);
 const db = getFirestore(await getApp());

 await upsertNewsletterSubscriberRecord(db, {
 email: normalizedEmail,
 name: displayName || null,
 preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
 source,
 sourceChannel:
 source === 'signup'
 ? 'auth_google'
 : source === 'signup_linkedin'
 ? 'auth_linkedin'
 : source === 'chatbot_google'
 ? 'auth_google'
 : source === 'chatbot_facebook'
 ? 'auth_facebook'
 : 'chatbot',
 sourcePage: window.location.pathname,
 sourceCta: source,
 sourceComponent: source.startsWith('chatbot') ? 'chatbot_auth' : 'app_auth',
 sourceRouteFamily: activeTab,
 locale: navigator.language || 'it-IT',
 isActive: true,
 ...(jobContext ? {
 jobContext: { slug: jobContext.slug, company: jobContext.company, location: jobContext.location, category: jobContext.category },
 locationInterest: jobContext.location,
 sectorInterest: jobContext.category,
 } : {}),
 });

 await deactivateLegacyDuplicates(db, normalizedEmail, `upsert_${source}`);
 markNewsletterSubscribedLocally();
 return true;
 } catch {
 return false;
 }
 }, [activeTab]);

 // Load user profile for prefilling simulator inputs (deferred to idle)
 // Skipped when URL params already hydrated the inputs
 useEffect(() => {
 const loadProfile = () => {
 // If URL params set the inputs, don't overwrite with profile
 if (urlHydrated.current) return;
 import('@/components/pages/UserProfile').then(({ loadUserProfile, profileToSimInputs }) => {
 const profile = loadUserProfile();
 const hasData = profile.familySituation || profile.children !== '0' || profile.age || profile.frontaliereType;
 if (hasData) {
 setUserProfile(profile);
 // Prefill simulation inputs from profile
 const prefilled = profileToSimInputs(profile);
 if (Object.keys(prefilled).length > 0) {
 setInputs(prev => ({ ...prev, ...prefilled }));
 }
 }
 }).catch((e) => { reportCaughtError(e, 'app.loadUserProfile'); });
 };
 if ('requestIdleCallback' in window) {
 requestIdleCallback(loadProfile, { timeout: 4000 });
 } else {
 setTimeout(loadProfile, 2000);
 }
 // Listen for profile updates via storage events
 const onStorage = (e: StorageEvent) => {
 if (e.key === 'frontaliere_user_profile' && e.newValue) {
 try {
 const updated = JSON.parse(e.newValue) as UserProfileData;
 setUserProfile(updated);
 } catch { /* ignore */ }
 }
 };
 window.addEventListener('storage', onStorage);
 return () => window.removeEventListener('storage', onStorage);
 }, []);

 // Auto-login via HMAC autologin code or legacy custom token in newsletter URL
 useEffect(() => {
 let cancelled = false;
 (async () => {
 try {
 const url = new URL(window.location.href);
 // 'ac' = HMAC autologin code (never expires, exchanged for fresh token)
 // 'at'/'authToken' = legacy Firebase custom token (expires in 1h, direct sign-in)
 const autologinCode = url.searchParams.get('ac');
 const legacyAuthToken = url.searchParams.get('at') || url.searchParams.get('authToken');

 // Always strip newsletter-specific query params from the URL immediately so
 // they don't persist during SPA navigation (privacy + cosmetics).
 const NEWSLETTER_PARAMS = ['ac', 'at', 'ne', 'authToken', 'newsletter_email', 'newsletter_autologin', 'newsletter_source', 'subscriber_key'];
 const hadNewsletterParams = NEWSLETTER_PARAMS.some(p => url.searchParams.has(p));

 // Skip if there's a newsletter action — the action handler owns auth in that case
 const action = url.searchParams.get('action');
 if (action === 'unsubscribe' || action === 'resubscribe' || action === 'confirm_newsletter') return;

 // Read email before stripping params (support short 'ne', legacy 'newsletter_email',
 // and 'email' fallback for confirmation links that share the 'email' param)
 const email = normalizeNewsletterEmail(url.searchParams.get('ne') || url.searchParams.get('newsletter_email') || url.searchParams.get('email') || '');

 // Strip newsletter params from URL right away
 if (hadNewsletterParams) {
 for (const p of NEWSLETTER_PARAMS) url.searchParams.delete(p);
 const cleanUrl = url.pathname + (url.search || '') + url.hash;
 window.history.replaceState(null, '', cleanUrl);
 }

 if (!autologinCode && !legacyAuthToken) return;
 if (!email || !email.includes('@')) return;

 let user = null;
 if (autologinCode) {
 // New flow: exchange HMAC code for a fresh custom token via Cloud Function
 const { exchangeNewsletterAuthCode } = await import('@/services/newsletterSubscribers');
 const result = await exchangeNewsletterAuthCode(email, autologinCode);
 if (result.success && result.authToken) {
 user = await signInWithCustomAuthToken(result.authToken);
 }
 } else if (legacyAuthToken) {
 // Legacy flow: direct sign-in with pre-generated custom token (may be expired)
 user = await signInWithCustomAuthToken(legacyAuthToken);
 }

 if (cancelled) return;
 Analytics.trackUIInteraction('newsletter', 'autologin', autologinCode ? 'hmac_code' : 'legacy_token', user ? 'success' : 'failed');
 } catch (error) {
 reportCaughtError(error, 'app.newsletterAutologin');
 Analytics.trackUIInteraction('newsletter', 'autologin', 'error');
 }
 })();
 return () => { cancelled = true; };
 }, []);

 // LinkedIn OAuth2 callback handler — processes ?code=XXX&state=YYY returned by LinkedIn.
 // Expected path is /auth/linkedin/callback (restored client-side via sessionStorage after
 // GitHub Pages' static callback page redirects to /). If the sessionStorage restoration fails
 // (browser-specific quirks have been observed), the user lands on / with the query preserved.
 // We detect the LinkedIn callback by (code|error)+state where state decodes to a path — our
 // encoding signature — so the handler fires regardless of which pathname the browser ended up on.
 useEffect(() => {
 let cancelled = false;
 (async () => {
 try {
 const currentUrl = new URL(window.location.href);
 const code = currentUrl.searchParams.get('code');
 const state = currentUrl.searchParams.get('state');
 const errorParam = currentUrl.searchParams.get('error');

 // LinkedIn always returns a `state` param because we always send one.
 // Absence of state → not our callback, bail early.
 if (!state) return;
 if (!code && !errorParam) return;

 // Guard against accidental triggering on unrelated ?code=&state= params:
 // our state is always encodeURIComponent(path) — so it must decode to a
 // string starting with `/`. If it doesn't, this isn't our callback.
 let decodedState: string;
 try {
 decodedState = decodeURIComponent(state);
 } catch {
 return;
 }
 if (!decodedState.startsWith('/')) return;

 // Only handle on expected callback path OR on root (fallback when the
 // sessionStorage-based SPA restoration from /auth/linkedin/callback/ fails).
 const path = currentUrl.pathname.replace(/\/+$/, '') || '/';
 if (path !== '/auth/linkedin/callback' && path !== '/') return;

 if (errorParam) {
 // User cancelled or LinkedIn returned an error
 Analytics.trackUIInteraction('auth', 'linkedin', 'login', 'cancelled');
 window.history.replaceState(null, '', decodedState);
 return;
 }

 if (!code) return;

 setLinkedInCallbackProcessing(true);

 const customToken = await exchangeLinkedInCode(code);

 if (cancelled) return;

 if (!customToken) {
 setLinkedInCallbackError('Errore durante il login con LinkedIn. Riprova.');
 Analytics.trackUIInteraction('auth', 'linkedin', 'login', 'error');
 return;
 }

 const user = await signInWithCustomAuthToken(customToken);
 Analytics.trackUIInteraction('auth', 'linkedin', 'login', user ? 'success' : 'no-user');

 if (user) {
 // Best-effort: save/update user profile in Firestore for personalization
 saveUserProfileToFirestore(user, 'linkedin').catch(() => {});

 // Subscribe to newsletter BEFORE navigating away — the auto-subscribe
 // effect won't fire because location.replace destroys React before re-render.
 // Also pass job context saved before the OAuth redirect for personalized job recs.
 const email = getAuthEmail(user);
 const savedJobCtx = consumeAuthJobContext();
 if (email) {
 try {
 await upsertNewsletterSubscriber(email, 'signup_linkedin', user.displayName || null, savedJobCtx);
 } catch { /* best-effort: auto-subscribe on next page load will retry */ }
 }
 }

 if (cancelled) return;

 // Navigate to original path (from state param) or homepage.
 // Use location.replace so the SPA router re-parses the target route;
 // replaceState alone would leave stale tab/subtab state.
 setLinkedInCallbackProcessing(false);
 window.location.replace(decodedState || '/');
 } catch (error) {
 if (cancelled) return;
 reportCaughtError(error, 'app.linkedInCallback');
 Analytics.trackUIInteraction('auth', 'linkedin', 'login', 'error');
 setLinkedInCallbackError('Errore durante il login con LinkedIn. Riprova.');
 }
 })();
 return () => { cancelled = true; };
 }, []);

 useEffect(() => {
 let cancelled = false;
 (async () => {
 try {
 const currentUrl = new URL(window.location.href);
 const path = currentUrl.pathname.replace(/\/+$/, '') || '/';
 if (path !== '/newsletter/click') return;

 const target = currentUrl.searchParams.get('target');
 if (!target) return;

 const newsletterEmail = normalizeNewsletterEmail(currentUrl.searchParams.get('ne') || currentUrl.searchParams.get('newsletter_email') || '');
 const campaignId = currentUrl.searchParams.get('campaign_id') || undefined;
 const messageId = currentUrl.searchParams.get('message_id') || undefined;
 const variant = currentUrl.searchParams.get('variant') || undefined;
 const sectionId = currentUrl.searchParams.get('section_id') || undefined;
 const linkLabel = currentUrl.searchParams.get('link_label') || undefined;
 const sourceLocale = currentUrl.searchParams.get('subscriber_locale') || navigator.language || 'it-IT';
 const sourceChannel = currentUrl.searchParams.get('source_channel') || 'newsletter_page';
 const locationInterest = currentUrl.searchParams.get('location_interest') || undefined;
 const sectorInterest = currentUrl.searchParams.get('sector_interest') || undefined;

 if (newsletterEmail && newsletterEmail.includes('@')) {
 try {
 const [{ getFirestore }, { getApp }] = await Promise.all([
 import('firebase/firestore'),
 import('@/services/firebase'),
 ]);
 const db = getFirestore(await getApp());
 await recordNewsletterClick(db, {
 email: newsletterEmail,
 eventType: 'click',
 campaignId,
 messageId,
 variant,
 sectionId,
 linkUrl: target,
 linkLabel,
 targetUrl: target,
 sourceLocale,
 sourcePage: currentUrl.pathname,
 sourceChannel,
 metadata: {
 subscriberKey: currentUrl.searchParams.get('subscriber_key') || currentUrl.searchParams.get('sk') || undefined,
 locationInterest,
 sectorInterest,
 },
 });
 } catch (error) {
 reportCaughtError(error, 'app.newsletterClickTrack');
 }
 }

 Analytics.trackNewsletterEvent('click', {
 campaignId,
 messageId,
 variant,
 sectionId,
 linkLabel,
 targetUrl: target,
 subscriberLocale: sourceLocale,
 sourceChannel,
 sourcePage: currentUrl.pathname,
 locationInterest,
 sectorInterest,
 });

 if (!cancelled) {
 window.location.replace(target);
 }
 } catch (error) {
 reportCaughtError(error, 'app.newsletterClickRedirect');
 }
 })();

 return () => {
 cancelled = true;
 };
 }, []);

 // Handle newsletter unsubscribe via URL parameter
 const [unsubscribeMsg, setUnsubscribeMsg] = useState<string | null>(null);
 const [newsletterActionEmail, setNewsletterActionEmail] = useState<string | null>(null);
 const [showNewsletterWelcome, setShowNewsletterWelcome] = useState(false);
 const [newsletterActionType, setNewsletterActionType] = useState<'unsubscribe' | 'resubscribe' | null>(null);
 useEffect(() => {
 const urlParams = new URLSearchParams(window.location.search);
 const action = urlParams.get('action');
 if (action !== 'unsubscribe' && action !== 'resubscribe' && action !== 'confirm_newsletter') return;
 const email = urlParams.get('email');
 if (!email) return;

 // Handle newsletter confirmation link (FRO-33)
 if (action === 'confirm_newsletter') {
 const token = urlParams.get('token');
 if (!token) return;
 (async () => {
 try {
 const result = await confirmNewsletterSubscription(email, token);
 if (result.success) {
 clearNewsletterPendingLocally();
 markNewsletterSubscribedLocally();
 localStorage.setItem('newsletter_subscribed', 'true');

 // Auto-login with the auth token returned by the Cloud Function
 if (result.authToken) {
 try {
 await signInWithCustomAuthToken(result.authToken);
 Analytics.trackUIInteraction('newsletter', 'confirm_autologin', 'success');
 } catch (authErr) {
 reportCaughtError(authErr, 'app.newsletterConfirmAutologin');
 Analytics.trackUIInteraction('newsletter', 'confirm_autologin', 'error');
 }
 }

 if (result.alreadyConfirmed) {
 setUnsubscribeMsg(t('newsletter.alreadyConfirmed'));
 } else {
 setShowNewsletterWelcome(true);
 }
 } else if (result.error === 'invalid_token') {
 setUnsubscribeMsg(t('newsletter.confirmationInvalidToken'));
 } else {
 setUnsubscribeMsg(t('newsletter.confirmationError'));
 }
 } catch {
 setUnsubscribeMsg(t('newsletter.confirmationError'));
 }
 window.history.replaceState({}, '', window.location.pathname);
 window.scrollTo({ top: 0, behavior: 'instant' });
 })();
 return;
 }

 setNewsletterActionEmail(normalizeNewsletterEmail(email));
 setNewsletterActionType(action);
 (async () => {
 try {
 const normalizedEmail = normalizeNewsletterEmail(email);
 if (!normalizedEmail || !normalizedEmail.includes('@')) {
 setUnsubscribeMsg(action === 'unsubscribe'
 ? t('newsletter.unsubscribeError')
 : 'Errore durante la riattivazione. Riprova più tardi.');
 return;
 }

 // Authenticate via autologin code or legacy custom token before processing
 const autologinCode = urlParams.get('ac');
 const legacyAuthToken = urlParams.get('at') || urlParams.get('authToken');
 if (autologinCode) {
 // New flow: exchange HMAC code for fresh token
 const { exchangeNewsletterAuthCode } = await import('@/services/newsletterSubscribers');
 const result = await exchangeNewsletterAuthCode(normalizedEmail, autologinCode);
 if (result.success && result.authToken) {
 const signedInUser = await signInWithCustomAuthToken(result.authToken);
 const signedInEmail = signedInUser ? getAuthEmail(signedInUser) : null;
 if (!signedInEmail || normalizeNewsletterEmail(signedInEmail) !== normalizedEmail) {
 setUnsubscribeMsg(action === 'unsubscribe'
 ? 'Link non valido o scaduto. Riprova dalla newsletter.'
 : 'Link non valido o scaduto. Riprova dalla newsletter.');
 window.history.replaceState({}, '', window.location.pathname);
 return;
 }
 }
 } else if (legacyAuthToken) {
 const signedInUser = await signInWithCustomAuthToken(legacyAuthToken);
 const signedInEmail = signedInUser ? getAuthEmail(signedInUser) : null;
 if (!signedInEmail || normalizeNewsletterEmail(signedInEmail) !== normalizedEmail) {
 setUnsubscribeMsg(action === 'unsubscribe'
 ? 'Link non valido o scaduto. Riprova dalla newsletter.'
 : 'Link non valido o scaduto. Riprova dalla newsletter.');
 window.history.replaceState({}, '', window.location.pathname);
 return;
 }
 } else {
 // No authToken — reject the action to prevent unauthorized unsubscribe
 setUnsubscribeMsg(action === 'unsubscribe'
 ? 'Link non valido. Usa il link dalla newsletter per disiscriverti.'
 : 'Link non valido. Usa il link dalla newsletter per riattivare.');
 window.history.replaceState({}, '', window.location.pathname);
 return;
 }

 const [{ getFirestore, collection, doc, setDoc, query, where, getDocs }, { getApp }] = await Promise.all([
 import('firebase/firestore'),
 import('@/services/firebase'),
 ]);
 const db = getFirestore(await getApp());

 const syncLegacyDuplicates = async (active: boolean, reason: string): Promise<void> => {
 const snap = await getDocs(query(collection(db, 'newsletter_subscribers'), where('email', '==', normalizedEmail)));
 if (snap.empty) return;
 const nowIso = new Date().toISOString();
 await Promise.all(
 snap.docs
 .filter((d) => d.id !== normalizedEmail)
 .map((d) =>
 setDoc(
 d.ref,
 {
 email: normalizedEmail,
 isActive: active,
 active,
 mergedInto: normalizedEmail,
 legacyMergedAt: nowIso,
 legacyMergeReason: reason,
 updatedAt: nowIso,
 },
 { merge: true },
 ),
 ),
 );
 };

 if (action === 'unsubscribe') {
 const nowIso = new Date().toISOString();
 await setDoc(
 doc(collection(db, 'newsletter_subscribers'), normalizedEmail),
 {
 email: normalizedEmail,
 status: 'unsubscribed',
 isActive: false,
 active: false,
 source: 'unsubscribe_link',
 unsubscribedAt: nowIso,
 updatedAt: nowIso,
 },
 { merge: true },
 );
 await syncLegacyDuplicates(false, 'unsubscribe_link');
 setUnsubscribeMsg(t('newsletter.unsubscribed'));
 localStorage.removeItem('newsletter_subscribed');
 } else {
 await upsertNewsletterSubscriberRecord(db, {
 email: normalizedEmail,
 name: null,
 preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
 source: 'resubscribe_link',
 locale: navigator.language || 'it-IT',
 isActive: true,
 });
 await syncLegacyDuplicates(false, 'resubscribe_link');
 markNewsletterSubscribedLocally();
 setUnsubscribeMsg('Iscrizione riattivata con successo. Riceverai di nuovo la newsletter.');
 }
 // Clean URL
 window.history.replaceState({}, '', window.location.pathname);
 } catch {
 setUnsubscribeMsg(action === 'unsubscribe'
 ? t('newsletter.unsubscribeError')
 : 'Errore durante la riattivazione. Riprova più tardi.');
 }
 })();
 }, []);

 // Auto-subscribe to newsletter on sign-in (if not already subscribed)
 // Uses getAuthEmail() to also check providerData (Facebook may not set user.email)
 const authEmail = useMemo(() => authUser ? getAuthEmail(authUser) : null, [authUser]);
 const isPrivilegedAdmin = useMemo(() => ADMIN_EMAIL_WHITELIST.includes(authEmail?.toLowerCase() ?? ''), [authEmail]);
 useEffect(() => {
 if (activeTab === 'admin') eagerAuth();
 }, [activeTab]);

 useEffect(() => {
 if (!authEmail) return;
 if (localStorage.getItem('newsletter_subscribed') === 'true') return;
 const savedJobCtx = consumeAuthJobContext();
 upsertNewsletterSubscriber(authEmail, 'signup', authUser?.displayName || null, savedJobCtx).catch((e) => reportCaughtError(e, 'app.autoNewsletterSubscribe'));
 }, [authEmail]);

 // ── Personalization feature flag (Firebase Remote Config) ──
 useEffect(() => {
 import('@/services/firebase').then(({ getConfigValue }) =>
 getConfigValue('ENABLE_JOB_PERSONALIZATION').then((v) => setEnablePersonalization(v === 'true'))
 ).catch(() => {});
 }, []);

 // ── Personalization: Firestore sync on auth ──
 useEffect(() => {
 if (!enablePersonalization || !authEmail) return;
 let cleanup: (() => void) | undefined;
 import('@/services/behaviorTracker').then(({ hydrateFromFirestore, syncToFirestore, startSyncInterval }) => {
 hydrateFromFirestore(authEmail).then(() => syncToFirestore(authEmail)).catch(() => {});
 cleanup = startSyncInterval(authEmail);
 }).catch(() => {});
 return () => { cleanup?.(); };
 }, [enablePersonalization, authEmail]);

 useEffect(() => {
 let cancelled = false;

 const mountAdminButton = async () => {
 if (authLoading || authUser || isPrivilegedAdmin || activeTab !== 'admin') {
 if (adminGoogleButtonRef.current) adminGoogleButtonRef.current.innerHTML = '';
 setAdminGoogleButtonReady(false);
 return;
 }

 try {
 const ready = await renderGoogleButtonWithReadiness(adminGoogleButtonRef.current, {
 theme: 'outline',
 size: 'large',
 text: 'signin_with',
 width: 280,
 locale,
 });
 if (!cancelled) setAdminGoogleButtonReady(ready);
 } catch (error) {
 if (!cancelled) {
 setAdminGoogleButtonReady(false);
 reportCaughtError(error, 'app.renderAdminGoogleButton');
 }
 }
 };

 void mountAdminButton();
 return () => {
 cancelled = true;
 };
 }, [activeTab, authLoading, authUser, isPrivilegedAdmin, locale]);

 const chatbotGoogleSignIn = async (): Promise<any | null> => {
 const user = await googleSignIn();
 const email = getAuthEmail(user);
 if (email) {
 try {
 await upsertNewsletterSubscriber(email, 'chatbot_google', user?.displayName || null);
 } catch (e) {
 // Never block chat auth flow on newsletter side-effects.
 console.warn('[Chatbot] newsletter upsert (google) failed:', e);
 reportCaughtError(e, 'app.chatbotNewsletterGoogle');
 }
 }
 return user;
 };

 const chatbotFacebookSignIn = async (): Promise<any | null> => {
 const user = await facebookSignIn();
 const email = getAuthEmail(user);
 if (email) {
 try {
 await upsertNewsletterSubscriber(email, 'chatbot_facebook', user?.displayName || null);
 } catch (e) {
 // Never block chat auth flow on newsletter side-effects.
 console.warn('[Chatbot] newsletter upsert (facebook) failed:', e);
 reportCaughtError(e, 'app.chatbotNewsletterFacebook');
 }
 }
 return user;
 };

 const chatbotContinueWithEmail = async (email: string): Promise<boolean> => {
 const ok = await upsertNewsletterSubscriber(email, 'chatbot_email', null);
 if (ok) {
 Analytics.trackNewsletter('subscribe', email.split('@')[1] || 'unknown');
 unlockAchievement('newsletter_sub');
 Analytics.trackUIInteraction('chatbot', 'auth_gate', 'newsletter_email_subscribe', 'success');
 } else {
 Analytics.trackUIInteraction('chatbot', 'auth_gate', 'newsletter_email_subscribe', 'error');
 }
 return ok;
 };

 // Google One Tap: prompt on first user interaction when not signed in.
 // Triggered by pointer/keyboard/scroll instead of a fixed timer so that:
 // 1. GSI script never loads during Lighthouse (no interaction) → no FedCM error → BP 100
 // 2. In real usage, loads 2s after first interaction → invisible to users
 useEffect(() => {
 if (authUser) {
 sessionStorage.removeItem('onetap_pending');
 cancelOneTap();
 return; // Already signed in
 }
 if (sessionStorage.getItem('onetap_prompted')) return;

 let queued = false;
 let promptTimeout: ReturnType<typeof setTimeout> | null = null;
 const trigger = () => {
 if (queued || sessionStorage.getItem('onetap_prompted')) return;
 queued = true;
 for (const e of ['pointerdown', 'keydown', 'touchstart'] as const)
 window.removeEventListener(e, trigger, { capture: true });
 // Small delay after interaction so One Tap doesn't compete with user's action
 promptTimeout = setTimeout(() => {
 if (authUser) return;
 if (authLoading) {
 sessionStorage.setItem('onetap_pending', '1');
 return;
 }
 // FRO-329: defer to idle callback to avoid blocking main thread
 const run = () => {
 sessionStorage.setItem('onetap_prompted', '1');
 sessionStorage.removeItem('onetap_pending');
 promptOneTap().catch(() => {});
 };
 if ('requestIdleCallback' in window) {
 (window as any).requestIdleCallback(run, { timeout: 5000 });
 } else {
 run();
 }
 }, 2000);
 };

 for (const e of ['pointerdown', 'keydown', 'touchstart'] as const)
 window.addEventListener(e, trigger, { capture: true, passive: true } as AddEventListenerOptions);

 return () => {
 if (promptTimeout) clearTimeout(promptTimeout);
 for (const e of ['pointerdown', 'keydown', 'touchstart'] as const)
 window.removeEventListener(e, trigger, { capture: true });
 cancelOneTap();
 };
 }, [authLoading, authUser]);

 // If the first interaction happened while auth was still loading,
 // trigger One Tap as soon as auth state is resolved.
 useEffect(() => {
 if (authLoading || authUser) return;
 if (sessionStorage.getItem('onetap_prompted')) return;
 if (sessionStorage.getItem('onetap_pending') !== '1') return;

 sessionStorage.setItem('onetap_prompted', '1');
 sessionStorage.removeItem('onetap_pending');
 promptOneTap().catch(() => {});
 }, [authLoading, authUser]);

 // Theme init, analytics init, SPA pageview tracking, deferred widgets,
 // and toggleTheme are all managed by useUIState (hooks/useUIState.ts).

 type CtaTarget =
 | { kind: 'tab'; tab: ActiveTab; subTab?: string }
 | { kind: 'glossary'; term: GlossaryTermId };

 type CtaItem = { label: string; target: CtaTarget; analyticsLabel: string };

 const getCtaItems = (): CtaItem[] => {
 const tabTarget = (tab: ActiveTab, subTab: string | undefined, label: string, analyticsLabel: string): CtaItem => (
 { label, target: { kind: 'tab', tab, subTab }, analyticsLabel }
 );
 const glossaryTarget = (term: GlossaryTermId, label: string, analyticsLabel: string): CtaItem => (
 { label, target: { kind: 'glossary', term }, analyticsLabel }
 );
 const termTitle = (term: GlossaryTermId) => t(`glossary.terms.${term}.title`);

 if (activeTab === 'calculator') {
 if (calcolatoreSubTab === 'calculator') {
 return [
 tabTarget('confronti', 'exchange', t('comparators.exchange'), 'confronti:exchange'),
 tabTarget('guida', 'permit-compare', t('strumenti.permitCompare'), 'guida:permit-compare'),
 tabTarget('fisco', 'calendar', t('guide.tabs.calendar'), 'fisco:calendar'),
 ];
 }
 if (calcolatoreSubTab === 'payslip') {
 return [
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 tabTarget('fisco', 'tax-return', t('comparators.taxReturn'), 'fisco:tax-return'),
 glossaryTarget('impostaAllaFonte', termTitle('impostaAllaFonte'), 'glossario:impostaAllaFonte'),
 ];
 }
 if (calcolatoreSubTab === 'whatif') {
 return [
 tabTarget('stats', 'salary-compare', t('strumenti.salaryCompare'), 'stats:salary-compare'),
 tabTarget('fisco', 'pension', t('nav.pension'), 'fisco:pension'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (calcolatoreSubTab === 'ral') {
 return [
 tabTarget('confronti', 'jobs', t('comparators.jobs'), 'confronti:jobs'),
 tabTarget('stats', 'salary-compare', t('strumenti.salaryCompare'), 'stats:salary-compare'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (calcolatoreSubTab === 'bonus') {
 return [
 tabTarget('fisco', 'tax-return', t('comparators.taxReturn'), 'fisco:tax-return'),
 tabTarget('guida', 'permits', t('guide.tabs.permits'), 'guida:permits'),
 glossaryTarget('franchigia', termTitle('franchigia'), 'glossario:franchigia'),
 ];
 }
 if (calcolatoreSubTab === 'parental-leave') {
 return [
 tabTarget('vita', 'schools', t('guide.tabs.schools'), 'vita:schools'),
 tabTarget('fisco', 'calendar', t('guide.tabs.calendar'), 'fisco:calendar'),
 tabTarget('confronti', 'cost-of-living', t('comparators.costOfLiving'), 'confronti:cost-of-living'),
 ];
 }
 if (calcolatoreSubTab === 'residency') {
 return [
 tabTarget('guida', 'permit-compare', t('strumenti.permitCompare'), 'guida:permit-compare'),
 tabTarget('confronti', 'health', t('comparators.health'), 'confronti:health'),
 glossaryTarget('permessoB', termTitle('permessoB'), 'glossario:permessoB'),
 ];
 }
 if (calcolatoreSubTab === 'salary-quiz') {
 return [
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 tabTarget('confronti', 'jobs', t('comparators.jobs'), 'confronti:jobs'),
 tabTarget('stats', 'overview', t('stats.tabOverview'), 'stats:overview'),
 ];
 }
 }

 if (activeTab === 'confronti') {
 if (confrontiSubTab === 'exchange') {
 return [
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 tabTarget('confronti', 'banks', t('comparators.banks'), 'confronti:banks'),
 glossaryTarget('tassoCambio', termTitle('tassoCambio'), 'glossario:tassoCambio'),
 ];
 }
 if (confrontiSubTab === 'banks') {
 return [
 tabTarget('confronti', 'exchange', t('comparators.exchange'), 'confronti:exchange'),
 tabTarget('fisco', 'pillar3', t('pension.pillar3'), 'fisco:pillar3'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (confrontiSubTab === 'health') {
 return [
 tabTarget('guida', 'permits', t('guide.tabs.permits'), 'guida:permits'),
 tabTarget('vita', 'living-ch', t('guide.tabs.livingCH'), 'vita:living-ch'),
 glossaryTarget('lamal', termTitle('lamal'), 'glossario:lamal'),
 ];
 }
 if (confrontiSubTab === 'mobile') {
 return [
 tabTarget('confronti', 'cost-of-living', t('comparators.costOfLiving'), 'confronti:cost-of-living'),
 tabTarget('confronti', 'shopping', t('comparators.shopping'), 'confronti:shopping'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (confrontiSubTab === 'shopping') {
 return [
 tabTarget('confronti', 'cost-of-living', t('comparators.costOfLiving'), 'confronti:cost-of-living'),
 tabTarget('confronti', 'exchange', t('comparators.exchange'), 'confronti:exchange'),
 tabTarget('confronti', 'mobile', t('comparators.mobile'), 'confronti:mobile'),
 ];
 }
 if (confrontiSubTab === 'cost-of-living') {
 return [
 tabTarget('confronti', 'shopping', t('comparators.shopping'), 'confronti:shopping'),
 tabTarget('confronti', 'mobile', t('comparators.mobile'), 'confronti:mobile'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (confrontiSubTab === 'jobs') {
 return [
 tabTarget('calculator', 'ral', t('comparators.ral'), 'calculator:ral'),
 tabTarget('guida', 'first-day', t('guide.tabs.firstDay'), 'guida:first-day'),
 tabTarget('stats', 'salary-compare', t('strumenti.salaryCompare'), 'stats:salary-compare'),
 ];
 }
 if (confrontiSubTab === 'renovation') {
 return [
 tabTarget('confronti', 'banks', t('comparators.banks'), 'confronti:banks'),
 tabTarget('confronti', 'cost-of-living', t('comparators.costOfLiving'), 'confronti:cost-of-living'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 }

 if (activeTab === 'fisco') {
 if (fiscoSubTab === 'tax-return') {
 return [
 tabTarget('fisco', 'calendar', t('guide.tabs.calendar'), 'fisco:calendar'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 glossaryTarget('irpef', termTitle('irpef'), 'glossario:irpef'),
 ];
 }
 if (fiscoSubTab === 'calendar') {
 return [
 tabTarget('fisco', 'tax-return', t('comparators.taxReturn'), 'fisco:tax-return'),
 tabTarget('guida', 'permits', t('guide.tabs.permits'), 'guida:permits'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (fiscoSubTab === 'holidays') {
 return [
 tabTarget('guida', 'border', t('guide.tabs.border'), 'guida:border'),
 tabTarget('vita', 'places', t('guide.tabs.places'), 'vita:places'),
 tabTarget('stats', 'overview', t('stats.tabOverview'), 'stats:overview'),
 ];
 }
 if (fiscoSubTab === 'ristorni') {
 return [
 glossaryTarget('ristorni', termTitle('ristorni'), 'glossario:ristorni'),
 tabTarget('fisco', 'tax-return', t('comparators.taxReturn'), 'fisco:tax-return'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (fiscoSubTab === 'pension') {
 return [
 tabTarget('fisco', 'pillar3', t('pension.pillar3'), 'fisco:pillar3'),
 tabTarget('calculator', 'whatif', t('simulator.whatif'), 'calculator:whatif'),
 glossaryTarget('lpp', termTitle('lpp'), 'glossario:lpp'),
 ];
 }
 if (fiscoSubTab === 'pillar3') {
 return [
 tabTarget('fisco', 'pension', t('nav.pension'), 'fisco:pension'),
 tabTarget('stats', 'overview', t('stats.tabOverview'), 'stats:overview'),
 glossaryTarget('terzoPilastro', termTitle('terzoPilastro'), 'glossario:terzoPilastro'),
 ];
 }
 if (fiscoSubTab === 'quiz') {
 return [
 tabTarget('calculator', 'salary-quiz', t('salaryQuiz.navLabel'), 'calculator:salary-quiz'),
 tabTarget('stats', 'overview', t('stats.tabOverview'), 'stats:overview'),
 glossaryTarget('franchigia', termTitle('franchigia'), 'glossario:franchigia'),
 ];
 }
 if (fiscoSubTab === 'tax-credit') {
 return [
 tabTarget('fisco', 'tax-return', t('comparators.taxReturn'), 'fisco:tax-return'),
 tabTarget('fisco', 'ristorni', t('guide.tabs.ristorni'), 'fisco:ristorni'),
 glossaryTarget('doppiaimposizione', termTitle('doppiaimposizione'), 'glossario:doppiaimposizione'),
 ];
 }
 }

 if (activeTab === 'guida') {
 if (guidaSubTab === 'first-day') {
 return [
 tabTarget('guida', 'permits', t('guide.tabs.permits'), 'guida:permits'),
 tabTarget('confronti', 'jobs', t('comparators.jobs'), 'confronti:jobs'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (guidaSubTab === 'permits') {
 return [
 tabTarget('guida', 'permit-compare', t('strumenti.permitCompare'), 'guida:permit-compare'),
 tabTarget('confronti', 'health', t('comparators.health'), 'confronti:health'),
 glossaryTarget('permessoG', termTitle('permessoG'), 'glossario:permessoG'),
 ];
 }
 if (guidaSubTab === 'border') {
 return [
 tabTarget('guida', 'border-map', t('comparators.borderMap'), 'guida:border-map'),
 tabTarget('stats', 'traffic-history', t('stats.trafficHistory'), 'stats:traffic-history'),
 tabTarget('vita', 'transport', t('comparators.transport'), 'vita:transport'),
 ];
 }
 if (guidaSubTab === 'unemployment') {
 return [
 tabTarget('confronti', 'cost-of-living', t('comparators.costOfLiving'), 'confronti:cost-of-living'),
 tabTarget('guida', 'first-day', t('guide.tabs.firstDay'), 'guida:first-day'),
 tabTarget('fisco', 'calendar', t('guide.tabs.calendar'), 'fisco:calendar'),
 ];
 }
 if (guidaSubTab === 'car-transfer') {
 return [
 tabTarget('guida', 'car-cost', t('strumenti.carCost'), 'guida:car-cost'),
 tabTarget('vita', 'transport', t('comparators.transport'), 'vita:transport'),
 tabTarget('fisco', 'calendar', t('guide.tabs.calendar'), 'fisco:calendar'),
 ];
 }
 if (guidaSubTab === 'car-cost') {
 return [
 tabTarget('vita', 'transport', t('comparators.transport'), 'vita:transport'),
 tabTarget('confronti', 'cost-of-living', t('comparators.costOfLiving'), 'confronti:cost-of-living'),
 tabTarget('guida', 'border', t('guide.tabs.border'), 'guida:border'),
 ];
 }
 if (guidaSubTab === 'permit-compare') {
 return [
 tabTarget('calculator', 'residency', t('comparators.residency'), 'calculator:residency'),
 tabTarget('confronti', 'health', t('comparators.health'), 'confronti:health'),
 glossaryTarget('permessoB', termTitle('permessoB'), 'glossario:permessoB'),
 ];
 }
 if (guidaSubTab === 'border-map') {
 return [
 tabTarget('guida', 'border', t('guide.tabs.border'), 'guida:border'),
 tabTarget('stats', 'traffic-history', t('stats.trafficHistory'), 'stats:traffic-history'),
 tabTarget('vita', 'municipalities', t('guide.tabs.municipalities'), 'vita:municipalities'),
 ];
 }
 }

 if (activeTab === 'vita') {
 if (vitaSubTab === 'living-ch') {
 return [
 tabTarget('guida', 'permits', t('guide.tabs.permits'), 'guida:permits'),
 tabTarget('confronti', 'health', t('comparators.health'), 'confronti:health'),
 tabTarget('fisco', 'tax-return', t('comparators.taxReturn'), 'fisco:tax-return'),
 ];
 }
 if (vitaSubTab === 'living-it') {
 return [
 tabTarget('confronti', 'cost-of-living', t('comparators.costOfLiving'), 'confronti:cost-of-living'),
 tabTarget('confronti', 'exchange', t('comparators.exchange'), 'confronti:exchange'),
 tabTarget('stats', 'livability', t('strumenti.livability'), 'stats:livability'),
 ];
 }
 if (vitaSubTab === 'companies') {
 return [
 tabTarget('confronti', 'jobs', t('comparators.jobs'), 'confronti:jobs'),
 tabTarget('guida', 'first-day', t('guide.tabs.firstDay'), 'guida:first-day'),
 tabTarget('vita', 'living-ch', t('guide.tabs.livingCH'), 'vita:living-ch'),
 ];
 }
 if (vitaSubTab === 'schools') {
 return [
 tabTarget('vita', 'nursery', t('comparators.nursery'), 'vita:nursery'),
 tabTarget('vita', 'places', t('guide.tabs.places'), 'vita:places'),
 tabTarget('guida', 'permits', t('guide.tabs.permits'), 'guida:permits'),
 ];
 }
 if (vitaSubTab === 'nursery') {
 return [
 tabTarget('vita', 'schools', t('guide.tabs.schools'), 'vita:schools'),
 tabTarget('vita', 'living-ch', t('guide.tabs.livingCH'), 'vita:living-ch'),
 tabTarget('confronti', 'cost-of-living', t('comparators.costOfLiving'), 'confronti:cost-of-living'),
 ];
 }
 if (vitaSubTab === 'places') {
 return [
 tabTarget('vita', 'transport', t('comparators.transport'), 'vita:transport'),
 tabTarget('guida', 'border', t('guide.tabs.border'), 'guida:border'),
 tabTarget('stats', 'livability', t('strumenti.livability'), 'stats:livability'),
 ];
 }
 if (vitaSubTab === 'transport') {
 return [
 tabTarget('guida', 'border', t('guide.tabs.border'), 'guida:border'),
 tabTarget('guida', 'car-cost', t('strumenti.carCost'), 'guida:car-cost'),
 tabTarget('stats', 'traffic-history', t('stats.trafficHistory'), 'stats:traffic-history'),
 ];
 }
 if (vitaSubTab === 'municipalities') {
 return [
 tabTarget('guida', 'border-map', t('comparators.borderMap'), 'guida:border-map'),
 tabTarget('vita', 'transport', t('comparators.transport'), 'vita:transport'),
 tabTarget('stats', 'livability', t('strumenti.livability'), 'stats:livability'),
 ];
 }
 }

 if (activeTab === 'stats') {
 if (statsSubTab === 'overview') {
 return [
 tabTarget('stats', 'jobs-observatory', t('stats.tabJobsObservatory'), 'stats:jobs-observatory'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 tabTarget('stats', 'salary-compare', t('strumenti.salaryCompare'), 'stats:salary-compare'),
 tabTarget('guida', 'border', t('guide.tabs.border'), 'guida:border'),
 ];
 }
 if (statsSubTab === 'livability') {
 return [
 tabTarget('stats', 'jobs-observatory', t('stats.tabJobsObservatory'), 'stats:jobs-observatory'),
 tabTarget('vita', 'places', t('guide.tabs.places'), 'vita:places'),
 tabTarget('vita', 'living-it', t('guide.tabs.livingIT'), 'vita:living-it'),
 tabTarget('stats', 'overview', t('stats.tabOverview'), 'stats:overview'),
 ];
 }
 if (statsSubTab === 'jobs-observatory') {
 return [
 tabTarget('stats', 'salary-compare', t('strumenti.salaryCompare'), 'stats:salary-compare'),
 tabTarget('job-board', undefined, t('jobBoard.title', getCantonI18nParams()), 'jobboard'),
 tabTarget('stats', 'overview', t('stats.tabOverview'), 'stats:overview'),
 ];
 }
 if (statsSubTab === 'salary-compare') {
 return [
 tabTarget('stats', 'jobs-observatory', t('stats.tabJobsObservatory'), 'stats:jobs-observatory'),
 tabTarget('calculator', 'ral', t('comparators.ral'), 'calculator:ral'),
 tabTarget('confronti', 'jobs', t('comparators.jobs'), 'confronti:jobs'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (statsSubTab === 'traffic-history') {
 return [
 tabTarget('stats', 'jobs-observatory', t('stats.tabJobsObservatory'), 'stats:jobs-observatory'),
 tabTarget('guida', 'border', t('guide.tabs.border'), 'guida:border'),
 tabTarget('guida', 'border-map', t('comparators.borderMap'), 'guida:border-map'),
 tabTarget('vita', 'transport', t('comparators.transport'), 'vita:transport'),
 ];
 }
 if (statsSubTab === 'unemployment') {
 return [
 tabTarget('stats', 'jobs-observatory', t('stats.tabJobsObservatory'), 'stats:jobs-observatory'),
 tabTarget('stats', 'overview', t('stats.tabOverview'), 'stats:overview'),
 tabTarget('confronti', 'jobs', t('comparators.jobs'), 'confronti:jobs'),
 tabTarget('stats', 'salary-compare', t('strumenti.salaryCompare'), 'stats:salary-compare'),
 ];
 }
 if (statsSubTab === 'mortgage') {
 return [
 tabTarget('stats', 'jobs-observatory', t('stats.tabJobsObservatory'), 'stats:jobs-observatory'),
 tabTarget('confronti', 'banks', t('comparators.banks'), 'confronti:banks'),
 tabTarget('confronti', 'exchange', t('comparators.exchange'), 'confronti:exchange'),
 tabTarget('fisco', 'tax-return', t('comparators.taxReturn'), 'fisco:tax-return'),
 ];
 }
 }

 if (activeTab === 'glossario') {
 if (glossaryTerm === 'lamal' || glossaryTerm === 'cmu') {
 return [
 tabTarget('confronti', 'health', t('comparators.health'), 'confronti:health'),
 tabTarget('guida', 'permits', t('guide.tabs.permits'), 'guida:permits'),
 tabTarget('vita', 'living-ch', t('guide.tabs.livingCH'), 'vita:living-ch'),
 ];
 }
 if (glossaryTerm === 'tassoCambio') {
 return [
 tabTarget('confronti', 'exchange', t('comparators.exchange'), 'confronti:exchange'),
 tabTarget('confronti', 'banks', t('comparators.banks'), 'confronti:banks'),
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 ];
 }
 if (glossaryTerm === 'impostaAllaFonte' || glossaryTerm === 'irpef' || glossaryTerm === 'franchigia' || glossaryTerm === 'ristorni') {
 return [
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 tabTarget('fisco', 'tax-return', t('comparators.taxReturn'), 'fisco:tax-return'),
 tabTarget('fisco', 'calendar', t('guide.tabs.calendar'), 'fisco:calendar'),
 ];
 }
 if (glossaryTerm === 'avs' || glossaryTerm === 'lpp' || glossaryTerm === 'terzoPilastro') {
 return [
 tabTarget('fisco', 'pension', t('nav.pension'), 'fisco:pension'),
 tabTarget('fisco', 'pillar3', t('pension.pillar3'), 'fisco:pillar3'),
 tabTarget('stats', 'overview', t('stats.tabOverview'), 'stats:overview'),
 ];
 }
 if (glossaryTerm === 'permessoG' || glossaryTerm === 'permessoB') {
 return [
 tabTarget('guida', 'permit-compare', t('strumenti.permitCompare'), 'guida:permit-compare'),
 tabTarget('calculator', 'residency', t('comparators.residency'), 'calculator:residency'),
 tabTarget('confronti', 'health', t('comparators.health'), 'confronti:health'),
 ];
 }
 return [
 tabTarget('calculator', 'calculator', t('nav.calculator'), 'calculator:calculator'),
 tabTarget('confronti', 'exchange', t('comparators.exchange'), 'confronti:exchange'),
 tabTarget('fisco', 'tax-return', t('comparators.taxReturn'), 'fisco:tax-return'),
 ];
 }

 return [];
 };

 const ctaItemsBase = useMemo(() => getCtaItems(), [activeTab, calcolatoreSubTab, confrontiSubTab, fiscoSubTab, guidaSubTab, vitaSubTab, statsSubTab, glossaryTerm, t]);

 const buildCtaItems = (baseItems: CtaItem[]): CtaItem[] => {
 const extras: CtaItem[] = [];

 // Add a few additional contextual suggestions so the UI can rotate while still showing only 3.
 if (activeTab === 'calculator') {
 extras.push(
 { label: t('comparators.ral'), target: { kind: 'tab', tab: 'calculator', subTab: 'ral' }, analyticsLabel: 'calculator:ral' },
 { label: t('strumenti.payslip'), target: { kind: 'tab', tab: 'calculator', subTab: 'payslip' }, analyticsLabel: 'calculator:payslip' },
 { label: t('simulator.whatif'), target: { kind: 'tab', tab: 'calculator', subTab: 'whatif' }, analyticsLabel: 'calculator:whatif' },
 );
 } else if (activeTab === 'confronti') {
 extras.push(
 { label: t('comparators.jobs'), target: { kind: 'tab', tab: 'confronti', subTab: 'jobs' }, analyticsLabel: 'confronti:jobs' },
 { label: t('comparators.health'), target: { kind: 'tab', tab: 'confronti', subTab: 'health' }, analyticsLabel: 'confronti:health' },
 { label: t('comparators.shopping'), target: { kind: 'tab', tab: 'confronti', subTab: 'shopping' }, analyticsLabel: 'confronti:shopping' },
 );
 } else if (activeTab === 'fisco') {
 extras.push(
 { label: t('withholdingRates.navLabel'), target: { kind: 'tab', tab: 'fisco', subTab: 'withholding-rates' }, analyticsLabel: 'fisco:withholding-rates' },
 { label: t('guide.tabs.calendar'), target: { kind: 'tab', tab: 'fisco', subTab: 'calendar' }, analyticsLabel: 'fisco:calendar' },
 { label: t('nav.pension'), target: { kind: 'tab', tab: 'fisco', subTab: 'pension' }, analyticsLabel: 'fisco:pension' },
 { label: t('comparators.taxReturn'), target: { kind: 'tab', tab: 'fisco', subTab: 'tax-return' }, analyticsLabel: 'fisco:tax-return' },
 );
 } else if (activeTab === 'guida') {
 extras.push(
 { label: t('guide.tabs.permits'), target: { kind: 'tab', tab: 'guida', subTab: 'permits' }, analyticsLabel: 'guida:permits' },
 { label: t('guide.tabs.firstDay'), target: { kind: 'tab', tab: 'guida', subTab: 'first-day' }, analyticsLabel: 'guida:first-day' },
 { label: t('comparators.borderMap'), target: { kind: 'tab', tab: 'guida', subTab: 'border-map' }, analyticsLabel: 'guida:border-map' },
 );
 } else if (activeTab === 'vita') {
 extras.push(
 { label: t('guide.tabs.livingCH'), target: { kind: 'tab', tab: 'vita', subTab: 'living-ch' }, analyticsLabel: 'vita:living-ch' },
 { label: t('guide.tabs.livingIT'), target: { kind: 'tab', tab: 'vita', subTab: 'living-it' }, analyticsLabel: 'vita:living-it' },
 { label: t('comparators.transport'), target: { kind: 'tab', tab: 'vita', subTab: 'transport' }, analyticsLabel: 'vita:transport' },
 );
 } else if (activeTab === 'stats') {
 extras.push(
 { label: t('stats.tabOverview'), target: { kind: 'tab', tab: 'stats', subTab: 'overview' }, analyticsLabel: 'stats:overview' },
 { label: t('stats.trafficHistory'), target: { kind: 'tab', tab: 'stats', subTab: 'traffic-history' }, analyticsLabel: 'stats:traffic-history' },
 { label: t('strumenti.livability'), target: { kind: 'tab', tab: 'stats', subTab: 'livability' }, analyticsLabel: 'stats:livability' },
 );
 }

 const all = [...baseItems, ...extras];
 const seen = new Set<string>();
 return all.filter((item) => {
 if (seen.has(item.analyticsLabel)) return false;
 seen.add(item.analyticsLabel);
 return true;
 });
 };

 const ctaItems = useMemo(() => buildCtaItems(ctaItemsBase), [ctaItemsBase, activeTab, t]);

 // Rotate the 3 CTA items when more are available (no animation; long interval to avoid test noise).
 const [ctaRotationIndex, setCtaRotationIndex] = useState(0);
 const ctaRotationKey = useMemo(() => ctaItems.map(i => i.analyticsLabel).join('|'), [ctaItems]);

 // Memoize footer date string — avoids new Date() + toLocaleDateString() on every render (Vercel rule 5.1)
 const footerDateStr = useMemo(() => {
 const now = new Date();
 const dateTimeAttr = now.toISOString().slice(0, 7);
 const localeTag = locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : locale === 'en' ? 'en-GB' : 'it-IT';
 const display = now.toLocaleDateString(localeTag, { month: 'long', year: 'numeric' });
 return { dateTimeAttr, display };
 }, [locale]);

 useEffect(() => {
 setCtaRotationIndex(0);
 }, [ctaRotationKey]);

 const visibleCtaItems = useMemo((): CtaItem[] => {
 if (ctaItems.length <= 3) return ctaItems;
 return [0, 1, 2].map((offset) => ctaItems[(ctaRotationIndex + offset) % ctaItems.length]);
 }, [ctaItems, ctaRotationIndex]);

 useEffect(() => {
 if (ctaItems.length <= 3) return;
 // Avoid timers/state updates during tests (pre-push hook runs vitest).
 if (typeof import.meta !== 'undefined' && (import.meta as any).env?.MODE === 'test') return;
 const prefersReducedMotion = typeof window !== 'undefined'
 && typeof window.matchMedia === 'function'
 && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 if (prefersReducedMotion) return;

 const interval = window.setInterval(() => {
 setCtaRotationIndex((idx) => (idx + 1) % ctaItems.length);
 }, 15000);

 return () => window.clearInterval(interval);
 }, [ctaItems.length, ctaRotationKey]);

 const handleCtaClick = useCallback((item: CtaItem) => {
 Analytics.trackUIInteraction('cta', 'internal-link', 'click', 'navigate', item.analyticsLabel);

 if (item.target.kind === 'tab') {
 handleSearchNavigate(item.target.tab, item.target.subTab);
 return;
 }

 // Glossary deep link
 suppressNextRouteSyncForTabRef.current = 'glossario';
 setActiveTab('glossario');
 setSeoLanding(null);
 setBlogArticle(null);
 setGlossaryTerm(item.target.term);

 const route: AppRoute = { activeTab: 'glossario', glossaryTerm: item.target.term };
 pushRoute(route);
 const seoKey = getSeoSection(route);
 updateMetaTags(seoKey);
 trackSectionView(seoKey);
 window.scrollTo({ top: 0, behavior: 'instant' });
 }, [handleSearchNavigate]);

 // --- 5-click logo easter egg: cache reset ---
 const logoClickCountRef = useRef(0);
 const logoClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
 const [showWhatsNew, setShowWhatsNew] = useState(false);
 const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

 // Close mobile menu on Escape key or route change
 useEffect(() => {
 if (!mobileMenuOpen) return;
 const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileMenuOpen(false); };
 window.addEventListener('keydown', close);
 return () => window.removeEventListener('keydown', close);
 }, [mobileMenuOpen]);

 const handleLogoClick = useCallback(() => {
 logoClickCountRef.current += 1;
 if (logoClickTimerRef.current) clearTimeout(logoClickTimerRef.current);

 if (logoClickCountRef.current >= 5) {
 logoClickCountRef.current = 0;
 // Trigger cache reset directly
 (async () => {
 try { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); } catch {}
 localStorage.clear();
 sessionStorage.clear();
 document.cookie.split(';').forEach(c => {
 document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=' + new Date(0).toUTCString() + ';path=/');
 });
 window.location.replace('/?_t=' + Date.now());
 })();
 } else {
 // Reset counter after 2s of inactivity
 logoClickTimerRef.current = setTimeout(() => {
 logoClickCountRef.current = 0;
 }, 2000);
 }
 }, []);

 // Navigation context value — shared with child components via useNavigation()
 // navigateTo() is the canonical one-call navigation: sets tab + sub-tab + pushes URL.
 const navigateTo = useCallback((tab: ActiveTab, subTab?: string) => {
 setActiveTab(tab);
 if (tab === 'calculator' && subTab) setCalcolatoreSubTab(subTab as CalcolatoreSubTab);
 else if (tab === 'confronti' && subTab) setConfrontiSubTab(subTab as ConfrontiSubTab);
 else if (tab === 'fisco' && subTab) setFiscoSubTab(subTab as FiscoSubTab);
 else if (tab === 'guida' && subTab) setGuidaSubTab(subTab as GuidaSubTab);
 else if (tab === 'vita' && subTab) setVitaSubTab(subTab as VitaSubTab);
 else if (tab === 'stats' && subTab) setStatsSubTab(subTab as StatsSubTab);
 else if (tab === 'blog' && subTab) setBlogArticle(subTab as BlogArticleId);
 else if (tab === 'job-board' && subTab) setJobSlug(subTab);
 else if (tab === 'autore' && subTab) setAuthor(subTab);
 const route: AppRoute = { activeTab: tab };
 if (tab === 'calculator') route.calcolatoreSubTab = (subTab || calcolatoreSubTab) as CalcolatoreSubTab;
 if (tab === 'confronti') route.confrontiSubTab = (subTab || confrontiSubTab) as ConfrontiSubTab;
 if (tab === 'fisco') route.fiscoSubTab = (subTab || fiscoSubTab) as FiscoSubTab;
 if (tab === 'guida') route.guidaSubTab = (subTab || guidaSubTab) as GuidaSubTab;
 if (tab === 'vita') route.vitaSubTab = (subTab || vitaSubTab) as VitaSubTab;
 if (tab === 'stats') route.statsSubTab = (subTab || statsSubTab) as StatsSubTab;
 if (tab === 'blog' && subTab) route.blogArticle = subTab as BlogArticleId;
 if (tab === 'job-board' && subTab) route.jobSlug = subTab;
 if (tab === 'autore') {
 const slug = subTab || author || undefined;
 if (slug) route.author = slug;
 }
 pushRoute(route);
 // Scroll to top on programmatic navigation, except when returning to the job-board
 // list (JobBoard manages its own scroll restoration in that case).
 if (!(tab === 'job-board' && !subTab)) {
 window.scrollTo({ top: 0, behavior: 'instant' });
 }
 }, [calcolatoreSubTab, confrontiSubTab, fiscoSubTab, guidaSubTab, vitaSubTab, statsSubTab, author]);

 const navContextValue = useMemo<NavigationContextType>(() => ({
 activeTab, calcolatoreSubTab, confrontiSubTab, fiscoSubTab,
 guidaSubTab, vitaSubTab, statsSubTab, isDarkMode, isFocusMode,
 setActiveTab: setActiveTab as any, setCalcolatoreSubTab: setCalcolatoreSubTab as any,
 setConfrontiSubTab: setConfrontiSubTab as any, setFiscoSubTab: setFiscoSubTab as any,
 setGuidaSubTab: setGuidaSubTab as any, setVitaSubTab: setVitaSubTab as any,
 setStatsSubTab: setStatsSubTab as any, toggleTheme, setIsFocusMode,
 navigateTo,
 }), [activeTab, calcolatoreSubTab, confrontiSubTab, fiscoSubTab, guidaSubTab, vitaSubTab, statsSubTab, isDarkMode, isFocusMode, toggleTheme, navigateTo]);

 // FRO-310: Critical IT translations are loaded synchronously (it-critical.ts, ~4KB).
 // isTranslationsReady() returns true immediately — no skeleton gate needed.
 // Full translations (it-core + it-calculator) still load lazily in background.

 // FRO-367: TabContentContext passes app-level state to lazy tab components.
 const tabContentValue = useMemo<TabContentState>(() => ({
 inputs, setInputs, result: deferredResult, isResultStale, handleCalculate,
 showDeferredHomeWidgets, seoLanding, setSeoLanding,
 userProfile, authUser, authLoading, isPrivilegedAdmin,
 googleSignIn, facebookSignIn,
 adminGoogleButtonRef, adminGoogleButtonReady,
 taxReturnCountry, setTaxReturnCountry,
 borderCrossing, setBorderCrossing,
 blogArticle, setBlogArticle,
 jobSlug, setJobSlug,
 setActiveTab: setActiveTab as any, navigateTo,
 setContactPrefill, glossaryTerm, setGlossaryTerm,
 }), [inputs, deferredResult, isResultStale, handleCalculate, showDeferredHomeWidgets, seoLanding, userProfile, authUser, authLoading, isPrivilegedAdmin, googleSignIn, facebookSignIn, adminGoogleButtonReady, taxReturnCountry, borderCrossing, blogArticle, jobSlug, navigateTo, glossaryTerm]);

 return (
 <ErrorBoundary>
 <TabContentContext.Provider value={tabContentValue}>
 <NavigationContext.Provider value={navContextValue}>
 {/* AUTO ADS POLICY (CLS fix — FRO-CLS).
  * Google AdSense Auto Ads is enabled at the account level. In-page auto ads
  * inject content into the DOM AFTER first paint, which causes severe CLS
  * (measured mobile p75 0.51, target <0.1). We opt the ENTIRE app out of
  * in-page auto ads by setting `data-no-auto-ads="inside"` on the root
  * layout container. This still allows:
  *   - Anchor / overlay auto ads (position:fixed, no CLS — `data-overlays=bottom`
  *     is set on the AdSense script in AdSenseBanner.tsx).
  *   - Manual AdSenseBanner slots (explicit `<ins class="adsbygoogle">` with
  *     reserved placeholder height in components/shared/AdSenseBanner.tsx —
  *     these are honored regardless of the no-auto-ads directive).
  * Revenue impact: loses in-page auto-ads (~€10/day RPM per adsenseSlots.ts
  * header comment). Anchor auto ads (~€16/day) remain. Manual slots remain.
  * SEO impact: removes the biggest CLS contributor, unblocking ranking
  * improvements on job/blog pages. */}
 <div data-no-auto-ads="inside" className={`${staticOverlay ? '' : 'min-h-screen'} relative flex flex-col font-sans text-strong transition-colors duration-300 overflow-hidden`}>
 <div className="absolute inset-0 bg-surface-alt -z-20" style={{ contain: 'strict' }}></div>

 {/* LinkedIn OAuth2 callback processing overlay */}
 {linkedInCallbackProcessing && (
 <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-surface">
 <div className="flex flex-col items-center gap-4 text-center px-6">
 <div className="w-12 h-12 rounded-xl bg-[#0A66C2] flex items-center justify-center">
 <svg className="w-7 h-7 text-on-accent" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 </div>
 <Loader2 className="w-6 h-6 animate-spin text-[#0A66C2]" />
 <p className="text-body text-sm font-medium">
 {linkedInCallbackError
 ? linkedInCallbackError
 : 'Accesso con LinkedIn in corso…'}
 </p>
 {linkedInCallbackError && (
 <a href="/" className="mt-2 text-sm text-accent underline">
 Torna alla home
 </a>
 )}
 </div>
 </div>
 )}

 {/* Newsletter confirmation welcome overlay */}
 {showNewsletterWelcome && (
 <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
 <div className="bg-surface rounded-2xl shadow-2xl p-8 max-w-lg mx-4 text-center border border-edge">
 <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success-subtle mb-4">
 <svg className="w-8 h-8 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
 </div>
 <h2 className="text-2xl font-bold text-heading mb-2">{t('newsletter.welcome.title')}</h2>
 <p className="text-subtle mb-6">{t('newsletter.welcome.description')}</p>
 <div className="space-y-3 text-left mb-6">
 <div className="flex items-start gap-3 p-3 rounded-lg bg-accent-subtle">
 <span className="text-accent mt-0.5">💱</span>
 <div>
 <p className="text-sm font-medium text-strong">{t('newsletter.exchangeRate')}</p>
 <p className="text-xs text-subtle">{t('newsletter.weeklyRate')}</p>
 </div>
 </div>
 <div className="flex items-start gap-3 p-3 rounded-lg bg-warning-subtle">
 <span className="text-warning mt-0.5">🚗</span>
 <div>
 <p className="text-sm font-medium text-strong">{t('newsletter.borderTraffic')}</p>
 <p className="text-xs text-subtle">{t('newsletter.timesAndTips')}</p>
 </div>
 </div>
 <div className="flex items-start gap-3 p-3 rounded-lg bg-success-subtle">
 <span className="text-success mt-0.5">📋</span>
 <div>
 <p className="text-sm font-medium text-strong">{t('newsletter.taxNews')}</p>
 <p className="text-xs text-subtle">{t('newsletter.deadlinesAndChanges')}</p>
 </div>
 </div>
 </div>
 <button
 onClick={() => setShowNewsletterWelcome(false)}
 className="w-full px-6 py-3 bg-accent hover:bg-accent-hover text-on-accent font-medium rounded-xl transition-colors"
 >
 {t('newsletter.welcome.cta')}
 </button>
 </div>
 </div>
 )}

 {/* Newsletter unsubscribe confirmation */}
 {unsubscribeMsg && (
 <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-surface border border-edge rounded-xl shadow-xl px-6 py-4 max-w-md text-center animate-fade-in">
 <p className="text-sm text-body">{unsubscribeMsg}</p>
 {newsletterActionType === 'unsubscribe' && newsletterActionEmail && (
 <a
 href={`/?action=resubscribe&email=${encodeURIComponent(newsletterActionEmail)}`}
 className="inline-block mt-2 text-xs text-accent hover:underline"
 >
 Re-iscriviti alla newsletter
 </a>
 )}
 <button onClick={() => setUnsubscribeMsg(null)} className="mt-2 min-h-[44px] inline-flex items-center text-xs text-accent hover:underline">{t('common.close')}</button>
 </div>
 )}

 {/* Navbar */}
 <nav aria-label="Navigazione principale" className="sticky top-0 z-50 bg-surface/95 border-b border-edge/50 shadow-sm transition-colors duration-300">
 <div className="max-w-[2400px] w-[95%] mx-auto px-4 sm:px-6">
 <div className="flex justify-between h-14 md:h-20 items-center">
 {/* Logo Section */}
 <a href={buildPath({ activeTab: 'calculator' })} onClick={(e) => { e.preventDefault(); handleLogoClick(); handleTabChange('calculator'); }} className="flex items-center gap-3 cursor-pointer no-underline" aria-label="Frontaliere Ticino — Analisi Fiscale 2026">
 <div className="relative group">
 <div className="absolute -inset-1 bg-gradient-to-r from-accent-strong to-accent-strong rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-200"></div>
 <div className="relative bg-surface p-2 rounded-xl text-accent ring-1 ring-edge">
 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" className="w-[22px] h-[22px] transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 transition-transform">
 <rect x="10" y="10" width="80" height="80" rx="16" fill="#1e293b" />
 <rect x="22" y="22" width="56" height="20" rx="4" fill="#94a3b8" />
 {/* CH Button */}
 <rect x="22" y="52" width="24" height="24" rx="6" fill="#dc2626" />
 <path d="M34 58v12M28 64h12" stroke="white" strokeWidth="3" strokeLinecap="round" />
 {/* IT Button */}
 <mask id="m-logo">
 <rect x="54" y="52" width="24" height="24" rx="6" fill="white" />
 </mask>
 <g mask="url(#m-logo)">
 <rect x="54" y="52" width="8" height="24" fill="#16a34a" />
 <rect x="62" y="52" width="8" height="24" fill="white" />
 <rect x="70" y="52" width="8" height="24" fill="#dc2626" />
 </g>
 </svg>
 </div>
 </div>
 <div>
 <span className="text-base sm:text-lg font-bold text-strong leading-none tracking-tight whitespace-nowrap">
 {t('app.title')}
 </span>
 <p className="hidden sm:block text-xs text-muted font-bold uppercase tracking-widest mt-0.5">{t('nav.subtitle')}</p>
 </div>
 </a>
 
 {/* Navigation Links — hidden on mobile, shown on md+ */}
 <div role="tablist" aria-label="Navigazione principale" className="hidden md:flex items-center gap-1 mx-2 lg:mx-4 whitespace-nowrap flex-1 min-w-0 justify-between overflow-hidden">
 <a
 href={buildPath({ activeTab: 'calculator' })}
 role="tab" aria-selected={activeTab === 'calculator'}
 onClick={(e) => { e.preventDefault(); handleTabChange('calculator'); }}
 onMouseEnter={() => prefetchTab('calculator')}
 aria-label={t('nav.simulator')}
 className={`relative flex-1 min-w-0 px-1.5 lg:px-2 py-3 min-h-[44px] text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 group no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${activeTab === 'calculator' ? 'text-accent' : 'text-tab-inactive-text hover:text-strong'}`}
 >
 <Calculator size={16} aria-hidden="true" />
 <span className="hidden xl:inline whitespace-nowrap">{t('nav.simulator')}</span>
 {activeTab === 'calculator' && (
 <span className="absolute bottom-0 left-0 w-full h-0.5 bg-accent rounded-full animate-fade-in" />
 )}
 </a>

 <a
 href={buildPath({ activeTab: 'confronti' })}
 role="tab" aria-selected={activeTab === 'confronti'}
 onClick={(e) => { e.preventDefault(); handleTabChange('confronti'); }}
 onMouseEnter={() => prefetchTab('confronti')}
 aria-label={t('nav.confronti')}
 className={`relative flex-1 min-w-0 px-1.5 lg:px-2 py-3 min-h-[44px] text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 group no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${activeTab === 'confronti' ? 'text-accent' : 'text-tab-inactive-text hover:text-strong'}`}
 >
 <Layers size={16} aria-hidden="true" />
 <span className="hidden xl:inline whitespace-nowrap">{t('nav.confronti')}</span>
 {activeTab === 'confronti' && (
 <span className="absolute bottom-0 left-0 w-full h-0.5 bg-accent rounded-full animate-fade-in" />
 )}
 </a>

 <a
 href={buildPath({ activeTab: 'fisco' })}
 role="tab" aria-selected={activeTab === 'fisco'}
 onClick={(e) => { e.preventDefault(); handleTabChange('fisco'); }}
 onMouseEnter={() => prefetchTab('fisco')}
 aria-label={t('nav.fisco')}
 className={`relative flex-1 min-w-0 px-1.5 lg:px-2 py-3 min-h-[44px] text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 group no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${activeTab === 'fisco' ? 'text-accent' : 'text-tab-inactive-text hover:text-strong'}`}
 >
 <PiggyBank size={16} aria-hidden="true" />
 <span className="hidden xl:inline whitespace-nowrap">{t('nav.fisco')}</span>
 {activeTab === 'fisco' && (
 <span className="absolute bottom-0 left-0 w-full h-0.5 bg-accent rounded-full animate-fade-in" />
 )}
 </a>

 <a
 href={buildPath({ activeTab: 'guida' })}
 role="tab" aria-selected={activeTab === 'guida'}
 onClick={(e) => { e.preventDefault(); handleTabChange('guida'); }}
 onMouseEnter={() => prefetchTab('guida')}
 aria-label={t('nav.guida')}
 className={`relative flex-1 min-w-0 px-1.5 lg:px-2 py-3 min-h-[44px] text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 group no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${activeTab === 'guida' ? 'text-accent' : 'text-tab-inactive-text hover:text-strong'}`}
 >
 <BookOpen size={16} aria-hidden="true" />
 <span className="hidden xl:inline whitespace-nowrap">{t('nav.guida')}</span>
 {activeTab === 'guida' && (
 <span className="absolute bottom-0 left-0 w-full h-0.5 bg-accent rounded-full animate-fade-in" />
 )}
 </a>

 <a
 href={buildPath({ activeTab: 'vita' })}
 role="tab" aria-selected={activeTab === 'vita'}
 onClick={(e) => { e.preventDefault(); handleTabChange('vita'); }}
 onMouseEnter={() => prefetchTab('vita')}
 aria-label={t('nav.vita')}
 className={`relative flex-1 min-w-0 px-1.5 lg:px-2 py-3 min-h-[44px] text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 group no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${activeTab === 'vita' ? 'text-accent' : 'text-tab-inactive-text hover:text-strong'}`}
 >
 <Home size={16} aria-hidden="true" />
 <span className="hidden xl:inline whitespace-nowrap">{t('nav.vita')}</span>
 {activeTab === 'vita' && (
 <span className="absolute bottom-0 left-0 w-full h-0.5 bg-accent rounded-full animate-fade-in" />
 )}
 </a>

 <a
 href={buildPath({ activeTab: 'stats' })}
 role="tab" aria-selected={activeTab === 'stats'}
 onClick={(e) => { e.preventDefault(); handleTabChange('stats'); }}
 onMouseEnter={() => prefetchTab('stats')}
 aria-label={t('nav.stats')}
 className={`relative flex-1 min-w-0 px-1.5 lg:px-2 py-3 min-h-[44px] text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 group no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${activeTab === 'stats' ? 'text-accent' : 'text-tab-inactive-text hover:text-strong'}`}
 >
 <BarChart2 size={16} aria-hidden="true" />
 <span className="hidden xl:inline whitespace-nowrap">{t('nav.stats')}</span>
 {activeTab === 'stats' && (
 <span className="absolute bottom-0 left-0 w-full h-0.5 bg-accent rounded-full animate-fade-in" />
 )}
 </a>
 </div>

 {/* Actions — slim on mobile (search + locale + hamburger), full on md+ */}
 {/* SilentErrorBoundary: contains React #31 / render errors in this nav-actions
  *  cluster (lazy-loaded LanguageSelector, WhatsNewBell, SiteSearch, profile
  *  menu) so a transient render failure in any header widget does not blank
  *  the whole homepage. The error is still reported to Analytics with a
  *  `nav-actions` boundary tag so we keep visibility on root causes. */}
 <SilentErrorBoundary boundary="nav-actions" fallback={<div className="w-9 h-9" aria-hidden="true" />}>
 <div className="flex items-center gap-0.5 sm:gap-1.5 pl-2 sm:pl-4 border-l border-edge shrink-0 min-w-fit">
 {/* Search — always visible */}
 {showDeferredHomeWidgets ? (
 <Suspense fallback={<div className="w-9 h-9" />}><SiteSearch onNavigate={handleSearchNavigate} /></Suspense>
 ) : (
 <div className="w-9 h-9" aria-hidden="true" />
 )}

 {/* Gamification — headless (toasts + streak tracking via portal) */}
 {showDeferredHomeWidgets && (
 <div className="hidden">
 <Suspense fallback={null}><GamificationWidget /></Suspense>
 </div>
 )}

 {/* Language selector — always visible */}
 <Suspense fallback={null}><LanguageSelector /></Suspense>

 {/* WhatsNew bell — desktop only */}
 <div className="hidden md:block">
 <Suspense fallback={null}><WhatsNewBellLazy onClick={() => setShowWhatsNew(true)} /></Suspense>
 </div>

 {/* Dark mode toggle — desktop only */}
 <button
 onClick={toggleTheme}
 className="hidden md:flex p-2 rounded-xl text-muted hover:bg-surface-raised transition-colors shrink-0 min-w-[44px] min-h-[44px] items-center justify-center"
 aria-label={isDarkMode ? t('app.lightMode') : t('app.darkMode')}
 >
 {isDarkMode ? <Sun size={18} className="text-warning" /> : <Moon size={18} className="text-subtle" />}
 </button>

 {/* Profile / Login — desktop only */}
 <div className="hidden md:block">
 {authUser ? (
 <button
 onClick={() => handleTabChange('profile')}
 className={`p-1 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl transition-[color,background-color,border-color,box-shadow] shrink-0 ${activeTab === 'profile' ? 'ring-2 ring-accent' : 'hover:ring-2 hover:ring-edge'}`}
 aria-label={t('profile.title')}
 title={getUserDisplayName(authUser)}
 >
 {getUserPhotoURL(authUser, authUser?.uid) ? (
 <img
 src={getUserPhotoURL(authUser, authUser?.uid)!}
 alt={getUserDisplayName(authUser)}
 width={30}
 height={30}
 className="w-[30px] h-[30px] rounded-lg object-cover"
 referrerPolicy="no-referrer"
 />
 ) : (
 <div className="w-[30px] h-[30px] rounded-lg bg-accent-subtle flex items-center justify-center">
 <UserIcon size={16} className="text-accent" />
 </div>
 )}
 </button>
 ) : authLoading ? (
 <div className="w-[30px] h-[30px] rounded-lg bg-surface-raised animate-pulse shrink-0" aria-hidden="true" />
 ) : (
 <button
 onClick={() => handleTabChange('profile')}
 className="p-2 rounded-xl text-muted hover:bg-surface-raised transition-colors shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center"
 aria-label={t('profile.signIn')}
 title={t('profile.signIn')}
 >
 <LogIn size={18} />
 </button>
 )}
 </div>

 {/* Admin — desktop only */}
 {isPrivilegedAdmin && (
 <button
 onClick={() => handleTabChange('admin')}
 className={`hidden md:flex p-2 min-w-[44px] min-h-[44px] rounded-xl transition-colors shrink-0 items-center justify-center ${
 activeTab === 'admin'
 ? 'bg-danger-subtle text-danger'
 : 'text-muted hover:bg-surface-raised'
 }`}
 aria-label="Apri pannello amministrazione"
 title="Pannello amministrazione"
 >
 <Shield size={18} />
 </button>
 )}

 {/* Hamburger — mobile only */}
 <button
 onClick={() => setMobileMenuOpen(prev => !prev)}
 className="md:hidden p-2 rounded-xl text-muted hover:bg-surface-raised transition-colors shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center"
 aria-label={mobileMenuOpen ? 'Chiudi menu' : 'Apri menu'}
 aria-expanded={mobileMenuOpen}
 >
 {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
 </button>
 </div>
 </SilentErrorBoundary>
 </div>

 {/* Mobile slide-down drawer */}
 {mobileMenuOpen && (
 <div className="md:hidden border-t border-edge bg-surface px-4 py-3 animate-slide-down">
 <div className="flex flex-col gap-1">
 {/* Dark mode toggle */}
 <button
 onClick={() => { toggleTheme(); setMobileMenuOpen(false); }}
 className="flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl text-body hover:bg-surface-raised transition-colors w-full text-left"
 >
 {isDarkMode ? <Sun size={18} className="text-warning" /> : <Moon size={18} className="text-subtle" />}
 <span className="text-sm font-medium">{isDarkMode ? t('app.lightMode') : t('app.darkMode')}</span>
 </button>

 {/* What's New */}
 <button
 onClick={() => { setShowWhatsNew(true); setMobileMenuOpen(false); }}
 className="flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl text-body hover:bg-surface-raised transition-colors w-full text-left"
 >
 <Newspaper size={18} />
 <span className="text-sm font-medium">What&apos;s New</span>
 </button>

 {/* Profile / Login */}
 {authUser ? (
 <button
 onClick={() => handleTabChange('profile')}
 className="flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl text-body hover:bg-surface-raised transition-colors w-full text-left"
 >
 {getUserPhotoURL(authUser, authUser?.uid) ? (
 <img
 src={getUserPhotoURL(authUser, authUser?.uid)!}
 alt={getUserDisplayName(authUser)}
 width={24}
 height={24}
 className="w-6 h-6 rounded-md object-cover"
 referrerPolicy="no-referrer"
 />
 ) : (
 <UserIcon size={18} className="text-accent" />
 )}
 <span className="text-sm font-medium">{t('profile.title')}</span>
 </button>
 ) : !authLoading && (
 <button
 onClick={() => handleTabChange('profile')}
 className="flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl text-body hover:bg-surface-raised transition-colors w-full text-left"
 >
 <LogIn size={18} />
 <span className="text-sm font-medium">{t('profile.signIn')}</span>
 </button>
 )}

 {/* Admin */}
 {isPrivilegedAdmin && (
 <button
 onClick={() => handleTabChange('admin')}
 className="flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl text-danger hover:bg-danger-subtle transition-colors w-full text-left"
 >
 <Shield size={18} />
 <span className="text-sm font-medium">Pannello amministrazione</span>
 </button>
 )}
 </div>
 </div>
 )}
 </div>
 </nav>

 {/* Sub-navigation bars — suppressed in lite-shell mode so static SEO pages
  * render only the top nav (logo + 6 top tabs) without secondary tab clutter.
  * Static SEO content (<main class="seo-static-content">) becomes the page body.
  */}
 {!staticOverlay && (<>
 {/* Sub-navigation for Calcolatore */}
 {activeTab === 'calculator' && (
 <SubTabNav
 items={[
 { key: 'calculator' as const, icon: Calculator, label: t('simulator.calculator') },
 { key: 'whatif' as const, icon: Sparkles, label: t('simulator.whatif') },
 { key: 'payslip' as const, icon: FileText, label: t('strumenti.payslip') },
 { key: 'ral' as const, icon: ClipboardList, label: t('comparators.ral') },
 { key: 'bonus' as const, icon: Gift, label: t('comparators.bonus') },
 { key: 'parental-leave' as const, icon: Baby, label: t('comparators.parentalLeave') },
 { key: 'residency' as const, icon: Home, label: t('comparators.residency') },
 { key: 'salary-quiz' as const, icon: TrendingUp, label: t('salaryQuiz.navLabel') },
 ] satisfies SubTabItem<CalcolatoreSubTab>[]}
 activeKey={calcolatoreSubTab}
 hubKey="calculator"
 hrefFor={(key) => buildPath({ activeTab: 'calculator', calcolatoreSubTab: key })}
 onSelect={(key) => {
 setCalcolatoreSubTab(key);
 Analytics.trackUIInteraction('calcolatore', 'navigazione', 'tab_sezione', 'cambio', key);
 }}
 />
 )}

 {/* Sub-navigation for Confronti */}
 {activeTab === 'confronti' && (
 <SubTabNav
 items={[
 { key: 'exchange' as const, icon: ArrowRightLeft, label: t('comparators.exchange') },
 { key: 'banks' as const, icon: Building2, label: t('comparators.banks') },
 { key: 'health' as const, icon: Heart, label: t('comparators.health') },
 { key: 'mobile' as const, icon: Phone, label: t('comparators.mobile') },
 { key: 'shopping' as const, icon: ShoppingCart, label: t('comparators.shopping') },
 { key: 'cost-of-living' as const, icon: Euro, label: t('comparators.costOfLiving') },
 { key: 'jobs' as const, icon: Briefcase, label: t('comparators.jobs') },
 { key: 'renovation' as const, icon: Hammer, label: t('comparators.renovation') },
 ] satisfies SubTabItem<ConfrontiSubTab>[]}
 activeKey={confrontiSubTab}
 hubKey="confronti"
 hrefFor={(key) => buildPath({ activeTab: 'confronti', confrontiSubTab: key })}
 onSelect={(key) => {
 setConfrontiSubTab(key);
 Analytics.trackComparatorView(key as any);
 }}
 />
 )}

 {/* Sub-navigation for Fisco & Previdenza */}
 {activeTab === 'fisco' && (
 <SubTabNav
 items={[
 { key: 'tax-return' as const, icon: FileText, label: t('comparators.taxReturn') },
 { key: 'withholding-rates' as const, icon: Banknote, label: t('withholdingRates.navLabel') },
 { key: 'calendar' as const, icon: Calendar, label: t('guide.tabs.calendar') },
 { key: 'holidays' as const, icon: Heart, label: t('guide.tabs.holidays') },
 { key: 'ristorni' as const, icon: BarChart2, label: t('guide.tabs.ristorni') },
 { key: 'pension' as const, icon: PiggyBank, label: t('nav.pension') },
 { key: 'pillar3' as const, icon: TrendingUp, label: t('pension.pillar3') },
 { key: 'tax-credit' as const, icon: Receipt, label: t('taxCredit.navLabel') },
 ] satisfies SubTabItem<FiscoSubTab>[]}
 activeKey={fiscoSubTab}
 hubKey="fisco"
 hrefFor={(key) => buildPath({ activeTab: 'fisco', fiscoSubTab: key })}
 onSelect={(key) => {
 setFiscoSubTab(key);
 Analytics.trackUIInteraction('fisco', 'navigazione', 'tab_sezione', 'cambio', key);
 }}
 />
 )}

 {/* Sub-navigation for Guida Pratica */}
 {activeTab === 'guida' && (
 <SubTabNav
 items={[
 { key: 'first-day' as const, icon: Rocket, label: t('guide.tabs.firstDay') },
 { key: 'permits' as const, icon: Shield, label: t('guide.tabs.permits') },
 { key: 'border' as const, icon: Timer, label: t('guide.tabs.border') },
 { key: 'unemployment' as const, icon: LifeBuoy, label: t('guide.tabs.unemployment') },
 { key: 'car-transfer' as const, icon: Car, label: t('guide.tabs.carTransfer') },
 { key: 'car-cost' as const, icon: Car, label: t('strumenti.carCost') },
 { key: 'permit-compare' as const, icon: Users, label: t('strumenti.permitCompare') },
 { key: 'border-map' as const, icon: Map, label: t('comparators.borderMap') },
 ] satisfies SubTabItem<GuidaSubTab>[]}
 activeKey={guidaSubTab}
 hubKey="guida"
 hrefFor={(key) => buildPath({ activeTab: 'guida', guidaSubTab: key })}
 onSelect={(key) => {
 setGuidaSubTab(key);
 Analytics.trackUIInteraction('guida', 'navigazione', 'tab_sezione', 'cambio', key);
 }}
 />
 )}

 {/* Sub-navigation for Vita in Ticino */}
 {activeTab === 'vita' && (
 <SubTabNav
 items={[
 { key: 'living-ch' as const, icon: Home, label: t('guide.tabs.livingCH') },
 { key: 'living-it' as const, icon: Users, label: t('guide.tabs.livingIT') },
 { key: 'companies' as const, icon: Building2, label: t('guide.tabs.companies', getCantonI18nParams()) },
 { key: 'schools' as const, icon: GraduationCap, label: t('guide.tabs.schools') },
 { key: 'nursery' as const, icon: School, label: t('comparators.nursery') },
 { key: 'places' as const, icon: Mountain, label: t('guide.tabs.places') },
 { key: 'transport' as const, icon: Car, label: t('comparators.transport') },
 { key: 'municipalities' as const, icon: MapPin, label: t('guide.tabs.municipalities') },
 ] satisfies SubTabItem<VitaSubTab>[]}
 activeKey={vitaSubTab}
 hubKey="vita"
 hrefFor={(key) => buildPath({ activeTab: 'vita', vitaSubTab: key })}
 onSelect={(key) => {
 setVitaSubTab(key);
 Analytics.trackUIInteraction('vita', 'navigazione', 'tab_sezione', 'cambio', key);
 }}
 />
 )}

 {/* Sub-navigation for Stats */}
 {activeTab === 'stats' && (
 <SubTabNav
 items={[
 { key: 'overview' as const, icon: Database, label: t('stats.tabOverview') },
 { key: 'livability' as const, icon: MapPin, label: t('strumenti.livability') },
 { key: 'jobs-observatory' as const, icon: Briefcase, label: t('stats.tabJobsObservatory') },
 { key: 'salary-compare' as const, icon: TrendingUp, label: t('strumenti.salaryCompare') },
 { key: 'traffic-history' as const, icon: Clock, label: t('stats.trafficHistory') },
 { key: 'unemployment' as const, icon: BarChart3, label: t('stats.tabUnemployment') },
 { key: 'mortgage' as const, icon: Home, label: t('stats.tabMortgage') },
 { key: 'fuel-prices' as const, icon: Fuel, label: t('stats.tabFuelPrices') },
 ] satisfies SubTabItem<StatsSubTab>[]}
 activeKey={statsSubTab}
 hubKey="stats"
 hrefFor={(key) => buildPath({ activeTab: 'stats', statsSubTab: key })}
 onSelect={(key) => {
 setStatsSubTab(key);
 Analytics.trackUIInteraction('statistiche', 'navigazione', 'tab_sezione', 'cambio', key);
 }}
 />
 )}
 </>)}

 {/* Main Content
  *
  * Lite-shell mode (staticOverlay): when the URL matches a build-time static
  * SEO page (per-station fuel, per-canton health premium, per-city employer
  * hub, etc.), the SEO content is emitted OUTSIDE `#root` as
  * `<main class="seo-static-content">`. We skip the React `<main>` so the
  * SPA never visually replaces the static SEO page.
  * The static content stays in place; only the top nav/header chrome
  * hydrates inside `#root`. The <footer> always renders (newsletter,
  * sitemap links, weekly employers teaser) regardless of overlay mode.
  */}
 {!staticOverlay && (
 <main id="main-content" data-no-auto-ads="inside" className={`flex-grow mx-auto py-4 lg:py-8 transition-[max-width,padding] duration-300 ease-out relative z-10 ${
 activeTab === 'admin' ? 'w-full px-3 sm:px-6' : '!max-w-[2400px] !w-[95%] px-3 sm:px-4'
 }`}>
 <Suspense fallback={<LazyFallback />}>
 {notFoundPath ? (
 <div className="max-w-2xl mx-auto">
 <NotFoundSuggestions
 path={notFoundPath}
 onNavigate={(tab, subTab) => {
 setNotFoundPath(undefined);
 handleTabChange(tab as ActiveTab);
 void subTab; // subTab handled by handleTabChange via existing subtab state
 }}
 />
 </div>
 ) : activeTab === 'calculator' ? (
 <>
 <CalcolatoreTabContent />
 {calcolatoreSubTab === 'calculator' && !seoLanding && (
 <>
 <h2 className="text-sm font-bold uppercase tracking-wider text-subtle mt-12 mb-4">
 Hub rapidi frontaliere
 </h2>
 <Suspense fallback={null}>
 <SeoDailyBanner className="mb-4" />
 </Suspense>
 <Suspense fallback={null}>
 <QuickLinksGrid className="mb-6" />
 </Suspense>
 </>
 )}
 </>
 ) : activeTab === 'confronti' ? (
 <ConfrontiTabContent />
 ) : activeTab === 'fisco' ? (
 <FiscoTabContent />
 ) : activeTab === 'guida' ? (
 <GuidaTabContent />
 ) : activeTab === 'vita' ? (
 <VitaTabContent />
 ) : activeTab === 'stats' ? (
 <StatsTabContent />
 ) : activeTab === 'blog' ? (
 <div className="max-w-7xl mx-auto">
 <BlogArticles
 selectedArticle={blogArticle}
 onSelectArticle={(id) => setBlogArticle(id)}
 isLoggedIn={!!authUser}
 authLoading={authLoading}
 />
 </div>
 ) : activeTab === 'privacy' ? (
 <div>
 <PrivacyPolicy />
 </div>
 ) : activeTab === 'terms' ? (
 <div>
 <TermsOfService />
 </div>
 ) : activeTab === 'chi-siamo' ? (
 <div>
 <ChiSiamo />
 </div>
 ) : activeTab === 'correzioni' ? (
 <div>
 <Correzioni />
 </div>
 ) : activeTab === 'metodologia' ? (
 <div>
 <Metodologia />
 </div>
 ) : activeTab === 'data-deletion' ? (
 <div>
 <DataDeletion />
 </div>
 ) : activeTab === 'email-confirmed' ? (
 <div>
 <EmailConfirmed />
 </div>
 ) : activeTab === 'newsletter-preferences' ? (
 <div>
 <NewsletterPreferences />
 </div>
 ) : activeTab === 'gamification' ? (
 <div className="max-w-7xl mx-auto">
 <GamificationPage />
 </div>
 ) : activeTab === 'forum' ? (
 <div className="max-w-7xl mx-auto">
 <CommunityForum />
 </div>
 ) : activeTab === 'api-status' ? (
 <div className="max-w-7xl mx-auto">
 <ApiStatus />
 </div>
 ) : activeTab === 'contact' ? (
 <div className="max-w-7xl mx-auto">
 <ContactPage prefill={contactPrefill} onPrefillConsumed={() => setContactPrefill(null)} />
 </div>
 ) : activeTab === 'partners' ? (
 <div className="max-w-7xl mx-auto">
 <PartnerServices />
 </div>
 ) : activeTab === 'consulting' ? (
 <div className="max-w-7xl mx-auto">
 <ConsultingPage />
 </div>
 ) : activeTab === 'press-kit' ? (
 <div className="max-w-7xl mx-auto">
 <PressKit />
 </div>
 ) : activeTab === 'job-board' ? (
 <div className="max-w-7xl mx-auto">
 <JobBoard
 initialJobSlug={jobSlug || undefined}
 initialFilterParams={jobBoardFilterParams}
 initialFilterCanton={typeof window !== 'undefined' ? (parsePath(window.location.pathname).route.jobBoardCanton ?? null) : null}
 onFilterParamsConsumed={() => setJobBoardFilterParams(null)}
 isLoggedIn={!!authUser}
 authUser={authUser}
 authLoading={authLoading}
 enablePersonalization={enablePersonalization}
 userProfile={userProfile}
 onGoogleAuthRequired={googleSignIn}
 onFacebookAuthRequired={facebookSignIn}
 onRequireAuth={() => {
 navigateTo('profile' as any);
 }}
 onJobRouteChange={(slug) => {
 setJobSlug(slug || null);
 pushRoute({ activeTab: 'job-board' as any, ...(slug ? { jobSlug: slug } : {}) });
 // Scroll to top when entering a job detail; JobBoard handles list restoration.
 if (slug) window.scrollTo({ top: 0, behavior: 'instant' });
 }}
 onPostJob={() => {
 setContactPrefill({ topic: 'contact.topic.jobPost' });
 navigateTo('contact' as any);
 }}
 />
 </div>
 ) : activeTab === 'profile' ? (
 <div className="max-w-7xl mx-auto">
 <UserProfile currentInputs={inputs} currentResult={result} />
 </div>
 ) : activeTab === 'morning' ? (
 <div className="max-w-7xl mx-auto">
 <MorningDashboard />
 </div>
 ) : activeTab === 'glossario' ? (
 <div className="max-w-7xl mx-auto">
 <Glossary initialEntry={glossaryTerm || undefined} />
 </div>
 ) : activeTab === 'dialetto' ? (
 <div className="max-w-7xl mx-auto">
 <TicineseDialect />
 </div>
 ) : activeTab === 'faq' ? (
 <div className="max-w-7xl mx-auto">
 <FaqSection />
 </div>
 ) : activeTab === 'sitemap' ? (
 <div className="max-w-7xl mx-auto">
 <SiteMapPage />
 </div>
 ) : activeTab === 'contracts' ? (
 <div className="max-w-7xl mx-auto">
 <ContractsGuide />
 </div>
 ) : activeTab === 'sindacati' ? (
 <div className="max-w-7xl mx-auto">
 <Sindacati />
 </div>
 ) : activeTab === 'tfr-calculator' ? (
 <div className="max-w-7xl mx-auto">
 <TfrCalculator />
 </div>
 ) : activeTab === 'permit-quiz' ? (
 <div className="max-w-7xl mx-auto">
 <PermitQuiz />
 </div>
 ) : activeTab === 'tredicesima' ? (
 <div className="max-w-7xl mx-auto">
 <TredicesimalCalculator />
 </div>
 ) : activeTab === 'weekly-digest' ? (
 <div className="max-w-7xl mx-auto">
 <WeeklyDigest />
 </div>
 ) : activeTab === 'tool-of-week' ? (
 <div className="max-w-7xl mx-auto">
 <ToolOfTheWeek />
 </div>
 ) : activeTab === 'admin' ? (
 <div className="w-full">
 {authLoading ? (
 <div className="flex flex-col items-center justify-center py-20 space-y-4">
 <Shield size={48} className="text-muted" />
 <h2 className="text-xl font-bold text-heading">Verifica sessione amministratore</h2>
 <p className="text-subtle text-center max-w-md">
 Stiamo ripristinando l&apos;accesso. Attendi un istante.
 </p>
 </div>
 ) : isPrivilegedAdmin ? (
 <AdminPanel />
 ) : (
 <div className="flex flex-col items-center justify-center py-20 space-y-4">
 <Shield size={48} className="text-danger" />
 <h2 className="text-xl font-bold text-heading">Accesso riservato</h2>
 <p className="text-subtle text-center max-w-md">
 Questa sezione è riservata all'amministratore del sito.
 </p>
 {!authUser && (
 <div className="mt-4 w-full max-w-[280px] space-y-2">
 <div ref={adminGoogleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-xl" />
 {!adminGoogleButtonReady && (
 <button
 onClick={googleSignIn}
 className="w-full px-6 py-2 bg-accent hover:bg-accent-hover text-on-accent rounded-lg font-medium transition-colors"
 >
 Accedi con Google
 </button>
 )}
 </div>
 )}
 </div>
 )}
 </div>
 ) : (
 <div className="max-w-7xl mx-auto">
 <FeedbackSection />
 </div>
 )}

 {ctaItems.length > 0 && (
 <div className="mt-8">
 <div className="bg-surface border border-edge rounded-2xl p-4 sm:p-6">
 <div className="flex items-center gap-2">
 <Sparkles size={18} className="text-accent" />
 <h2 className="text-lg font-bold text-heading">{t('cta.tryAlso')}</h2>
 </div>
 <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
 {visibleCtaItems.map((item) => (
 <button
 key={item.analyticsLabel}
 onClick={() => handleCtaClick(item)}
 className="w-full text-left rounded-xl border border-edge bg-surface-alt px-4 py-3 hover:bg-surface-raised transition-colors"
 >
 <div className="flex items-center justify-between gap-3">
 <span className="text-sm font-semibold text-heading">{item.label}</span>
 <span className="text-subtle" aria-hidden>→</span>
 </div>
 </button>
 ))}
 </div>
 </div>
 </div>
 )}
 </Suspense>

 {/* Visible"last updated" date — AI freshness signal + user trust */}
 {!(['admin', 'profile', 'email-confirmed', 'newsletter-preferences', 'privacy', 'terms', 'data-deletion'] as string[]).includes(activeTab) && (
 <p className="text-sm text-muted text-center mt-6">
 <time dateTime={footerDateStr.dateTimeAttr}>
 {t('stats.lastUpdate')}: {footerDateStr.display}
 </time>
 </p>
 )}
 </main>
 )}

 {/* Footer — on staticOverlay pages it is portalled into #footer-root which
   * lives AFTER <main class="seo-static-content"> in the DOM, so the footer
   * appears below the SEO content rather than above it (Bug A fix).
   * On normal SPA pages the footer renders inline inside #root as before.
   *
   * Portal target: build-plugins/htmlTemplate.ts emits
   *   <div id="root"></div>
   *   <main class="seo-static-content">...</main>
   *   <div id="footer-root"></div>   ← portal target
   * so the footer flows naturally after the SEO content in visual order. */}
 {(() => {
   const footerPortalTarget = staticOverlay ? document.getElementById('footer-root') : null;
   const footerJsx = (
 <footer className="border-t border-edge bg-surface-alt py-8 pb-20 md:pb-8 mt-auto relative z-10" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 1600px' }}>
 <div className="max-w-7xl mx-auto px-4 space-y-6">
 {/* Footer weather widget */}
 <Suspense fallback={<SkeletonFooterSlot height="min-h-[36px]" />}><FooterWeather /></Suspense>

 {/* Newsletter signup — inline in footer for persistent visibility */}
 <div className="max-w-xl mx-auto">
 <Suspense fallback={null}><NewsletterInline compact /></Suspense>
 </div>

 {/* Donation banner */}
 <div className="max-w-xl mx-auto">
 <Suspense fallback={<SkeletonFooterSlot height="min-h-[48px]" />}><DonationBanner variant="inline" /></Suspense>
 </div>

 {/* Version badge with GitHub link */}
 <div className="flex items-center justify-center mt-2 mb-2">
 <a
 href={`https://github.com/valerielinc-ops/frontaliere-si-o-no/commit/${typeof __COMMIT_HASH__ !== 'undefined' ? __COMMIT_HASH__ : 'unknown'}`}
 target="_blank"
 rel="noopener noreferrer"
 className="text-sm font-mono text-muted hover:text-accent px-1 py-0.5 rounded transition-colors opacity-70 hover:opacity-100"
 title="Versione del sito: commit GitHub deploy"
 >
 <span>v</span>
 <span>{typeof __SHORT_COMMIT_HASH__ !== 'undefined' ? __SHORT_COMMIT_HASH__ : 'unknown'}</span>
 </a>
 </div>

 <div className="text-center text-muted text-sm space-y-3">
 <p className="font-medium">
 {t('footer.copyright')}
 <span className="text-subtle mx-2">|</span>
 {t('footer.disclaimer')}
 </p>
 {/* Layer 2B — Close orphan sitemap: top weekly {company × city} pages. */}
 <Suspense fallback={null}>
 <WeeklyEmployersTeaser />
 </Suspense>
 {/* Layer 2A — Internal linking: freshly-updated SEO resources, desktop + mobile */}
 <nav
 aria-label={t('seoLinks.footer.title')}
 data-testid="footer-seo-links"
 className="pt-3 pb-2 border-t border-edge/50"
 >
 <h3 className="text-xs font-bold uppercase tracking-wider text-subtle mb-2">
 {t('seoLinks.footer.title')}
 </h3>
 <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 list-none p-0 m-0">
 {!killSwitches.fuelDaily && (
 <li>
 <a
 href={buildFuelTodayPath(locale, 'diesel')}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-warning transition-colors no-underline"
 >
 <Fuel className="w-3.5 h-3.5" aria-hidden="true" />
 {t('seoLinks.footer.fuelToday')}
 </a>
 </li>
 )}
 {!killSwitches.weeklyEmployers && (
 <li>
 <a
 href={buildCurrentWeekPath(locale, 'ticino')}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Building2 className="w-3.5 h-3.5" aria-hidden="true" />
 {t('seoLinks.footer.weeklyEmployers')}
 </a>
 </li>
 )}
 {!killSwitches.jobMarket && (
 <li>
 <a
 href={buildJobMarketHubPath(locale)}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <TrendingUp className="w-3.5 h-3.5" aria-hidden="true" />
 {t('seoLinks.footer.jobMarket')}
 </a>
 </li>
 )}
 {!killSwitches.healthPremiums && (
 <li>
 <a
 href={buildHealthPremiumsCantonPath(locale, 'ticino')}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-success transition-colors no-underline"
 >
 <Heart className="w-3.5 h-3.5" aria-hidden="true" />
 {t('seoLinks.footer.healthPremiums')}
 </a>
 </li>
 )}
 {!killSwitches.orphanLandings && (
 <li>
 <a
 href={
 locale === 'it'
 ? '/cerca-lavoro-ticino/da-ieri/'
 : locale === 'en'
 ? '/en/find-jobs-ticino/since-yesterday/'
 : locale === 'de'
 ? '/de/jobs-im-tessin/seit-gestern/'
 : '/fr/trouver-emploi-tessin/depuis-hier/'
 }
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
 {t('seoLinks.footer.newYesterday')}
 </a>
 </li>
 )}
 {/* Depth-cleanup — additional canonical hubs from the same SEO families,
   so Semrush no longer flags >3-click-deep crawl. F6 gasoline (alt to
   diesel above), F2 per-comune premiums alt-hub. */}
 {!killSwitches.fuelDaily && (
 <li>
 <a
 href={buildFuelTodayPath(locale, 'benzina')}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-warning transition-colors no-underline"
 >
 <Fuel className="w-3.5 h-3.5" aria-hidden="true" />
 {t('seoLinks.footer.gasolineToday')}
 </a>
 </li>
 )}
 {!killSwitches.healthPremiums && (
 <li>
 <a
 href={buildPath({ activeTab: 'stats', statsSubTab: 'health-premiums' })}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-success transition-colors no-underline"
 >
 <Heart className="w-3.5 h-3.5" aria-hidden="true" />
 {t('seoLinks.footer.healthPremiumsByCommune')}
 </a>
 </li>
 )}
 </ul>
 </nav>
 {/* Phase 2-UI — SEO hub-page entry points (close orphan/deep-page graph). */}
 {(() => {
   const hubLoc = (locale as SeoHubLocale) || 'it';
   const hubs = SEO_HUB_SLUGS[hubLoc];
   const sectorMap = Object.fromEntries(SEO_HUB_SECTORS.map((s) => [s.key, s])) as Record<string, typeof SEO_HUB_SECTORS[number]>;
   const sectionRoot = locale === 'it'
     ? '/cerca-lavoro-ticino'
     : `/${locale}/${locale === 'en' ? 'find-jobs-ticino' : locale === 'de' ? 'jobs-im-tessin' : 'trouver-emploi-tessin'}`;
   return (
     <nav
       aria-label={t('seoHubs.footer.title') || 'SEO hub navigation'}
       data-testid="footer-seo-hubs"
       className="pt-3 pb-3 border-t border-edge/50 grid grid-cols-1 md:grid-cols-4 gap-4 text-left max-w-5xl mx-auto"
     >
       <div>
         <h3 className="text-xs font-bold uppercase tracking-wider text-strong mb-2">
           {t('seoHubs.footer.sectors') || 'Esplora settori'}
         </h3>
         <ul className="space-y-1 list-none p-0 m-0">
           {SEO_FOOTER_TOP_SECTORS.map((sk) => {
             const sector = sectorMap[sk];
             if (!sector) return null;
             const label = sector[hubLoc] || sector.it;
             // Prefer the canonical static sector hub (`/cerca-lavoro-ticino/infermieri/`)
             // when one exists for this key; fall back to a `?q=` keyword search for
             // sectors without a curated hub. Routing footer traffic through the
             // canonical hub avoids diluting internal SEO equity to non-indexable
             // query URLs and gives users the richer landing page.
             const hasHub = (SECTOR_HUB_KEYS as readonly string[]).includes(sk);
             const href = hasHub
               ? buildSectorHubPath(hubLoc, sk as SectorHubKey)
               : `${sectionRoot}/?q=${encodeURIComponent(label)}`;
             return (
               <li key={sk}>
                 <a
                   href={href}
                   className="text-xs text-subtle hover:text-accent no-underline"
                 >
                   {label}
                 </a>
               </li>
             );
           })}
           <li>
             <a href={hubs.sectorsAll} className="text-xs font-semibold text-accent hover:underline no-underline">
               {t('seoHubs.footer.allSectors') || 'Tutti i settori →'}
             </a>
           </li>
         </ul>
       </div>
       <div>
         <h3 className="text-xs font-bold uppercase tracking-wider text-strong mb-2">
           {t('seoHubs.footer.cities') || 'Esplora città'}
         </h3>
         <ul className="space-y-1 list-none p-0 m-0">
           {SEO_FOOTER_TOP_CITIES.map((c) => (
             <li key={c.key}>
               <a
                 href={`${sectionRoot}/${c.key}/`}
                 className="text-xs text-subtle hover:text-accent no-underline"
               >
                 {c.display}
               </a>
             </li>
           ))}
           <li>
             <a href={hubs.jobsAll} className="text-xs font-semibold text-accent hover:underline no-underline">
               {t('seoHubs.footer.allJobs') || 'Tutti i lavori →'}
             </a>
           </li>
         </ul>
       </div>
       <div>
         <h3 className="text-xs font-bold uppercase tracking-wider text-strong mb-2">
           {t('seoHubs.footer.companies') || 'Aziende che assumono'}
         </h3>
         <ul className="space-y-1 list-none p-0 m-0">
           <li>
             <a href={`${sectionRoot}/azienda-eoc-ente-ospedaliero-cantonale/`} className="text-xs text-subtle hover:text-accent no-underline">EOC</a>
           </li>
           <li>
             <a href={`${sectionRoot}/azienda-abb-svizzera-sede-ticino/`} className="text-xs text-subtle hover:text-accent no-underline">ABB</a>
           </li>
           <li>
             <a href={`${sectionRoot}/azienda-coop/`} className="text-xs text-subtle hover:text-accent no-underline">Coop</a>
           </li>
           <li>
             <a href={`${sectionRoot}/azienda-migros/`} className="text-xs text-subtle hover:text-accent no-underline">Migros</a>
           </li>
           <li>
             <a href={hubs.companiesAll} className="text-xs font-semibold text-accent hover:underline no-underline">
               {t('seoHubs.footer.allCompanies') || 'Tutte le aziende →'}
             </a>
           </li>
         </ul>
       </div>
       <div>
         <h3 className="text-xs font-bold uppercase tracking-wider text-strong mb-2">
           {t('seoHubs.footer.articles') || 'Ultimi articoli'}
         </h3>
         <ul className="space-y-1 list-none p-0 m-0">
           <li>
             <a href={hubs.articlesAll} className="text-xs font-semibold text-accent hover:underline no-underline">
               {t('seoHubs.footer.allArticles') || 'Tutti gli articoli →'}
             </a>
           </li>
         </ul>
       </div>
     </nav>
   );
 })()}
 {/* Footer links — desktop: flat flex-wrap, mobile: accordion */}
 <div className="hidden md:flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
 <a
 href={buildPath({ activeTab: 'chi-siamo' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('chi-siamo' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Users className="w-3.5 h-3.5" />
 {t('footer.aboutUs')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'correzioni' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('correzioni' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <ScrollText className="w-3.5 h-3.5" />
 Correzioni
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'metodologia' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('metodologia' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Info className="w-3.5 h-3.5" />
 Metodologia
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'contact' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('contact' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Mail className="w-3.5 h-3.5" />
 {t('footer.contactTitle')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'feedback' })}
 onClick={(e) => { e.preventDefault(); navigateTo('feedback'); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Bug className="w-3.5 h-3.5" />
 {t('footer.improveTitle')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'privacy' })}
 onClick={(e) => { e.preventDefault(); navigateTo('privacy' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Shield className="w-3.5 h-3.5" />
 {t('footer.privacy')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'terms' })}
 onClick={(e) => { e.preventDefault(); navigateTo('terms' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <FileText className="w-3.5 h-3.5" />
 Termini
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'api-status' })}
 onClick={(e) => { e.preventDefault(); navigateTo('api-status' as any); Analytics.trackApiDiagnostics('view'); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-body transition-colors no-underline"
 >
 {t('footer.apiStatus')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'partners' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('partners' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-success transition-colors no-underline"
 >
 {t('partners.footerLink')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'consulting' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('consulting' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 {t('consulting.footerLink')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'job-board' as any })}
 onClick={(e) => { e.preventDefault(); setJobSlug(null); navigateTo('job-board' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 {t('jobBoard.footerLink', getCantonI18nParams())}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'stats', statsSubTab: 'fuel-prices' })}
 onClick={(e) => { e.preventDefault(); setStatsSubTab('fuel-prices'); navigateTo('stats', 'fuel-prices'); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-warning transition-colors no-underline"
 >
 <Fuel className="w-3.5 h-3.5" />
 {t('footer.fuelPrices')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'morning' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('morning' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-warning transition-colors no-underline"
 >
 <Sunrise className="w-3.5 h-3.5" />
 {t('footer.morningDashboard')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'faq' })}
 onClick={(e) => { e.preventDefault(); navigateTo('faq' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <HelpCircle className="w-3.5 h-3.5" />
 FAQ
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'blog' })}
 onClick={(e) => { e.preventDefault(); navigateTo('blog' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Newspaper className="w-3.5 h-3.5" />
 {t('blog.title')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'glossario' })}
 onClick={(e) => { e.preventDefault(); navigateTo('glossario' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-info transition-colors no-underline"
 >
 <BookA className="w-3.5 h-3.5" />
 {t('glossary.title')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'dialetto' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('dialetto' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-warning transition-colors no-underline"
 >
 <Languages className="w-3.5 h-3.5" />
 {t('dialect.title')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'sitemap' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('sitemap' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-body transition-colors no-underline"
 >
 {t('sitemap.title')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'contracts' })}
 onClick={(e) => { e.preventDefault(); navigateTo('contracts' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <FileText className="w-3.5 h-3.5" />
 {t('contracts.footerLink')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'sindacati' as any })}
 onClick={(e) => { e.preventDefault(); navigateTo('sindacati' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Scale className="w-3.5 h-3.5" />
 Sindacati
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'tfr-calculator' })}
 onClick={(e) => { e.preventDefault(); navigateTo('tfr-calculator' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-warning transition-colors no-underline"
 >
 <Banknote className="w-3.5 h-3.5" />
 {t('tfr.footerLink')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'tredicesima' })}
 onClick={(e) => { e.preventDefault(); navigateTo('tredicesima' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-warning transition-colors no-underline"
 >
 <Gift className="w-3.5 h-3.5" />
 {t('tredicesima.footerLink')}
 </a>
 <span className="text-edge">·</span>
 <a
 href={buildPath({ activeTab: 'tool-of-week' })}
 onClick={(e) => { e.preventDefault(); navigateTo('tool-of-week' as any); }}
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 >
 <Sparkles className="w-3.5 h-3.5" />
 {t('toolOfWeek.title')}
 </a>
 <span className="text-edge">·</span>
 <a
 href="https://www.facebook.com/profile.php?id=61588174947294"
 target="_blank"
 rel="noopener noreferrer"
 className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
 aria-label={t('footer.followFacebook')}
 >
 <Facebook className="w-3.5 h-3.5" />
 Facebook
 </a>
 </div>

 {/* Mobile footer accordion — grouped links for scanability */}
 <div className="md:hidden space-y-1 mt-2">
 {/* Info & Legal */}
 <details className="group border-b border-edge/50">
 <summary className="flex items-center justify-between py-3 text-sm font-semibold text-body cursor-pointer list-none [&::-webkit-details-marker]:hidden">
 <span>Informazioni</span>
 <span className="text-muted text-xs group-open:rotate-180 transition-transform">▼</span>
 </summary>
 <div className="pb-3 grid grid-cols-2 gap-x-4 gap-y-1">
 <a href={buildPath({ activeTab: 'chi-siamo' as any })} onClick={(e) => { e.preventDefault(); navigateTo('chi-siamo' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><Users className="w-3.5 h-3.5 shrink-0" />{t('footer.aboutUs')}</a>
 <a href={buildPath({ activeTab: 'correzioni' as any })} onClick={(e) => { e.preventDefault(); navigateTo('correzioni' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><ScrollText className="w-3.5 h-3.5 shrink-0" />Correzioni</a>
<a href={buildPath({ activeTab: 'metodologia' as any })} onClick={(e) => { e.preventDefault(); navigateTo('metodologia' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><Info className="w-3.5 h-3.5 shrink-0" />Metodologia</a>
 <a href={buildPath({ activeTab: 'contact' as any })} onClick={(e) => { e.preventDefault(); navigateTo('contact' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><Mail className="w-3.5 h-3.5 shrink-0" />{t('footer.contactTitle')}</a>
 <a href={buildPath({ activeTab: 'feedback' })} onClick={(e) => { e.preventDefault(); navigateTo('feedback'); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><Bug className="w-3.5 h-3.5 shrink-0" />{t('footer.improveTitle')}</a>
 <a href={buildPath({ activeTab: 'privacy' })} onClick={(e) => { e.preventDefault(); navigateTo('privacy' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><Shield className="w-3.5 h-3.5 shrink-0" />{t('footer.privacy')}</a>
 <a href={buildPath({ activeTab: 'terms' })} onClick={(e) => { e.preventDefault(); navigateTo('terms' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><FileText className="w-3.5 h-3.5 shrink-0" />Termini</a>
 <a href={buildPath({ activeTab: 'api-status' })} onClick={(e) => { e.preventDefault(); navigateTo('api-status' as any); Analytics.trackApiDiagnostics('view'); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline">{t('footer.apiStatus')}</a>
 <a href={buildPath({ activeTab: 'partners' as any })} onClick={(e) => { e.preventDefault(); navigateTo('partners' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-success py-1.5 min-h-[44px] no-underline">{t('partners.footerLink')}</a>
 </div>
 </details>
 {/* Strumenti */}
 <details className="group border-b border-edge/50">
 <summary className="flex items-center justify-between py-3 text-sm font-semibold text-body cursor-pointer list-none [&::-webkit-details-marker]:hidden">
 <span>Strumenti</span>
 <span className="text-muted text-xs group-open:rotate-180 transition-transform">▼</span>
 </summary>
 <div className="pb-3 grid grid-cols-2 gap-x-4 gap-y-1">
 <a href={buildPath({ activeTab: 'job-board' as any })} onClick={(e) => { e.preventDefault(); setJobSlug(null); navigateTo('job-board' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><Briefcase className="w-3.5 h-3.5 shrink-0" />{t('jobBoard.footerLink', getCantonI18nParams())}</a>
 <a href={buildPath({ activeTab: 'stats', statsSubTab: 'fuel-prices' })} onClick={(e) => { e.preventDefault(); setStatsSubTab('fuel-prices'); navigateTo('stats', 'fuel-prices'); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-warning py-1.5 min-h-[44px] no-underline"><Fuel className="w-3.5 h-3.5 shrink-0" />{t('footer.fuelPrices')}</a>
 <a href={buildPath({ activeTab: 'morning' as any })} onClick={(e) => { e.preventDefault(); navigateTo('morning' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-warning py-1.5 min-h-[44px] no-underline"><Sunrise className="w-3.5 h-3.5 shrink-0" />{t('footer.morningDashboard')}</a>
 <a href={buildPath({ activeTab: 'tfr-calculator' })} onClick={(e) => { e.preventDefault(); navigateTo('tfr-calculator' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-warning py-1.5 min-h-[44px] no-underline"><Banknote className="w-3.5 h-3.5 shrink-0" />{t('tfr.footerLink')}</a>
 <a href={buildPath({ activeTab: 'tredicesima' })} onClick={(e) => { e.preventDefault(); navigateTo('tredicesima' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-warning py-1.5 min-h-[44px] no-underline"><Gift className="w-3.5 h-3.5 shrink-0" />{t('tredicesima.footerLink')}</a>
 <a href={buildPath({ activeTab: 'contracts' })} onClick={(e) => { e.preventDefault(); navigateTo('contracts' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><FileText className="w-3.5 h-3.5 shrink-0" />{t('contracts.footerLink')}</a>
 <a href={buildPath({ activeTab: 'sindacati' as any })} onClick={(e) => { e.preventDefault(); navigateTo('sindacati' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><Scale className="w-3.5 h-3.5 shrink-0" />Sindacati</a>
 <a href={buildPath({ activeTab: 'consulting' as any })} onClick={(e) => { e.preventDefault(); navigateTo('consulting' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline">{t('consulting.footerLink')}</a>
 <a href={buildPath({ activeTab: 'tool-of-week' })} onClick={(e) => { e.preventDefault(); navigateTo('tool-of-week' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><Sparkles className="w-3.5 h-3.5 shrink-0" />{t('toolOfWeek.title')}</a>
 </div>
 </details>
 {/* Contenuti */}
 <details className="group border-b border-edge/50">
 <summary className="flex items-center justify-between py-3 text-sm font-semibold text-body cursor-pointer list-none [&::-webkit-details-marker]:hidden">
 <span>Contenuti</span>
 <span className="text-muted text-xs group-open:rotate-180 transition-transform">▼</span>
 </summary>
 <div className="pb-3 grid grid-cols-2 gap-x-4 gap-y-1">
 <a href={buildPath({ activeTab: 'blog' })} onClick={(e) => { e.preventDefault(); navigateTo('blog' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><Newspaper className="w-3.5 h-3.5 shrink-0" />{t('blog.title')}</a>
 <a href={buildPath({ activeTab: 'faq' })} onClick={(e) => { e.preventDefault(); navigateTo('faq' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-accent py-1.5 min-h-[44px] no-underline"><HelpCircle className="w-3.5 h-3.5 shrink-0" />FAQ</a>
 <a href={buildPath({ activeTab: 'glossario' })} onClick={(e) => { e.preventDefault(); navigateTo('glossario' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-info py-1.5 min-h-[44px] no-underline"><BookA className="w-3.5 h-3.5 shrink-0" />{t('glossary.title')}</a>
 <a href={buildPath({ activeTab: 'dialetto' as any })} onClick={(e) => { e.preventDefault(); navigateTo('dialetto' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-warning py-1.5 min-h-[44px] no-underline"><Languages className="w-3.5 h-3.5 shrink-0" />{t('dialect.title')}</a>
 <a href={buildPath({ activeTab: 'sitemap' as any })} onClick={(e) => { e.preventDefault(); navigateTo('sitemap' as any); }} className="flex items-center gap-1.5 text-xs text-subtle hover:text-body py-1.5 min-h-[44px] no-underline">{t('sitemap.title')}</a>
 </div>
 </details>
 {/* Social */}
 <div className="py-3">
 <a
 href="https://www.facebook.com/profile.php?id=61588174947294"
 target="_blank"
 rel="noopener noreferrer"
 className="inline-flex items-center gap-1.5 text-xs text-subtle hover:text-accent no-underline"
 aria-label={t('footer.followFacebook')}
 >
 <Facebook className="w-3.5 h-3.5" />
 Facebook
 </a>
 </div>
 {/* Mobile sitemap accordion */}
 <details className="group border-t border-edge/50">
 <summary className="flex items-center justify-between py-3 text-sm font-semibold text-body cursor-pointer list-none [&::-webkit-details-marker]:hidden">
 <span>Mappa del sito</span>
 <span className="text-muted text-xs group-open:rotate-180 transition-transform">▼</span>
 </summary>
 <nav aria-label="Mappa del sito mobile" className="pb-4">
 <div className="grid grid-cols-2 gap-4 text-left">
 <div>
 <a href={buildPath({ activeTab: 'calculator' })} onClick={(e) => { e.preventDefault(); handleTabChange('calculator'); }} className="text-xs font-bold text-accent no-underline hover:underline">{t('nav.simulator')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {(['whatif', 'payslip', 'ral', 'bonus', 'parental-leave', 'residency', 'salary-quiz'] as const).map((sub) => (
 <li key={sub}><a href={buildPath({ activeTab: 'calculator', calcolatoreSubTab: sub })} onClick={(e) => { e.preventDefault(); setCalcolatoreSubTab(sub); setActiveTab('calculator'); pushRoute({ activeTab: 'calculator', calcolatoreSubTab: sub }); }} className="block text-xs text-muted hover:text-accent no-underline hover:underline leading-relaxed py-1">{t(sub === 'whatif' ? 'simulator.whatif' : sub === 'payslip' ? 'strumenti.payslip' : sub === 'ral' ? 'comparators.ral' : sub === 'bonus' ? 'comparators.bonus' : sub === 'parental-leave' ? 'comparators.parentalLeave' : sub === 'residency' ? 'comparators.residency' : 'salaryQuiz.navLabel')}</a></li>
 ))}
 </ul>
 </div>
 <div>
 <a href={buildPath({ activeTab: 'confronti' })} onClick={(e) => { e.preventDefault(); handleTabChange('confronti'); }} className="text-xs font-bold text-accent no-underline hover:underline">{t('nav.confronti')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {(['exchange', 'banks', 'health', 'mobile', 'shopping', 'cost-of-living', 'jobs', 'renovation'] as const).map((sub) => (
 <li key={sub}><a href={buildPath({ activeTab: 'confronti', confrontiSubTab: sub })} onClick={(e) => { e.preventDefault(); setConfrontiSubTab(sub); setActiveTab('confronti'); pushRoute({ activeTab: 'confronti', confrontiSubTab: sub }); }} className="block text-xs text-muted hover:text-accent no-underline hover:underline leading-relaxed py-1">{t(`comparators.${sub === 'cost-of-living' ? 'costOfLiving' : sub}`)}</a></li>
 ))}
 </ul>
 </div>
 <div>
 <a href={buildPath({ activeTab: 'fisco' })} onClick={(e) => { e.preventDefault(); handleTabChange('fisco'); }} className="text-xs font-bold text-success no-underline hover:underline">{t('nav.fisco')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {(['tax-return', 'withholding-rates', 'calendar', 'holidays', 'ristorni', 'pension', 'pillar3', 'tax-credit'] as const).map((sub) => (
 <li key={sub}><a href={buildPath({ activeTab: 'fisco', fiscoSubTab: sub })} onClick={(e) => { e.preventDefault(); setFiscoSubTab(sub); setActiveTab('fisco'); pushRoute({ activeTab: 'fisco', fiscoSubTab: sub }); }} className="block text-xs text-muted hover:text-success no-underline hover:underline leading-relaxed py-1">{t(sub === 'tax-return' ? 'comparators.taxReturn' : sub === 'withholding-rates' ? 'withholdingRates.navLabel' : sub === 'calendar' ? 'guide.tabs.calendar' : sub === 'holidays' ? 'guide.tabs.holidays' : sub === 'ristorni' ? 'guide.tabs.ristorni' : sub === 'pension' ? 'nav.pension' : sub === 'pillar3' ? 'pension.pillar3' : 'taxCredit.navLabel')}</a></li>
 ))}
 </ul>
 </div>
 <div>
 <a href={buildPath({ activeTab: 'guida' })} onClick={(e) => { e.preventDefault(); handleTabChange('guida'); }} className="text-xs font-bold text-accent no-underline hover:underline">{t('nav.guida')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {(['first-day', 'permits', 'border', 'unemployment', 'car-transfer', 'car-cost', 'permit-compare', 'border-map'] as const).map((sub) => (
 <li key={sub}><a href={buildPath({ activeTab: 'guida', guidaSubTab: sub })} onClick={(e) => { e.preventDefault(); setGuidaSubTab(sub); setActiveTab('guida'); pushRoute({ activeTab: 'guida', guidaSubTab: sub }); }} className="block text-xs text-muted hover:text-accent no-underline hover:underline leading-relaxed py-1">{t(sub === 'first-day' ? 'guide.tabs.firstDay' : sub === 'permits' ? 'guide.tabs.permits' : sub === 'border' ? 'guide.tabs.border' : sub === 'unemployment' ? 'guide.tabs.unemployment' : sub === 'car-transfer' ? 'guide.tabs.carTransfer' : sub === 'car-cost' ? 'strumenti.carCost' : sub === 'permit-compare' ? 'strumenti.permitCompare' : 'comparators.borderMap')}</a></li>
 ))}
 </ul>
 </div>
 <div>
 <a href={buildPath({ activeTab: 'vita' })} onClick={(e) => { e.preventDefault(); handleTabChange('vita'); }} className="text-xs font-bold text-warning no-underline hover:underline">{t('nav.vita')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {(['living-ch', 'living-it', 'companies', 'schools', 'nursery', 'places', 'transport', 'municipalities'] as const).map((sub) => (
 <li key={sub}><a href={buildPath({ activeTab: 'vita', vitaSubTab: sub })} onClick={(e) => { e.preventDefault(); setVitaSubTab(sub); setActiveTab('vita'); pushRoute({ activeTab: 'vita', vitaSubTab: sub }); }} className="block text-xs text-muted hover:text-warning no-underline hover:underline leading-relaxed py-1">{sub === 'companies' ? t('guide.tabs.companies', getCantonI18nParams()) : t(sub === 'living-ch' ? 'guide.tabs.livingCH' : sub === 'living-it' ? 'guide.tabs.livingIT' : sub === 'schools' ? 'guide.tabs.schools' : sub === 'nursery' ? 'comparators.nursery' : sub === 'places' ? 'guide.tabs.places' : sub === 'transport' ? 'comparators.transport' : 'guide.tabs.municipalities')}</a></li>
 ))}
 </ul>
 </div>
 <div>
 <a href={buildPath({ activeTab: 'stats' })} onClick={(e) => { e.preventDefault(); handleTabChange('stats'); }} className="text-xs font-bold text-accent no-underline hover:underline">{t('nav.stats')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {(['jobs-observatory', 'livability', 'salary-compare', 'traffic-history', 'unemployment', 'mortgage', 'fuel-prices'] as const).map((sub) => (
 <li key={sub}><a href={buildPath({ activeTab: 'stats', statsSubTab: sub })} onClick={(e) => { e.preventDefault(); setStatsSubTab(sub); setActiveTab('stats'); pushRoute({ activeTab: 'stats', statsSubTab: sub }); }} className="block text-xs text-muted hover:text-accent no-underline hover:underline leading-relaxed py-1">{t(sub === 'jobs-observatory' ? 'stats.tabJobsObservatory' : sub === 'livability' ? 'strumenti.livability' : sub === 'salary-compare' ? 'strumenti.salaryCompare' : sub === 'traffic-history' ? 'stats.trafficHistory' : sub === 'unemployment' ? 'stats.tabUnemployment' : sub === 'mortgage' ? 'stats.tabMortgage' : 'stats.tabFuelPrices')}</a></li>
 ))}
 </ul>
 </div>
 </div>
 </nav>
 </details>
 </div>

 {/* SEO Sitemap — desktop: full grid, mobile: collapsed accordion */}
 <nav aria-label="Mappa del sito" className="hidden md:block mt-6 pt-4 border-t border-edge/50">
 <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-4 text-left">
 {/* Calcolatore */}
 <div>
 <a href={buildPath({ activeTab: 'calculator' })} onClick={(e) => { e.preventDefault(); handleTabChange('calculator'); }} className="text-xs font-bold text-accent no-underline hover:underline">{t('nav.simulator')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {([
 { sub: 'whatif' as const, label: t('simulator.whatif') },
 { sub: 'payslip' as const, label: t('strumenti.payslip') },
 { sub: 'ral' as const, label: t('comparators.ral') },
 { sub: 'bonus' as const, label: t('comparators.bonus') },
 { sub: 'parental-leave' as const, label: t('comparators.parentalLeave') },
 { sub: 'residency' as const, label: t('comparators.residency') },
 { sub: 'salary-quiz' as const, label: t('salaryQuiz.navLabel') },
 ] as const).map(({ sub, label }) => (
 <li key={sub}>
 <a
 href={buildPath({ activeTab: 'calculator', calcolatoreSubTab: sub })}
 onClick={(e) => { e.preventDefault(); setCalcolatoreSubTab(sub); setActiveTab('calculator'); pushRoute({ activeTab: 'calculator', calcolatoreSubTab: sub }); }}
 className="block text-xs text-muted hover:text-accent no-underline hover:underline leading-relaxed py-1"
 >{label}</a>
 </li>
 ))}
 </ul>
 </div>
 {/* Confronti */}
 <div>
 <a href={buildPath({ activeTab: 'confronti' })} onClick={(e) => { e.preventDefault(); handleTabChange('confronti'); }} className="text-xs font-bold text-accent no-underline hover:underline">{t('nav.confronti')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {([
 { sub: 'exchange' as const, label: t('comparators.exchange') },
 { sub: 'banks' as const, label: t('comparators.banks') },
 { sub: 'health' as const, label: t('comparators.health') },
 { sub: 'mobile' as const, label: t('comparators.mobile') },
 { sub: 'shopping' as const, label: t('comparators.shopping') },
 { sub: 'cost-of-living' as const, label: t('comparators.costOfLiving') },
 { sub: 'jobs' as const, label: t('comparators.jobs') },
 { sub: 'renovation' as const, label: t('comparators.renovation') },
 ] as const).map(({ sub, label }) => (
 <li key={sub}>
 <a
 href={buildPath({ activeTab: 'confronti', confrontiSubTab: sub })}
 onClick={(e) => { e.preventDefault(); setConfrontiSubTab(sub); setActiveTab('confronti'); pushRoute({ activeTab: 'confronti', confrontiSubTab: sub }); }}
 className="block text-xs text-muted hover:text-accent no-underline hover:underline leading-relaxed py-1"
 >{label}</a>
 </li>
 ))}
 </ul>
 </div>
 {/* Fisco */}
 <div>
 <a href={buildPath({ activeTab: 'fisco' })} onClick={(e) => { e.preventDefault(); handleTabChange('fisco'); }} className="text-xs font-bold text-success no-underline hover:underline">{t('nav.fisco')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {([
 { sub: 'tax-return' as const, label: t('comparators.taxReturn') },
 { sub: 'withholding-rates' as const, label: t('withholdingRates.navLabel') },
 { sub: 'calendar' as const, label: t('guide.tabs.calendar') },
 { sub: 'holidays' as const, label: t('guide.tabs.holidays') },
 { sub: 'ristorni' as const, label: t('guide.tabs.ristorni') },
 { sub: 'pension' as const, label: t('nav.pension') },
 { sub: 'pillar3' as const, label: t('pension.pillar3') },
 { sub: 'tax-credit' as const, label: t('taxCredit.navLabel') },
 { sub: 'new-frontier-tax-sim' as const, label: t('newFrontierTaxSim.navLabel') },
 { sub: 'quiz' as const, label: t('guide.tabs.quiz') },
 ] as const).map(({ sub, label }) => (
 <li key={sub}>
 <a
 href={buildPath({ activeTab: 'fisco', fiscoSubTab: sub })}
 onClick={(e) => { e.preventDefault(); setFiscoSubTab(sub); setActiveTab('fisco'); pushRoute({ activeTab: 'fisco', fiscoSubTab: sub }); }}
 className="block text-xs text-muted hover:text-success no-underline hover:underline leading-relaxed py-1"
 >{label}</a>
 </li>
 ))}
 </ul>
 </div>
 {/* Guida */}
 <div>
 <a href={buildPath({ activeTab: 'guida' })} onClick={(e) => { e.preventDefault(); handleTabChange('guida'); }} className="text-xs font-bold text-accent no-underline hover:underline">{t('nav.guida')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {([
 { sub: 'first-day' as const, label: t('guide.tabs.firstDay') },
 { sub: 'permits' as const, label: t('guide.tabs.permits') },
 { sub: 'border' as const, label: t('guide.tabs.border') },
 { sub: 'unemployment' as const, label: t('guide.tabs.unemployment') },
 { sub: 'car-transfer' as const, label: t('guide.tabs.carTransfer') },
 { sub: 'car-cost' as const, label: t('strumenti.carCost') },
 { sub: 'permit-compare' as const, label: t('strumenti.permitCompare') },
 { sub: 'border-map' as const, label: t('comparators.borderMap') },
 ] as const).map(({ sub, label }) => (
 <li key={sub}>
 <a
 href={buildPath({ activeTab: 'guida', guidaSubTab: sub })}
 onClick={(e) => { e.preventDefault(); setGuidaSubTab(sub); setActiveTab('guida'); pushRoute({ activeTab: 'guida', guidaSubTab: sub }); }}
 className="block text-xs text-muted hover:text-accent no-underline hover:underline leading-relaxed py-1"
 >{label}</a>
 </li>
 ))}
 </ul>
 </div>
 {/* Vita */}
 <div>
 <a href={buildPath({ activeTab: 'vita' })} onClick={(e) => { e.preventDefault(); handleTabChange('vita'); }} className="text-xs font-bold text-warning no-underline hover:underline">{t('nav.vita')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {([
 { sub: 'living-ch' as const, label: t('guide.tabs.livingCH') },
 { sub: 'living-it' as const, label: t('guide.tabs.livingIT') },
 { sub: 'companies' as const, label: t('guide.tabs.companies', getCantonI18nParams()) },
 { sub: 'schools' as const, label: t('guide.tabs.schools') },
 { sub: 'nursery' as const, label: t('comparators.nursery') },
 { sub: 'places' as const, label: t('guide.tabs.places') },
 { sub: 'transport' as const, label: t('comparators.transport') },
 { sub: 'municipalities' as const, label: t('guide.tabs.municipalities') },
 ] as const).map(({ sub, label }) => (
 <li key={sub}>
 <a
 href={buildPath({ activeTab: 'vita', vitaSubTab: sub })}
 onClick={(e) => { e.preventDefault(); setVitaSubTab(sub); setActiveTab('vita'); pushRoute({ activeTab: 'vita', vitaSubTab: sub }); }}
 className="block text-xs text-muted hover:text-warning no-underline hover:underline leading-relaxed py-1"
 >{label}</a>
 </li>
 ))}
 </ul>
 </div>
 {/* Statistiche */}
 <div>
 <a href={buildPath({ activeTab: 'stats' })} onClick={(e) => { e.preventDefault(); handleTabChange('stats'); }} className="text-xs font-bold text-accent no-underline hover:underline">{t('nav.stats')}</a>
 <ul className="mt-1 space-y-0.5 list-none p-0">
 {([
 { sub: 'jobs-observatory' as const, label: t('stats.tabJobsObservatory') },
 { sub: 'livability' as const, label: t('strumenti.livability') },
 { sub: 'salary-compare' as const, label: t('strumenti.salaryCompare') },
 { sub: 'traffic-history' as const, label: t('stats.trafficHistory') },
 { sub: 'unemployment' as const, label: t('stats.tabUnemployment') },
 { sub: 'mortgage' as const, label: t('stats.tabMortgage') },
 { sub: 'fuel-prices' as const, label: t('stats.tabFuelPrices') },
 ] as const).map(({ sub, label }) => (
 <li key={sub}>
 <a
 href={buildPath({ activeTab: 'stats', statsSubTab: sub })}
 onClick={(e) => { e.preventDefault(); setStatsSubTab(sub); setActiveTab('stats'); pushRoute({ activeTab: 'stats', statsSubTab: sub }); }}
 className="block text-xs text-muted hover:text-accent no-underline hover:underline leading-relaxed py-1"
 >{label}</a>
 </li>
 ))}
 </ul>
 </div>
 {/* Articoli / Blog */}
 <div>
 <a href={buildPath({ activeTab: 'blog' })} onClick={(e) => { e.preventDefault(); handleTabChange('blog'); }} className="text-xs font-bold text-danger no-underline hover:underline">{t('nav.blog')}</a>
 <a href={buildPath({ activeTab: 'blog' })} onClick={(e) => { e.preventDefault(); handleTabChange('blog'); }} className="block mt-1 text-xs text-muted hover:text-danger no-underline hover:underline leading-relaxed py-1 cursor-pointer">{t('blog.subtitle')}</a>
 </div>
 </div>
 </nav>

 {/* E-E-A-T alias links — SPA-routed for crawler discoverability */}
 <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mt-3 text-[10px] text-muted">
 <a href={buildPath({ activeTab: 'chi-siamo' as any })} onClick={(e) => { e.preventDefault(); navigateTo('chi-siamo' as any); }} className="hover:text-subtle no-underline">About</a>
 <span>·</span>
 <a href={buildPath({ activeTab: 'contact' as any })} onClick={(e) => { e.preventDefault(); navigateTo('contact' as any); }} className="hover:text-subtle no-underline">Contact</a>
 <span>·</span>
 <a href={buildPath({ activeTab: 'privacy' })} onClick={(e) => { e.preventDefault(); navigateTo('privacy' as any); }} className="hover:text-subtle no-underline">Privacy Policy</a>
 </div>

 <div className="flex items-center justify-center gap-1.5 mt-3 text-xs text-success font-medium">
 <Shield className="w-3 h-3" />
 <span>{t('footer.securityBadge')}</span>
 </div>
 </div>
 </div>
 </footer>
   );
   return footerPortalTarget ? createPortal(footerJsx, footerPortalTarget) : footerJsx;
 })()}
 {/* Mobile Bottom Navigation Bar */}
 <nav aria-label="Navigazione mobile" className="fixed bottom-0 inset-x-0 z-50 md:hidden bg-surface/95 border-t border-edge/50 pb-[env(safe-area-inset-bottom,0px)]">
 <div className="grid grid-cols-6 h-14">
 {([
 { tab: 'calculator' as const, icon: Calculator, label: t('nav.simulator.mobile') },
 { tab: 'confronti' as const, icon: Layers, label: t('nav.confronti.mobile') },
 { tab: 'fisco' as const, icon: PiggyBank, label: t('nav.fisco.mobile') },
 { tab: 'guida' as const, icon: BookOpen, label: t('nav.guida.mobile') },
 { tab: 'vita' as const, icon: Home, label: t('nav.vita.mobile') },
 { tab: 'stats' as const, icon: BarChart2, label: t('nav.stats.mobile') },
 ] as const).map(({ tab, icon: Icon, label }) => {
 const isActive = activeTab === tab;
 return (
 <a
 key={tab}
 href={buildPath({ activeTab: tab })}
 onClick={(e) => { e.preventDefault(); handleTabChange(tab); }}
 className={`relative flex flex-col items-center justify-center gap-0.5 transition-colors no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
 isActive ? 'text-accent' : 'text-tab-inactive-text'
 }`}
 >
 <Icon size={20} />
 <span className="text-xs font-semibold leading-tight text-center w-full line-clamp-1">{label}</span>
 {isActive && (
 <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-accent rounded-full" />
 )}
 </a>
 );
 })}
 </div>
 </nav>

 <Suspense fallback={null}>
 <NewsletterPopup />
 <NewsletterMount />
 {showWhatsNew && (
 <WhatsNewModal
 open={showWhatsNew}
 onClose={() => setShowWhatsNew(false)}
 />
 )}
 </Suspense>
 <Suspense fallback={null}>
 <AiChatbot
 isLoggedIn={!!authUser}
 onSignIn={chatbotGoogleSignIn}
 onSignInFacebook={chatbotFacebookSignIn}
 onContinueWithEmail={chatbotContinueWithEmail}
 hideOnMobile={activeTab === 'blog'}
 />
 </Suspense>
 </div>
 </NavigationContext.Provider>
 </TabContentContext.Provider>
 </ErrorBoundary>
 );
};

export default App;
