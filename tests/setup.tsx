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
    setWorkerType: vi.fn(),
    setUserPreferences: vi.fn(),
  },
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
