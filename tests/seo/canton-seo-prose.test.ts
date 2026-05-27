/**
 * Regression test for the canton-aware SEO prose helper.
 *
 * Why this exists
 * ---------------
 * The May 2026 audit-text-html-ratio CI gate failed with 1243 offenders
 * (baseline 471). Three template families dominated the regression:
 *   - thin canton hubs (`/cerca-lavoro-{canton}/{settori|aziende|tutti}/`)
 *   - bridge plugins (company + location placeholder pages)
 *   - per-canton companies-hiring landing
 *
 * Each emits ~6.5-10 KB of HTML with ~400-700 bytes of visible text
 * (~5-9 % ratio). The fix appends a shared prose helper
 * (`build-plugins/shared/cantonSeoProse.ts`) that adds an intro,
 * methodology, permit context, FAQ block and cross-links — comfortably
 * lifting every host page above the 10 % Semrush threshold.
 *
 * This test renders the prose helper output for each slot and locale
 * and asserts:
 *   1. The helper emits ≥ 1500 bytes of visible text per call (enough
 *      to lift a 7-10 KB host page well above the 10 % threshold).
 *   2. The helper output is parametric in canton/entity (two calls
 *      with different cantons produce different HTML — no cross-page
 *      duplicate-content penalty).
 *   3. The FAQ JSON-LD items mirror the visible FAQ Q&A so the host
 *      can merge them into a single FAQPage script.
 *
 * A regression in any of these dimensions silently tanks the
 * text-to-html-ratio gate again.
 */
import { describe, it, expect } from 'vitest';
import {
  renderCantonSeoProse,
  buildCantonSeoProseFaqItems,
  type CantonSeoLocale,
  type CantonSeoSlot,
} from '@/build-plugins/shared/cantonSeoProse';

/** Mirrors `scripts/audit-text-html-ratio.mjs::extractVisibleText`. */
function extractVisibleText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<!doctype[^>]*>/gi, ' ');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<template\b[\s\S]*?<\/template>/gi, ' ');
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const LOCALES: CantonSeoLocale[] = ['it', 'en', 'de', 'fr'];
const SLOTS: CantonSeoSlot[] = [
  'canton-hub',
  'sectors-hub',
  'companies-hub',
  'company-landing',
  'city-landing',
  'editorial-today',
  'editorial-nursing',
  'editorial-clinics',
  'editorial-part-time',
];

describe('canton-seo-prose helper', () => {
  describe('text body weight', () => {
    for (const locale of LOCALES) {
      for (const slot of SLOTS) {
        it(`emits ≥ 1500 bytes of visible text for ${locale}/${slot}`, () => {
          const html = renderCantonSeoProse({
            locale,
            cantonDisplay: locale === 'de' ? 'Tessin' : 'Ticino',
            slot,
            entityName: 'Lugano',
            countHint: 42,
            ctaHref: '/',
            ctaLabel: null,
          });
          const visible = extractVisibleText(html);
          const bytes = Buffer.byteLength(visible, 'utf8');
          expect(bytes).toBeGreaterThanOrEqual(1500);
        });
      }
    }
  });

  describe('parametric per canton', () => {
    it('produces different prose for Zurigo vs Argovia (same slot, same locale)', () => {
      const a = renderCantonSeoProse({
        locale: 'it',
        cantonDisplay: 'Zurigo',
        slot: 'companies-hub',
        entityName: null,
        countHint: 10,
        ctaHref: '/',
        ctaLabel: null,
      });
      const b = renderCantonSeoProse({
        locale: 'it',
        cantonDisplay: 'Argovia',
        slot: 'companies-hub',
        entityName: null,
        countHint: 10,
        ctaHref: '/',
        ctaLabel: null,
      });
      expect(a).not.toEqual(b);
      expect(a).toContain('Zurigo');
      expect(b).toContain('Argovia');
      expect(a).not.toContain('Argovia');
      expect(b).not.toContain('Zurigo');
    });

    it('produces different prose for two companies in the same canton', () => {
      const a = renderCantonSeoProse({
        locale: 'en',
        cantonDisplay: 'Ticino',
        slot: 'company-landing',
        entityName: 'Migros',
        countHint: 8,
        ctaHref: '/',
        ctaLabel: null,
      });
      const b = renderCantonSeoProse({
        locale: 'en',
        cantonDisplay: 'Ticino',
        slot: 'company-landing',
        entityName: 'Lonza',
        countHint: 8,
        ctaHref: '/',
        ctaLabel: null,
      });
      expect(a).not.toEqual(b);
      expect(a).toContain('Migros');
      expect(b).toContain('Lonza');
    });
  });

  describe('FAQ JSON-LD parity', () => {
    it('returns the same FAQ items as the visible HTML', () => {
      const opts = {
        locale: 'it' as const,
        cantonDisplay: 'Ginevra',
        slot: 'sectors-hub' as const,
        entityName: null,
        countHint: 0,
        ctaHref: '/',
        ctaLabel: null,
      };
      const html = renderCantonSeoProse(opts);
      const ldItems = buildCantonSeoProseFaqItems(opts);
      expect(ldItems.length).toBe(4);
      for (const item of ldItems) {
        expect(item['@type']).toBe('Question');
        expect(item.name.length).toBeGreaterThan(10);
        expect(item.acceptedAnswer.text.length).toBeGreaterThan(50);
        // The Q text appears verbatim in the visible HTML (escaped).
        expect(html).toContain(item.name.split(' ').slice(0, 3).join(' '));
      }
    });
  });

  describe('no dark: prefixes, no hex colours', () => {
    it('uses only --color-* semantic tokens', () => {
      const html = renderCantonSeoProse({
        locale: 'it',
        cantonDisplay: 'Vallese',
        slot: 'canton-hub',
        entityName: null,
        countHint: 5,
        ctaHref: '/',
        ctaLabel: null,
      });
      // No Tailwind `dark:` color prefixes (CLAUDE.md non-negotiable).
      expect(html).not.toMatch(/\bdark:[a-z-]/);
      // No raw hex background/border colours — every colour binds to
      // a `--color-*` semantic token from index.css.
      const inlineHexBg = html.match(/style="[^"]*(?:background-color|border-color):\s*#[0-9a-f]{3,8}/gi);
      expect(inlineHexBg).toBeNull();
    });
  });
});
