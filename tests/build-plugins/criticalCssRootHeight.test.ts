/**
 * Regression gate: the first-paint critical CSS shipped by `staticPagesPlugin`
 * and `ogPagesPlugin` MUST NOT force `min-height: 100vh` on `#root`, and MUST
 * stay a SINGLE shared source of truth (no per-plugin copy that can drift).
 *
 * Background (2026-05-18 — fix for "/calcola-stipendio/* centralmente vuota")
 * ─────────────────────────────────────────────────────────────────────────
 * staticOverlay pages emit the SEO body OUTSIDE `#root` as a sibling
 * `<main class="seo-static-content">`. App.tsx's wrapper drops `min-h-screen`
 * when `staticOverlay` is true (App.tsx:1582:
 *   `${staticOverlay ? '' : 'min-h-screen'}`)
 * so #root naturally collapses to chrome height (~124 px). If the critical
 * CSS forces `#root{min-height:100vh}`, #root expands to 100 vh (~896 px on
 * mobile), creating a 770 px empty band between the SPA chrome and the
 * static content — the page looks "centrally empty" until the user scrolls.
 *
 * Structural fix: `body{min-height:100vh}` instead. body contains
 * #root + main.seo-static-content + #footer-root, so the page always
 * fills the viewport in both staticOverlay and full-SPA modes without
 * carving dead space inside #root.
 *
 * Dedup gate (2026-06-10 — issue #1586)
 * ─────────────────────────────────────────────────────────────────────────
 * The critical-CSS literal used to be hand-copied in BOTH plugins and had
 * drifted (ogPagesPlugin was missing the `@font-face` metric overrides that
 * `index.html` and staticPagesPlugin carry). It now lives in ONE module,
 * `build-plugins/shared/criticalCss.ts`, imported by both plugins. These tests
 * lock that single-source invariant so the twin-file drift cannot reappear.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CRITICAL_CSS } from '@/build-plugins/shared/criticalCss';

const SHARED = 'build-plugins/shared/criticalCss.ts';
const CONSUMERS = [
  'build-plugins/staticPagesPlugin.ts',
  'build-plugins/ogPagesPlugin.ts',
] as const;

const ROOT = resolve(__dirname, '..', '..');

describe('critical CSS single source of truth (#1586)', () => {
  it('forbids #root{min-height:100vh} in the shared critical CSS', () => {
    // body{min-height:100vh} is the structural replacement and is allowed.
    expect(
      /#root\s*\{[^}]*min-height/i.test(CRITICAL_CSS),
      'Remove `#root{min-height:100vh}` from the critical CSS. Use ' +
        '`body{min-height:100vh}` instead so staticOverlay pages do not leave ' +
        'a ~770px empty band between SPA chrome and static content. ' +
        'See CLAUDE.md rule #14 + the App.tsx:1582 conditional `min-h-screen`.',
    ).toBe(false);
    expect(CRITICAL_CSS).toMatch(/body\{[^}]*min-height:100vh\}/);
  });

  it('carries the @font-face metric overrides (CLS stabilization)', () => {
    // These were missing from the old ogPagesPlugin copy; the shared constant
    // must keep them so OG/article pages get the same font-metric CLS guard as
    // index.html and the static pages.
    for (const decl of [
      'size-adjust:100%',
      'ascent-override:90%',
      'descent-override:22%',
      'line-gap-override:0%',
    ]) {
      expect(CRITICAL_CSS, `critical CSS lost ${decl}`).toContain(decl);
    }
  });

  it('uses a token-with-fallback heading color (stable first paint)', () => {
    // var(--color-heading,#0f172a): token once async CSS lands, exact old
    // ogPages first-paint colour (#0f172a == resolved --color-heading) before.
    expect(CRITICAL_CSS).toContain('.text-heading{color:var(--color-heading,#0f172a)}');
  });

  it('is defined ONCE — consumers import it, never re-inline the literal', () => {
    // No plugin should re-declare the full CSS string. They must reference the
    // shared CRITICAL_CSS so the twin-file drift (#1586 root cause) is
    // impossible by construction.
    for (const rel of CONSUMERS) {
      const src = readFileSync(resolve(ROOT, rel), 'utf-8');
      expect(
        src,
        `${rel} must import CRITICAL_CSS from shared/criticalCss, not re-inline it`,
      ).toContain("from './shared/criticalCss'");
      // The hand-copied literal signature (the @font-face Inter src) must NOT
      // appear inline in the consumer anymore.
      expect(
        src.includes("@font-face{font-family:Inter") === false,
        `${rel} still inlines the critical-CSS @font-face literal — import ` +
          'CRITICAL_CSS from shared/criticalCss.ts instead (#1586).',
      ).toBe(true);
    }
  });
});
