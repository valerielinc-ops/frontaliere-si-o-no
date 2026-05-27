import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCrossingTraffic,
  getTomTomRouteTravelTimes,
} from '../functions/src/trafficSchedulerCore.js';

const fetchMock = vi.fn();

describe('traffic provider migration', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests TomTom live route timings with no-traffic travel time enabled', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        routes: [
          {
            summary: {
              travelTimeInSeconds: 420,
              noTrafficTravelTimeInSeconds: 180,
              trafficDelayInSeconds: 240,
            },
          },
        ],
      }),
    });

    const result = await getTomTomRouteTravelTimes(45.1, 9.1, 45.2, 9.2, 'tomtom-key');

    expect(result).toEqual({
      durationNormalSec: 180,
      durationTrafficSec: 420,
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('api.tomtom.com/routing/1/calculateRoute/45.1,9.1:45.2,9.2/json');
    expect(url).toContain('traffic=true');
    expect(url).toContain('computeTravelTimeFor=all');
    expect(url).toContain('routeRepresentation=summaryOnly');
  });

  it('prefers TomTom when available and computes aggregate crossing time', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          routes: [{ summary: { travelTimeInSeconds: 480, noTrafficTravelTimeInSeconds: 180 } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          routes: [{ summary: { travelTimeInSeconds: 240, noTrafficTravelTimeInSeconds: 120 } }],
        }),
      });

    const result = await fetchCrossingTraffic(
      { name: 'Chiasso-Brogeda', lat: 45.8409, lng: 9.0376 },
      { tomtomApiKey: 'tomtom-key', googleApiKey: 'google-key' },
    );

    expect(result.source).toBe('tomtom');
    expect(result.waitTimeMinutes).toBe(5);
    expect(result.approachMinutes).toBe(2);
    expect(result.totalCrossingMinutes).toBe(7);
    expect(result.status).toBe('yellow');
  });

  it('falls back to Google when TomTom is not configured', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'OK',
          rows: [{ elements: [{ status: 'OK', duration: { value: 180 }, duration_in_traffic: { value: 480 } }] }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'OK',
          rows: [{ elements: [{ status: 'OK', duration: { value: 120 }, duration_in_traffic: { value: 240 } }] }],
        }),
      });

    const result = await fetchCrossingTraffic(
      { name: 'Ponte Tresa', lat: 45.967, lng: 8.8589 },
      { googleApiKey: 'google-key' },
    );

    expect(result.source).toBe('google-maps');
    expect(String(fetchMock.mock.calls[0][0])).toContain('maps.googleapis.com/maps/api/distancematrix/json');
  });
});
