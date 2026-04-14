/**
 * useUIState — Manages visual/UI state extracted from App.tsx
 *
 * Handles:
 * - Dark mode (isDarkMode, toggleTheme)
 * - Focus mode
 * - Blob animations (deferred until after LCP)
 * - Deferred home widgets (load on first interaction or fallback timer)
 * - Translations readiness gate
 * - Analytics initialization (consent-aware, interaction-deferred)
 * - SPA pageview tracking (pushState/replaceState/popstate/hashchange)
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation, initLocale, isTranslationsReady, itReady, loadTabTranslations } from '@/services/i18n';
import { setDefaultConsent, onConsentChange, isAnalyticsGranted } from '@/services/consentService';
import type { ActiveTab } from '@/services/router';

import { Analytics, unlockAchievement } from '@/services/analyticsProxy';

// SEO service is lazy-loaded to reduce critical path.
let runtimeSeoEnabled = false;
export const enableRuntimeSeo = () => { runtimeSeoEnabled = true; };

export interface UIState {
 isDarkMode: boolean;
 isFocusMode: boolean;
 showBlobs: boolean;
 showDeferredHomeWidgets: boolean;
 translationsReady: boolean;
 toggleTheme: () => void;
 setIsFocusMode: (v: boolean) => void;
}



export function useUIState(activeTab: ActiveTab): UIState {
 const [translationsReady, setTranslationsReady] = useState(isTranslationsReady);
 const [isDarkMode, setIsDarkMode] = useState(false);
 const [isFocusMode, setIsFocusMode] = useState(false);
 const [showBlobs, setShowBlobs] = useState(false);
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
 });
 }
 }, [translationsReady]);

 useEffect(() => {
 const tabChunkMap: Record<string, string> = {
 confronti: 'comparatori', fisco: 'fisco', guida: 'guide',
 vita: 'vita', stats: 'stats', blog: 'stats',
 };
 const chunk = tabChunkMap[activeTab];
 if (chunk) loadTabTranslations(chunk);
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

 // Analytics Init
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
 Analytics.init();
 Analytics.trackPageView(`${window.location.pathname}${window.location.search}${window.location.hash}`);
 Analytics.trackFunnelStep('entry', { source: document.referrer ? 'referral' : 'direct' });
 Analytics.initGlobalErrorTracking();
 import('@/services/webVitals').then(m => m.initWebVitals()).catch(() => {});
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
 const originalReplaceState = history.replaceState;

 history.pushState = function (...args) {
 const ret = originalPushState.apply(this, args as any);
 trackCurrentLocation();
 return ret;
 } as History['pushState'];

 history.replaceState = function (...args) {
 const ret = originalReplaceState.apply(this, args as any);
 trackCurrentLocation();
 return ret;
 } as History['replaceState'];

 window.addEventListener('popstate', trackCurrentLocation);
 window.addEventListener('hashchange', trackCurrentLocation);

 return () => {
 history.pushState = originalPushState;
 history.replaceState = originalReplaceState;
 window.removeEventListener('popstate', trackCurrentLocation);
 window.removeEventListener('hashchange', trackCurrentLocation);
 };
 }, []);

 // Defer expensive blob animations until after LCP
 useEffect(() => {
 const id = typeof requestIdleCallback === 'function'
 ? requestIdleCallback(() => setShowBlobs(true))
 : setTimeout(() => setShowBlobs(true), 1500) as unknown as number;
 return () => {
 if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id);
 else clearTimeout(id);
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

 const toggleTheme = useCallback(() => {
 const newMode = !isDarkMode;
 setIsDarkMode(newMode);
 Analytics.trackSettingsChange('theme', newMode ? 'dark' : 'light');
 if (newMode) unlockAchievement('dark_mode_fan');

 if (newMode) {
 document.documentElement.classList.add('dark');
 localStorage.theme = 'dark';
 } else {
 document.documentElement.classList.remove('dark');
 localStorage.theme = 'light';
 }
 }, [isDarkMode]);

 return {
 isDarkMode,
 isFocusMode,
 showBlobs,
 showDeferredHomeWidgets,
 translationsReady,
 toggleTheme,
 setIsFocusMode,
 };
}

export { Analytics };
