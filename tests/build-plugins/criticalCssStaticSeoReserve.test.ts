/**
 * Unit coverage for the layout-only CSS projection helper.
 *
 * The projection is useful for diagnostics and targeted reserve generation,
 * but the full async-sheet projection must not be concatenated into the
 * render-blocking critical.css. The first-paint contract is covered by
 * critical-css-overlap.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/build-plugins/constants', () => ({ BASE_URL: '' }));

import { CRITICAL_CSS, TAILWIND_PREFLIGHT_RESERVE_CSS } from '@/build-plugins/shared/criticalCss';
import { deriveSeoStaticFirstPaintReserve } from '@/build-plugins/shared/seoStaticFirstPaintReserve';

describe('layout-only CSS projection helper', () => {
  it('keeps layout, drops paint, and preserves source order', () => {
    const out = deriveSeoStaticFirstPaintReserve(
      '.a{color:red;margin:4px;background:blue}.b{padding:8px;box-shadow:0 0 2px #000}',
    );
    expect(out).toBe('.a{margin:4px}.b{padding:8px}');
  });

  it('drops rules without layout declarations and state-only variants', () => {
    expect(deriveSeoStaticFirstPaintReserve('.a{color:red}.b{margin:0}')).toBe('.b{margin:0}');
    expect(deriveSeoStaticFirstPaintReserve('.a:hover,.b{margin:0}.c:focus{margin:0}')).toBe(
      '.b{margin:0}',
    );
  });

  it('drops print media while preserving screen conditions and source order', () => {
    const out = deriveSeoStaticFirstPaintReserve(
      '.a{margin:0}@media print{.p{display:none}}@media (min-width:640px){.a{margin:8px}}.z{padding:1px}',
    );
    expect(out).toBe('.a{margin:0}@media (min-width:640px){.a{margin:8px}}.z{padding:1px}');
  });

  it('can project only the requested selectors without leaking siblings', () => {
    expect(
      deriveSeoStaticFirstPaintReserve('.cth-page{padding:8px}.other{margin:0}', {
        selectorFilter: (selector) => selector.includes('.cth-page'),
      }),
    ).toBe('.cth-page{padding:8px}');
  });

  it('keeps border geometry without leaking border paint', () => {
    expect(deriveSeoStaticFirstPaintReserve('.a{border:1px solid var(--color-edge)}')).toBe(
      '.a{border-width:1px;border-style:solid}',
    );
    expect(deriveSeoStaticFirstPaintReserve('.a{border:1px red}')).toBe(
      '.a{border-width:1px;border-style:none}',
    );
  });

  it('ignores declaration at-rules and handles quoted braces', () => {
    expect(
      deriveSeoStaticFirstPaintReserve(
        '@font-face{font-family:X;src:url(a.woff2)}@keyframes k{from{margin:0}to{margin:9px}}.a{content:"}";margin:1px}',
      ),
    ).toBe('.a{margin:1px}');
  });

  it('keeps the last declaration and merges adjacent blocks', () => {
    expect(deriveSeoStaticFirstPaintReserve('.a{margin:1px;margin:2px}')).toBe('.a{margin:2px}');
    expect(deriveSeoStaticFirstPaintReserve('.a{margin:1px}.a{padding:2px}')).toBe(
      '.a{margin:1px;padding:2px}',
    );
  });

  it('keeps only the preflight mirror in critical.css', () => {
    expect(CRITICAL_CSS).toContain(TAILWIND_PREFLIGHT_RESERVE_CSS);
    expect(CRITICAL_CSS).not.toContain('.jc-card{border-style:solid');
    expect(CRITICAL_CSS).not.toContain('.s-MwMbiH{');
  });
});
