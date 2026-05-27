/**
 * Tests for TrafficHistory component — verifies Firestore-first data loading
 * with fallback to the hardcoded CROSSING_PATTERNS model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import TrafficHistory from '@/components/guide/TrafficHistory';

// ─── Mock firebase/firestore ────────────────────────────────────

const mockGetDocs = vi.fn();

vi.mock('@/services/firebase', () => ({
  getApp: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/services/errorReporter', () => ({
  reportCaughtError: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn((_db: unknown, ...pathSegments: string[]) => ({ path: pathSegments.join('/') })),
  query: vi.fn((...args: unknown[]) => args[0]),
  orderBy: vi.fn(),
  limit: vi.fn(),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────

/** Creates a minimal Firestore snapshot with the given docs */
function fakeSnapshot(docs: Record<string, unknown>[]) {
  return {
    size: docs.length,
    empty: docs.length === 0,
    forEach: (cb: (d: { data: () => Record<string, unknown> }) => void) =>
      docs.forEach(d => cb({ data: () => d })),
  };
}

/** Generates N snapshot docs for a given day/hour with a specific wait time */
function generateDocs(count: number, day: number, hour: number, totalMinutes: number) {
  return Array.from({ length: count }, () => ({
    dayOfWeek: day,
    hour,
    totalCrossingMinutes: totalMinutes,
    waitTimeMinutes: totalMinutes - 1,
    status: totalMinutes < 5 ? 'green' : totalMinutes < 15 ? 'yellow' : 'red',
    direction: 'IT → CH',
    lastUpdate: { toDate: () => new Date() },
  }));
}

// ─── Tests ──────────────────────────────────────────────────────

describe('TrafficHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
  });

  it('renders with fallback model when Firestore returns no data', async () => {
    mockGetDocs.mockResolvedValue(fakeSnapshot([]));

    render(<TrafficHistory />);

    await waitFor(() => {
      expect(screen.getByText(/modello statistico/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    // Heatmap should still render with model data
    expect(screen.getByText(/mappa dei tempi/i)).toBeInTheDocument();
  });

  it('renders with fallback model when Firestore throws', async () => {
    mockGetDocs.mockRejectedValue(new Error('Network error'));

    render(<TrafficHistory />);

    await waitFor(() => {
      expect(screen.getByText(/modello statistico/i)).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('shows real data badge when Firestore has enough snapshots', async () => {
    // Generate 30 docs spread across Monday 7AM and Monday 8AM for chiasso-strada
    const docs = [
      ...generateDocs(15, 1, 7, 12),
      ...generateDocs(15, 1, 8, 18),
    ];

    mockGetDocs.mockResolvedValue(fakeSnapshot(docs));

    render(<TrafficHistory />);

    await waitFor(() => {
      expect(screen.getByText(/dati reali/i)).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('shows loading state initially', () => {
    mockGetDocs.mockImplementation(() => new Promise(() => {})); // never resolves

    render(<TrafficHistory />);

    expect(screen.getByText(/caricamento/i)).toBeInTheDocument();
  });

  it('falls back when snapshot count is below threshold', async () => {
    // Only 10 docs — below MIN_SNAPSHOTS_FOR_REAL_DATA (20)
    const docs = generateDocs(10, 1, 7, 12);
    mockGetDocs.mockResolvedValue(fakeSnapshot(docs));

    render(<TrafficHistory />);

    await waitFor(() => {
      expect(screen.getByText(/modello statistico/i)).toBeInTheDocument();
    }, { timeout: 5000 });
  });
});
