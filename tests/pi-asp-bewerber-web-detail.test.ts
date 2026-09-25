import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PI_ASP_DETAIL_CONTAINER_SELECTOR,
  PI_ASP_DETAIL_NOISE_SELECTOR,
  DEFAULT_MAX_DETAIL_RENDERS,
  MIN_DETAIL_TEXT_CHARS,
  piAspDetailHtmlToDescription,
} from '../scripts/lib/pi-asp-bewerber-web-detail.mjs';

const FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures', 'pi-asp-detail-container.html'),
  'utf8',
);

describe('pi-asp bewerber-web detail helper', () => {
  it('exposes the GWT detail-screen selectors extracted from the deployed bundle', () => {
    // "Deteil" is P&I's own typo in the app constant — do not "fix" it.
    expect(PI_ASP_DETAIL_CONTAINER_SELECTOR).toContain('.BW-webPositionDeteilScreen');
    expect(PI_ASP_DETAIL_CONTAINER_SELECTOR).toContain('.BW-WebPositionPage');
    expect(PI_ASP_DETAIL_NOISE_SELECTOR).toContain('.BW-WebPositionActionButtons');
    expect(PI_ASP_DETAIL_NOISE_SELECTOR).toContain('.BW-WebPositionSocialMediaSection');
    expect(DEFAULT_MAX_DETAIL_RENDERS).toBeGreaterThan(0);
  });

  describe('piAspDetailHtmlToDescription', () => {
    it('converts the rendered job ad into structured text with bullet lines', () => {
      const text = piAspDetailHtmlToDescription(FIXTURE);
      expect(text.length).toBeGreaterThanOrEqual(MIN_DETAIL_TEXT_CHARS);
      // Section headings survive as their own lines.
      expect(text).toContain('Ihre Aufgaben');
      expect(text).toContain('Ihr Profil');
      // <li> items become `• ` line-start bullets — this is exactly what the
      // parser-quality audit's hasStructuredContent check looks for
      // (issue #3836: no-structured-content ratchet on pi-asp crawlers).
      const bulletLines = text.split('\n').filter((l) => l.startsWith('• '));
      expect(bulletLines.length).toBeGreaterThanOrEqual(8);
      expect(bulletLines[0]).toContain('Individuelle, ganzheitliche Pflege');
    });

    it('decodes HTML entities and strips tags', () => {
      const text = piAspDetailHtmlToDescription(FIXTURE);
      expect(text).toContain('Fort- und Weiterbildungsmöglichkeiten');
      expect(text).toContain('Ärzteschaft');
      expect(text).not.toMatch(/<[a-z]/i);
      expect(text).not.toContain('&uuml;');
    });

    it('drops leaked <script> content', () => {
      const text = piAspDetailHtmlToDescription(FIXTURE);
      expect(text).not.toContain('window.location');
      expect(text).not.toContain('var leaked');
    });

    it('returns empty string for skeleton/error screens below the min length', () => {
      expect(piAspDetailHtmlToDescription('')).toBe('');
      expect(piAspDetailHtmlToDescription('<div>Wird geladen…</div>')).toBe('');
      expect(
        piAspDetailHtmlToDescription('<p>Die Stelle ist nicht mehr verfügbar.</p>'),
      ).toBe('');
    });

    it('collapses per-line whitespace and 3+ blank lines', () => {
      const text = piAspDetailHtmlToDescription(FIXTURE);
      expect(text).not.toMatch(/\n{3,}/);
      expect(text).not.toMatch(/^[ \t]/m);
      expect(text).not.toMatch(/ {2,}/);
    });
  });
});
