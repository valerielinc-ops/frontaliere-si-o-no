/**
 * Tests for the live border-wait popup merge in BorderMunicipalitiesMap.tsx
 * (issue #4892). The map used to render a static field populated on only
 * 32/143 crossings, showing "n.d." for the rest even though live wait data
 * already existed for ~140/143 in data/border-wait-current.json.
 *
 * Covers the task's three required scenarios:
 *  1. merging static + live data produces the expected value for a real crossing
 *  2. a crossing absent from the live snapshot doesn't regress (falls back)
 *  3. a failed/null fetch doesn't break rendering or hang in a loading state
 *
 * All crossing names/slugs are read structurally from the real
 * data/borderCrossings.ts + services/borderCrossingSlug.ts — no hardcoded
 * slug string. Fixture timestamps use an offset from a fixed `now`, never a
 * hardcoded absolute date.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import BorderMunicipalitiesMap from '@/components/guide/BorderMunicipalitiesMap';
import { borderCrossings } from '@/data/borderCrossings';
import { slugifyCrossingName } from '@/services/borderCrossingSlug';
import type { BorderWaitCurrentSnapshot } from '@/services/borderWaitCurrentService';

const mockFetchBorderWaitCurrent = vi.fn();

vi.mock('@/services/borderWaitCurrentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/borderWaitCurrentService')>();
  return {
    ...actual,
    // Keep effectiveWaitMinutes real (component imports it directly); only
    // the network entrypoint is faked.
    fetchBorderWaitCurrent: () => mockFetchBorderWaitCurrent(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Finds the rendered popup <div data-testid="popup"> that contains the given crossing name. */
function popupFor(crossingName: string): HTMLElement {
  const nameEl = screen.getByText(crossingName);
  const popup = nameEl.closest('[data-testid="popup"]');
  if (!popup) throw new Error(`No popup ancestor found for crossing "${crossingName}"`);
  return popup as HTMLElement;
}

describe('BorderMunicipalitiesMap — live border-wait popup (#4892)', () => {
  it('merges live data into the popup for a crossing present in the snapshot', async () => {
    const liveCrossing = borderCrossings[0];
    const liveSlug = slugifyCrossingName(liveCrossing.name);
    const lastUpdate = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago

    const snapshot: BorderWaitCurrentSnapshot = {
      updatedAt: new Date().toISOString(),
      perCrossing: {
        [liveSlug]: {
          waitTimeMinutes: 4,
          totalCrossingMinutes: 9,
          status: 'green',
          source: 'here',
          lastUpdate,
        },
      },
    };
    mockFetchBorderWaitCurrent.mockResolvedValue(snapshot);

    render(<BorderMunicipalitiesMap />);

    await waitFor(() => {
      const popup = popupFor(liveCrossing.name);
      // effectiveWaitMinutes prefers totalCrossingMinutes (9) over waitTimeMinutes (4).
      expect(within(popup).getByText('9 min')).toBeInTheDocument();
    });

    const popup = popupFor(liveCrossing.name);
    expect(within(popup).getByText(/6 min/)).toBeInTheDocument();
    // Static "AM: n.d." fallback line must NOT render once live data is present.
    expect(within(popup).queryByText(/^⏱ AM:/)).not.toBeInTheDocument();
  });

  it('falls back to the static field for a crossing absent from the live snapshot (no regression)', async () => {
    const liveCrossing = borderCrossings[0];
    const liveSlug = slugifyCrossingName(liveCrossing.name);
    // Pick a real crossing guaranteed absent from the snapshot below (snapshot
    // only ever contains liveSlug).
    const missingCrossing = borderCrossings.find(bc => slugifyCrossingName(bc.name) !== liveSlug)!;
    expect(missingCrossing).toBeDefined();

    const snapshot: BorderWaitCurrentSnapshot = {
      updatedAt: new Date().toISOString(),
      perCrossing: {
        [liveSlug]: { waitTimeMinutes: 4, totalCrossingMinutes: 9, status: 'green', source: 'here', lastUpdate: new Date().toISOString() },
      },
    };
    mockFetchBorderWaitCurrent.mockResolvedValue(snapshot);

    render(<BorderMunicipalitiesMap />);

    await waitFor(() => {
      expect(screen.getByText(missingCrossing.name)).toBeInTheDocument();
    });

    const popup = popupFor(missingCrossing.name);
    // Same fallback the component always had: static avgWaitMorning, else 'n.d.'.
    const expectedFallback = missingCrossing.avgWaitMorning ?? 'n.d.';
    expect(within(popup).getByText(`⏱ AM: ${expectedFallback}`)).toBeInTheDocument();
  });

  it('does not break rendering or hang when the live fetch fails (resolves null)', async () => {
    mockFetchBorderWaitCurrent.mockResolvedValue(null);
    const anyCrossing = borderCrossings[0];

    render(<BorderMunicipalitiesMap />);

    // Renders immediately with the static fallback, not a perpetual loading state.
    await waitFor(() => {
      expect(screen.getByText(anyCrossing.name)).toBeInTheDocument();
    });
    const popup = popupFor(anyCrossing.name);
    const expectedFallback = anyCrossing.avgWaitMorning ?? 'n.d.';
    expect(within(popup).getByText(`⏱ AM: ${expectedFallback}`)).toBeInTheDocument();
  });
});
