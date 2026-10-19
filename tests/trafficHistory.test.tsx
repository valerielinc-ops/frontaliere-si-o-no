/**
 * Tests for TrafficHistory component — verifies public read-model loading
 * with fallback to the hardcoded CROSSING_PATTERNS model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import TrafficHistory from '@/components/guide/TrafficHistory';

vi.mock('@/services/errorReporter', () => ({
  reportCaughtError: vi.fn(),
}));

const mockFetch = vi.fn();

// ─── Helpers ────────────────────────────────────────────────────

function mockHistoryResponse(history: Record<string, unknown>) {
  return { ok: true, json: async () => ({ history }) };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('TrafficHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
  });

  it('renders with fallback model when the public read model has no data', async () => {
    mockFetch.mockResolvedValue(mockHistoryResponse({}));

    render(<TrafficHistory />);

    await waitFor(() => {
      expect(screen.getByText(/modello statistico/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    // Heatmap should still render with model data
    expect(screen.getByText(/mappa dei tempi/i)).toBeInTheDocument();
  });

  it('renders with fallback model when the public read model throws', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    render(<TrafficHistory />);

    await waitFor(() => {
      expect(screen.getByText(/modello statistico/i)).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('shows real data badge when the public read model has an aggregate', async () => {
    mockFetch.mockResolvedValue(mockHistoryResponse({
      'Chiasso - Strada': { 1: { 7: 12, 8: 18 } },
    }));

    render(<TrafficHistory />);

    await waitFor(() => {
      expect(screen.getByText(/dati reali/i)).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('shows loading state initially', () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // never resolves

    render(<TrafficHistory />);

    expect(screen.getByText(/caricamento/i)).toBeInTheDocument();
  });

  it('falls back when the server has no aggregate for a below-threshold sample', async () => {
    mockFetch.mockResolvedValue(mockHistoryResponse({}));

    render(<TrafficHistory />);

    await waitFor(() => {
      expect(screen.getByText(/modello statistico/i)).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('does not turn an aggregate without a wait reading into zero-minute history', async () => {
    mockFetch.mockResolvedValue(mockHistoryResponse({
      'Chiasso - Strada': { 1: {} },
    }));

    render(<TrafficHistory />);

    await waitFor(() => {
      expect(screen.getByText(/modello statistico/i)).toBeInTheDocument();
    }, { timeout: 5000 });
    expect(screen.queryByText(/^0 min$/)).not.toBeInTheDocument();
  });
});
