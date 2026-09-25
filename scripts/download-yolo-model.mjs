#!/usr/bin/env node
/**
 * One-time downloader for the YOLO ONNX vehicle-detection model used by
 * scripts/analyze-webcam-frame.mjs.
 *
 * The model is COMMITTED to the repo (scripts/models/yolov8n.onnx, ~12.8 MB) so
 * CI is offline-reproducible — the collector workflow must NOT download it at
 * runtime. Run this script only to (re)fetch or update the committed model.
 *
 * MODEL: YOLOv8n (Ultralytics, COCO-trained, 80 classes).
 * SOURCE: Hugging Face `SpotLab/YOLOv8Detection`, pinned to commit
 *   3005c6751fb19cdeb6b10c066185908faf66a097 (immutable revision → reproducible).
 *   https://huggingface.co/SpotLab/YOLOv8Detection
 * This is a standard `ultralytics` ONNX export of yolov8n.pt:
 *   input  `images`  : float32 [1, 3, 640, 640] (RGB, 0..1, NCHW)
 *   output `output0` : float32 [1, 84, 8400]    (cx,cy,w,h + 80 class scores)
 * Expected SHA-256:
 *   dd48a79dd7fec8ca25fde4eca742ff7bca23b27e2e903eb23bc1d9f83a459bd2
 *
 * Usage: node scripts/download-yolo-model.mjs
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_URL =
  'https://huggingface.co/SpotLab/YOLOv8Detection/resolve/3005c6751fb19cdeb6b10c066185908faf66a097/yolov8n.onnx';
const EXPECTED_SHA256 =
  'dd48a79dd7fec8ca25fde4eca742ff7bca23b27e2e903eb23bc1d9f83a459bd2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, 'models', 'yolov8n.onnx');

console.log(`⬇️  Downloading YOLOv8n ONNX from ${MODEL_URL}`);
const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(120000) });
if (!res.ok) {
  console.error(`❌ HTTP ${res.status} fetching model`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());

const sha = createHash('sha256').update(buf).digest('hex');
if (sha !== EXPECTED_SHA256) {
  console.error(`❌ SHA-256 mismatch.\n  expected ${EXPECTED_SHA256}\n  got      ${sha}`);
  process.exit(1);
}

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, buf);
console.log(`✅ Saved ${OUT_PATH} (${(buf.length / 1e6).toFixed(1)} MB, sha256 OK). Commit it.`);
