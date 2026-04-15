/**
 * useUIState — Manages visual/UI state extracted from App.tsx
 *
 * Handles:
 * - Dark mode (isDarkMode, toggleTheme)
 * - Focus mode
 * - Deferred home widgets (load on first interaction or fallback timer)
 * - Translations readiness gate
 * - Analytics initialization (consent-aware, interaction-deferred)
 * - SPA pageview tracking (pushState/popstate/hashchange)
 */
import { useState, useEffect, useCallback } from 'react';
import { initLocale, isTranslationsReady, itReady, loadTabTranslations } from '@/services/i18n';
import { onConsentChange, isAnalyticsGranted } from '@/services/consentService';
import type { ActiveTab } from '@/services/router';
import { enableRuntimeSeo } from '@/hooks/seoHelpers';

import { Analytics, unlockAchievement } from '@/services/analyticsProxy';

export interface UIState {
 isDarkMode: boolean;
 isFocusMode: boolean;
 showDeferredHomeWidgets: boolean;
 translationsReady: boolean;
 toggleTheme: () => void;
 setIsFocusMode: (v: boolean) => void;
}

export function useUIState(activeTab: ActiveTab): UIState {
 const [translationsReady, setTranslationsReady] = useState(isTranslationsReady);
 const [isDarkMode, setIsDarkMode] = useState(() => document.documentElement.classList.contains('dark'));
 const [isFocusMode, setIsFocusMode] = useState(false);
 const [showDeferredHomeWidgets, setShowDeferredHomeWidgets] = useState(false);

 // Load per-page IT translations: initial tab + on tab switch
 useEffect(() => {
 if (!translationsReady) {
 itReady.then(async () => {
 const tabChunkMap: Record<string, string> = {
 confronti: 'comparatori', fisco: 'fisco', guida: 'guide',
 vita: 'vita', stats: 'stats', blog: 'stats',
 };
 const chunk = tabChunkMap[activeTab];
 if (chunk) await loadTabTranslations(chunk);
 setTranslationsReady(true);
 }).catch(() => {});
 }
 }, [translationsReady]);

 useEffect(() => {
 const tabChunkMap: Record<string, string> = {
 confronti: 'comparatori', fisco: 'fisco', guida: 'guide',
 vita: 'vita', stats: 'stats', blog: 'stats',
 };
 const chunk = tabChunkMap[activeTab];
 if (chunk) loadTabTranslations(chunk).catch(() => {});
 }, [activeTab]);

 // Initialize theme and Analytics
 useEffect(() => {
 // i18n Init
 initLocale();

 // Theme Init
 if (localStorage.theme === 'dark') {
 setIsDarkMode(true);
 document.documentElement.classList.add('dark');
 } else {
 setIsDarkMode(false);
 document.documentElement.classList.remove('dark');
 }

 // Analytics Init:
 // - immediate if analytics consent already granted
 // - on consent update when user accepts from banner
 // - fallback on first real interaction
 let analyticsReady = false;
 const analyticsEvents: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
 const listenerOptions: AddEventListenerOptions = { passive: true };
 const cleanupAnalyticsListeners = () => {
 analyticsEvents.forEach((eventName) => {
 window.removeEventListener(eventName, initAnalytics, listenerOptions);
 });
 };
 const initAnalytics = () => {
 if (analyticsReady || !isAnalyticsGranted()) return;
 analyticsReady = true;
 enableRuntimeSeo();
 cleanupAnalyticsListeners();
 // FRO-329: defer heavy analytics/tracking init to idle callback
 // so it doesn't block the main thread during page interaction.
 const run = () => {
 Analytics.init();
 Analytics.trackPageView(`${window.location.pathname}${window.location.search}${window.location.hash}`);
 Analytics.trackFunnelStep('entry', { source: document.referrer ? 'referral' : 'direct' });
 Analytics.initGlobalErrorTracking();
 import('@/services/webVitals').then(m => m.initWebVitals()).catch(() => {});
 import('@/services/clarity').then(m => m.initClarity()).catch(() => {});
 };
 if ('requestIdleCallback' in window) {
 (window as any).requestIdleCallback(run, { timeout: 3000 });
 } else {
 run();
 }
 };
 analyticsEvents.forEach((eventName) => {
 window.addEventListener(eventName, initAnalytics, listenerOptions);
 });

 if (isAnalyticsGranted()) {
 initAnalytics();
 }

 const unsubscribeConsent = onConsentChange((state) => {
 if (state.analytics) initAnalytics();
 });

 return () => {
 unsubscribeConsent();
 cleanupAnalyticsListeners();
 };
 }, []);

 // Centralized SPA pageview tracking for all route changes
 useEffect(() => {
 const trackCurrentLocation = () => {
 Analytics.trackPageView(`${window.location.pathname}${window.location.search}${window.location.hash}`);
 };

 const originalPushState = history.pushState;

 history.pushState = function (...args) {
 const ret = originalPushState.apply(this, args as any);
 trackCurrentLocation();
 return ret;
 } as History['pushState'];

 // NOTE: replaceState is NOT monkey-patched. App.tsx calls replaceState
 // for URL cleanup (newsletter params, OAuth redirects, legacy paths) —
 // those are not real navigations and should not fire pageview events.

 window.addEventListener('popstate', trackCurrentLocation);
 window.addEventListener('hashchange', trackCurrentLocation);

 return () => {
 history.pushState = originalPushState;
 window.removeEventListener('popstate', trackCurrentLocation);
 window.removeEventListener('hashchange', trackCurrentLocation);
 };
 }, []);

 // Defer non-essential widgets to improve first paint on mobile
 useEffect(() => {
 let done = false;
 const complete = () => {
 if (done) return;
 done = true;
 setShowDeferredHomeWidgets(true);
 events.forEach((eventName) => window.removeEventListener(eventName, complete, listenerOptions));
 clearTimeout(timer);
 };
 const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart'];
 const listenerOptions: AddEventListenerOptions = { passive: true };
 events.forEach((eventName) => window.addEventListener(eventName, complete, listenerOptions));
 const timer = window.setTimeout(complete, 7000);
 if (typeof requestIdleCallback === 'function') {
 requestIdleCallback(complete, { timeout: 7000 });
 }
 return () => {
 events.forEach((eventName) => window.removeEventListener(eventName, complete, listenerOptions));
 clearTimeout(timer);
 };
 }, []);

 // toggleTheme uses functional setter to avoid stale closure
 const toggleTheme = useCallback(() => {
 setIsDarkMode(prev => {
 const newMode = !prev;
 Analytics.trackSettingsChange('theme', newMode ? 'dark' : 'light');
 if (newMode) unlockAchievement('dark_mode_fan');
 if (newMode) {
 document.documentElement.classList.add('dark');
 localStorage.theme = 'dark';
 } else {
 document.documentElement.classList.remove('dark');
 localStorage.theme = 'light';
 }
 return newMode;
 });
 }, []);

 return {
 isDarkMode,
 isFocusMode,
 showDeferredHomeWidgets,
 translationsReady,
 toggleTheme,
 setIsFocusMode,
 };
}
