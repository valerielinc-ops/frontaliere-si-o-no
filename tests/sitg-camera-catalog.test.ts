import { describe, expect, it, vi } from 'vitest';
import {
  ch1903ToWgs84,
  fetchSITGCameraFeeds,
  parseSITGCameraFeatures,
} from '../scripts/lib/sitg-camera-catalog.mjs';
import { feedAnalysisBox } from '../scripts/analyze-webcam-frame.mjs';

describe('SITG Geneva camera catalog', () => {
  it('converts LV03 coordinates near the Geneva border', () => {
    const point = ch1903ToWgs84(496379.11, 112095.07);
    expect(point?.lat).toBeCloseTo(46.15, 1);
    expect(point?.lng).toBeCloseTo(6.08, 1);
  });

  it('maps ArcGIS image attributes to a CV feed with full-frame analysis', () => {
    const feeds = parseSITGCameraFeatures({
      features: [{
        attributes: {
          OBJECTID: 7,
          NOM: 'Bardonnex (douane)',
          IMAGE_ALLER: 'https://app2.ge.ch/tercameras/CAM_14.jpg',
          IMAGE_RETOUR: 'https://app2.ge.ch/tercameras/CAM_14.jpg',
        },
        geometry: { x: 496379.11, y: 112095.07 },
      }],
    });
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({
      key: 'sitg-7',
      url: 'https://app2.ge.ch/tercameras/CAM_14.jpg',
      crossings: ['bardonnex'],
      box: null,
    });
  });

  it('falls back to the official static catalog after an ArcGIS outage', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const feeds = await fetchSITGCameraFeeds(fetchMock);
    expect(feeds.length).toBeGreaterThanOrEqual(4);
    expect(feeds.some((feed) => feed.url.includes('CAM_14'))).toBe(true);
  });
});

describe('webcam feed crop defaults', () => {
  it('uses the entire image when an official catalog has no crop contract', () => {
    expect(feedAnalysisBox({ box: null }, 640, 360)).toEqual([0, 0, 640, 360]);
    expect(feedAnalysisBox({ box: [1, 2, 3, 4] }, 640, 360)).toEqual([1, 2, 3, 4]);
  });
});
