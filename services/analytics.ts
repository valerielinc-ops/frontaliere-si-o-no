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

  trackPageView: (path: string, title?: string) => {
    if (!Analytics.isInitialized) return;
    ReactGA.send({ 
      hitType: "pageview", 
      page: path,
      title: title || path
    });
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

  // Track calculator interactions
  trackCalculation: (workerType: 'old' | 'new', salary: number, hasChildren: boolean) => {
    Analytics.trackEvent('Calculator', 'Calculate', workerType, salary);
    if (hasChildren) {
      Analytics.trackEvent('Calculator', 'Calculate with Children', workerType);
    }
  },

  // Track input changes
  trackInputChange: (field: string, value: string | number | boolean) => {
    Analytics.trackEvent('Input', 'Change Field', field, typeof value === 'number' ? value : undefined);
  },

  // Track UI interactions
  trackUIInteraction: (element: string, action: string, details?: string) => {
    Analytics.trackEvent('UI Interaction', action, `${element}${details ? ` - ${details}` : ''}`);
  },

  // Track focus mode toggle
  trackFocusMode: (enabled: boolean) => {
    Analytics.trackEvent('UX', 'Focus Mode', enabled ? 'Enabled' : 'Disabled');
  },

  // Track border crossing filter usage
  trackBorderFilter: (filterType: string, resultCount: number) => {
    Analytics.trackEvent('Border Crossings', 'Apply Filter', filterType, resultCount);
  },

  // Track municipality selection
  trackMunicipalityView: (municipalityName: string, taxLevel: string) => {
    Analytics.trackEvent('Municipalities', 'View Details', `${municipalityName} - ${taxLevel}`);
  },

  // Track expense management
  trackExpense: (action: 'add' | 'edit' | 'delete', category: string, amount?: number) => {
    Analytics.trackEvent('Expenses', action, category, amount);
  },

  // Track pension planner interactions
  trackPensionPlanner: (action: string, years?: number, amount?: number) => {
    Analytics.trackEvent('Pension Planner', action, years ? `${years} years` : undefined, amount);
  },

  // Track social sharing
  trackShare: (platform: string, content: string) => {
    Analytics.trackEvent('Social', 'Share', `${platform} - ${content}`);
  },

  // Track external links
  trackExternalLink: (url: string, label?: string) => {
    Analytics.trackEvent('External Link', 'Click', label || url);
  },

  // Track comparison chart interactions
  trackChartInteraction: (chartType: string, action: string) => {
    Analytics.trackEvent('Chart', action, chartType);
  },

  // Track settings changes
  trackSettingsChange: (setting: string, value: string | boolean) => {
    Analytics.trackEvent('Settings', 'Change', `${setting}: ${value}`);
  },

  // Track tab navigation with more details
  trackTabNavigation: (from: string, to: string) => {
    Analytics.trackEvent('Navigation', 'Tab Change', `${from} → ${to}`);
    Analytics.trackPageView(`/${to}`, `Frontaliere - ${to}`);
  },

  // Track time-based border crossing recommendations
  trackBorderTimeSelection: (timeSlot: string, recommendedCount: number) => {
    Analytics.trackEvent('Border Crossings', 'Time Selection', timeSlot, recommendedCount);
  },

  // Track map interactions
  trackMapInteraction: (mapType: string, action: string, location?: string) => {
    Analytics.trackEvent('Map', action, `${mapType}${location ? ` - ${location}` : ''}`);
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