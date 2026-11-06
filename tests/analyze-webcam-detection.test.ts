/**
 * Unit tests for the PURE vehicle-detection helpers that back webcam congestion.
 *
 * The detector itself (YOLOv8n via onnxruntime-node) is too heavy for CI, so the
 * real ONNX inference is NOT exercised here. Instead we pin the pure, deterministic
 * pieces that turn raw model output into a congestion verdict:
 *  - vehicleCountToCongestion: count → 0..1 score against per-feed capacity;
 *  - boxCenterInZone: only vehicles whose box-center is on the monitored road count;
 *  - computeLetterbox / mapBoxToOriginal: letterbox geometry round-trips;
 *  - parseYoloOutput: decode the [1,84,8400] tensor → vehicle detections (and the
 *    normalized-coords scaling this export needs);
 *  - iou / nms: overlap dedup.
 */

import { describe, expect, it } from 'vitest';
import {
  vehicleCountToCongestion,
  boxCenterInZone,
  computeLetterbox,
  mapBoxToOriginal,
  iou,
  nms,
  parseYoloOutput,
} from '../scripts/analyze-webcam-frame.mjs';

describe('vehicleCountToCongestion', () => {
  it('is count / capacity, clamped to [0,1]', () => {
    expect(vehicleCountToCongestion(0, 10)).toBe(0);
    expect(vehicleCountToCongestion(4, 8)).toBeCloseTo(0.5);
    expect(vehicleCountToCongestion(5, 10)).toBeCloseTo(0.5);
    expect(vehicleCountToCongestion(10, 10)).toBe(1);
    expect(vehicleCountToCongestion(99, 10)).toBe(1); // saturates, never > 1
  });

  it('crosses the 0.4 queue gate only when count exceeds 40% of capacity', () => {
    // capacity 10: 4 cars = exactly 0.4 (NOT > 0.4 → no queue); 5 cars = 0.5 (queue).
    expect(vehicleCountToCongestion(4, 10) > 0.4).toBe(false);
    expect(vehicleCountToCongestion(5, 10) > 0.4).toBe(true);
  });

  it('falls back to the default capacity for bad input', () => {
    expect(vehicleCountToCongestion(5)).toBeCloseTo(0.5); // default capacity 10
    expect(vehicleCountToCongestion(5, 0)).toBeCloseTo(0.5);
    expect(vehicleCountToCongestion(5, -3)).toBeCloseTo(0.5);
    expect(vehicleCountToCongestion(5, NaN)).toBeCloseTo(0.5);
  });

  it('treats negative / non-finite counts as zero', () => {
    expect(vehicleCountToCongestion(-2, 10)).toBe(0);
    expect(vehicleCountToCongestion(NaN, 10)).toBe(0);
  });
});

describe('boxCenterInZone', () => {
  // zone [left, top, width, height] = x:[80,272], y:[100,188]
  const zone: [number, number, number, number] = [80, 100, 192, 88];

  it('counts a vehicle whose box-center is inside the road zone', () => {
    // center (110, 130) ∈ zone
    expect(boxCenterInZone([100, 120, 120, 140], zone)).toBe(true);
  });

  it('rejects a vehicle whose box-center is above the road zone (sky/overpass)', () => {
    // center (110, 60): y < 100 → outside
    expect(boxCenterInZone([100, 50, 120, 70], zone)).toBe(false);
  });

  it('rejects a vehicle whose box-center is left of the road zone', () => {
    // center (30, 130): x < 80 → outside
    expect(boxCenterInZone([20, 120, 40, 140], zone)).toBe(false);
  });

  it('includes vehicles exactly on the zone boundary', () => {
    // center exactly at (80, 100) = top-left corner
    expect(boxCenterInZone([70, 90, 90, 110], zone)).toBe(true);
    // center exactly at (272, 188) = bottom-right corner
    expect(boxCenterInZone([262, 178, 282, 198], zone)).toBe(true);
  });
});

