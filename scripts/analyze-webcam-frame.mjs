#!/usr/bin/env node
/**
 * Webcam pixel analysis for border crossing congestion detection.
 *
 * Fetches a GIF from the Canton Ticino webcam network, extracts the first frame,
 * crops the road zone, and computes brightness/variance metrics to estimate
 * whether a queue is visible.
 *
 * Output: { congestionScore: 0-1, queueDetected: bool, visibility: 'good'|'poor'|'night', brightness, variance }
 *
 * Limitations:
 * - Fog/rain → variance collapses (all grey) → false "libero". Detected via variance < 5 threshold.
 * - Night + headlights → brightness spikes on green channel. Use greyscale to reduce sensitivity.
 * - Seasonal baseline drift: baseline updated via WEBCAM_CALIBRATE=1 env var.
 * - Warmup period: first 14 days of operation, output is informational only (no override).
 */

import sharp from 'sharp';

// F5 BIG-IP ASM on www4.ti.ch sets session cookies (dtCookie, BIGipServer*, TS*) on the
// first response. Subsequent requests from the same IP without those cookies get 403.
// This cookie jar collects them from each response and resends them on the next fetch,
// exactly as a browser would — restoring session continuity across all feed fetches.
const tiChCookieJar = new Map();

function buildCookieHeader() {
  if (tiChCookieJar.size === 0) return undefined;
  return [...tiChCookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function updateCookieJar(response) {
  // getSetCookie() returns each Set-Cookie header as a separate string (Node 20+)
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    const [nameValue] = cookie.split(';');
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx > 0) {
      tiChCookieJar.set(nameValue.slice(0, eqIdx).trim(), nameValue.slice(eqIdx + 1).trim());
    }
  }
}

// Feed URLs — deduplicated. Multiple crossings may share the same physical camera.
export const WEBCAM_FEEDS = {
  '01.2S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/01.2S.gif',
    crossings: ['chiasso-centro', 'chiasso-strada'],
    // Road zone bounding box [left, top, width, height] in pixels.
    // Conservative center crop covering approximately the middle 50% of a typical 352x288 GIF.
    box: [80, 100, 192, 88],
    // Baseline variance for empty road (calibrate with WEBCAM_CALIBRATE=1).
    baselineVariance: 18,
  },
  '00.3S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/00.3S.gif',
    crossings: ['chiasso-brogeda'],
    box: [80, 100, 192, 88],
    baselineVariance: 18,
  },
  '00.3N': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/00.3N.gif',
    crossings: ['chiasso-brogeda'],
    box: [80, 100, 192, 88],
    baselineVariance: 18,
  },
  '00.3O': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/00.3O.gif',
    crossings: ['chiasso-brogeda'],
    box: [80, 100, 192, 88],
    baselineVariance: 18,
  },
  '02.0N': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/02.0N.gif',
    crossings: ['gaggiolo', 'san-pietro'],
    box: [80, 100, 192, 88],
    baselineVariance: 18,
  },
  '06.8S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/06.8S.gif',
    crossings: ['gaggiolo'],
    box: [80, 100, 192, 88],
    baselineVariance: 18,
  },
};

// Map crossing slug → primary feed key for queue detection.
export const CROSSING_TO_PRIMARY_FEED = {
  'chiasso-centro': '01.2S',
  'chiasso-strada': '01.2S',
  'chiasso-brogeda': '00.3S',
  'gaggiolo': '02.0N',
  'san-pietro': '02.0N',
};

/**
 * Analyze a single webcam feed.
 * @param {string} feedKey - Key from WEBCAM_FEEDS (e.g. '01.2S')
 * @returns {Promise<{congestionScore: number, queueDetected: boolean, visibility: string, brightness: number, variance: number, feedKey: string} | null>}
 */
export async function analyzeWebcamFeed(feedKey) {
  const feed = WEBCAM_FEEDS[feedKey];
  if (!feed) return null;

  let buf;
  try {
    const cookieHeader = buildCookieHeader();
    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': 'FrontaliereTicino/1.0 (traffic-monitor)',
        'Referer': 'https://www4.ti.ch/',
        'Accept': 'image/gif,image/*,*/*',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    updateCookieJar(res);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn(`⚠️ Webcam fetch failed [${feedKey}]: ${err.message}`);
    return null;
  }

  try {
    const [left, top, width, height] = feed.box;
    // Extract first frame only (animated: false), crop road zone, convert to greyscale
    const frame = await sharp(buf, { animated: false })
      .extract({ left, top, width, height })
      .greyscale()
      .toBuffer();

    const stats = await sharp(frame).stats();
    const brightness = stats.channels[0].mean;   // 0-255
    const variance = stats.channels[0].stdev;    // high = texture = cars visible

    // Night: very low brightness across the crop
    if (brightness < 30) {
      return { congestionScore: null, queueDetected: false, visibility: 'night', brightness, variance, feedKey };
    }

    // Poor visibility (fog/rain): variance collapses globally
    // Check variance of the full uncropped greyscale image too
    const fullFrame = await sharp(buf, { animated: false }).greyscale().toBuffer();
    const fullStats = await sharp(fullFrame).stats();
    if (fullStats.channels[0].stdev < 5) {
      return { congestionScore: null, queueDetected: false, visibility: 'poor', brightness, variance, feedKey };
    }

    // Congestion score: how much variance exceeds the "empty road" baseline
    // Higher variance = more objects (cars) in frame = more congestion
    const baselineVariance = feed.baselineVariance ?? 18;
    const congestionScore = Math.min(1, Math.max(0, (variance - baselineVariance) / 30));

    return {
      congestionScore,
      queueDetected: congestionScore > 0.4,
      visibility: 'good',
      brightness,
      variance,
      feedKey,
    };
  } catch (err) {
    console.warn(`⚠️ Webcam analysis failed [${feedKey}]: ${err.message}`);
    return null;
  }
}

/**
 * Analyze the primary webcam feed for a crossing.
 * @param {string} crossingSlug
 * @returns {Promise<{congestionScore: number|null, queueDetected: boolean, visibility: string}|null>}
 */
export async function analyzeWebcamForCrossing(crossingSlug) {
  const feedKey = CROSSING_TO_PRIMARY_FEED[crossingSlug];
  if (!feedKey) return null;
  return analyzeWebcamFeed(feedKey);
}

// CLI usage: node scripts/analyze-webcam-frame.mjs [feedKey]
if (process.argv[1]?.endsWith('analyze-webcam-frame.mjs')) {
  const feedKey = process.argv[2];
  if (feedKey) {
    const result = await analyzeWebcamFeed(feedKey);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Usage: node scripts/analyze-webcam-frame.mjs <feedKey>');
    console.log('Available feeds:', Object.keys(WEBCAM_FEEDS).join(', '));
  }
}
