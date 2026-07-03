#!/usr/bin/env node
/**
 * Webcam VEHICLE-DETECTION analysis for border-crossing congestion.
 *
 * Fetches a GIF from the Canton Ticino webcam network, extracts the first frame,
 * and runs a small YOLO object detector (yolov8n, COCO) via onnxruntime-node to
 * COUNT vehicles inside each feed's road zone. The congestion score is the count
 * relative to the feed's "full road" capacity — so a free-flowing but structured
 * road (gantries, lane markings, barriers) no longer false-trips as a queue the
 * way the previous greyscale-variance heuristic did (it read texture, not cars).
 *
 * Output (unchanged contract + `vehicleCount`):
 *   { congestionScore: 0..1|null, queueDetected: bool,
 *     visibility: 'good'|'poor'|'night'|'warming-up', brightness, variance, vehicleCount, feedKey }
 *
 * Visibility gates are kept from the pixel era — YOLO is unreliable at night and
 * in fog/rain, so those frames still return visibility:'night'/'poor' and
 * congestionScore:null (no detection attempted).
 *
 * WARMUP GATING: a newly-introduced feed (`introducedAt` within the last
 * WARMUP_DAYS, default 14) is NOT yet trusted for queue verdicts — its boxes /
 * capacity are calibrated on a single live snapshot and need a grace period to
 * be validated against real traffic conditions. Such a feed is still fetched and
 * scored (informational), but reported as visibility:'warming-up' with
 * queueDetected:false, so aggregateWebcamResults excludes it from the vote.
 *
 * MAJORITY VOTE: with several cameras per crossing (chiasso-brogeda now sees 2),
 * a queue flagged on a SINGLE camera is no longer enough — aggregateWebcamResults
 * requires a majority of the good feeds to agree before emitting queueDetected,
 * cutting the structural false-positive rate of the previous any-one-frame rule.
 *
 * Model: scripts/models/yolov8n.onnx (committed; see scripts/download-yolo-model.mjs
 * for the exact pinned source URL + SHA). CPU inference ~60ms / 640² frame, so a
 * handful of CV feeds per cron run is comfortably within the Actions collector.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

// F5 BIG-IP ASM on www4.ti.ch sets session cookies (dtCookie, BIGipServer*, TS*) on the
// first response. Subsequent requests from the same IP without those cookies get 403.
// The shared per-process cookie jar collects them from each response and resends them on
// the next fetch, exactly as a browser would — restoring session continuity across feeds.
import { buildCookieHeader, updateCookieJar } from './lib/tiChCookieJar.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── YOLO detection constants ────────────────────────────────────────────────
const MODEL_PATH = join(__dirname, 'models', 'yolov8n.onnx');
const INPUT_SIZE = 640;                 // yolov8n square input
const CONF_THRESHOLD = 0.35;            // min class confidence to keep a detection
const IOU_THRESHOLD = 0.45;             // NMS overlap threshold
const DEFAULT_CAPACITY = 10;            // "full road" vehicle count when a feed omits `capacity`
const QUEUE_SCORE_GATE = 0.4;           // congestionScore above which a queue is flagged
// Parse a numeric env var, treating empty/whitespace-only string as UNSET.
// `Number('')` is 0 and `Number.isFinite(0)` is true, so a bare
// `Number.isFinite(Number(process.env.X))` guard would let `WEBCAM_*=''`
// silently coerce to 0 — disabling the warmup window (WARMUP_DAYS=0) or
// collapsing the vote to any-one-camera (fraction 0 → threshold floored to 1).
// Trim first and bail to the default when the result is blank.
export function envNumber(raw, fallback) {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : fallback;
}
// Defaults for the env-tunable warmup window / vote fraction. Named so the
// downstream range guards (isFeedWarmingUp / queueVoteThreshold) can fall back
// to the REAL default rather than to the module constant itself — otherwise a
// degenerate-but-finite env value (e.g. WARMUP_DAYS=0, fraction='0'/-1/>1) would
// recurse onto its own degenerate value (no-op fallback). The literal closes
// that loop by construction.
const DEFAULT_WARMUP_DAYS = 14;
const DEFAULT_QUEUE_VOTE_FRACTION = 0.5;
// Warmup grace window: a feed introduced fewer than this many days ago is scored
// informationally but excluded from the trusted queue vote (its calibration is
// not yet validated against varied light/season/traffic conditions). Env-tunable
// so the window can be widened/shortened without a code change.
export const WARMUP_DAYS = envNumber(process.env.WEBCAM_WARMUP_DAYS, DEFAULT_WARMUP_DAYS);
// Fraction of good feeds that must agree before a crossing is flagged as a queue.
// 0.5 ⇒ a strict majority (>= half, rounded up); env-tunable for calibration
// without a deploy. With a single good feed the vote is trivially that feed.
export const QUEUE_VOTE_FRACTION = envNumber(process.env.WEBCAM_QUEUE_VOTE_FRACTION, DEFAULT_QUEUE_VOTE_FRACTION);
// COCO class ids that count as road vehicles.
const VEHICLE_CLASS_IDS = new Set([2 /* car */, 3 /* motorcycle */, 5 /* bus */, 7 /* truck */]);

