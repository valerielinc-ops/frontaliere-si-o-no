import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Keep this focused test runnable in the agent sparse checkout. The real module
// only needs BASE_URL; mocking the build-only constants avoids pulling the
// crawler/data graph into a CSS contract test.
vi.mock('@/build-plugins/constants', () => ({ BASE_URL: '' }));

import {
  CRITICAL_CSS,
  CRITICAL_CSS_LINK,
  RAIL_RESERVE_CSS,
  ROOT_HEADER_RESERVE_CSS,
  SEO_STATIC_GRID_RESERVE_CSS,
  SEO_STATIC_HERO_RESERVE_CSS,
  STATIC_AD_COLLAPSE_CSS,
} from '@/build-plugins/shared/criticalCss';

const ROOT = resolve(__dirname, '..', '..');

function closingBrace(css: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < css.length; i += 1) {
    const char = css[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return i;
  }
  return css.length - 1;
}

function normalizeSelector(selector: string): string {
  return selector
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*([>+~])\s*/g, '$1')
    .trim();
}

function splitSelectors(prelude: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i += 1) {
    if (prelude[i] === '(') depth += 1;
    else if (prelude[i] === ')') depth -= 1;
    else if (prelude[i] === ',' && depth === 0) {
      selectors.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  selectors.push(prelude.slice(start));
  return selectors;
}

function cssSelectors(css: string): Set<string> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = new Set<string>();

  function visit(start: number, end: number): void {
    let cursor = start;
    while (cursor < end) {
      const open = source.indexOf('{', cursor);
      if (open < 0 || open >= end) return;
      const close = closingBrace(source, open);
      const prelude = source.slice(cursor, open).trim();
      if (prelude.startsWith('@')) visit(open + 1, close);
      else {
        for (const selector of splitSelectors(prelude)) {
          const normalized = normalizeSelector(selector);
          if (normalized && !/^(?:from|to|\d+(?:\.\d+)?%)$/.test(normalized)) {
            selectors.add(normalized);
          }
        }
      }
      cursor = close + 1;
    }
  }

  visit(0, source.length);
  return selectors;
}

const asyncCss = [
  resolve(ROOT, 'index.css'),
  resolve(ROOT, 'public', 'assets', 'seo-static.css'),
]
  .filter(existsSync)
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

describe('render-blocking critical CSS first-paint contract', () => {
  it('keeps selector overlap with async sheets below the broad-mirror threshold', () => {
    const criticalSelectors = cssSelectors(CRITICAL_CSS);
    const asyncSelectors = cssSelectors(asyncCss);
    const overlap = [...criticalSelectors].filter((selector) => asyncSelectors.has(selector));
    const ratio = overlap.length / criticalSelectors.size;

    expect(criticalSelectors.size).toBeGreaterThan(20);
    expect(asyncSelectors.size).toBeGreaterThan(20);
    expect(ratio, `critical CSS selector overlap is ${(ratio * 100).toFixed(1)}%`).toBeLessThan(0.95);
  });

  it('retains the measured first-paint geometry and ad reserves', () => {
    for (const reserve of [
      RAIL_RESERVE_CSS,
      ROOT_HEADER_RESERVE_CSS,
      SEO_STATIC_GRID_RESERVE_CSS,
      SEO_STATIC_HERO_RESERVE_CSS,
      STATIC_AD_COLLAPSE_CSS,
    ]) {
      expect(CRITICAL_CSS).toContain(reserve);
    }

    expect(CRITICAL_CSS).toContain('@font-face{font-family:Inter');
    expect(CRITICAL_CSS).toContain('ascent-override:90%');
    expect(CRITICAL_CSS).toContain('descent-override:22%');
    expect(CRITICAL_CSS).toContain('ins.adsbygoogle[data-ft-static-ad-collapsed]');
    expect(CRITICAL_CSS).not.toMatch(/adsbygoogle[^}]*display:none/);
    expect(CRITICAL_CSS).not.toContain('enable_page_level_ads:false');
  });

  it('keeps critical.css render-blocking while dropping the broad utility mirror', () => {
    expect(CRITICAL_CSS_LINK).toContain('<link rel="stylesheet"');
    expect(CRITICAL_CSS_LINK).toContain('href="/assets/critical.css"');
    expect(CRITICAL_CSS_LINK).not.toContain('media="print"');
    expect(CRITICAL_CSS).not.toContain('.jc-card{border-style:solid');
  });
});
