import ReactGA from 'react-ga4';

// Safely access environment variable to prevent runtime crashes
// We use optional chaining because import.meta.env might be undefined in some environments
const GA_MEASUREMENT_ID = import.meta.env?.VITE_GA_MEASUREMENT_ID;

export const Analytics = {
  isInitialized: false,

  init: () => {
    if (GA_MEASUREMENT_ID && !Analytics.isInitialized) {
      ReactGA.initialize(GA_MEASUREMENT_ID);
      Analytics.isInitialized = true;
      console.log('GA4 Initialized');
    }
  },

  trackPageView: (path: string) => {
    if (!Analytics.isInitialized) return;
    ReactGA.send({ hitType: "pageview", page: path });
  },

  trackEvent: (category: string, action: string, label?: string, value?: number) => {
    if (!Analytics.isInitialized) {
      // In dev mode or without ID, log to console for debugging
      console.log(`[Analytics] ${category} - ${action}`, label, value);
      return;
    }
    ReactGA.event({
      category,
      action,
      label,
      value
    });
  },

  trackError: (description: string, fatal: boolean = false) => {
    if (!Analytics.isInitialized) {
      console.error(`[Analytics Error] ${description}`);
      return;
    }
    ReactGA.event({
      category: 'Exception',
      action: 'App Crash',
      label: description,
      nonInteraction: true
    });
  }
};