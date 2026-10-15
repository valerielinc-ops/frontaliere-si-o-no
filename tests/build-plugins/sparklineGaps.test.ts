/**
 * Regression tests for renderSparklineChart (build-plugins/shared/seoContentTokens.ts).
 *
 * Covers:
 *  (a) Returns '' when fewer than 3 numeric points are provided — callers
 *      must render a locale-aware fallback in that case.
 *  (b) On 4 points with one interior null, draws a continuous line that
 *      skips the null (no phantom segment bridging the gap).
 *  (c) viewBox aspect ratio is ≤ 4:1 so the chart does not squash.
 *  (d) Contains preserveAspectRatio="xMidYMid meet" — avoids anisotropic
 *      scaling when the container is wider than the intrinsic viewBox.
 *  (e) Does NOT contain preserveAspectRatio="none" — the prior bug that
 *      stretched the sparkline to the full container height.
 */

import { describe, it, expect } from 'vitest';
import { renderSparklineChart } from '@/build-plugins/shared/seoContentTokens';

const ARIA = 'Test sparkline';

describe('renderSparklineChart — gap and aspect-ratio behaviour', () => {
  it('(a) returns empty string when fewer than 3 numeric points are provided', () => {
    expect(renderSparklineChart([], { ariaLabel: ARIA })).toBe('');
    expect(
      renderSparklineChart([{ date: '2026-04-20', value: 1.9 }], { ariaLabel: ARIA }),
    ).toBe('');
    expect(
      renderSparklineChart(
        [
          { date: '2026-04-20', value: 1.9 },
          { date: '2026-04-21', value: 1.92 },
        ],
        { ariaLabel: ARIA },
      ),
    ).toBe('');
    // Null-only series with two numeric points still below threshold.
    expect(
      renderSparklineChart(
        [
          { date: '2026-04-20', value: 1.9 },
          { date: '2026-04-21', value: null },
          { date: '2026-04-22', value: 1.95 },
        ],
        { ariaLabel: ARIA },
      ),
    ).toBe('');
  });

  it('(b) on 4 points with one null, draws a continuous polyline skipping the null', () => {
    const svg = renderSparklineChart(
      [
        { date: '2026-04-20', value: 1.9 },
        { date: '2026-04-21', value: 1.92 },
        { date: '2026-04-22', value: null },
        { date: '2026-04-23', value: 1.95 },
      ],
      { ariaLabel: ARIA },
    );
    expect(svg).not.toBe('');
    // Line path must exist.
    const linePath = svg.match(/<path d="([^"]+)" fill="none" stroke="var\(--color-chart-line\)/);
    expect(linePath).not.toBeNull();
    const d = linePath![1];
    // Gap handling: there must be two separate M commands (one per contiguous run)
    // rather than a single M-L-L-L that would imply a phantom segment across the null.
    const mCount = (d.match(/M/g) || []).length;
    expect(mCount).toBeGreaterThanOrEqual(2);
    // Only 3 numeric points → exactly 3 circle markers in the SVG.
    const circleCount = (svg.match(/<circle\b/g) || []).length;
    expect(circleCount).toBe(3);
  });

  it('(c) viewBox aspect ratio is ≤ 4:1 so the chart is not squashed', () => {
    const svg = renderSparklineChart(
      [
        { date: '2026-04-20', value: 1.9 },
        { date: '2026-04-21', value: 1.92 },
        { date: '2026-04-22', value: 1.94 },
      ],
      { ariaLabel: ARIA },
    );
    const vb = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
    expect(vb).not.toBeNull();
    const w = Number(vb![1]);
    const h = Number(vb![2]);
    expect(h).toBeGreaterThan(0);
    expect(w / h).toBeLessThanOrEqual(4);
  });

  it('(d) contains preserveAspectRatio="xMidYMid meet"', () => {
    const svg = renderSparklineChart(
      [
        { date: '2026-04-20', value: 1.9 },
        { date: '2026-04-21', value: 1.92 },
        { date: '2026-04-22', value: 1.94 },
      ],
      { ariaLabel: ARIA },
    );
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  it('(e) does NOT contain preserveAspectRatio="none" (regression guard)', () => {
    const svg = renderSparklineChart(
      [
        { date: '2026-04-20', value: 1.9 },
        { date: '2026-04-21', value: 1.92 },
        { date: '2026-04-22', value: 1.94 },
      ],
      { ariaLabel: ARIA },
    );
    expect(svg).not.toContain('preserveAspectRatio="none"');
  });
});
