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
// The shared per-process cookie jar collects them from each response and resends them on
// the next fetch, exactly as a browser would — restoring session continuity across feeds.
import { buildCookieHeader, updateCookieJar } from './lib/tiChCookieJar.mjs';

// Feed URLs — deduplicated. Multiple crossings may share the same physical camera.
export const WEBCAM_FEEDS = {
  '01.2S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/01.2S.gif',
    crossings: ['chiasso-centro', 'chiasso-strada'],
    // Road zone bounding box [left, top, width, height] in pixels.
    // Conservative center crop covering approximately the middle 50% of a typical 352x288 GIF.
    box: [80, 100, 192, 88],
    // Baseline = free-flow crop stdev + ~4pt noise margin, so flowing traffic
    // scores ~0 and only a denser-than-normal queue clears the 0.4 gate.
    // Recalibrated 2026-06-16 from 3 distinct free-flow frames (median stdev ≈33.6).
    baselineVariance: 38,
  },
  '00.3S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/00.3S.gif',
    crossings: ['chiasso-brogeda'],
    box: [80, 100, 192, 88],
    // Low-texture Brogeda booth: free-flow crop stdev ≈15 (a car at the booth
    // jumps it to ~33). Kept SENSITIVE at 18 (a few points above the empty floor)
    // — this is the at-booth detector, deliberately left untouched.
    baselineVariance: 18,
  },
  // North view over the Brogeda interchange: permanent high-texture structures
  // (multi-lane gantries, buildings) → empty-road stdev ~63 (score 1.00) even with
  // no queue. Registered for display/CLI but EXCLUDED from queue-detection
  // (`cvDetect:false`) so it can't false-trip the multi-feed sanity check.
  '00.3N': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/00.3N.gif',
    crossings: ['chiasso-brogeda'],
    box: [80, 100, 192, 88],
    baselineVariance: 18,
    cvDetect: false,
  },
  // Commercial-customs lane (Brogeda merci): parked/queuing trucks are a constant
  // regardless of passenger-car wait → stdev ~34 (score 0.54) chronically.
  // Display/CLI only; excluded from queue-detection.
  '00.3O': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/00.3O.gif',
    crossings: ['chiasso-brogeda'],
    box: [80, 100, 192, 88],
    baselineVariance: 18,
    cvDetect: false,
  },
  // Primary Gaggiolo / San Pietro view. Free-flow median stdev ≈21.5 (3 distinct
  // frames 2026-06-16). The old baseline of 18 made normal flow score ~0.5 → the
  // false "15 min" the owner reported. Recalibrated so free-flow scores ~0.
  '02.0N': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/02.0N.gif',
    crossings: ['gaggiolo', 'san-pietro'],
    box: [80, 100, 192, 88],
    baselineVariance: 25,
  },
  // Gaggiolo southbound. Free-flow median stdev ≈32.3 (3 distinct frames 2026-06-16).
  '06.8S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/06.8S.gif',
    crossings: ['gaggiolo', 'san-pietro'],
    box: [80, 100, 192, 88],
    baselineVariance: 36,
  },
  // A2 corridor camera just north of the Chiasso customs (Balerna, km 3.3).
  // Box shifted right of the default to exclude the textured noise-barrier wall
  // on the left (which otherwise inflates variance → false queue). Free-flow
  // median stdev ≈23.7 over 3 distinct frames 2026-06-16 (swing ≈6, NOT the
  // >15 erratic swing seen on prior days → kept CV-eligible). A real queue here
  // pushes stdev well above 32 → clears the 0.4 gate.
  '03.3S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/03.3S.gif',
    crossings: ['chiasso-brogeda'],
    box: [120, 120, 180, 90],
    baselineVariance: 28,
  },
  // A2 Mendrisio interchange (km 7.2) — the motorway access funnelling the
  // Stabio/Gaggiolo crossings. Free-flow median stdev ≈37.9 (3 distinct frames 2026-06-16).
  '07.2N': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/07.2N.gif',
    crossings: ['gaggiolo'],
    box: [80, 100, 192, 88],
    baselineVariance: 42,
  },
  // A2 Melide–Bissone causeway (km 17.84) — the road carrying the
  // Campione d'Italia–Bissone crossing. Free-flow median stdev ≈37.9 (3 distinct frames 2026-06-16).
  '17.84S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/17.84S.gif',
    crossings: ['campione-d-italia-bissone'],
    box: [80, 100, 192, 88],
    baselineVariance: 42,
  },
  // A2 Coldrerio (km 4.4N) — approach corridor north of the Chiasso/Brogeda
  // customs. 400x225 GIF. The default center box catches the chevron-painted gore
  // and the textured concrete median barrier (stripes) → inflated variance. Box
  // shifted up-right onto the clean far-carriageway asphalt, excluding the gore,
  // median wall, and the left grass embankment. Free-flow median stdev ≈32.6
  // over 3 distinct frames 2026-06-16 (small box → noisier, swing ≈11); a
  // car-dense queue pushes this view well above 41, clearing the 0.4 gate.
  '04.4N': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/04.4N.gif',
    crossings: ['chiasso-brogeda'],
    box: [160, 35, 110, 45],
    baselineVariance: 37,
  },
};

