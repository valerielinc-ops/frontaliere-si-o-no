/**
 * Regression gate: critical CSS shipped by `staticPagesPlugin.ts` and
 * `ogPagesPlugin.ts` MUST NOT force `min-height: 100vh` on `#root`.
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
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILES = [
  'build-plugins/staticPagesPlugin.ts',
  'build-plugins/ogPagesPlugin.ts',
] as const;

const ROOT = resolve(__dirname, '..', '..');

describe('critical CSS must not pin #root to 100vh', () => {
  for (const rel of FILES) {
    it(`${rel} forbids #root{min-height:100vh} in any inlined criticalCSS string`, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf-8');
      const offenders: string[] = [];
      // Scan every line that holds a criticalCSS-style literal.
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('criticalCSS') && !line.includes('min-height')) continue;
        // Allow body{min-height:100vh} — that's the structural replacement.
        // Forbid any #root{...min-height...} variant.
        if (/#root\s*\{[^}]*min-height/i.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
        }
      }
      expect(
        offenders,
        'Remove `#root{min-height:100vh}` from the critical CSS string. ' +
          'Use `body{min-height:100vh}` instead so staticOverlay pages do not ' +
          'leave a ~770px empty band between SPA chrome and static content. ' +
          'See CLAUDE.md rule #14 + the App.tsx:1582 conditional `min-h-screen`.',
      ).toEqual([]);
    });
  }
});