// Feed URLs — deduplicated. Multiple crossings may share the same physical camera.
// `box` = road-zone bounding box [left, top, width, height] in ORIGINAL-image pixels;
// only vehicles whose detected box-center falls inside it are counted. The feeds
// now serve 400x225 frames, so boxes cover the carriageway broadly and clip only
// the top sky/overpass band (no vehicles there) — YOLO ignores non-vehicle
// texture, so the tight variance-era crops are no longer needed.
// `capacity` = vehicle count that saturates the score to 1.0 (a "packed road").
//   Calibrated 2026-06-16 against the live free-flow count so normal traffic sits
//   well under the 0.4 queue gate while a bumper-to-bumper jam clears it. Tuned
//   per view: a 4-lane A2 segment fits many more cars than a short booth view.
export const WEBCAM_FEEDS = {
  '01.2S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/01.2S.gif',
    crossings: ['chiasso-centro', 'chiasso-strada'],
    box: [0, 30, 400, 195],
    // Short at-booth urban view (Chiasso centro). Live free-flow ~2 cars (0.20).
    capacity: 10,
  },
  // '00.3S'/'00.3N'/'00.3O' (Brogeda at-booth + interchange + commercial-customs
  // views) REMOVED 2026-07-03 (sibling of issue #3372/#3274): the upstream
  // www4.ti.ch feeds now consistently return HTTP 200 with a 0-byte body
  // (confirmed 3x, ~10s apart). Already dropped from the display catalog in
  // data/borderCrossings.ts (#3274); this registry still had them wired into
  // queue detection, so chiasso-brogeda's vote silently included a dead feed.
  // No replacement filename found. chiasso-brogeda now votes on 03.3S + 04.4N.
  // Stabio/Gaggiolo near road view. This is the camera whose variance heuristic
  // false-reported a 15-min wait on a free-flowing road; vehicle counting fixes it.
  '02.0N': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/02.0N.gif',
    crossings: ['gaggiolo', 'san-pietro'],
    box: [0, 30, 400, 195],
    // Live free-flow / forming-queue ~4 cars (0.33). A packed lane (~12) → ≥1.0.
    capacity: 12,
  },
  '06.8S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/06.8S.gif',
    crossings: ['gaggiolo', 'san-pietro'],
    box: [0, 30, 400, 195],
    // Live free-flow ~5 vehicles (0.36).
    capacity: 14,
  },
  // A2 corridor camera just north of the Chiasso customs (Balerna, km 3.3).
  // Long straight A2 view; live free-flow ~0–2 cars.
  '03.3S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/03.3S.gif',
    crossings: ['chiasso-brogeda'],
    box: [0, 30, 400, 195],
    capacity: 14,
    // New A2-corridor feed (PR #2286). Warmup-gated until calibration is validated.
    introducedAt: '2026-06-16',
  },
  // '07.2N' (A2 Mendrisio interchange, km 7.2) REMOVED 2026-07-03 (issue #3372):
  // the upstream www4.ti.ch feed now returns a confirmed HTTP 404 (checked from
  // multiple vantage points, not a transient cloud-IP block). No replacement feed
  // exists at this exact vantage point; 'gaggiolo' still votes on 02.0N + 06.8S.
  // A2 Melide–Bissone causeway (km 17.84) — the multi-lane road carrying the
  // Campione d'Italia–Bissone crossing. Live moderate flow ~7–8 vehicles; a busy
  // (but moving) causeway view, so capacity is generous to keep flow under the gate.
  '17.84S': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/17.84S.gif',
    crossings: ['campione-d-italia-bissone'],
    box: [0, 30, 400, 195],
    capacity: 24,
    // New A2-corridor feed (PR #2286). Warmup-gated until calibration is validated.
    introducedAt: '2026-06-16',
  },
  // A2 Coldrerio (km 4.4N) — approach corridor north of the Chiasso/Brogeda
  // customs. Live free-flow ~2–3 cars.
  '04.4N': {
    url: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/04.4N.gif',
    crossings: ['chiasso-brogeda'],
    box: [0, 30, 400, 195],
    capacity: 14,
    // New A2-corridor feed (PR #2286). Warmup-gated until calibration is validated.
    introducedAt: '2026-06-16',
  },
};

