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
import { readBuildPluginSource } from '../helpers/buildPluginSource';

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

  it('forbids an UNSCOPED #root{min-height:100vh} in index.css (#2162 regression)', () => {
    // #2162 reintroduced the #1586 bug in the main stylesheet (out of the
    // CRITICAL_CSS scope above): a bare `#root{...min-height:100vh}` rule
    // carves a ~770px empty band on staticOverlay pages, pushing the H1 below
    // the fold (caught live by spa-hydration-contract-live.spec.ts). A 100vh
    // reservation on #root is allowed ONLY when scoped to SPA-owned pages
    // (e.g. `body:has(.seo-footer-block) #root{min-height:100vh}`), so the
    // staticOverlay hubs — which have no footer block — keep their static
    // content flowing right below the chrome.
    const indexCss = readBuildPluginSource(resolve(ROOT, 'index.css'), 'utf-8');
    // Match a rule whose selector list ENDS in a bare `#root` (no descendant
    // combinator prefix like `body:has(...) #root`) and whose body forces a
    // full-viewport min-height. We strip comments first so the documentation
    // block above the rule (which legitimately mentions the pattern) is ignored.
    const cssNoComments = indexCss.replace(/\/\*[\s\S]*?\*\//g, '');
    // Unwrap at-rule blocks (@media/@supports/@container/@layer/…) so their
    // inner rules are exposed to the bare-`#root` check below. Without this the
    // naive block matcher swallows a nested rule: for
    // `@media (…){ #root{min-height:100vh} }` it captures `@media (…)` as the
    // selector and the inner `#root` never reaches `/^#root$/` → a silent false
    // negative that would let the #1586/#2162 CLS regression back in through a
    // media-query wrapper. We strip only each at-rule's prelude + its opening
    // brace; the now-dangling closing brace is harmless (the matcher requires a
    // `selector{…}` shape, so an orphan `}` never matches). A global pass
    // unwraps nested at-rules too (`@supports{@media{#root{…}}}`).
    // The prelude class EXCLUDES `;` so at-STATEMENTS (`@import …;`,
    // `@custom-variant …;`, `@charset …;`, `@layer a,b;`) — which `index.css`
    // opens with — stop the strip at their `;` instead of greedily consuming
    // forward to the next `{` and swallowing the following rule's selector
    // (which would silently skip a bare `#root{min-height:100vh}` placed right
    // after an at-statement → the same #1586/#2162 false negative we close).
    const cssUnwrapped = cssNoComments.replace(/@[a-z-]+[^{};]*\{/gi, '');
    const unscopedRootBlocks = [...cssUnwrapped.matchAll(/([^{};]+)\{([^}]*)\}/g)].filter(
      (m) => {
        const selectors = m[1].split(',').map((s) => s.trim());
        const body = m[2];
        const forcesFullViewport = /min-height\s*:\s*100(vh|dvh|svh|lvh)/i.test(body);
        if (!forcesFullViewport) return false;
        // A selector is "unscoped #root" when its last compound is exactly
        // `#root` AND nothing precedes it (no descendant/child combinator).
        return selectors.some((sel) => /^#root$/.test(sel));
      },
    );
    expect(
      unscopedRootBlocks.length,
      'index.css must not force min-height:100vh on a bare `#root` selector. ' +
        'Scope it to SPA-owned pages instead, e.g. ' +
        '`body:has(.seo-footer-block) #root{min-height:100vh}` (see #1586/#2162 ' +
        'and the comment above the #root rule).',
    ).toBe(0);
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

  it('declares the Space Grotesk heading @font-face at first paint (#2659)', () => {
    // Article/OG cold-loads showed a dominant ~0.32 heading font-swap shift
    // because critical CSS carried ONLY the Inter @font-face — headings painted
    // in the system-ui fallback, then the async sheet's Space Grotesk @font-face
    // landed late and reflowed the column. The shared block must declare the SG
    // @font-face (with font-display:optional → no swap reflow) AND map headings
    // to it so the final heading box is in place at first paint.
    expect(CRITICAL_CSS, 'critical CSS missing Space Grotesk @font-face').toContain(
      '@font-face{font-family:"Space Grotesk"',
    );
    expect(
      CRITICAL_CSS,
      'Space Grotesk must use font-display:optional to avoid heading swap reflow',
    ).toContain('font-display:optional');
    expect(
      CRITICAL_CSS,
      'headings must map to Space Grotesk at first paint',
    ).toContain('h1,h2,h3{font-family:"Space Grotesk"');
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
      const src = readBuildPluginSource(resolve(ROOT, rel));
      // Two accepted shapes: the legacy direct import from shared/criticalCss,
      // or — for the article engine after #4881 Fase 6 — the link arriving via
      // the injected SiteShellContract. Both mean "one shared source". The
      // @font-face literal check below is what actually guards the drift.
      expect(
        /from '\.\/shared\/criticalCss'|criticalCssLink:\s*CRITICAL_CSS_LINK|\bCRITICAL_CSS_LINK\b/.test(src),
        `${rel} must obtain CRITICAL_CSS from the shared module (direct import or injected site shell), not re-inline it`,
      ).toBe(true);
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