describe('computeLetterbox + mapBoxToOriginal', () => {
  it('letterboxes a 400x225 frame into 640² with vertical padding', () => {
    const lb = computeLetterbox(400, 225, 640);
    expect(lb.scale).toBeCloseTo(1.6); // 640/400
    expect(lb.resizeW).toBe(640);
    expect(lb.resizeH).toBe(360); // 225 * 1.6
    expect(lb.padX).toBe(0);
    expect(lb.padY).toBe(140); // (640-360)/2
  });

  it('round-trips an original box → 640-space → original', () => {
    const lb = computeLetterbox(400, 225, 640);
    // an original box, projected into 640-space, then mapped back:
    const orig: [number, number, number, number] = [40, 60, 120, 100];
    const in640: [number, number, number, number] = [
      orig[0] * lb.scale + lb.padX,
      orig[1] * lb.scale + lb.padY,
      orig[2] * lb.scale + lb.padX,
      orig[3] * lb.scale + lb.padY,
    ];
    const back = mapBoxToOriginal(in640, lb);
    expect(back[0]).toBeCloseTo(orig[0]);
    expect(back[1]).toBeCloseTo(orig[1]);
    expect(back[2]).toBeCloseTo(orig[2]);
    expect(back[3]).toBeCloseTo(orig[3]);
  });
});

describe('iou', () => {
  it('is 1 for identical boxes', () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1);
  });
  it('is 0 for disjoint boxes', () => {
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
  });
  it('is the overlap ratio for partial overlap', () => {
    // two 10x10 boxes overlapping in a 5x5 corner → inter 25, union 175
    expect(iou([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(25 / 175);
  });
});

describe('nms', () => {
  it('keeps the highest-scoring box and drops heavy overlaps', () => {
    const dets = [
      { box: [0, 0, 10, 10] as [number, number, number, number], score: 0.9, classId: 2 },
      { box: [1, 1, 11, 11] as [number, number, number, number], score: 0.8, classId: 2 }, // overlaps #1
      { box: [50, 50, 60, 60] as [number, number, number, number], score: 0.7, classId: 7 }, // disjoint
    ];
    const kept = nms(dets, 0.45);
    expect(kept).toHaveLength(2);
    expect(kept[0].score).toBe(0.9);
    expect(kept.map((d) => d.classId).sort()).toEqual([2, 7]);
  });
});

describe('parseYoloOutput', () => {
  // Build a synthetic [1, 84, 8400]-style buffer with one car anchor and one
  // person anchor (person must be ignored — not a vehicle class).
  const numAnchors = 4;
  const numClasses = 80;
  const channels = 4 + numClasses;
  const at = (data: Float32Array, row: number, i: number, v: number) => {
    data[row * numAnchors + i] = v;
  };

  it('keeps only vehicle classes above threshold and scales normalized coords', () => {
    const data = new Float32Array(channels * numAnchors);
    // anchor 0: a CAR (class 2) with normalized center (0.5, 0.5), size (0.1, 0.1)
    at(data, 0, 0, 0.5);
    at(data, 1, 0, 0.5);
    at(data, 2, 0, 0.1);
    at(data, 3, 0, 0.1);
    at(data, 4 + 2, 0, 0.9); // car score
    // anchor 1: a PERSON (class 0), high score — must be ignored.
    at(data, 4 + 0, 1, 0.95);
    // anchor 2: a CAR but below threshold.
    at(data, 4 + 2, 2, 0.1);

    const dets = parseYoloOutput(data, numAnchors, numClasses, 0.35, 640);
    expect(dets).toHaveLength(1);
    expect(dets[0].classId).toBe(2);
    expect(dets[0].score).toBeCloseTo(0.9);
    // normalized center 0.5 * 640 = 320, size 0.1 * 640 = 64 → box [288,288,352,352]
    expect(dets[0].box[0]).toBeCloseTo(288);
    expect(dets[0].box[2]).toBeCloseTo(352);
  });

  it('picks the best vehicle class when several score on one anchor', () => {
    const data = new Float32Array(channels * numAnchors);
    at(data, 0, 0, 0.5);
    at(data, 1, 0, 0.5);
    at(data, 2, 0, 0.2);
    at(data, 3, 0, 0.2);
    at(data, 4 + 2, 0, 0.4); // car
    at(data, 4 + 7, 0, 0.8); // truck — higher
    const dets = parseYoloOutput(data, numAnchors, numClasses, 0.35, 640);
    expect(dets).toHaveLength(1);
    expect(dets[0].classId).toBe(7);
    expect(dets[0].score).toBeCloseTo(0.8);
  });
});
