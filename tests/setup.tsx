import '@testing-library/jest-dom/vitest';

// Mock window.matchMedia (not available in jsdom)
Object.defineProperty(window, 'matchMedia', {
 writable: true,
 value: vi.fn().mockImplementation((query: string) => ({
 matches: false,
 media: query,
 onchange: null,
 addListener: vi.fn(),
 removeListener: vi.fn(),
 addEventListener: vi.fn(),
 removeEventListener: vi.fn(),
 dispatchEvent: vi.fn(),
 })),
});

// JSDOM does not implement scrollTo; avoid noisy "Not implemented" warnings.
Object.defineProperty(window, 'scrollTo', {
 writable: true,
 value: vi.fn(),
});

// Mock localStorage
const store: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
 value: {
 getItem: (key: string) => store[key] ?? null,
 setItem: (key: string, val: string) => { store[key] = val; },
 removeItem: (key: string) => { delete store[key]; },
 clear: () => { Object.keys(store).forEach(k => delete store[k]); },
 },
});

// Mock Firebase
vi.mock('@/services/firebase', () => ({
 app: {},
 analytics: null,
 db: {},
 getApp: vi.fn(async () => ({})),
 getConfigValue: vi.fn(() => ''),
 createTrace: vi.fn(async () => null),
 measureTrace: vi.fn(async (_name: string, fn: () => Promise<any>) => fn()),
}));

// Mock the real Firebase SDK packages so they never initialise in tests
vi.mock('firebase/analytics', () => ({
 getAnalytics: vi.fn(() => ({})),
 logEvent: vi.fn(),
 setUserId: vi.fn(),
 setUserProperties: vi.fn(),
 isSupported: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('firebase/performance', () => ({
 getPerformance: vi.fn(() => ({})),
 trace: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), putAttribute: vi.fn(), putMetric: vi.fn() })),
}));

// Mock Auth Service
vi.mock('@/services/authService', () => ({
 useAuth: () => ({
 user: null,
 loading: false,
 signIn: vi.fn(),
 signOut: vi.fn(),
 signInFacebook: vi.fn(),
 logout: vi.fn(),
 }),
 signInWithGoogle: vi.fn(),
 signInWithFacebook: vi.fn(),
 signOut: vi.fn(),
 getUserDisplayName: () => '',
 getUserPhotoURL: (_user?: any, _uid?: string) => null,
 getAuthEmail: (user: any) => user?.email || null,
 getLinkedProviders: vi.fn(() => []),
 isEmailLinkSignIn: vi.fn(async () => false),
 signInWithNewsletterEmailLink: vi.fn(async () => null),
 promptOneTap: vi.fn(() => Promise.resolve()),
 eagerAuth: vi.fn(() => Promise.resolve(null)),
 cancelOneTap: vi.fn(),
 renderGoogleButton: vi.fn(),
 deleteCurrentUser: vi.fn(),
 consumeFacebookProfilePrefill: vi.fn(() => null),
 renderGoogleButtonWithReadiness: vi.fn(() => Promise.resolve(false)),
 isLinkedInSignInAvailable: vi.fn(() => Promise.resolve(false)),
 signInWithLinkedIn: vi.fn(() => Promise.resolve(null)),
}));

// Mock Analytics
vi.mock('@/services/analytics', () => ({
 Analytics: {
 init: vi.fn(),
 isInitialized: false,
 trackPageView: vi.fn(),
 trackCalculation: vi.fn(),
 trackTabNavigation: vi.fn(),
 trackSettingsChange: vi.fn(),
 trackFocusMode: vi.fn(),
 trackComparatorView: vi.fn(),
 trackUIInteraction: vi.fn(),
 trackApiDiagnostics: vi.fn(),
 trackError: vi.fn(),
 trackAppError: vi.fn(),
 trackErrorPageView: vi.fn(),
 initGlobalErrorTracking: vi.fn(),
 trackInputChange: vi.fn(),
 trackSelectContent: vi.fn(),
 trackShare: vi.fn(),
 trackSearch: vi.fn(),
 trackGenerateLead: vi.fn(),
 trackBorderFilter: vi.fn(),
 trackMunicipalityView: vi.fn(),
 trackExpense: vi.fn(),
 trackPensionPlanner: vi.fn(),
 trackExternalLink: vi.fn(),
 trackChartInteraction: vi.fn(),
 trackBorderTimeSelection: vi.fn(),
 trackMapInteraction: vi.fn(),
 trackNewsletter: vi.fn(),
 setWorkerType: vi.fn(),
 setUserPreferences: vi.fn(),
 trackFunnelStep: vi.fn(),
 trackConsentChange: vi.fn(),
 },
 extractAppFrames: vi.fn((stack: string) => stack ? 'mock-file.ts:1:1' : ''),
 parseBrowserInfo: vi.fn(() => 'Chrome/125'),
 decodeReactError: vi.fn((msg: string) => msg),
}));

