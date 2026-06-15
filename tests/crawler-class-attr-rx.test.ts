/**
 * classAttrRx — shared quote/multi-class-tolerant `class` selector fragment.
 *
 * #2118 / PR #2149: the dedicated crawler parsers (Solique, Dualoo tenants
 * uroviva/klinik-arlesheim, jobalino) extracted content with a quote-strict,
 * exact-class regex (`class="${cls}"`). A vendor markup tweak (single quotes,
 * an extra utility class, attr reorder) silently matched nothing → '' →
 * thin-source → degraded/de-indexed JobPosting. The fix centralizes one
 * tolerant selector here so the parsers cannot drift. This locks its contract.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs crawler lib, no type declarations
import { classAttrRx } from '../scripts/lib/crawler-template.mjs';

const rx = (token: string) => new RegExp(`${classAttrRx(token)}[^>]*>`);

describe('classAttrRx', () => {
  it('matches the canonical double-quoted exact class', () => {
    expect(rx('tasks').test('<div class="tasks">')).toBe(true);
  });

  it('tolerates single quotes, no quotes, and multi-class lists in any order', () => {
    expect(rx('tasks').test("<div class='tasks'>")).toBe(true);
    expect(rx('tasks').test('<div class=tasks>')).toBe(true);
    expect(rx('tasks').test('<div class="tasks col-6">')).toBe(true);
    expect(rx('tasks').test('<div class="col-6 tasks">')).toBe(true);
  });

  it('tolerates attributes before the class attribute', () => {
    expect(rx('tasks').test('<div data-x="y" class="tasks">')).toBe(true);
  });

  it('supports an alternation of whole class names', () => {
    expect(rx('tasks|profile').test('<div class="profile">')).toBe(true);
    expect(rx('tasks|profile').test('<div class="tasks">')).toBe(true);
  });

  it('matches only whole class names, not substrings/suffixes', () => {
    // `tasksy` shares no word boundary after `tasks`, so it must NOT match.
    expect(rx('tasks').test('<div class="tasksy">')).toBe(false);
    expect(rx('advertisementResponsibilitiesText').test('<div class="other">')).toBe(false);
  });
});
