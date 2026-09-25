/** Official Geneva INFOMOB camera catalog (SITG ArcGIS REST). */

import { BORDER_CROSSINGS, slugifyCrossingName } from '../../functions/src/borderCrossingsData.js';

export const SITG_CAMERA_QUERY_URL = 'https://vector.sitg.ge.ch/arcgis/rest/services/INFOMOB_CAMERA/FeatureServer/0/query';
export const SITG_CAMERA_SOURCE_URL = 'https://sitg.ge.ch/donnees/infomob-camera';

const STATIC_SITG_FEEDS = Object.freeze([
  { id: 'sitg-camera-2', name: 'Vengeron', lat: 46.272, lng: 6.143, url: 'https://app2.ge.ch/tercameras/CAM_2.jpg' },
  { id: 'sitg-camera-4', name: 'Aéroport', lat: 46.233, lng: 6.109, url: 'https://app2.ge.ch/tercameras/CAM_4.jpg' },
  { id: 'sitg-camera-6', name: 'Meyrin', lat: 46.219, lng: 6.094, url: 'https://app2.ge.ch/tercameras/CAM_6.jpg' },
  { id: 'sitg-camera-8', name: 'Vernier', lat: 46.214, lng: 6.089, url: 'https://app2.ge.ch/tercameras/CAM_8.jpg' },
  { id: 'sitg-camera-10', name: 'Bernex', lat: 46.190, lng: 6.063, url: 'https://app2.ge.ch/tercameras/CAM_10.jpg' },
  { id: 'sitg-camera-12', name: 'Perly', lat: 46.152, lng: 6.090, url: 'https://app2.ge.ch/tercameras/CAM_12.jpg' },
  { id: 'sitg-camera-14', name: 'Bardonnex douane', lat: 46.143, lng: 6.091, url: 'https://app2.ge.ch/tercameras/CAM_14.jpg' },
  { id: 'sitg-camera-16', name: 'Bachet', lat: 46.126, lng: 6.137, url: 'https://app2.ge.ch/tercameras/CAM_16.jpg' },
  { id: 'sitg-camera-18', name: 'Route des Jeunes', lat: 46.153, lng: 6.141, url: 'https://app2.ge.ch/tercameras/CAM_18.jpg' },
]);

/** Swiss CH1903/LV03 metres → WGS84 degrees. */
export function ch1903ToWgs84(east, north) {
  const e = Number(east);
  const n = Number(north);
  if (!Number.isFinite(e) || !Number.isFinite(n)) return null;
  const y = (e - 600000) / 1_000_000;
  const x = (n - 200000) / 1_000_000;
  const lat = (16.9023892
    + 3.238272 * x
    - 0.270978 * y ** 2
    - 0.002528 * x ** 2
    - 0.0447 * y ** 2 * x
    - 0.0140 * x ** 3) * 100 / 36;
  const lng = (2.6779094
    + 4.728982 * y
    + 0.791484 * y * x ** 2
    + 0.1306 * y ** 3
    - 0.0436 * x ** 2 * y) * 100 / 36;
  return { lat, lng };
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
}

function crossingForCamera(camera) {
  const label = String(camera.name ?? '').toLowerCase();
  const explicit = label.includes('bardonnex')
    ? 'bardonnex'
    : label.includes('perly')
      ? 'perly'
      : label.includes('meyrin')
        ? 'meyrin-cern'
        : null;
  if (explicit) return explicit;

  const nearest = BORDER_CROSSINGS
    .map((crossing) => ({ crossing, distance: distanceKm(camera, crossing) }))
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest && nearest.distance <= 8 ? slugifyCrossingName(nearest.crossing.name) : null;
}

function imageUrlFromAttributes(attributes = {}) {
  return Object.entries(attributes)
    .filter(([key, value]) => /image/i.test(key) && /^https?:\/\//i.test(String(value ?? '')))
    .map(([, value]) => String(value))
    .find((url) => /\.(?:jpe?g|png)(?:\?|$)/i.test(url)) ?? null;
}

/** Parse ArcGIS features into the feed shape consumed by analyze-webcam-frame. */
export function parseSITGCameraFeatures(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  return features.flatMap((feature) => {
    const attributes = feature?.attributes ?? {};
    const point = ch1903ToWgs84(feature?.geometry?.x, feature?.geometry?.y);
    const url = imageUrlFromAttributes(attributes);
    if (!point || !url) return [];
    const crossing = crossingForCamera({ ...point, name: attributes.NOM ?? attributes.name ?? '' });
    if (!crossing) return [];
    const id = String(attributes.OBJECTID ?? attributes.objectid ?? attributes.NOM ?? url)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    return [{
      key: `sitg-${id}`,
      id: `sitg-${id}`,
      name: String(attributes.NOM ?? attributes.name ?? id),
      url,
      crossings: [crossing],
      // Full-frame analysis: the ArcGIS catalog does not publish a stable crop
      // contract, so analyze-webcam-frame derives the image dimensions first.
      box: null,
      capacity: 14,
      introducedAt: '2026-09-15',
      sourceUrl: SITG_CAMERA_SOURCE_URL,
    }];
  });
}

function fallbackFeeds() {
  return STATIC_SITG_FEEDS.flatMap((camera) => {
    const crossing = crossingForCamera(camera);
    return crossing ? [{
      key: camera.id,
      id: camera.id,
      name: camera.name,
      url: camera.url,
      crossings: [crossing],
      box: null,
      capacity: 14,
      introducedAt: '2026-09-15',
      sourceUrl: SITG_CAMERA_SOURCE_URL,
    }] : [];
  });
}

export async function fetchSITGCameraFeeds(fetchImpl = globalThis.fetch) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    f: 'json',
  });
  try {
    const response = await fetchImpl(`${SITG_CAMERA_QUERY_URL}?${params}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`SITG camera HTTP ${response.status}`);
    const feeds = parseSITGCameraFeatures(await response.json());
    return feeds.length ? feeds : fallbackFeeds();
  } catch (error) {
    console.warn(`⚠️ SITG camera catalog unavailable (${error.message}) — using static catalog`);
    return fallbackFeeds();
  }
}