// Mock Consent Service
vi.mock('@/services/consentService', () => ({
 setDefaultConsent: vi.fn(),
 hasConsent: vi.fn(() => true),
 getConsent: vi.fn(() => ({ analytics: true, advertising: false, timestamp: Date.now() })),
 isAnalyticsGranted: vi.fn(() => false),
 isAdvertisingGranted: vi.fn(() => false),
 acceptAll: vi.fn(),
 rejectAll: vi.fn(),
 updateConsent: vi.fn(),
 revokeConsent: vi.fn(),
 onConsentChange: vi.fn(() => () => {}),
}));

// Mock PostHog
vi.mock('@/services/posthog', () => ({
 initPostHog: vi.fn(),
 captureEvent: vi.fn(),
 capturePageView: vi.fn(),
 identifyUser: vi.fn(),
}));

// Mock Web Vitals
vi.mock('@/services/webVitals', () => ({
 initWebVitals: vi.fn(),
}));

// Mock Prefetch
vi.mock('@/services/prefetch', () => ({
 prefetchTab: vi.fn(),
 prefetchOnIdle: vi.fn(),
}));

// Mock SEO Service
vi.mock('@/services/seoService', () => ({
 updateMetaTags: vi.fn(),
 trackSectionView: vi.fn(),
}));

// Mock Leaflet
vi.mock('leaflet', () => ({
 default: {
 divIcon: vi.fn(() => ({})),
 icon: vi.fn(() => ({})),
 marker: vi.fn(() => ({ addTo: vi.fn(), bindPopup: vi.fn() })),
 map: vi.fn(() => ({ setView: vi.fn(), addLayer: vi.fn() })),
 tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
 Icon: {
 Default: {
 prototype: {},
 mergeOptions: vi.fn(),
 },
 },
 },
 divIcon: vi.fn(() => ({})),
 icon: vi.fn(() => ({})),
 Icon: {
 Default: {
 prototype: {},
 mergeOptions: vi.fn(),
 },
 },
}));

vi.mock('react-leaflet', () => ({
 MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
 TileLayer: () => <div data-testid="tile-layer" />,
 Marker: ({ children }: any) => <div data-testid="marker">{children}</div>,
 Popup: ({ children }: any) => <div data-testid="popup">{children}</div>,
}));

// Recharts can emit noisy width/height warnings in JSDOM (no layout engine).
const RechartsMock = ({ children }: any) => <div>{children}</div>;
vi.mock('recharts', () => ({
 ResponsiveContainer: RechartsMock,
 LineChart: RechartsMock,
 Line: RechartsMock,
 AreaChart: RechartsMock,
 Area: RechartsMock,
 BarChart: RechartsMock,
 Bar: RechartsMock,
 PieChart: RechartsMock,
 Pie: RechartsMock,
 Cell: RechartsMock,
 XAxis: RechartsMock,
 YAxis: RechartsMock,
 CartesianGrid: RechartsMock,
 Tooltip: RechartsMock,
 Legend: RechartsMock,
 ReferenceLine: RechartsMock,
 ComposedChart: RechartsMock,
 ScatterChart: RechartsMock,
 Scatter: RechartsMock,
 RadarChart: RechartsMock,
 Radar: RechartsMock,
 PolarGrid: RechartsMock,
 PolarAngleAxis: RechartsMock,
 PolarRadiusAxis: RechartsMock,
 Treemap: RechartsMock,
 FunnelChart: RechartsMock,
 Funnel: RechartsMock,
 LabelList: RechartsMock,
}));
