import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOOTER_LINK_GROUP_CLASS } from '@/components/footer/footerLinkGroup';

// Lighthouse `target-size` (WCAG 2.5.8): a link smaller than 24x24 CSS px
// fails unless its 24px safe circle clears every neighbour. The footer link
// groups wrap `text-xs` links (16px line box) onto rows 4px apart, so without a
// minimum height every page that renders the footer loses the audit — measured
// on the production run of 2026-10-05, where it took /prezzi-diesel/ from 0.92
// to 0.89 accessibility on both form factors (budget 0.9).
const MIN_TARGET_PX = 24;
const TAILWIND_SPACING_PX = 4;

function directLinkMinHeightPx(className: string): number {
  const match = className.match(/(?:^|\s)\[&>a\]:min-h-(\d+)(?:\s|$)/);
  return match ? Number(match[1]) * TAILWIND_SPACING_PX : 0;
}

describe('footer link groups keep a 24px touch target', () => {
  it('gives every direct link a minimum height of at least 24px', () => {
    expect(directLinkMinHeightPx(FOOTER_LINK_GROUP_CLASS)).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  });

  it('applies the shared class to every footer link group in App.tsx', () => {
    const app = readFileSync(resolve(__dirname, '..', 'App.tsx'), 'utf8');
    const groups = [...app.matchAll(/<section aria-labelledby="footer-[a-z-]+-links"[\s\S]*?<\/h3>\s*<div className=(\{[^}]+\}|"[^"]*")>/g)];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group[1]).toBe('{FOOTER_LINK_GROUP_CLASS}');
    }
  });
});
