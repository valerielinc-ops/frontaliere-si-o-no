import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  renderFastestCrossingCard,
  renderTrafficFluidBanner,
} from '@/build-plugins/borderWaitPagesPlugin';

/**
 * Class-extract migration (2026-05-20): inline `style="..."` declarations
 * across all build-plugins/ moved to content-hashed classes in
 * public/assets/seo-static.css. WCAG-affecting assertions now look up the
 * declaration in EITHER the inline-style attribute OR the resolved CSS
 * rule for the referenced `s-<hash>` class.
 */
const CSS_SOURCE_PATH = path.resolve(__dirname, '..', '..', 'public', 'assets', 'seo-static.css');
const CSS_SOURCE = fs.readFileSync(CSS_SOURCE_PATH, 'utf-8');

function htmlOrCssMatches(html: string, declRegex: RegExp): boolean {
  if (declRegex.test(html)) return true;
  const classes = new Set(
    [...html.matchAll(/class="(?:[^"]* )?(s-[A-Za-z0-9_-]+)/g)].map((m) => m[1]),
  );
  for (const c of classes) {
    const rule = CSS_SOURCE.match(new RegExp(`\\.${c}\\s*\\{([^}]*)\\}`));
    if (rule && declRegex.test(rule[1])) return true;
  }
  return false;
}

function htmlAndCssAreFreeOf(html: string, declRegex: RegExp): boolean {
  if (declRegex.test(html)) return false;
  const classes = new Set(
    [...html.matchAll(/class="(?:[^"]* )?(s-[A-Za-z0-9_-]+)/g)].map((m) => m[1]),
  );
  for (const c of classes) {
    const rule = CSS_SOURCE.match(new RegExp(`\\.${c}\\s*\\{([^}]*)\\}`));
    if (rule && declRegex.test(rule[1])) return false;
  }
  return true;
}

describe('border-wait hero contrast markup', () => {
  it('hero card wait-time span uses strong foreground token, not default', () => {
    const html = renderFastestCrossingCard(
      [{ slug: 'a', labelIt: 'A', waitTimeMinutes: 10 }],
      'it',
    );
    // Wait-time span must declare an explicit foreground colour that
    // clears WCAG AA (4.5:1) against --color-success-subtle.
    expect(htmlOrCssMatches(html, /color:\s*var\(--color-success-strong\)/)).toBe(true);
  });

  it('hero card has a 4px left rail for visual anchoring', () => {
    const html = renderFastestCrossingCard(
      [{ slug: 'a', labelIt: 'A', waitTimeMinutes: 10 }],
      'it',
    );
    expect(htmlOrCssMatches(html, /border-left:\s*4px solid var\(--color-success-strong\)/)).toBe(true);
  });

  it('fluid banner body text does not rely on muted colour', () => {
    const html = renderTrafficFluidBanner(true, 'it');
    expect(htmlAndCssAreFreeOf(html, /color:\s*var\(--color-text-muted\)/)).toBe(true);
    expect(htmlOrCssMatches(html, /color:\s*var\(--color-text\)/)).toBe(true);
  });

  it('fluid banner has a 4px left rail for visual anchoring', () => {
    const html = renderTrafficFluidBanner(true, 'it');
    expect(htmlOrCssMatches(html, /border-left:\s*4px solid var\(--color-success-strong\)/)).toBe(true);
  });
});
