/**
 * job-board-text-ratio-regression.test.ts
 *
 * Regression test for the "low text-to-HTML ratio" Semrush gate on job-board
 * landing pages. Apr 2026 audit found 824/3 city/sector/type pages below the
 * 10 % threshold; the fix added a city-/sector-aware commuter prose block
 * via `renderJobBoardCommuterContext`. This test calls the helper directly
 * and verifies that a sample emit produces visible-text-to-HTML ratio >12 %
 * (2pt margin above the Semrush gate of 10 %).
 *
 * If this test starts failing, do NOT lower the threshold (CLAUDE.md rule
 * 1: zero tolerance). Investigate why the helper produced less prose and
 * fix the root cause.
 */

import { describe, expect, it } from 'vitest';
import { renderJobBoardCommuterContext } from '../../build-plugins/shared/jobBoardCommuterContext';

/**
 * Strip HTML to its visible-text portion using the same heuristic Semrush
 * documents for "Low text-to-HTML ratio" — mirrors `extractVisibleText`
 * in scripts/audit-text-html-ratio.mjs.
 */
function extractVisibleText(html: string): string {
  let s = html;
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function ratio(html: string): number {
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  const text = extractVisibleText(html);
  const textBytes = Buffer.byteLength(text, 'utf8');
  return (textBytes / Math.max(htmlBytes, 1)) * 100;
}

const RATIO_FLOOR_PCT = 12; // 2pt margin above Semrush 10 % gate

describe('renderJobBoardCommuterContext — text-to-HTML ratio', () => {
  it('Lugano IT city landing: text >12 % of standalone block HTML', () => {
    const block = renderJobBoardCommuterContext({ locale: 'it', location: 'Lugano' });
    expect(block.length).toBeGreaterThan(2_000);
    expect(ratio(block)).toBeGreaterThan(RATIO_FLOOR_PCT);
  });

  it('Mendrisio IT sector × location landing: substantive prose with sector name interpolated', () => {
    const block = renderJobBoardCommuterContext({
      locale: 'it',
      location: 'Mendrisio',
      sectorOrType: 'sanità',
    });
    expect(block).toContain('Mendrisio');
    // Confirm the sector label flows into a question for relevance.
    expect(block).toContain('sanità');
    expect(ratio(block)).toBeGreaterThan(RATIO_FLOOR_PCT);
  });

  it('Locarno DE city landing: German locale carries city-specific commute data', () => {
    const block = renderJobBoardCommuterContext({ locale: 'de', location: 'Locarno' });
    // German locale must surface methodology + commute paragraphs.
    expect(block).toContain('Locarno');
    expect(block).toContain('Grenzgänger');
    expect(ratio(block)).toBeGreaterThan(RATIO_FLOOR_PCT);
  });

  it('Bellinzona FR sector × location landing: French locale produces FAQ + scenario', () => {
    const block = renderJobBoardCommuterContext({
      locale: 'fr',
      location: 'Bellinzona',
      sectorOrType: 'finance',
    });
    expect(block).toContain('Bellinzona');
    expect(block).toContain('frontalier');
    // FAQ marker (4 questions emitted as <details>).
    expect((block.match(/<details/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(ratio(block)).toBeGreaterThan(RATIO_FLOOR_PCT);
  });

  it('omitCommute=true pages (today/category): general-Ticino prose still passes the gate', () => {
    const block = renderJobBoardCommuterContext({
      locale: 'en',
      location: 'Ticino',
      sectorOrType: 'Healthcare',
      omitCommute: true,
    });
    expect(block).toContain('Ticino');
    expect(block).toContain('20 km');
    expect(ratio(block)).toBeGreaterThan(RATIO_FLOOR_PCT);
  });

  it('renderJobBoardCommuterContext is deterministic across calls (no Date.now / Math.random)', () => {
    const a = renderJobBoardCommuterContext({ locale: 'it', location: 'Lugano' });
    const b = renderJobBoardCommuterContext({ locale: 'it', location: 'Lugano' });
    expect(a).toBe(b);
  });
});
