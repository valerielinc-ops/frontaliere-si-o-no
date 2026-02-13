import ReactGA from 'react-ga4';
import { getConfigValue, analytics as firebaseAnalytics } from './firebase';
import { logEvent, setUserProperties, setUserId, type Analytics as FirebaseAnalyticsType } from 'firebase/analytics';

// Safely access environment variable to prevent runtime crashes
// We use optional chaining because import.meta.env might be undefined in some environments
let GA_MEASUREMENT_ID: string | null = null;

// Helper to safely use Firebase Analytics
const logFirebaseEvent = (eventName: string, params?: Record<string, any>) => {
  try {
    if (firebaseAnalytics) {
      logEvent(firebaseAnalytics, eventName as any, params);
    }
  } catch (error) {
    console.warn('Firebase Analytics event error:', error);
  }
};

// Inizializza l'ID da Firebase Remote Config
async function initGAMeasurementId() {
  if (!GA_MEASUREMENT_ID) {
    GA_MEASUREMENT_ID = await getConfigValue('GA_MEASUREMENT_ID');
  }
  return GA_MEASUREMENT_ID;
}

export const Analytics = {
  isInitialized: false,
  firebaseEnabled: true,

  init: async () => {
    const measurementId = await initGAMeasurementId();
    if (measurementId && !Analytics.isInitialized) {
      ReactGA.initialize(measurementId);
      Analytics.isInitialized = true;
      console.log('✅ GA4 Initialized with Firebase Remote Config');
      console.log('✅ Firebase Analytics Enabled');
    }
  },

  trackPageView: (path: string, title?: string) => {
    if (!Analytics.isInitialized) return;
    
    // Google Analytics
    ReactGA.send({ 
      hitType: "pageview", 
      page: path,
      title: title || path
    });
    
    // Firebase Analytics
    if (Analytics.firebaseEnabled) {
      logFirebaseEvent('page_view', {
        page_path: path,
        page_title: title || path
      });
    }
  },

  trackEvent: (category: string, action: string, label?: string, value?: number) => {
    if (!Analytics.isInitialized) {
      // In dev mode or without ID, log to console for debugging
      console.log(`[Analytics] ${category} - ${action}`, label, value);
      return;
    }
    
    // Google Analytics
    ReactGA.event({
      category,
      action,
      label,
      value
    });
    
    // Firebase Analytics (converti in snake_case per convenzione Firebase)
    if (Analytics.firebaseEnabled) {
      const eventName = `${category.toLowerCase().replace(/\s+/g, '_')}_${action.toLowerCase().replace(/\s+/g, '_')}`;
      logFirebaseEvent(eventName, {
        event_category: category,
        event_label: label,
        value: value
      });
    }
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
    
    // Google Analytics
    ReactGA.event({
      category: 'Exception',
      action: 'App Crash',
      label: description,
      nonInteraction: true
    });
    
    // Firebase Analytics
    if (Analytics.firebaseEnabled) {
      logFirebaseEvent('exception', {
        description: description,
        fatal: fatal
      });
    }
  },

  // Track comparator tool usage
  trackComparatorView: (tool: 'exchange' | 'mobile' | 'transport' | 'health' | 'banks' | 'traffic') => {
    const toolNames: Record<string, string> = {
      exchange: 'Cambio Valuta',
      mobile: 'Telefonia Mobile',
      transport: 'Costi Trasporto',
      health: 'Assicurazione Sanitaria',
      banks: 'Conti Correnti',
      traffic: 'Traffico Valichi'
    };
    Analytics.trackEvent('Comparatori', 'View Tool', toolNames[tool]);
    Analytics.trackPageView(`/comparatori/${tool}`, `Comparatori - ${toolNames[tool]}`);
  },

  // Track currency exchange interactions
  trackCurrencyExchange: (action: 'convert' | 'swap' | 'provider_view', provider?: string, amount?: number) => {
    Analytics.trackEvent('Currency Exchange', action, provider, amount);
  },

  // Track mobile operator comparisons
  trackMobileOperator: (action: 'view' | 'filter' | 'sort' | 'link_click', operator?: string, filter?: string) => {
    Analytics.trackEvent('Mobile Operators', action, operator || filter);
  },

  // Track transport calculator usage
  trackTransportCalculator: (action: 'calculate' | 'change_type' | 'change_param', transportType?: string, value?: number) => {
    Analytics.trackEvent('Transport Calculator', action, transportType, value);
  },

  // Track health insurance interactions
  trackHealthInsurance: (action: 'view_provider' | 'filter' | 'compare', provider?: string) => {
    Analytics.trackEvent('Health Insurance', action, provider);
  },

  // Track bank comparison
  trackBankComparison: (action: 'view_bank' | 'filter' | 'link_click', bank?: string, country?: string) => {
    Analytics.trackEvent('Bank Comparison', action, bank || country);
  },

  // Track traffic alerts usage
  trackTrafficAlerts: (action: 'view' | 'refresh' | 'filter', crossing?: string, waitTime?: number) => {
    Analytics.trackEvent('Traffic Alerts', action, crossing, waitTime);
  },

  // Track API diagnostics page
  trackApiDiagnostics: (action: 'view' | 'refresh' | 'test_api', apiName?: string) => {
    Analytics.trackEvent('API Diagnostics', action, apiName);
  },

  // Track guide sections
  trackGuideSection: (section: string, action: 'view' | 'expand' | 'link_click') => {
    Analytics.trackEvent('Frontier Guide', action, section);
  },

  // Track feedback interactions
  trackFeedback: (action: 'open' | 'submit' | 'cancel', type?: 'bug' | 'feature' | 'question') => {
    Analytics.trackEvent('Feedback', action, type);
  }
};

// Export Firebase Analytics helpers
export const FirebaseAnalytics = {
  setUser: (userId: string) => {
    if (firebaseAnalytics) {
      setUserId(firebaseAnalytics, userId);
    }
  },

  setUserProperty: (name: string, value: string) => {
    if (firebaseAnalytics) {
      setUserProperties(firebaseAnalytics, { [name]: value });
    }
  },

  logCustomEvent: (eventName: string, params?: Record<string, any>) => {
    logFirebaseEvent(eventName, params);
  },

  // Track recommended Firebase events
  trackPurchase: (value: number, currency: string = 'CHF', items?: any[]) => {
    logFirebaseEvent('purchase', {
      value,
      currency,
      items
    });
  },

  trackSelectContent: (contentType: string, itemId: string) => {
    logFirebaseEvent('select_content', {
      content_type: contentType,
      item_id: itemId
    });
  },

  trackSearch: (searchTerm: string) => {
    logFirebaseEvent('search', {
      search_term: searchTerm
    });
  }
};