// Map crossing slug → primary feed key for queue detection (kept for
// back-compat; `analyzeWebcamForCrossing` now aggregates ALL feeds covering a
// crossing via the `crossings` arrays above and falls back to this map).
export const CROSSING_TO_PRIMARY_FEED = {
  'chiasso-centro': '01.2S',
  'chiasso-strada': '01.2S',
  'chiasso-brogeda': '00.3S',
  'gaggiolo': '02.0N',
  'san-pietro': '02.0N',
  'campione-d-italia-bissone': '17.84S',
};

/**
 * Feed keys covering each crossing for QUEUE DETECTION, derived from WEBCAM_FEEDS
 * `crossings`. A crossing's wait estimate is sanity-checked against every camera
 * that sees it (at-booth + approach-corridor), so a queue visible on any one of
 * them is caught. Feeds flagged `cvDetect: false` (commercial-customs lanes,
 * permanent-high-texture views) are DISPLAY-only and excluded here — they would
 * chronically false-trip the detector regardless of the passenger-car queue.
 */
export const CROSSING_TO_FEEDS = Object.entries(WEBCAM_FEEDS).reduce((acc, [key, feed]) => {
  if (feed.cvDetect === false) return acc;
  for (const slug of feed.crossings ?? []) {
    (acc[slug] ??= []).push(key);
  }
  return acc;
}, /** @type {Record<string, string[]>} */ ({}));

/**
 * Combine per-feed analysis results for one crossing into a single verdict.
 * - Only feeds with `visibility: 'good'` vote (night/poor feeds are ignored).
 * - A queue on ANY good feed ⇒ queueDetected (errs toward warning the user).
 * - "All clear" requires EVERY good feed clear ⇒ the suppress-outlier path stays
 *   conservative (won't falsely reassure when one camera still shows a queue).
 * Pure + synchronous so it is unit-testable without network/sharp.
 * @param {Array<{congestionScore: number|null, queueDetected: boolean, visibility: string, feedKey?: string}|null>} results
 * @returns {{congestionScore: number|null, queueDetected: boolean, visibility: string, feeds: string[]}|null}
 */
export function aggregateWebcamResults(results) {
  const present = (results ?? []).filter(Boolean);
  if (present.length === 0) return null;
  const good = present.filter((r) => r.visibility === 'good');
  if (good.length === 0) {
    // No usable camera (all night/poor): surface the first so the caller no-ops.
    const r = present[0];
    return { congestionScore: r.congestionScore ?? null, queueDetected: false, visibility: r.visibility, feeds: [] };
  }
  const queueDetected = good.some((r) => r.queueDetected);
  const congestionScore = good.reduce((m, r) => Math.max(m, r.congestionScore ?? 0), 0);
  return { congestionScore, queueDetected, visibility: 'good', feeds: good.map((r) => r.feedKey).filter(Boolean) };
}

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
  const feedKeys = CROSSING_TO_FEEDS[crossingSlug]
    ?? (CROSSING_TO_PRIMARY_FEED[crossingSlug] ? [CROSSING_TO_PRIMARY_FEED[crossingSlug]] : []);
  if (feedKeys.length === 0) return null;
  const results = await Promise.all(feedKeys.map((k) => analyzeWebcamFeed(k)));
  return aggregateWebcamResults(results);
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
