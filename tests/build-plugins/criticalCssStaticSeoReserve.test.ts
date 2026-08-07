/**
 * Regression gate for the static-SEO FIRST-PAINT reserve added for the desktop
 * CLS failure in issue 5001 point 3.
 *
 * Background
 * ──────────
 * Static SEO pages paint from the render-blocking `/assets/critical.css` and
 * only later apply the two `media="print"`-swapped sheets (`index.css`,
 * `seo-static.css`). Anything those sheets own that critical.css does not
 * reserve therefore paints with UA-default geometry first and snaps into place
 * on the swap. Measured on the production HTML, served locally with only the
 * async sheets differing (Lighthouse 12, desktop preset):
 *
 *   /vivere-in-ticino/comuni-di-frontiera/albiolo/   CLS 0.470 → 0.004
 *   /articoli-frontaliere/lamal-vs-cmi-frontaliere/  CLS 0.653 → 0.002
 *   /cerca-lavoro-ticino/ricerca/                    CLS 0.430 → 0.001
 *   /calcola-stipendio/stipendio-netto-40000-chf/    CLS 0.116 → 0.005
 *   /lavoro-argovia-infermiere/                      CLS 0.412 → 0.003
 *
 * The three properties below are what make that fix hold, and each of them is
 * invisible in a diff — hence the gate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CRITICAL_CSS,
  TAILWIND_THEME_TOKENS_RESERVE_CSS,
  TAILWIND_PREFLIGHT_RESERVE_CSS,
  TAILWIND_UTILITY_RESERVE_CSS,
  SEO_STATIC_SHEET_RESERVE_CSS,
} from '@/build-plugins/shared/criticalCss';
import { deriveSeoStaticFirstPaintReserve } from '@/build-plugins/shared/seoStaticFirstPaintReserve';

const ROOT = resolve(__dirname, '..', '..');
const SEO_STATIC_CSS = readFileSync(resolve(ROOT, 'public', 'assets', 'seo-static.css'), 'utf-8');

describe('static SEO first-paint reserve (issue 5001 point 3)', () => {
  it('derives the seo-static.css reserve FROM the sheet, never from a hand-copy', () => {
    // The four older blocks in criticalCss.ts (hero / search-hub / article-shell
    // / grid) are hand-transcribed `.s-*` rules — one family each, each written
    // after that family showed up in a CLS trace, and each free to drift from
    // the sheet (AGENTS.md §6). This one is a projection of the sheet itself, so
    // the only way it can be wrong is if someone replaces it with a literal.
    expect(SEO_STATIC_SHEET_RESERVE_CSS).toBe(deriveSeoStaticFirstPaintReserve(SEO_STATIC_CSS));
    expect(SEO_STATIC_SHEET_RESERVE_CSS.length).toBeGreaterThan(20_000);
  });

  it('keeps ONLY layout declarations in the derived reserve', () => {
    // Two reasons this matters. (1) Bytes: this block is render-blocking on
    // every static SEO page. (2) AGENTS.md §7 / #1586: a first-paint block that
    // paints, rather than only reserving space, is how a critical-CSS copy
    // starts overriding the real sheet in ways nobody intended — the reserve
    // must be unable to change a single pixel's colour.
    for (const paintProp of [
      'color:', 'background', 'box-shadow', 'transition', 'border-color',
      'border-radius', 'opacity', 'fill:', 'stroke:', 'text-decoration',
    ]) {
      expect(
        SEO_STATIC_SHEET_RESERVE_CSS.includes(paintProp),
        `derived reserve leaked the paint declaration "${paintProp}"`,
      ).toBe(false);
    }
    // `border-width` IS layout (the box grows) and must survive the filter.
    expect(SEO_STATIC_SHEET_RESERVE_CSS).toContain('border-width');
  });

  it('drops state variants from the derived reserve', () => {
    // Nothing is hovered/focused at first paint — dead render-blocking bytes.
    expect(SEO_STATIC_SHEET_RESERVE_CSS).not.toMatch(/:hover|:focus|:active/);
    // …and the source sheet really does carry them, so this is not vacuous.
    expect(SEO_STATIC_CSS).toMatch(/:hover/);
  });

  describe('deriveSeoStaticFirstPaintReserve', () => {
    // Unit-level, on synthetic input: the sheet does not currently exercise
    // every branch (it has no `@media print` today, for instance), and a
    // whole-sheet assertion would go vacuous the moment it stops doing so.
    it('keeps layout, drops paint, and preserves source order', () => {
      const out = deriveSeoStaticFirstPaintReserve(
        '.a{color:red;margin:4px;background:blue}.b{padding:8px;box-shadow:0 0 2px #000}',
      );
      expect(out).toBe('.a{margin:4px}.b{padding:8px}');
    });

    it('drops rules that end up with no layout declaration at all', () => {
      expect(deriveSeoStaticFirstPaintReserve('.a{color:red}.b{margin:0}')).toBe('.b{margin:0}');
    });

    it('drops @media print but keeps screen media conditions, in place', () => {
      const out = deriveSeoStaticFirstPaintReserve(
        '.a{margin:0}@media print{.p{display:none}}@media (min-width:640px){.a{margin:8px}}.z{padding:1px}',
      );
      expect(out).toBe('.a{margin:0}@media (min-width:640px){.a{margin:8px}}.z{padding:1px}');
    });

    it('drops state variants but keeps the rest of the selector list', () => {
      const out = deriveSeoStaticFirstPaintReserve('.a:hover,.b{margin:0}.c:focus{margin:0}');
      expect(out).toBe('.b{margin:0}');
    });

    it('splits border shorthands into width+style and discards the colour', () => {
      // Under-reserving a carded box by its 1px border on each side is a real
      // (if small) shift; carrying `var(--color-edge)` into a first-paint block
      // that must not paint is the bug this split exists to avoid.
      expect(deriveSeoStaticFirstPaintReserve('.a{border:1px solid var(--color-edge)}')).toBe(
        '.a{border-width:1px;border-style:solid}',
      );
      expect(deriveSeoStaticFirstPaintReserve('.a{border-left:3px solid #f00}')).toBe(
        '.a{border-left-width:3px;border-left-style:solid}',
      );
      // A shorthand with no style keyword computes to `none` — zero used width.
      // Mirror that instead of inventing a border that is not there.
      expect(deriveSeoStaticFirstPaintReserve('.a{border:1px red}')).toBe(
        '.a{border-width:1px;border-style:none}',
      );
    });

    it('keeps the last declaration when a block repeats a property', () => {
      expect(deriveSeoStaticFirstPaintReserve('.a{margin:1px;margin:2px}')).toBe('.a{margin:2px}');
    });

    it('merges adjacent blocks that repeat the same selector', () => {
      expect(deriveSeoStaticFirstPaintReserve('.a{margin:1px}.a{padding:2px}')).toBe(
        '.a{margin:1px;padding:2px}',
      );
    });

    it('ignores at-rules that hold declarations rather than rules', () => {
      // @font-face/@keyframes bodies are declaration lists; parsing them as
      // style rules would emit garbage selectors into the first-paint block.
      const out = deriveSeoStaticFirstPaintReserve(
        '@font-face{font-family:X;src:url(a.woff2)}@keyframes k{from{margin:0}to{margin:9px}}.a{margin:1px}',
      );
      expect(out).toBe('.a{margin:1px}');
    });

    it('is not confused by braces inside quoted values', () => {
      expect(deriveSeoStaticFirstPaintReserve('.a::after{content:"}";margin:1px}.b{padding:2px}')).toBe(
        '.a::after{margin:1px}.b{padding:2px}',
      );
    });
  });

  it('covers the three measured shift sources of the derived half', () => {
    // Regression anchors, one per family whose residual the block removed.
    // `.ft-blog-article` — the article prose column (desktop 0.061 → 0.0002).
    expect(SEO_STATIC_SHEET_RESERVE_CSS).toContain('.ft-blog-article{');
    // Raw headings inside a static body (`h1:not([class])` et al.) — the
    // font-metric half of the same shift.
    expect(SEO_STATIC_SHEET_RESERVE_CSS).toContain('main.seo-static-content h1:not([class]){');
    // The BODY FONT. `seo-static.css` overrides this file's metric-matched
    // Inter with "Manrope", which is never loaded anywhere in the site, so the
    // swap re-metrics every text node on the page. Reserving the declaration is
    // what makes first paint agree with the end state; if a future change drops
    // it from the reserve WITHOUT also aligning the two stacks, the sitewide
    // font-swap shift comes straight back.
    expect(SEO_STATIC_SHEET_RESERVE_CSS).toMatch(/body\{[^}]*font-family:"Manrope"/);
  });

  it('keeps the index.css mirrors inside @layer base, never unlayered', () => {
    // THE structural invariant of the Tailwind half. An unlayered author rule
    // beats every layered one forever, so an unlayered copy of `.text-sm` would
    // outrank `index.css`'s own `@layer utilities` permanently — the exact trap
    // documented above CRITICAL_CSS for the `border:0 solid` reset (confirmed
    // live via CDP, 2026-07-28). Inside `@layer base` the copy can only ever
    // govern the pre-swap frame, which is what makes mirroring a compiled
    // stylesheet safe at all.
    const layerBaseBlocks = [...CRITICAL_CSS.matchAll(/@layer base\{/g)];
    expect(layerBaseBlocks.length).toBeGreaterThanOrEqual(2);
    for (const mirror of [
      TAILWIND_THEME_TOKENS_RESERVE_CSS,
      TAILWIND_PREFLIGHT_RESERVE_CSS,
      TAILWIND_UTILITY_RESERVE_CSS,
    ]) {
      const at = CRITICAL_CSS.indexOf(mirror);
      expect(at, 'mirror is not present in CRITICAL_CSS at all').toBeGreaterThan(-1);
      const opened = CRITICAL_CSS.lastIndexOf('@layer base{', at);
      const closedBefore = CRITICAL_CSS.lastIndexOf('}}', at);
      expect(opened, 'index.css mirror must live inside an @layer base block').toBeGreaterThan(-1);
      expect(opened).toBeGreaterThan(closedBefore);
    }
    // The seo-static.css mirror is the opposite case and must stay UNLAYERED:
    // its source sheet is unlayered too, and it is emitted before it, so the
    // real sheet wins on source order. Wrapping it in a layer would let
    // `index.css`'s utilities outrank it at first paint.
    expect(CRITICAL_CSS.endsWith(SEO_STATIC_SHEET_RESERVE_CSS)).toBe(true);
  });

  it('declares every theme token the utility mirror resolves against', () => {
    // Tailwind v4 emits `calc(var(--spacing)*3)` / `var(--text-sm)`. A `var()`
    // with no definition and no fallback makes the whole declaration
    // invalid-at-computed-value-time — the browser DROPS it. So a missing token
    // does not degrade the reserve, it silently deletes the rule and the CLS
    // comes back with a green diff.
    const referenced = new Set(
      [...TAILWIND_UTILITY_RESERVE_CSS.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]),
    );
    expect(referenced.size).toBeGreaterThan(10);
    for (const token of referenced) {
      expect(
        TAILWIND_THEME_TOKENS_RESERVE_CSS.includes(`${token}:`),
        `utility mirror references ${token} but the reserve never declares it — ` +
          'every rule using it is dropped at first paint',
      ).toBe(true);
    }
    // …including the tokens the declared values themselves reference.
    const nested = new Set(
      [...TAILWIND_THEME_TOKENS_RESERVE_CSS.matchAll(/:\s*[^;}]*var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]),
    );
    for (const token of nested) {
      expect(TAILWIND_THEME_TOKENS_RESERVE_CSS.includes(`${token}:`)).toBe(true);
    }
  });

  it('reserves the preflight resets that the measured shifts came from', () => {
    // Each of these was a distinct source in the layout-shift attribution on
    // /vivere-in-ticino/comuni-di-frontiera/albiolo/ and
    // /articoli-frontaliere/lamal-vs-cmi-frontaliere/.
    expect(TAILWIND_PREFLIGHT_RESERVE_CSS).toMatch(/\*[^{]*\{[^}]*margin:0/); // <p>/<h1> UA margins
    expect(TAILWIND_PREFLIGHT_RESERVE_CSS).toMatch(/\*[^{]*\{[^}]*padding:0/); // <ul> UA padding-left
    expect(TAILWIND_PREFLIGHT_RESERVE_CSS).toContain('h1,h2,h3,h4,h5,h6{font-size:inherit');
    expect(TAILWIND_PREFLIGHT_RESERVE_CSS).toContain('ol,ul,menu{list-style:none}');
    expect(TAILWIND_PREFLIGHT_RESERVE_CSS).toContain('img,video{max-width:100%;height:auto}');
  });

  it('reserves the utilities behind the dominant data-landing shift', () => {
    // The single 0.4206 shift at 252ms on the data landing had three sources:
    // the `dl` block→grid collapse, the `header` padding, and the wrapper's
    // padding-inline (which re-wraps the whole column).
    expect(TAILWIND_UTILITY_RESERVE_CSS).toContain('.grid{display:grid}');
    expect(TAILWIND_UTILITY_RESERVE_CSS).toContain('.lg\\:grid-cols-4{');
    expect(TAILWIND_UTILITY_RESERVE_CSS).toContain('.sm\\:grid-cols-2{');
    expect(TAILWIND_UTILITY_RESERVE_CSS).toContain('.lg\\:px-8{');
    expect(TAILWIND_UTILITY_RESERVE_CSS).toContain('.sm\\:p-7{');
    // The escaped-colon selectors above are the whole point of the responsive
    // half; a single-backslash literal in the TS source would silently turn
    // `.sm\:p-7` into the pseudo-class selector `.sm:p-7` and match nothing.
    expect(TAILWIND_UTILITY_RESERVE_CSS).not.toMatch(/\.[a-z]+:(?:grid-cols|px|py|p)-/);
  });
});