// Map crossing slug → primary feed key for queue detection (kept for
// back-compat; `analyzeWebcamForCrossing` now aggregates ALL feeds covering a
// crossing via the `crossings` arrays above and falls back to this map).
export const CROSSING_TO_PRIMARY_FEED = {
  'chiasso-centro': '01.2S',
  'chiasso-strada': '01.2S',
  'chiasso-brogeda': '03.3S',
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

// ─── Pure scoring / geometry helpers (unit-testable, no network / no ONNX) ──────

/**
 * Is a feed still inside its warmup grace window? A feed introduced fewer than
 * `warmupDays` ago is scored informationally but excluded from the trusted queue
 * vote — its boxes/capacity are calibrated on a single live snapshot and need a
 * grace period before its CV signal is trusted in production. Pure.
 * @param {{introducedAt?: string}|undefined} feed - feed config (uses `introducedAt` ISO date)
 * @param {number} [now=Date.now()] - current epoch ms (injectable for tests)
 * @param {number} [warmupDays=WARMUP_DAYS] - grace window length in days
 * @returns {boolean} true while the feed is within the warmup window
 */
export function isFeedWarmingUp(feed, now = Date.now(), warmupDays = WARMUP_DAYS) {
  if (!feed?.introducedAt) return false;
  const introMs = new Date(feed.introducedAt).getTime();
  if (!Number.isFinite(introMs)) return false;
  const days = Number.isFinite(warmupDays) && warmupDays > 0 ? warmupDays : DEFAULT_WARMUP_DAYS;
  return now - introMs < days * 24 * 60 * 60 * 1000;
}

/**
 * Count of good feeds that must flag a queue before the crossing is flagged.
 * A strict majority of the `goodCount` good feeds (>= half, rounded up), with a
 * floor of 1 so a single good feed still votes. Pure.
 * @param {number} goodCount - number of good-visibility feeds voting
 * @param {number} [fraction=QUEUE_VOTE_FRACTION] - fraction of feeds that must agree
 * @returns {number} minimum agreeing-feed count to flag a queue (>=1)
 */
export function queueVoteThreshold(goodCount, fraction = QUEUE_VOTE_FRACTION) {
  const n = Math.max(0, Math.floor(goodCount));
  if (n === 0) return 1;
  const f = Number.isFinite(fraction) && fraction > 0 && fraction <= 1 ? fraction : DEFAULT_QUEUE_VOTE_FRACTION;
  return Math.max(1, Math.ceil(n * f));
}

/**
 * Map a vehicle count to a 0..1 congestion score.
 * `capacity` is the per-feed "full road" count; the score saturates at 1.0.
 * Pure: no side effects, no I/O.
 * @param {number} count - vehicles detected inside the road zone (>=0)
 * @param {number} [capacity=DEFAULT_CAPACITY] - vehicles that saturate the score
 * @returns {number} congestion score clamped to [0, 1]
 */
export function vehicleCountToCongestion(count, capacity = DEFAULT_CAPACITY) {
  const n = Number.isFinite(count) ? Math.max(0, count) : 0;
  const cap = Number.isFinite(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY;
  return Math.min(1, n / cap);
}

/**
 * Is the CENTER of an [x1,y1,x2,y2] detection box inside the road zone
 * [left, top, width, height]? Used to count only vehicles on the monitored road.
 * Pure.
 * @param {[number,number,number,number]} box - detection box [x1,y1,x2,y2] in original px
 * @param {[number,number,number,number]} zone - road zone [left, top, width, height] in original px
 * @returns {boolean}
 */
export function boxCenterInZone(box, zone) {
  const [x1, y1, x2, y2] = box;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const [left, top, width, height] = zone;
  return cx >= left && cx <= left + width && cy >= top && cy <= top + height;
}

/**
 * Letterbox geometry: scale `(srcW, srcH)` to fit a `size×size` square keeping
 * aspect ratio, centering with grey padding. Returns the scale + offsets needed
 * to map detections in the square back to original coordinates. Pure.
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} [size=INPUT_SIZE]
 * @returns {{scale:number, padX:number, padY:number, resizeW:number, resizeH:number}}
 */
export function computeLetterbox(srcW, srcH, size = INPUT_SIZE) {
  const scale = Math.min(size / srcW, size / srcH);
  const resizeW = Math.round(srcW * scale);
  const resizeH = Math.round(srcH * scale);
  const padX = Math.floor((size - resizeW) / 2);
  const padY = Math.floor((size - resizeH) / 2);
  return { scale, padX, padY, resizeW, resizeH };
}

/**
 * Map a box from 640-space (letterboxed) back to original-image coordinates. Pure.
 * @param {[number,number,number,number]} box - [x1,y1,x2,y2] in letterboxed 640 space
 * @param {{scale:number, padX:number, padY:number}} lb - from computeLetterbox
 * @returns {[number,number,number,number]} [x1,y1,x2,y2] in original px
 */
export function mapBoxToOriginal([x1, y1, x2, y2], { scale, padX, padY }) {
  return [
    (x1 - padX) / scale,
    (y1 - padY) / scale,
    (x2 - padX) / scale,
    (y2 - padY) / scale,
  ];
}

/** Intersection-over-union of two [x1,y1,x2,y2] boxes. Pure. */
export function iou(a, b) {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Greedy non-max suppression. Detections are {box:[x1,y1,x2,y2], score, classId}.
 * Keeps the highest-scoring box and drops overlaps above `iouThreshold`. Pure.
 * @param {Array<{box:[number,number,number,number], score:number, classId:number}>} dets
 * @param {number} [iouThreshold=IOU_THRESHOLD]
 * @returns {Array<{box:[number,number,number,number], score:number, classId:number}>}
 */
export function nms(dets, iouThreshold = IOU_THRESHOLD) {
  const sorted = [...dets].sort((p, q) => q.score - p.score);
  const kept = [];
  for (const d of sorted) {
    if (kept.every((k) => iou(k.box, d.box) <= iouThreshold)) kept.push(d);
  }
  return kept;
}

/**
 * Parse a raw YOLOv8 detect output tensor into vehicle detections (in 640-space).
 * YOLOv8 ONNX output shape is [1, 84, 8400]: for each of 8400 anchors,
 * rows 0..3 = cx,cy,w,h (in 640 px), rows 4..83 = 80 COCO class scores.
 * The buffer is row-major over [84, 8400], so value(row, i) = data[row*8400 + i].
 * Keeps only VEHICLE classes above `confThreshold`. Pure (no NMS, no zone filter).
 *
 * NOTE on box units: the committed yolov8n.onnx (SpotLab export, see
 * scripts/download-yolo-model.mjs) emits cx,cy,w,h NORMALIZED to [0,1] rather than
 * in 640-pixel units. `coordScale` multiplies them back into the letterboxed
 * INPUT_SIZE² space so mapBoxToOriginal can undo the letterbox. (A vanilla
 * Ultralytics export emits pixel coords → pass coordScale=1.)
 * @param {Float32Array|number[]} data - flat output0 data
 * @param {number} numAnchors - e.g. 8400
 * @param {number} [numClasses=80]
 * @param {number} [confThreshold=CONF_THRESHOLD]
 * @param {number} [coordScale=1] - multiplier applied to cx,cy,w,h (use INPUT_SIZE for normalized exports)
 * @returns {Array<{box:[number,number,number,number], score:number, classId:number}>}
 */
export function parseYoloOutput(data, numAnchors, numClasses = 80, confThreshold = CONF_THRESHOLD, coordScale = 1) {
  const dets = [];
  for (let i = 0; i < numAnchors; i++) {
    // Find the best class among the vehicle classes only.
    let bestId = -1;
    let bestScore = 0;
    for (const classId of VEHICLE_CLASS_IDS) {
      const score = data[(4 + classId) * numAnchors + i];
      if (score > bestScore) {
        bestScore = score;
        bestId = classId;
      }
    }
    if (bestId < 0 || bestScore < confThreshold) continue;
    const cx = data[0 * numAnchors + i] * coordScale;
    const cy = data[1 * numAnchors + i] * coordScale;
    const w = data[2 * numAnchors + i] * coordScale;
    const h = data[3 * numAnchors + i] * coordScale;
    dets.push({
      box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
      score: bestScore,
      classId: bestId,
    });
  }
  return dets;
}

// ─── ONNX session (lazy singleton) + inference ──────────────────────────────────

/** @type {Promise<import('onnxruntime-node').InferenceSession>|null} */
let _sessionPromise = null;

/**
 * Load the YOLO ONNX session once per process (lazy singleton). onnxruntime-node
 * is imported dynamically so importing this module (e.g. for the pure helpers /
 * the WEBCAM_FEEDS registry in tests) never pulls in the native runtime.
 * @returns {Promise<import('onnxruntime-node').InferenceSession>}
 */
function getYoloSession() {
  if (!_sessionPromise) {
    _sessionPromise = (async () => {
      const ort = await import('onnxruntime-node');
      return ort.InferenceSession.create(MODEL_PATH, { logSeverityLevel: 3 });
    })();
  }
  return _sessionPromise;
}

/**
 * Letterbox-resize an image buffer to INPUT_SIZE² and return the NCHW Float32
 * tensor data (RGB, normalized 0..1) plus the letterbox geometry for back-mapping.
 * @param {Buffer} buf - source image bytes (first GIF frame extracted upstream)
 * @returns {Promise<{input: Float32Array, lb: {scale:number,padX:number,padY:number}, srcW:number, srcH:number}>}
 */
async function preprocessFrame(buf) {
  const base = sharp(buf, { animated: false });
  const meta = await base.metadata();
  const srcW = meta.width ?? INPUT_SIZE;
  const srcH = meta.height ?? INPUT_SIZE;
  const lb = computeLetterbox(srcW, srcH, INPUT_SIZE);

  // Resize keeping aspect, then extend with grey (114) padding to a 640² canvas.
  const { data } = await sharp(buf, { animated: false })
    .resize(lb.resizeW, lb.resizeH, { fit: 'fill' })
    .extend({
      top: lb.padY,
      bottom: INPUT_SIZE - lb.resizeH - lb.padY,
      left: lb.padX,
      right: INPUT_SIZE - lb.resizeW - lb.padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // data is HWC RGB uint8; convert to NCHW float32 normalized 0..1.
  const plane = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    input[p] = data[p * 3] / 255;             // R
    input[plane + p] = data[p * 3 + 1] / 255; // G
    input[2 * plane + p] = data[p * 3 + 2] / 255; // B
  }
  return { input, lb, srcW, srcH };
}

/**
 * Run YOLO on a frame buffer and count vehicles inside the feed's road zone.
 * @param {Buffer} buf
 * @param {[number,number,number,number]} zone - road zone in original px
 * @returns {Promise<number>} vehicle count inside the zone
 */
async function detectVehiclesInZone(buf, zone) {
  const ort = await import('onnxruntime-node');
  const session = await getYoloSession();
  const { input, lb } = await preprocessFrame(buf);

  const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const out = await session.run({ [inputName]: tensor });
  const o = out[outputName];
  const [, channels, numAnchors] = o.dims; // [1, 84, 8400]
  const numClasses = channels - 4;

  // This export emits normalized [0,1] coords → scale to the 640 letterbox space.
  const raw = parseYoloOutput(o.data, numAnchors, numClasses, CONF_THRESHOLD, INPUT_SIZE);
  const kept = nms(raw, IOU_THRESHOLD);

  let count = 0;
  for (const d of kept) {
    const orig = mapBoxToOriginal(d.box, lb);
    if (boxCenterInZone(orig, zone)) count++;
  }
  return count;
}

/**
 * Combine per-feed analysis results for one crossing into a single verdict.
 * - Only feeds with `visibility: 'good'` vote. night/poor (no signal) and
 *   warming-up (not-yet-trusted) feeds are ignored — `analyzeWebcamFeed` already
 *   marks a warmup feed `visibility:'warming-up'`, so it never reaches the vote.
 * - MAJORITY VOTE: queueDetected requires a majority of the good feeds to agree
 *   (`queueVoteThreshold`), not just any one camera — with several cameras per
 *   crossing a single false trip no longer flags the crossing. A lone good feed
 *   still decides on its own (threshold floors at 1).
 * - congestionScore stays the MAX across good feeds (worst-camera headline).
 * Pure + synchronous so it is unit-testable without network/sharp.
 * @param {Array<{congestionScore: number|null, queueDetected: boolean, visibility: string, feedKey?: string}|null>} results
 * @param {number} [voteFraction=QUEUE_VOTE_FRACTION] - fraction of good feeds that must agree
 * @returns {{congestionScore: number|null, queueDetected: boolean, visibility: string, feeds: string[]}|null}
 */
export function aggregateWebcamResults(results, voteFraction = QUEUE_VOTE_FRACTION) {
  const present = (results ?? []).filter(Boolean);
  if (present.length === 0) return null;
  const good = present.filter((r) => r.visibility === 'good');
  if (good.length === 0) {
    // No usable camera (all night/poor/warming-up): surface the first feed's
    // visibility so the caller no-ops (consumer only acts on visibility:'good').
    const r = present[0];
    return { congestionScore: r.congestionScore ?? null, queueDetected: false, visibility: r.visibility, feeds: [] };
  }
  const votes = good.filter((r) => r.queueDetected).length;
  const queueDetected = votes >= queueVoteThreshold(good.length, voteFraction);
  const congestionScore = good.reduce((m, r) => Math.max(m, r.congestionScore ?? 0), 0);
  return { congestionScore, queueDetected, visibility: 'good', feeds: good.map((r) => r.feedKey).filter(Boolean) };
}

/**
 * Analyze a single webcam feed via vehicle detection.
 * @param {string} feedKey - Key from WEBCAM_FEEDS (e.g. '01.2S')
 * @returns {Promise<{congestionScore: number|null, queueDetected: boolean, visibility: 'good'|'poor'|'night'|'warming-up', brightness: number|null, variance: number|null, vehicleCount: number|null, feedKey: string} | null>}
 */
export async function analyzeWebcamFeed(feedKey) {
  const feed = WEBCAM_FEEDS[feedKey];
  if (!feed) return null;

  // Warmup gating: a feed introduced within the last WARMUP_DAYS is not yet
  // trusted for a queue verdict — its box/capacity calibration needs a grace
  // period to be validated against real conditions. Report 'warming-up' (no
  // fetch/inference needed) so aggregateWebcamResults excludes it from the vote;
  // a chronic false queueDetected can't propagate to the user during warmup.
  if (isFeedWarmingUp(feed)) {
    return {
      congestionScore: null,
      queueDetected: false,
      visibility: 'warming-up',
      brightness: null,
      variance: null,
      vehicleCount: null,
      feedKey,
    };
  }

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
    // Brightness/variance from the cropped greyscale frame drive the visibility
    // gates (YOLO is unreliable at night / in fog), exactly as before.
    const frame = await sharp(buf, { animated: false })
      .extract({ left, top, width, height })
      .greyscale()
      .toBuffer();

    const stats = await sharp(frame).stats();
    const brightness = stats.channels[0].mean;   // 0-255
    const variance = stats.channels[0].stdev;     // kept for debuggability/visibility gates

    // Night: very low brightness across the crop → YOLO unreliable, no detection.
    if (brightness < 30) {
      return { congestionScore: null, queueDetected: false, visibility: 'night', brightness, variance, vehicleCount: null, feedKey };
    }

    // Poor visibility (fog/rain): full-frame variance collapses globally.
    const fullFrame = await sharp(buf, { animated: false }).greyscale().toBuffer();
    const fullStats = await sharp(fullFrame).stats();
    if (fullStats.channels[0].stdev < 5) {
      return { congestionScore: null, queueDetected: false, visibility: 'poor', brightness, variance, vehicleCount: null, feedKey };
    }

    // Good frame → real vehicle detection.
    const capacity = feed.capacity ?? DEFAULT_CAPACITY;
    const vehicleCount = await detectVehiclesInZone(buf, feed.box);
    const congestionScore = vehicleCountToCongestion(vehicleCount, capacity);

    return {
      congestionScore,
      queueDetected: congestionScore > QUEUE_SCORE_GATE,
      visibility: 'good',
      brightness,
      variance,
      vehicleCount,
      feedKey,
    };
  } catch (err) {
    console.warn(`⚠️ Webcam analysis failed [${feedKey}]: ${err.message}`);
    return null;
  }
}

/**
 * Analyze every queue-detection feed covering a crossing and aggregate.
 * @param {string} crossingSlug
 * @returns {Promise<{congestionScore: number|null, queueDetected: boolean, visibility: string, feeds: string[]}|null>}
 */
export async function analyzeWebcamForCrossing(crossingSlug) {
  const feedKeys = CROSSING_TO_FEEDS[crossingSlug]
    ?? (CROSSING_TO_PRIMARY_FEED[crossingSlug] ? [CROSSING_TO_PRIMARY_FEED[crossingSlug]] : []);
  if (feedKeys.length === 0) return null;
  const results = await Promise.all(feedKeys.map((k) => analyzeWebcamFeed(k)));
  return aggregateWebcamResults(results);
}

// CLI usage:
//   node scripts/analyze-webcam-frame.mjs <feedKey>      → analyze one feed
//   node scripts/analyze-webcam-frame.mjs --crossing <slug> → aggregate a crossing
if (process.argv[1]?.endsWith('analyze-webcam-frame.mjs')) {
  const arg = process.argv[2];
  if (arg === '--crossing') {
    const result = await analyzeWebcamForCrossing(process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
  } else if (arg) {
    const result = await analyzeWebcamFeed(arg);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Usage: node scripts/analyze-webcam-frame.mjs <feedKey>');
    console.log('       node scripts/analyze-webcam-frame.mjs --crossing <slug>');
    console.log('Available feeds:', Object.keys(WEBCAM_FEEDS).join(', '));
  }
}
